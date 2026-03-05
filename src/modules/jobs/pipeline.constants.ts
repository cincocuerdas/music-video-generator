import { JobType } from '@prisma/client';

export const PIPELINE_JOB_TYPES: JobType[] = [
  JobType.YOUTUBE_DOWNLOAD,
  JobType.TRANSCRIPTION,
  JobType.ANALYZE_LYRICS,
  JobType.GENERATE_IMAGES,
  JobType.RENDER_VIDEO,
  JobType.FINALIZE,
];

export const PIPELINE_JOB_TYPE_SET = new Set<JobType>(PIPELINE_JOB_TYPES);
