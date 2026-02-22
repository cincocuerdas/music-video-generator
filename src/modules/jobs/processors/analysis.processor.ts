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

@Processor(QUEUE_NAMES.ANALYSIS)
export class AnalysisProcessor extends WorkerHost {
  private readonly logger = new Logger(AnalysisProcessor.name);
  private readonly useMock = false;

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
    const trace = getJobTraceContext(job, JobType.ANALYZE_LYRICS, projectId, jobId);

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
        JobType.ANALYZE_LYRICS,
        0,
        'Starting lyrics analysis...',
      );

      if (this.useMock) {
        this.logger.log('Using mock analysis');
        await new Promise((resolve) => setTimeout(resolve, 3000));
        return { mock: true };
      }

      this.logger.log(`${trace.prefix} executing python script`);

      await updateProgressAndEmit({
        jobsService: this.jobsService,
        eventsGateway: this.eventsGateway,
        jobId,
        projectId,
        jobType: JobType.ANALYZE_LYRICS,
        progress: 20,
        currentStep: 'Analyzing lyrics with AI...',
      });

      const result = await this.pythonRunnerService.runScript('analyze_lyrics.py', [projectId]);
      const assessment = assessScriptResult(result);
      if (assessment.normalizedStatus === 'failed') {
        throw new Error(assessment.message || 'analyze_lyrics.py returned failed status');
      }
      if (assessment.normalizedStatus === 'unknown' && assessment.rawStatus) {
        this.logger.warn(
          `${trace.prefix} script returned non-standard status "${assessment.rawStatus}", treating as success`,
        );
      }
      const completionStep =
        assessment.normalizedStatus === 'degraded'
          ? `Analysis completed with fallback${assessment.message ? `: ${assessment.message}` : ''}`
          : 'Analysis complete';

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
        JobType.ANALYZE_LYRICS,
        `${completionStep}!`,
      );

      // Avanzar automáticamente al siguiente job del pipeline
      await this.jobsService.advancePipeline(projectId);

      this.logger.log(`${trace.prefix} pipeline stage completed`);
      return result;

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryTrace = getJobTraceContext(job, JobType.ANALYZE_LYRICS, projectId, jobId);

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
          jobType: JobType.ANALYZE_LYRICS,
          progress: 0,
          currentStep: retryStep,
        });
        throw error;
      }

      this.logger.error(`${retryTrace.prefix} final failure: ${message}`);
      this.sentryService.captureException(error, {
        tags: {
          component: 'job_processor',
          jobType: JobType.ANALYZE_LYRICS,
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
        JobType.ANALYZE_LYRICS,
        message,
      );

      throw error;
    }
  }
}
