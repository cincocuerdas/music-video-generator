import { Injectable, NotFoundException } from '@nestjs/common';
import { Job, JobStatus, JobType } from '@prisma/client';

export type PipelineAdvanceDecision =
  | { kind: 'dispatch'; job: Job }
  | { kind: 'wait' }
  | { kind: 'complete' };

const PIPELINE_JOB_TYPE_SET = new Set<JobType>([
  JobType.YOUTUBE_DOWNLOAD,
  JobType.TRANSCRIPTION,
  JobType.ANALYZE_LYRICS,
  JobType.GENERATE_IMAGES,
  JobType.RENDER_VIDEO,
  JobType.FINALIZE,
]);

@Injectable()
export class PipelineTransitionService {
  resolveAdvanceDecision(projectId: string, jobs: Job[]): PipelineAdvanceDecision {
    if (jobs.length === 0) {
      throw new NotFoundException(`No jobs found for project ${projectId}`);
    }

    const pipelineJobs = jobs.filter((job) => PIPELINE_JOB_TYPE_SET.has(job.type));
    if (pipelineJobs.length === 0) {
      throw new NotFoundException(`No pipeline jobs found for project ${projectId}`);
    }

    const nextJob = pipelineJobs.find((job) => job.status === JobStatus.PENDING);
    if (nextJob) {
      return { kind: 'dispatch', job: nextJob };
    }

    const hasRunning = pipelineJobs.some((job) => job.status === JobStatus.PROCESSING);
    if (hasRunning) {
      return { kind: 'wait' };
    }

    const allCompleted = pipelineJobs.every((job) => job.status === JobStatus.COMPLETED);
    if (allCompleted) {
      return { kind: 'complete' };
    }

    return { kind: 'wait' };
  }
}

