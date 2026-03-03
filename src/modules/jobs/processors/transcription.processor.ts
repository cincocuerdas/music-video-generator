import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { JobsService } from '../jobs.service';
import { DeadLetterOrchestratorService } from '../services/dead-letter-orchestrator.service';
import { JobType } from '../dto';
import { QUEUE_NAMES } from '../../queue';
import { CircuitBreakerService, PythonRunnerService } from '../../../common/services';
import { EventsGateway } from '../../events';
import { SentryService } from '../../observability';
import {
    assessScriptResult,
    buildRetryCurrentStep,
    classifyJobError,
    emitCompletedUpdate,
    emitFailedUpdate,
    emitProcessingUpdate,
    getJobTraceContext,
    shouldRetryError,
    updateProgressAndEmit,
} from './retry.utils';

@Processor(QUEUE_NAMES.TRANSCRIPTION, { lockDuration: 600000 })
export class TranscriptionProcessor extends WorkerHost {
    private readonly logger = new Logger(TranscriptionProcessor.name);

    constructor(
        private readonly jobsService: JobsService,
        private readonly deadLetterOrchestrator: DeadLetterOrchestratorService,
        private readonly pythonRunnerService: PythonRunnerService,
        private readonly circuitBreaker: CircuitBreakerService,
        private readonly eventsGateway: EventsGateway,
        private readonly sentryService: SentryService,
    ) {
        super();
    }

