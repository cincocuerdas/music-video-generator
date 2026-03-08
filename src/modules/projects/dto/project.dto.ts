import {
  Expose,
  Type,
} from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { YOUTUBE_URL_REGEX } from '../../../common/constants';

export class CreateProjectDto {
  @IsString()
  @MaxLength(200)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(YOUTUBE_URL_REGEX, { message: 'youtubeUrl must be a valid YouTube URL' })
  youtubeUrl?: string;

  @IsOptional()
  @IsString()
  lyrics?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  visualStyle?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  colorPalette?: string[];

  @IsOptional()
  @IsString()
  aspectRatio?: string;
}

export class UpdateProjectDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  lyrics?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  visualStyle?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  colorPalette?: string[];

  @IsOptional()
  @IsString()
  aspectRatio?: string;
}

export enum MotionPreset {
  SUBTLE = 'subtle',
  MODERATE = 'moderate',
  DYNAMIC = 'dynamic',
}

export class StartGenerationDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(YOUTUBE_URL_REGEX, { message: 'youtubeUrl must be a valid YouTube URL' })
  youtubeUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  visualStyle?: string;

  @IsOptional()
  @IsEnum(MotionPreset)
  motionPreset?: MotionPreset;
}

export class CreateFeedbackDto {
  @IsInt()
  @Min(-1)
  @Max(1)
  score: number;

  @IsString()
  @MaxLength(5000)
  prompt: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  frameTime?: number;

  @IsOptional()
  @IsInt()
  sceneIndex?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  style?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

export enum LiveSignalType {
  BOOST = 'boost',
  CORRECT = 'correct',
}

export class SendLiveSignalDto {
  @IsEnum(LiveSignalType, { message: 'type must be "boost" or "correct"' })
  type: LiveSignalType;

  @IsInt()
  @Min(0)
  sceneIndex: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  timestamp?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.1)
  @Max(2.0)
  intensity?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class ProjectListItemResponseDto {
  @Expose()
  id!: string;

  @Expose()
  title!: string;

  @Expose()
  status!: string;

  @Expose()
  thumbnailUrl!: string | null;

  @Expose()
  videoUrl!: string | null;

  @Expose()
  visualStyle!: string | null;

  @Expose()
  @Type(() => Date)
  createdAt!: Date;
}

export class ProjectListResponseDto {
  @Expose()
  @Type(() => ProjectListItemResponseDto)
  data!: ProjectListItemResponseDto[];

  @Expose()
  total!: number;

  @Expose()
  page!: number;

  @Expose()
  limit!: number;
}

export class ProjectJobSummaryResponseDto {
  @Expose()
  id!: string;

  @Expose()
  type!: string;

  @Expose()
  status!: string;

  @Expose()
  progress!: number;

  @Expose()
  currentStep!: string | null;

  @Expose()
  errorMessage!: string | null;

  @Expose()
  outputData!: Record<string, unknown> | null;

  @Expose()
  @Type(() => Date)
  createdAt!: Date;

  @Expose()
  @Type(() => Date)
  updatedAt!: Date;
}

export class ProjectResponseDto {
  @Expose()
  id!: string;

  @Expose()
  title!: string;

  @Expose()
  status!: string;

  @Expose()
  sourceMode!: string | null;

  @Expose()
  lyrics!: string | null;

  @Expose()
  audioUrl!: string | null;

  @Expose()
  audioDuration!: number | null;

  @Expose()
  visualStyle!: string | null;

  @Expose()
  colorPalette!: string[];

  @Expose()
  aspectRatio!: string;

  @Expose()
  analysisResult!: Record<string, unknown> | null;

  @Expose()
  videoUrl!: string | null;

  @Expose()
  thumbnailUrl!: string | null;

  @Expose()
  @Type(() => Date)
  createdAt!: Date;

  @Expose()
  @Type(() => Date)
  updatedAt!: Date;

  @Expose()
  youtubeUrl!: string | null;
}

export class ProjectDetailResponseDto extends ProjectResponseDto {
  @Expose()
  @Type(() => ProjectJobSummaryResponseDto)
  jobs!: ProjectJobSummaryResponseDto[];

