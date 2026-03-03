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

@Processor(QUEUE_NAMES.VIDEO_RENDER, { lockDuration: 600000 })
export class VideoRenderProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoRenderProcessor.name);
  private readonly useMock = false;
  private readonly mockVideoUrl =
    process.env.MOCK_VIDEO_URL ||
    '/output/videos/mock-video.mp4';

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
    const trace = getJobTraceContext(job, JobType.RENDER_VIDEO, projectId, jobId, correlationId);
    const circuitKey = 'video-render';

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

      const circuitDecision = this.circuitBreaker.canExecute(circuitKey);
      if (!circuitDecision.allowed) {
        throw new Error(`Circuit open for ${circuitKey}. Retry after ${circuitDecision.retryAfterMs}ms`);
      }

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
      this.circuitBreaker.recordSuccess(circuitKey);

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
      const retryTrace = getJobTraceContext(
        job,
        JobType.RENDER_VIDEO,
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
        sourceQueue: QUEUE_NAMES.VIDEO_RENDER,
        projectId,
        jobId,
        jobType: JobType.RENDER_VIDEO,
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
        JobType.RENDER_VIDEO,
        message,
      );

      throw error;
    }
  }
}