    async process(job: Job<{ jobId: string; projectId: string; correlationId?: string }>): Promise<any> {
        const { jobId, projectId, correlationId } = job.data || {};
        const trace = getJobTraceContext(job, JobType.TRANSCRIPTION, projectId, jobId, correlationId);
        const circuitKey = 'transcription';

        // Defensive check: skip zombie jobs with missing data
        if (!jobId || !projectId) {
            this.logger.warn(`${trace.prefix} skipping zombie job (missing data)`);
            return { skipped: true, reason: 'missing job data' };
        }

        this.logger.log(`${trace.prefix} processing started`);

        try {
            await this.jobsService.markAsProcessing(jobId, this.worker.id);

            emitProcessingUpdate(
                this.eventsGateway,
                projectId,
                JobType.TRANSCRIPTION,
                0,
                'Starting transcription...',
            );

            // Run Whisper transcription
            await updateProgressAndEmit({
                jobsService: this.jobsService,
                eventsGateway: this.eventsGateway,
                jobId,
                projectId,
                jobType: JobType.TRANSCRIPTION,
                progress: 10,
                currentStep: 'Transcribing audio with Whisper...',
            });

            const circuitDecision = this.circuitBreaker.canExecute(circuitKey);
            if (!circuitDecision.allowed) {
                throw new Error(
                    `Circuit open for ${circuitKey}. Retry after ${circuitDecision.retryAfterMs}ms`,
                );
            }

            let reportedProgress = 10;
            const result = await this.pythonRunnerService.runScriptWithProgress(
                'transcribe_audio.py',
                [projectId],
                (event) => {
                    if (event.type !== 'progress') {
                        return;
                    }

                    const rawMessage =
                        typeof event.data === 'string'
                            ? event.data
                            : event.data?.message || '';
                    const message = String(rawMessage || 'Transcribing audio with Whisper...').trim();
                    if (!message) {
                        return;
                    }

                    const segmentMatch = message.match(/transcribed\s+(\d+)\s+segments/i);
                    let nextProgress = reportedProgress;
                    if (segmentMatch) {
                        const segments = Number(segmentMatch[1]);
                        if (Number.isFinite(segments)) {
                            // Gradual fill from 10% to 95% as segments increase.
                            nextProgress = Math.min(95, Math.max(15, 10 + Math.floor(segments * 2)));
                        }
                    } else {
                        nextProgress = Math.min(95, reportedProgress + 1);
                    }

                    if (nextProgress <= reportedProgress) {
                        return;
                    }
                    reportedProgress = nextProgress;

                    updateProgressAndEmit({
                        jobsService: this.jobsService,
                        eventsGateway: this.eventsGateway,
                        jobId,
                        projectId,
                        jobType: JobType.TRANSCRIPTION,
                        progress: nextProgress,
                        currentStep: message,
                    }).catch((err) => {
                        this.logger.warn(
                            `${trace.prefix} failed to persist transcription progress: ${
                                err instanceof Error ? err.message : String(err)
                            }`,
                        );
                    });
                },
            );
            const assessment = assessScriptResult(result);
            if (assessment.normalizedStatus === 'failed') {
                throw new Error(assessment.message || 'transcribe_audio.py returned failed status');
            }
            if (assessment.normalizedStatus === 'unknown' && assessment.rawStatus) {
                this.logger.warn(
                    `${trace.prefix} script returned non-standard status "${assessment.rawStatus}", treating as success`,
                );
            }

            const completionStep =
                assessment.normalizedStatus === 'degraded'
                    ? `Transcription completed with fallback${assessment.message ? `: ${assessment.message}` : ''}`
                    : 'Transcription complete';

            this.logger.log(`${trace.prefix} script completed successfully`);
            if (assessment.normalizedStatus === 'degraded') {
                this.logger.warn(
                    `${trace.prefix} script completed in DEGRADED mode: ${assessment.message || 'fallback output used'}`,
                );
            }
            await this.jobsService.updateProgress(jobId, 100, completionStep);
            await this.jobsService.markAsCompleted(jobId, result);
            this.circuitBreaker.recordSuccess(circuitKey);

            emitCompletedUpdate(
                this.eventsGateway,
                projectId,
                JobType.TRANSCRIPTION,
                `${completionStep}!`,
            );

            // Advance to next job (analysis)
            await this.jobsService.advancePipeline(projectId);

            return result;

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const retryTrace = getJobTraceContext(
                job,
                JobType.TRANSCRIPTION,
                projectId,
                jobId,
                correlationId,
            );
            const classification = classifyJobError(error);

            if (classification.retryable) {
                this.circuitBreaker.recordFailure(circuitKey, message);
            }

            if (shouldRetryError(error, retryTrace)) {
                const retryStep = buildRetryCurrentStep(retryTrace);
                this.logger.warn(
                    `${retryTrace.prefix} temporary failure (${classification.category}), retry scheduled: ${message}`,
                );
                await updateProgressAndEmit({
                    jobsService: this.jobsService,
                    eventsGateway: this.eventsGateway,
                    jobId,
                    projectId,
                    jobType: JobType.TRANSCRIPTION,
                    progress: 0,
                    currentStep: retryStep,
                });
                throw error;
            }

            this.logger.error(`${retryTrace.prefix} final failure: ${message}`);
            this.sentryService.captureException(error, {
                tags: {
                    component: 'job_processor',
                    jobType: JobType.TRANSCRIPTION,
                    stage: 'final_failure',
                },
                extra: {
                    projectId,
                    jobId,
                    correlationId: retryTrace.correlationId,
                    attemptsMade: retryTrace.attemptNumber,
                    maxAttempts: retryTrace.maxAttempts,
                    message,
                    errorCategory: classification.category,
                    retryable: classification.retryable,
                },
            });
            await this.jobsService.markAsFailed(jobId, message);
            await this.deadLetterOrchestrator.enqueue({
                sourceQueue: QUEUE_NAMES.TRANSCRIPTION,
                projectId,
                jobId,
                jobType: JobType.TRANSCRIPTION,
                correlationId: retryTrace.correlationId,
                message,
                attemptsMade: retryTrace.attemptNumber,
                maxAttempts: retryTrace.maxAttempts,
                retryable: classification.retryable,
                category: classification.category,
                payload: job.data as Record<string, unknown>,
                capturedAt: new Date().toISOString(),
            });

            emitFailedUpdate(
                this.eventsGateway,
                projectId,
                JobType.TRANSCRIPTION,
                message,
            );

            throw error;
        }
    }
}
