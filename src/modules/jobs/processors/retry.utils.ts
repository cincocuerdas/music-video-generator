import { Job } from 'bullmq';
import { JobType } from '../dto';
import { JobsService } from '../jobs.service';
import { EventsGateway } from '../../events';

export interface RetryState {
  attemptNumber: number;
  maxAttempts: number;
  hasRemainingAttempts: boolean;
}

export interface ErrorClassification {
  category: 'transient' | 'permanent' | 'unknown';
  retryable: boolean;
  reason: string;
}

export interface ScriptContractValidation {
  valid: boolean;
  issues: string[];
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
  correlationId: string;
  prefix: string;
}

export function getJobTraceContext(
  job: Job,
  jobType: string,
  projectId?: string,
  jobId?: string,
  correlationId?: string,
): JobTraceContext {
  const retry = getRetryState(job);
  const resolvedProjectId = projectId || 'unknown-project';
  const resolvedJobId = jobId || 'unknown-job';
  const resolvedCorrelationId =
    correlationId ||
    (job.data &&
    typeof job.data === 'object' &&
    typeof (job.data as Record<string, unknown>).correlationId === 'string'
      ? ((job.data as Record<string, unknown>).correlationId as string)
      : `${resolvedProjectId}:${resolvedJobId}`);

  return {
    ...retry,
    projectId: resolvedProjectId,
    jobId: resolvedJobId,
    jobType,
    correlationId: resolvedCorrelationId,
    prefix: `[cid=${resolvedCorrelationId} project=${resolvedProjectId} jobType=${jobType} jobId=${resolvedJobId} attempt=${retry.attemptNumber}/${retry.maxAttempts}]`,
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
  contractValid: boolean;
  contractIssues: string[];
}

export function classifyJobError(error: unknown): ErrorClassification {
  const message = (error instanceof Error ? error.message : String(error || 'unknown error')).trim();
  const normalized = message.toLowerCase();

  const permanentPatterns = [
    /no youtube url found/,
    /missing youtube url/,
    /invalid youtube url/,
    /invalid or expired token/,
    /missing bearer token/,
    /not found/,
    /\bstatus code 40[0-9]\b/,
    /\bstatus code 404\b/,
    /\bstatus code 422\b/,
    /schema validation failed/,
    /invalid result_json contract/,
  ];

  const transientPatterns = [
    /timeout/,
    /timed out/,
    /etimedout/,
    /econnreset/,
    /econnrefused/,
    /ehostunreach/,
    /socket hang up/,
    /\bstatus code 429\b/,
    /\bstatus code 5\d\d\b/,
    /service unavailable/,
    /temporarily unavailable/,
    /rate limit/,
    /circuit open/,
    /retry/i,
  ];

  if (permanentPatterns.some((pattern) => pattern.test(normalized))) {
    return {
      category: 'permanent',
      retryable: false,
      reason: message || 'Permanent error',
    };
  }

  if (transientPatterns.some((pattern) => pattern.test(normalized))) {
    return {
      category: 'transient',
      retryable: true,
      reason: message || 'Transient error',
    };
  }

  return {
    category: 'unknown',
    retryable: true,
    reason: message || 'Unknown error',
  };
}

export function shouldRetryError(error: unknown, retryState: RetryState): boolean {
  if (!retryState.hasRemainingAttempts) {
    return false;
  }
  const classification = classifyJobError(error);
  return classification.retryable;
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

export function validateScriptResultContract(result: unknown): ScriptContractValidation {
  if (!result || typeof result !== 'object') {
    return {
      valid: false,
      issues: ['result must be a JSON object'],
    };
  }

  const payload = result as Record<string, unknown>;
  const issues: string[] = [];
  const status = payload.status;
  const success = payload.success;
  const degraded = payload.degraded;
  const degradedReasons = payload.degradedReasons;
  const normalizedStatus = typeof status === 'string' ? status.toLowerCase().trim() : '';

  if (typeof status !== 'string' || !['success', 'degraded', 'failed'].includes(status.toLowerCase())) {
    issues.push('status must be one of success|degraded|failed');
  }
  if (typeof success !== 'boolean') {
    issues.push('success must be boolean');
  }
  if (typeof degraded !== 'boolean') {
    issues.push('degraded must be boolean');
  }
  if (!Array.isArray(degradedReasons)) {
    issues.push('degradedReasons must be an array');
  }
  if (normalizedStatus === 'failed' || success === false) {
    const errorCode = payload.errorCode;
    if (typeof errorCode !== 'string' || !errorCode.trim()) {
      issues.push('errorCode must be a non-empty string when status=failed or success=false');
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

export function assessScriptResult(result: unknown): ScriptResultAssessment {
  const contract = validateScriptResultContract(result);
  const rawStatus =
    result && typeof result === 'object' && typeof (result as Record<string, unknown>).status === 'string'
      ? String((result as Record<string, unknown>).status).trim().toLowerCase()
      : null;
  const message = extractScriptMessage(result);
  const successFlag =
    result && typeof result === 'object' && typeof (result as Record<string, unknown>).success === 'boolean'
      ? Boolean((result as Record<string, unknown>).success)
      : undefined;

  if (!contract.valid) {
    return {
      normalizedStatus: 'failed',
      rawStatus,
      message: `Invalid RESULT_JSON contract: ${contract.issues.join(', ')}`,
      contractValid: false,
      contractIssues: contract.issues,
    };
  }

  if (rawStatus === 'failed' || successFlag === false) {
    return {
      normalizedStatus: 'failed',
      rawStatus,
      message: message || 'Script reported failed status',
      contractValid: true,
      contractIssues: [],
    };
  }

  if (rawStatus === 'degraded') {
    return {
      normalizedStatus: 'degraded',
      rawStatus,
      message: message || 'Script completed with degraded output',
      contractValid: true,
      contractIssues: [],
    };
  }

  if (rawStatus === 'success' || successFlag === true) {
    return {
      normalizedStatus: 'success',
      rawStatus,
      message,
      contractValid: true,
      contractIssues: [],
    };
  }

  return {
    normalizedStatus: 'unknown',
    rawStatus,
    message,
    contractValid: true,
    contractIssues: [],
  };
}

function collectResultStrings(result: unknown): string[] {
  if (!result || typeof result !== 'object') {
    return [];
  }

  const payload = result as Record<string, unknown>;
  const values: string[] = [];
  const pushIfString = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) {
      values.push(value.trim().toLowerCase());
    }
  };

  pushIfString(payload.message);
  pushIfString(payload.warning);
  pushIfString(payload.error);
  pushIfString(payload.details);
  pushIfString(payload._fallbackReason);

  if (Array.isArray(payload.degradedReasons)) {
    for (const reason of payload.degradedReasons) {
      pushIfString(reason);
    }
  }

  return values;
}

export function isQuotaDegradedResult(result: unknown): boolean {
  const lowered = collectResultStrings(result);
  if (!lowered.length) {
    return false;
  }

  const hasQuotaSignal = lowered.some((value) =>
    value.includes('status code 429') ||
    value.includes('http 429') ||
    value.includes('resource_exhausted') ||
    value.includes('quota exceeded') ||
    value.includes('rate limit') ||
    value.includes('too many requests'),
  );

  return hasQuotaSignal;
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

