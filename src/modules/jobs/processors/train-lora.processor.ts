import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { JobsService } from '../jobs.service';
import { DeadLetterOrchestratorService } from '../services/dead-letter-orchestrator.service';
import { JobType } from '../dto';
import { QUEUE_NAMES } from '../../queue';
import { CircuitBreakerService, PythonRunnerService } from '../../../common/services';
import type { TrainLoraResult } from '../../../common/services/python-runner.types';
import { EventsGateway } from '../../events';
import { SentryService } from '../../observability';
import { JobConcurrencyService } from '../services/job-concurrency.service';
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

@Processor(QUEUE_NAMES.TRAIN_LORA, { lockDuration: 7200000 })
export class TrainLoraProcessor extends WorkerHost {
  private readonly logger = new Logger(TrainLoraProcessor.name);

  constructor(
    private readonly jobsService: JobsService,
    private readonly deadLetterOrchestrator: DeadLetterOrchestratorService,
    private readonly pythonRunnerService: PythonRunnerService,
    private readonly circuitBreaker: CircuitBreakerService,
    private readonly eventsGateway: EventsGateway,
    private readonly jobConcurrencyService: JobConcurrencyService,
    private readonly sentryService: SentryService,
  ) {
    super();
  }

  async process(
    job: Job<{ jobId: string; projectId: string; style?: string; correlationId?: string }>,
  ): Promise<any> {
    const { jobId, projectId, style, correlationId } = job.data || {};
    const trace = getJobTraceContext(job, JobType.TRAIN_LORA, projectId, jobId, correlationId);
    const circuitKey = 'train-lora';

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

      const circuitDecision = this.circuitBreaker.canExecute(circuitKey);
      if (!circuitDecision.allowed) {
        throw new Error(`Circuit open for ${circuitKey}. Retry after ${circuitDecision.retryAfterMs}ms`);
      }

      const result = await this.jobConcurrencyService.runWithLimits(
        JobType.TRAIN_LORA,
        () =>
          this.pythonRunnerService.runScript<TrainLoraResult>('train_style_lora.py', [
            style,
          ]),
      );
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
      this.circuitBreaker.recordSuccess(circuitKey);

      emitCompletedUpdate(
        this.eventsGateway,
        projectId,
        JobType.TRAIN_LORA,
        completionStep,
      );

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const retryTrace = getJobTraceContext(
        job,
        JobType.TRAIN_LORA,
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
        sourceQueue: QUEUE_NAMES.TRAIN_LORA,
        projectId,
        jobId,
        jobType: JobType.TRAIN_LORA,
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
        JobType.TRAIN_LORA,
        message,
      );

      throw error;
    }
  }
}
