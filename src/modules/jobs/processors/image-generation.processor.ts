import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { JobsService } from '../jobs.service';
import { JobType } from '../dto';
import { QUEUE_NAMES } from '../../queue';
import { PythonRunnerService, ProgressEvent } from '../../../common/services/python-runner.service';
import { EventsGateway } from '../../events';
import { ProjectsService } from '../../projects/projects.service';
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

@Processor(QUEUE_NAMES.IMAGE_GENERATION, { lockDuration: 3600000 })
export class ImageGenerationProcessor extends WorkerHost {
  private readonly logger = new Logger(ImageGenerationProcessor.name);

  constructor(
    private readonly jobsService: JobsService,
    private readonly pythonRunner: PythonRunnerService,
    private readonly eventsGateway: EventsGateway,
    private readonly projectsService: ProjectsService,
    private readonly sentryService: SentryService,
  ) {
    super();
  }

  async process(job: Job<{ jobId: string; projectId: string }>): Promise<any> {
    const { jobId, projectId } = job.data || {};
    const trace = getJobTraceContext(job, JobType.GENERATE_IMAGES, projectId, jobId);

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
        JobType.GENERATE_IMAGES,
        0,
        'Starting image generation...',
      );

      // 🧠 AI LEARNING: Get prompt optimization based on user feedback
      const optimization = await this.projectsService.getPromptOptimization(projectId);
      if (optimization.confidence > 0) {
        this.logger.log(`${trace.prefix} AI learning applied (confidence: ${Math.round(optimization.confidence * 100)}%)`);
        if (optimization.qualityBoost) this.logger.log(`${trace.prefix} quality boost: ${optimization.qualityBoost}`);
        if (optimization.negativeBoost) this.logger.log(`${trace.prefix} negative boost: ${optimization.negativeBoost}`);
      }

      // Run Python script with progress callback
      // Pass optimization as JSON argument
      const optimizationArg = JSON.stringify(optimization);
      const result = await this.pythonRunner.runScriptWithProgress(
        'generate_images.py',
        [projectId, jobId, optimizationArg],
        (event: ProgressEvent) => {
          // Debug: Log every event received from Python script
          this.logger.debug(`${trace.prefix} event received: type=${event.type}, data=${JSON.stringify(event.data)}`);

          // Emit real-time events via WebSocket
          if (event.type === 'image_generated') {
            this.logger.debug(`${trace.prefix} image generated: scene ${event.data.sceneIndex}/${event.data.totalScenes}`);
            this.eventsGateway.emitImageGenerated(projectId, event.data);
          } else if (event.type === 'progress') {
            const progress = event.data.progress || 0;
            const message = event.data.message || 'Generating images...';
            this.logger.debug(`${trace.prefix} progress ${progress}% - ${message}`);

            // Update progress and emit in a single shared helper.
            updateProgressAndEmit({
              jobsService: this.jobsService,
              eventsGateway: this.eventsGateway,
              jobId,
              projectId,
              jobType: JobType.GENERATE_IMAGES,
              progress,
              currentStep: message,
            }).catch(err => {
              this.logger.warn(`${trace.prefix} failed to update DB progress: ${err.message}`);
            });
          }
        },
      );
      const assessment = assessScriptResult(result);
      if (assessment.normalizedStatus === 'failed') {
        throw new Error(assessment.message || 'generate_images.py returned failed status');
      }
      if (assessment.normalizedStatus === 'unknown' && assessment.rawStatus) {
        this.logger.warn(
          `${trace.prefix} script returned non-standard status "${assessment.rawStatus}", treating as success`,
        );
      }
      const completionStep =
        assessment.normalizedStatus === 'degraded'
          ? `Image generation completed with fallback${assessment.message ? `: ${assessment.message}` : ''}`
          : 'All images generated';

      this.logger.log(`${trace.prefix} script completed successfully`);
      if (assessment.normalizedStatus === 'degraded') {
        this.logger.warn(
          `${trace.prefix} script completed in DEGRADED mode: ${assessment.message || 'fallback output used'}`,
        );
      }
      this.logger.log(`${trace.prefix} output: ${JSON.stringify(result)}`);

      await this.jobsService.updateProgress(jobId, 100, completionStep);
      await this.jobsService.markAsCompleted(jobId, result);

      emitCompletedUpdate(
        this.eventsGateway,
        projectId,
        JobType.GENERATE_IMAGES,
        `${completionStep}!`,
      );

      // Avanzar automáticamente al siguiente job del pipeline
      await this.jobsService.advancePipeline(projectId);

      this.logger.log(`${trace.prefix} pipeline stage completed`);
      return result;

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryTrace = getJobTraceContext(job, JobType.GENERATE_IMAGES, projectId, jobId);

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
          jobType: JobType.GENERATE_IMAGES,
          progress: 0,
          currentStep: retryStep,
        });
        throw error;
      }

      this.logger.error(`${retryTrace.prefix} final failure: ${message}`);
      this.sentryService.captureException(error, {
        tags: {
          component: 'job_processor',
          jobType: JobType.GENERATE_IMAGES,
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
        JobType.GENERATE_IMAGES,
        message,
      );

      throw error;
    }
  }
}
