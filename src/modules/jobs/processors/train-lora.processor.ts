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

@Processor(QUEUE_NAMES.TRAIN_LORA, { lockDuration: 7200000 })
export class TrainLoraProcessor extends WorkerHost {
  private readonly logger = new Logger(TrainLoraProcessor.name);

  constructor(
    private readonly jobsService: JobsService,
    private readonly pythonRunnerService: PythonRunnerService,
    private readonly eventsGateway: EventsGateway,
    private readonly sentryService: SentryService,
  ) {
    super();
  }

  async process(
    job: Job<{ jobId: string; projectId: string; style?: string }>,
  ): Promise<any> {
    const { jobId, projectId, style } = job.data || {};
    const trace = getJobTraceContext(job, JobType.TRAIN_LORA, projectId, jobId);

    if (!jobId || !projectId || !style) {
      this.logger.warn(
        `${trace.prefix} skipping TRAIN_LORA job (missing data, style=${style || 'missing'})`,
      );
      return { skipped: true, reason: 'missing job data' };
    }

    this.logger.log(
      `${trace.prefix} processing started (style=${style})`,
    );

    try {
      await this.jobsService.markAsProcessing(jobId, this.worker.id);

      emitProcessingUpdate(
        this.eventsGateway,
        projectId,
        JobType.TRAIN_LORA,
        0,
        `Starting LoRA training for style "${style}"...`,
      );

      await updateProgressAndEmit({
        jobsService: this.jobsService,
        eventsGateway: this.eventsGateway,
        jobId,
        projectId,
        jobType: JobType.TRAIN_LORA,
        progress: 15,
        currentStep: `Preparing dataset for "${style}"`,
      });

      const result = await this.pythonRunnerService.runScript('train_style_lora.py', [
        style,
      ]);
      const assessment = assessScriptResult(result);
      if (assessment.normalizedStatus === 'failed') {
        throw new Error(assessment.message || 'train_style_lora.py returned failed status');
      }
      if (assessment.normalizedStatus === 'unknown' && assessment.rawStatus) {
        this.logger.warn(
          `${trace.prefix} script returned non-standard status "${assessment.rawStatus}", treating as success`,
        );
      }
      const completionStep =
        assessment.normalizedStatus === 'degraded'
          ? `LoRA training completed with fallback${assessment.message ? `: ${assessment.message}` : ''}`
          : `LoRA training complete for "${style}"`;

      await updateProgressAndEmit({
        jobsService: this.jobsService,
        eventsGateway: this.eventsGateway,
        jobId,
        projectId,
        jobType: JobType.TRAIN_LORA,
        progress: 90,
        currentStep: `Applying trained LoRA config for "${style}"`,
      });

      const loraFilename =
        typeof result?.loraFilename === 'string' ? result.loraFilename : undefined;
      const loraPath = typeof result?.loraPath === 'string' ? result.loraPath : undefined;
      const likesUsed =
        typeof result?.likesCount === 'number' ? result.likesCount : undefined;

      if (loraFilename && loraPath) {
        await this.jobsService.updateStyleLoraConfig(style, {
          loraFilename,
          loraPath,
          likesUsed,
        });
      }

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
        JobType.TRAIN_LORA,
        completionStep,
      );

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const retryTrace = getJobTraceContext(job, JobType.TRAIN_LORA, projectId, jobId);

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
          jobType: JobType.TRAIN_LORA,
          progress: 0,
          currentStep: retryStep,
        });
        throw error;
      }

      this.logger.error(`${retryTrace.prefix} final failure: ${message}`);
      this.sentryService.captureException(error, {
        tags: {
          component: 'job_processor',
          jobType: JobType.TRAIN_LORA,
          stage: 'final_failure',
        },
        extra: {
          projectId,
          jobId,
          style,
          attemptsMade: retryTrace.attemptNumber,
          maxAttempts: retryTrace.maxAttempts,
          message,
        },
      });
      await this.jobsService.markAsFailed(jobId, message);

      emitFailedUpdate(
        this.eventsGateway,
        projectId,
        JobType.TRAIN_LORA,
        message,
      );

      throw error;
    }
  }
}
