import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { JobsService } from '../jobs.service';
import { DeadLetterOrchestratorService } from '../services/dead-letter-orchestrator.service';
import { JobType } from '../dto';
import { QUEUE_NAMES } from '../../queue';
import { CircuitBreakerService, PythonRunnerService } from '../../../common/services';
import type { YouTubeDownloadResult } from '../../../common/services/python-runner.types';
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

@Processor(QUEUE_NAMES.YOUTUBE_DOWNLOAD)
export class YouTubeDownloadProcessor extends WorkerHost {
    private readonly logger = new Logger(YouTubeDownloadProcessor.name);

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
        const trace = getJobTraceContext(job, JobType.YOUTUBE_DOWNLOAD, projectId, jobId, correlationId);
        const circuitKey = 'youtube-download';

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
                JobType.YOUTUBE_DOWNLOAD,
                0,
                'Starting YouTube download...',
            );

            await updateProgressAndEmit({
                jobsService: this.jobsService,
                eventsGateway: this.eventsGateway,
                jobId,
                projectId,
                jobType: JobType.YOUTUBE_DOWNLOAD,
                progress: 10,
                currentStep: 'Downloading audio from YouTube...',
            });

            const circuitDecision = this.circuitBreaker.canExecute(circuitKey);
            if (!circuitDecision.allowed) {
                throw new Error(
                    `Circuit open for ${circuitKey}. Retry after ${circuitDecision.retryAfterMs}ms`,
                );
            }

            // Call Python script to download audio and thumbnail
            const result = await this.pythonRunnerService.runScript<YouTubeDownloadResult>('youtube_download.py', [projectId]);
            const assessment = assessScriptResult(result);

            if (assessment.normalizedStatus === 'failed') {
                throw new Error(assessment.message || 'youtube_download.py returned failed status');
            }
            if (assessment.normalizedStatus === 'unknown' && assessment.rawStatus) {
                this.logger.warn(
                    `${trace.prefix} script returned non-standard status "${assessment.rawStatus}", treating as success`,
                );
            }

            const completionStep =
                assessment.normalizedStatus === 'degraded'
                    ? `Download completed with fallback${assessment.message ? `: ${assessment.message}` : ''}`
                    : 'Download complete';

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
                JobType.YOUTUBE_DOWNLOAD,
                `${completionStep}!`,
            );

            // Advance to next job (transcription)
            await this.jobsService.advancePipeline(projectId);

            return result;

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const retryTrace = getJobTraceContext(
                job,
                JobType.YOUTUBE_DOWNLOAD,
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
                    jobType: JobType.YOUTUBE_DOWNLOAD,
                    progress: 0,
                    currentStep: retryStep,
                });
                throw error;
            }

            this.logger.error(`${retryTrace.prefix} final failure: ${message}`);
            this.sentryService.captureException(error, {
                tags: {
                    component: 'job_processor',
                    jobType: JobType.YOUTUBE_DOWNLOAD,
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
                sourceQueue: QUEUE_NAMES.YOUTUBE_DOWNLOAD,
                projectId,
                jobId,
                jobType: JobType.YOUTUBE_DOWNLOAD,
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
                JobType.YOUTUBE_DOWNLOAD,
                message,
            );

            throw error;
        }
    }
}
