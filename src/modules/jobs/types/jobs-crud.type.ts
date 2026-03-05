import { JobStatus, JobType } from '@prisma/client';

export interface CreateJobDto {
  projectId: string;
  type: JobType;
  inputData?: Record<string, any>;
}

export interface UpdateJobDto {
  status?: JobStatus;
  progress?: number;
  currentStep?: string;
  workerId?: string;
  errorMessage?: string;
  outputData?: Record<string, any>;
}
