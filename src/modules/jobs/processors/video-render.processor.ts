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

@Processor(QUEUE_NAMES.VIDEO_RENDER, { lockDuration: 600000 })
export class VideoRenderProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoRenderProcessor.name);
  private readonly useMock = false;
  private readonly mockVideoUrl =
    process.env.MOCK_VIDEO_URL ||
    '/output/videos/mock-video.mp4';

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
    const trace = getJobTraceContext(job, JobType.RENDER_VIDEO, projectId, jobId);

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
        JobType.RENDER_VIDEO,
        0,
        'Starting video render...',
      );

      if (this.useMock) {
        this.logger.log(`${trace.prefix} using mock video render`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
        await this.jobsService.markAsCompleted(jobId, {
          videoUrl: this.mockVideoUrl,
        });
        return { success: true };
      }

      this.logger.log(`${trace.prefix} executing FFmpeg render script`);

      await updateProgressAndEmit({
        jobsService: this.jobsService,
        eventsGateway: this.eventsGateway,
        jobId,
        projectId,
        jobType: JobType.RENDER_VIDEO,
        progress: 10,
        currentStep: 'Rendering video with FFmpeg...',
      });

      const result = await this.pythonRunnerService.runScript('render_video.py', [projectId]);
      const assessment = assessScriptResult(result);
      if (assessment.normalizedStatus === 'failed') {
        throw new Error(assessment.message || 'render_video.py returned failed status');
      }
      if (assessment.normalizedStatus === 'unknown' && assessment.rawStatus) {
        this.logger.warn(
          `${trace.prefix} script returned non-standard status "${assessment.rawStatus}", treating as success`,
        );
      }
      const completionStep =
        assessment.normalizedStatus === 'degraded'
          ? `Video render completed with fallback${assessment.message ? `: ${assessment.message}` : ''}`
          : 'Video render complete';

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
        JobType.RENDER_VIDEO,
        `${completionStep}!`,
      );

      // Avanzar automáticamente al siguiente job del pipeline
      await this.jobsService.advancePipeline(projectId);

      this.logger.log(`${trace.prefix} pipeline stage completed`);
      return result;

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryTrace = getJobTraceContext(job, JobType.RENDER_VIDEO, projectId, jobId);

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
          jobType: JobType.RENDER_VIDEO,
          progress: 0,
          currentStep: retryStep,
        });
        throw error;
      }

      this.logger.error(`${retryTrace.prefix} final failure: ${message}`);
      this.sentryService.captureException(error, {
        tags: {
          component: 'job_processor',
          jobType: JobType.RENDER_VIDEO,
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
        JobType.RENDER_VIDEO,
        message,
      );

      throw error;
    }
  }
}
