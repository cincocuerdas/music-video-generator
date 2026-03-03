import { JobStatus, JobType, ProjectStatus } from '@prisma/client';
import type { ProjectPipelineStatus } from '../pipeline-quality.utils';

export interface PipelineStatus {
  projectId: string;
  projectStatus: ProjectStatus;
  pipelineStatus: ProjectPipelineStatus;
  degraded: boolean;
  degradedReasons: string[];
  degradedReasonCodes: string[];
  jobs: {
    type: JobType;
    status: JobStatus;
    progress: number;
    currentStep: string | null;
    errorMessage: string | null;
  }[];
  currentJob: JobType | null;
  overallProgress: number;
}

