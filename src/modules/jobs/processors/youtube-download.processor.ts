import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { JobsService } from '../jobs.service';
import { JobType } from '../dto';
import { QUEUE_NAMES } from '../../queue';
import { PythonRunnerService } from '../../../common/services';
import { EventsGateway } from '../../events';
import { SentryService } from '../../observability';
import {
    assessScriptResult,
    buildRetryCurrentStep,
    emitCompletedUpdate,
    emitFailedUpdate,
    emitProcessingUpdate,
    getJobTraceContext,
    updateProgressAndEmit,
} from './retry.utils';

@Processor(QUEUE_NAMES.YOUTUBE_DOWNLOAD)
export class YouTubeDownloadProcessor extends WorkerHost {
    private readonly logger = new Logger(YouTubeDownloadProcessor.name);

    constructor(
        private readonly jobsService: JobsService,
        private readonly pythonRunnerService: PythonRunnerService,
        private readonly eventsGateway: EventsGateway,
        private readonly sentryService: SentryService,
    ) {
        super();
    }

    async process(job: Job<{ jobId: string; projectId: string }>): Promise<any> {
        const { jobId, projectId } = job.data || {};
        const trace = getJobTraceContext(job, JobType.YOUTUBE_DOWNLOAD, projectId, jobId);

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

            // Call Python script to download audio and thumbnail
            const result = await this.pythonRunnerService.runScript('youtube_download.py', [projectId]);
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
            const retryTrace = getJobTraceContext(job, JobType.YOUTUBE_DOWNLOAD, projectId, jobId);

            if (retryTrace.hasRemainingAttempts) {
                const retryStep = buildRetryCurrentStep(retryTrace);
                this.logger.warn(
                    `${retryTrace.prefix} temporary failure, retry scheduled: ${message}`,
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
                    attemptsMade: retryTrace.attemptNumber,
                    maxAttempts: retryTrace.maxAttempts,
                    message,
                },
            });
            await this.jobsService.markAsFailed(jobId, message);

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
