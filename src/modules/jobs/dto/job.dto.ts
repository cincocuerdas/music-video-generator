import { Expose, Type } from 'class-transformer';
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
  @Expose()
  id: string;

  @Expose()
  projectId: string;

  @Expose()
  type: JobType;

  @Expose()
  status: JobStatus;

  @Expose()
  progress: number;

  @Expose()
  currentStep: string | null;

  @Expose()
  inputData: Record<string, any> | null;

  @Expose()
  outputData: Record<string, any> | null;

  @Expose()
  errorMessage: string | null;

  @Expose()
  @Type(() => Date)
  createdAt: Date;

  @Expose()
  @Type(() => Date)
  updatedAt: Date;

  @Expose()
  workerId: string | null;
}

export class JobListResponseDto {
  @Expose()
  @Type(() => JobResponseDto)
  data: JobResponseDto[];

  @Expose()
  total: number;
}

export class PipelineStatusStageDto {
  @Expose()
  type: JobType;

  @Expose()
  status: JobStatus;

  @Expose()
  progress: number | null;

  @Expose()
  currentStep?: string | null;

  @Expose()
  errorMessage?: string | null;
}

export class PipelineStatusDto {
  @Expose()
  projectId: string;

  @Expose()
  projectStatus: string;

  @Expose()
  pipelineStatus: string;

  @Expose()
  degraded: boolean;

  @Expose()
  degradedReasons: string[];

  @Expose()
  degradedReasonCodes: string[];

  @Expose()
  overallProgress: number;

  @Expose()
  currentJob: JobType | null;

  @Expose()
  @Type(() => PipelineStatusStageDto)
  jobs: PipelineStatusStageDto[];
}

export class DeadLetterItemResponseDto {
  @Expose()
  deadLetterId: string;

  @Expose()
  status: string;

  @Expose()
  name: string;

  @Expose()
  attemptsMade: number;

  @Expose()
  failedReason: string | null;

  @Expose()
  timestamp: number;

  @Expose()
  data: Record<string, unknown>;
}

export class DeadLetterListResponseDto {
  @Expose()
  total: number;

  @Expose()
  @Type(() => DeadLetterItemResponseDto)
  items: DeadLetterItemResponseDto[];
}

export class DeadLetterReplayResponseDto {
  @Expose()
  replayed: boolean;

  @Expose()
  reason?: string;

  @Expose()
  deadLetterId?: string;

  @Expose()
  jobId?: string;

  @Expose()
  projectId?: string;

  @Expose()
  type?: string;
}
