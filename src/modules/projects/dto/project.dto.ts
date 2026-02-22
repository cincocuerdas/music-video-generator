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

