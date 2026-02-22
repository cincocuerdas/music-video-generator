import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';

// Must match Prisma schema enums
export enum JobType {
  YOUTUBE_DOWNLOAD = 'YOUTUBE_DOWNLOAD',
  TRANSCRIPTION = 'TRANSCRIPTION',
  ANALYZE_LYRICS = 'ANALYZE_LYRICS',
  GENERATE_IMAGES = 'GENERATE_IMAGES',
  RENDER_VIDEO = 'RENDER_VIDEO',
  TRAIN_LORA = 'TRAIN_LORA',
  FINALIZE = 'FINALIZE',
}

export enum JobStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

export class CreateJobDto {
  @IsUUID()
  projectId: string;

  @IsEnum(JobType)
  type: JobType;

  @IsOptional()
  inputData?: Record<string, any>;
}

export class UpdateJobDto {
  @IsOptional()
  @IsEnum(JobStatus)
  status?: JobStatus;

  @IsOptional()
  progress?: number;

  @IsOptional()
  @IsString()
  currentStep?: string;

  @IsOptional()
  outputData?: Record<string, any>;

  @IsOptional()
  @IsString()
  errorMessage?: string;

  @IsOptional()
  @IsString()
  workerId?: string;
}

export class JobResponseDto {
  id: string;
  projectId: string;
  jobType: JobType;
  status: JobStatus;
  progress: number;
  currentStep: string | null;
  inputData: Record<string, any> | null;
  outputData: Record<string, any> | null;
  errorMessage: string | null;
  queuedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  workerId: string | null;
}

export class JobListResponseDto {
  data: JobResponseDto[];
  total: number;
}

export class PipelineStatusDto {
  projectId: string;
  overallProgress: number;
  currentStage: JobType | null;
  stages: {
    type: JobType;
    status: JobStatus;
    progress: number;
  }[];
}
