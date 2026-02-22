import { Job } from 'bullmq';
import { JobType } from '../dto';
import { JobsService } from '../jobs.service';
import { EventsGateway } from '../../events';

export interface RetryState {
  attemptNumber: number;
  maxAttempts: number;
  hasRemainingAttempts: boolean;
}

export function getRetryState(job: Job): RetryState {
  const maxAttempts =
    typeof job.opts.attempts === 'number' && job.opts.attempts > 0
      ? job.opts.attempts
      : 1;
  const attemptNumber = job.attemptsMade + 1;

  return {
    attemptNumber,
    maxAttempts,
    hasRemainingAttempts: attemptNumber < maxAttempts,
  };
}

export interface JobTraceContext extends RetryState {
  projectId: string;
  jobId: string;
  jobType: string;
  prefix: string;
}

export function getJobTraceContext(
  job: Job,
  jobType: string,
  projectId?: string,
  jobId?: string,
): JobTraceContext {
  const retry = getRetryState(job);
  const resolvedProjectId = projectId || 'unknown-project';
  const resolvedJobId = jobId || 'unknown-job';

  return {
    ...retry,
    projectId: resolvedProjectId,
    jobId: resolvedJobId,
    jobType,
    prefix: `[project=${resolvedProjectId} jobType=${jobType} jobId=${resolvedJobId} attempt=${retry.attemptNumber}/${retry.maxAttempts}]`,
  };
}

export function buildRetryCurrentStep(retry: RetryState): string {
  return `Temporary error. Retrying (${retry.attemptNumber}/${retry.maxAttempts})...`;
}

export function buildErrorCurrentStep(message: string): string {
  return `Error: ${message}`;
}

type ScriptNormalizedStatus = 'success' | 'degraded' | 'failed' | 'unknown';

export interface ScriptResultAssessment {
  normalizedStatus: ScriptNormalizedStatus;
  rawStatus: string | null;
  message: string | null;
}

function extractScriptMessage(result: unknown): string | null {
  if (!result || typeof result !== 'object') {
    return null;
  }

  const candidateKeys = ['message', 'warning', 'error', 'details'] as const;
  for (const key of candidateKeys) {
    const value = (result as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

export function assessScriptResult(result: unknown): ScriptResultAssessment {
  const rawStatus =
    result && typeof result === 'object' && typeof (result as Record<string, unknown>).status === 'string'
      ? String((result as Record<string, unknown>).status).trim().toLowerCase()
      : null;
  const message = extractScriptMessage(result);
  const successFlag =
    result && typeof result === 'object' && typeof (result as Record<string, unknown>).success === 'boolean'
      ? Boolean((result as Record<string, unknown>).success)
      : undefined;

  if (rawStatus === 'failed' || successFlag === false) {
    return {
      normalizedStatus: 'failed',
      rawStatus,
      message: message || 'Script reported failed status',
    };
  }

  if (rawStatus === 'degraded') {
    return {
      normalizedStatus: 'degraded',
      rawStatus,
      message: message || 'Script completed with degraded output',
    };
  }

  if (rawStatus === 'success' || successFlag === true) {
    return {
      normalizedStatus: 'success',
      rawStatus,
      message,
    };
  }

  return {
    normalizedStatus: 'unknown',
    rawStatus,
    message,
  };
}

type RealtimeJobStatus = 'processing' | 'completed' | 'failed';

interface EmitJobUpdateParams {
  eventsGateway: EventsGateway;
  projectId: string;
  jobType: JobType;
  status: RealtimeJobStatus;
  progress: number;
  currentStep: string;
}

export function emitJobUpdate({
  eventsGateway,
  projectId,
  jobType,
  status,
  progress,
  currentStep,
}: EmitJobUpdateParams): void {
  eventsGateway.emitJobUpdate(projectId, {
    jobType,
    status,
    progress,
    currentStep,
  });
}

export function emitProcessingUpdate(
  eventsGateway: EventsGateway,
  projectId: string,
  jobType: JobType,
  progress: number,
  currentStep: string,
): void {
  emitJobUpdate({
    eventsGateway,
    projectId,
    jobType,
    status: 'processing',
    progress,
    currentStep,
  });
}

export function emitCompletedUpdate(
  eventsGateway: EventsGateway,
  projectId: string,
  jobType: JobType,
  currentStep: string,
): void {
  emitJobUpdate({
    eventsGateway,
    projectId,
    jobType,
    status: 'completed',
    progress: 100,
    currentStep,
  });
}

export function emitFailedUpdate(
  eventsGateway: EventsGateway,
  projectId: string,
  jobType: JobType,
  message: string,
): void {
  emitJobUpdate({
    eventsGateway,
    projectId,
    jobType,
    status: 'failed',
    progress: 0,
    currentStep: buildErrorCurrentStep(message),
  });
}

interface UpdateProgressAndEmitParams {
  jobsService: JobsService;
  eventsGateway: EventsGateway;
  jobId: string;
  projectId: string;
  jobType: JobType;
  progress: number;
  currentStep: string;
}

export async function updateProgressAndEmit({
  jobsService,
  eventsGateway,
  jobId,
  projectId,
  jobType,
  progress,
  currentStep,
}: UpdateProgressAndEmitParams): Promise<void> {
  await jobsService.updateProgress(jobId, progress, currentStep);
  emitProcessingUpdate(eventsGateway, projectId, jobType, progress, currentStep);
}
