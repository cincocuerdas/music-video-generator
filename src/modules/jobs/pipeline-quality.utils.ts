import { JobStatus, JobType, ProjectStatus } from '@prisma/client';

const CORE_PIPELINE_JOB_TYPES = new Set<JobType>([
  JobType.YOUTUBE_DOWNLOAD,
  JobType.TRANSCRIPTION,
  JobType.ANALYZE_LYRICS,
  JobType.GENERATE_IMAGES,
  JobType.RENDER_VIDEO,
  JobType.FINALIZE,
]);

export type ProjectPipelineStatus =
  | 'draft'
  | 'processing'
  | 'success'
  | 'degraded'
  | 'failed'
  | 'cancelled';

export interface PipelineQualitySummary {
  degraded: boolean;
  degradedReasons: string[];
  degradedReasonCodes: string[];
  hasFailedJob: boolean;
}

interface JobLikeForQuality {
  type: JobType;
  status: JobStatus;
  outputData?: unknown;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
}

function normalizeReasonToken(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'unspecified';
}

function extractFirstDegradedMessage(payload: Record<string, unknown>): string {
  return (
    (typeof payload.message === 'string' && payload.message.trim()) ||
    (typeof payload.warning === 'string' && payload.warning.trim()) ||
    (typeof payload.error === 'string' && payload.error.trim()) ||
    (typeof payload.details === 'string' && payload.details.trim()) ||
    'fallback output'
  );
}

export function extractDegradedReasonCodesFromOutputData(
  outputData: unknown,
  jobType?: JobType,
): string[] {
  if (!outputData || typeof outputData !== 'object') {
    return [];
  }

  const payload = outputData as Record<string, unknown>;
  const normalizedStatus =
    typeof payload.status === 'string' ? payload.status.trim().toLowerCase() : '';
  const degradedFlag = payload.degraded === true || normalizedStatus === 'degraded';
  if (!degradedFlag) {
    return [];
  }

  const prefix = jobType ? `${jobType.toLowerCase()}.` : '';
  const reasonsFromArray = toStringArray(payload.degradedReasons);
  if (reasonsFromArray.length > 0) {
    return reasonsFromArray.map((reason) => `${prefix}${normalizeReasonToken(reason)}`);
  }

  return [`${prefix}${normalizeReasonToken(extractFirstDegradedMessage(payload))}`];
}

export function isCorePipelineJob(type: JobType): boolean {
  return CORE_PIPELINE_JOB_TYPES.has(type);
}

export function extractDegradedReasonsFromOutputData(
  outputData: unknown,
  jobType?: JobType,
): string[] {
  if (!outputData || typeof outputData !== 'object') {
    return [];
  }

  const payload = outputData as Record<string, unknown>;
  const normalizedStatus =
    typeof payload.status === 'string' ? payload.status.trim().toLowerCase() : '';
  const degradedFlag = payload.degraded === true || normalizedStatus === 'degraded';
  if (!degradedFlag) {
    return [];
  }

  const prefix = jobType ? `${jobType}: ` : '';
  const reasonsFromArray = toStringArray(payload.degradedReasons);
  if (reasonsFromArray.length > 0) {
    return reasonsFromArray.map((reason) => `${prefix}${reason}`);
  }

  const firstMessage = extractFirstDegradedMessage(payload);

  return [`${prefix}${firstMessage}`];
}

export function summarizePipelineQuality(jobs: JobLikeForQuality[]): PipelineQualitySummary {
  const summary = jobs.reduce<PipelineQualitySummary>(
    (acc, job) => {
      if (!isCorePipelineJob(job.type)) {
        return acc;
      }

      if (job.status === JobStatus.FAILED) {
        acc.hasFailedJob = true;
      }

      const degradedReasons = extractDegradedReasonsFromOutputData(job.outputData, job.type);
      if (degradedReasons.length > 0) {
        acc.degraded = true;
        acc.degradedReasons.push(...degradedReasons);
        acc.degradedReasonCodes.push(
          ...extractDegradedReasonCodesFromOutputData(job.outputData, job.type),
        );
      }

      return acc;
    },
    {
      degraded: false,
      degradedReasons: [],
      degradedReasonCodes: [],
      hasFailedJob: false,
    },
  );

  summary.degradedReasons = Array.from(new Set(summary.degradedReasons)).slice(0, 50);
  summary.degradedReasonCodes = Array.from(new Set(summary.degradedReasonCodes)).slice(0, 50);
  return summary;
}

export function deriveProjectPipelineStatus(
  projectStatus: ProjectStatus,
  quality: PipelineQualitySummary,
): ProjectPipelineStatus {
  if (quality.hasFailedJob || projectStatus === ProjectStatus.FAILED) {
    return 'failed';
  }

  switch (projectStatus) {
    case ProjectStatus.DRAFT:
      return 'draft';
    case ProjectStatus.PROCESSING:
      return 'processing';
    case ProjectStatus.CANCELLED:
      return 'cancelled';
    case ProjectStatus.COMPLETED:
      return quality.degraded ? 'degraded' : 'success';
    default:
      return 'processing';
  }
}