  @Expose()
  pipelineStatus!: string;

  @Expose()
  degraded!: boolean;

  @Expose()
  degradedReasons!: string[];

  @Expose()
  degradedReasonCodes!: string[];
}

export class ProjectStartJobResponseDto {
  @Expose()
  id!: string;

  @Expose()
  type!: string;

  @Expose()
  status!: string;
}

export class ProjectStartGenerationResponseDto {
  @Expose()
  projectId!: string;

  @Expose()
  message!: string;

  @Expose()
  totalJobs!: number;

  @Expose()
  @Type(() => ProjectStartJobResponseDto)
  jobs!: ProjectStartJobResponseDto[];
}

export class ProjectStatusJobResponseDto {
  @Expose()
  id!: string;

  @Expose()
  type!: string;

  @Expose()
  status!: string;

  @Expose()
  progress!: number;

  @Expose()
  currentStep!: string | null;

  @Expose()
  errorMessage!: string | null;
}

export class ProjectStatusResponseDto {
  @Expose()
  projectId!: string;

  @Expose()
  status!: string;

  @Expose()
  pipelineStatus!: string;

  @Expose()
  degraded!: boolean;

  @Expose()
  degradedReasons!: string[];

  @Expose()
  degradedReasonCodes!: string[];

  @Expose()
  overallProgress!: number;

  @Expose()
  @Type(() => ProjectStatusJobResponseDto)
  jobs!: ProjectStatusJobResponseDto[];
}

export class ProjectActionResponseDto {
  @Expose()
  success!: boolean;

  @Expose()
  message!: string;

  @Expose()
  projectId?: string;
}

export class ProjectVideoResponseDto {
  @Expose()
  projectId!: string;

  @Expose()
  status!: string;

  @Expose()
  pipelineStatus!: string;

  @Expose()
  degraded!: boolean;

  @Expose()
  degradedReasons!: string[];

  @Expose()
  degradedReasonCodes!: string[];

  @Expose()
  videoUrl!: string | null;

  @Expose()
  thumbnailUrl!: string | null;
}

export class ProjectDownloadResponseDto {
  @Expose()
  projectId!: string;

  @Expose()
  downloadUrl!: string;

  @Expose()
  expiresAt!: string | null;
}

export class FeedbackActionResponseDto {
  @Expose()
  id!: string;

  @Expose()
  message!: string;
}

export class FeedbackEntryResponseDto {
  @Expose()
  id!: string;

  @Expose()
  projectId!: string;

  @Expose()
  score!: number;

  @Expose()
  frameTime!: number | null;

  @Expose()
  prompt!: string;

  @Expose()
  style!: string | null;

  @Expose()
  @Type(() => Date)
  createdAt!: Date;
}

export class ProjectFeedbackResponseDto {
  @Expose()
  projectId!: string;

  @Expose()
  total!: number;

  @Expose()
  likes!: number;

  @Expose()
  dislikes!: number;

  @Expose()
  @Type(() => FeedbackEntryResponseDto)
  feedbacks!: FeedbackEntryResponseDto[];
}

export class FeedbackStatsResponseDto {
  @Expose()
  style!: string;

  @Expose()
  totalLikes!: number;

  @Expose()
  totalDislikes!: number;

  @Expose()
  successRate!: number;

  @Expose()
  topSuccessfulKeywords!: string[];
}

export class PromptOptimizationResponseDto {
  @Expose()
  qualityBoost!: string;

  @Expose()
  negativeBoost!: string;

  @Expose()
  confidence!: number;
}

export class LiveSignalDataResponseDto {
  @Expose()
  type!: 'boost' | 'correct';

  @Expose()
  sceneIndex!: number;

  @Expose()
  timestamp!: number;

  @Expose()
  intensity!: number;

  @Expose()
  reason!: string | undefined;

  @Expose()
  processed!: boolean;
}

export class LiveSignalActionResponseDto {
  @Expose()
  success!: boolean;

  @Expose()
  message!: string;

  @Expose()
  @Type(() => LiveSignalDataResponseDto)
  signal?: LiveSignalDataResponseDto;
}
