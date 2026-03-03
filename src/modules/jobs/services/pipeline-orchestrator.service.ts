import { BadRequestException, Injectable } from '@nestjs/common';
import { JobType } from '@prisma/client';

export type PipelineSourceMode = 'youtube' | 'audio' | 'lyrics';

export interface PipelineDefinition {
  source: PipelineSourceMode;
  order: JobType[];
}

const FULL_PIPELINE_ORDER: JobType[] = [
  JobType.YOUTUBE_DOWNLOAD,
  JobType.TRANSCRIPTION,
  JobType.ANALYZE_LYRICS,
  JobType.GENERATE_IMAGES,
  JobType.RENDER_VIDEO,
  JobType.FINALIZE,
];

@Injectable()
export class PipelineOrchestratorService {
  resolveProjectSourceMode(project: {
    youtubeUrl: string | null;
    audioUrl: string | null;
    lyrics: string | null;
  }): PipelineSourceMode | 'unknown' {
    const youtubeUrl = (project.youtubeUrl || '').trim();
    const audioUrl = (project.audioUrl || '').trim();
    const lyrics = (project.lyrics || '').trim();

    if (youtubeUrl) {
      return 'youtube';
    }
    if (audioUrl && !lyrics) {
      return 'audio';
    }
    if (lyrics || audioUrl) {
      return 'lyrics';
    }
    return 'unknown';
  }

  ensureProviderPreflight(): void {
    const imageProvider = (process.env.IMAGE_PROVIDER || 'comfyui').trim().toLowerCase();
    const llmProvider = (process.env.LLM_PROVIDER || 'gemini').trim().toLowerCase();

    if (imageProvider === 'comfyui' && !(process.env.COMFYUI_URL || '').trim()) {
      throw new BadRequestException(
        'Pipeline preflight failed: COMFYUI_URL is missing while IMAGE_PROVIDER=comfyui.',
      );
    }

    if (imageProvider === 'replicate' && !(process.env.REPLICATE_API_TOKEN || '').trim()) {
      throw new BadRequestException(
        'Pipeline preflight failed: REPLICATE_API_TOKEN is missing while IMAGE_PROVIDER=replicate.',
      );
    }

    if (llmProvider === 'gemini' && !(process.env.GEMINI_API_KEY || '').trim()) {
      throw new BadRequestException(
        'Pipeline preflight failed: GEMINI_API_KEY is missing while LLM_PROVIDER=gemini.',
      );
    }
  }

  ensureProjectPreflight(project: {
    youtubeUrl: string | null;
    audioUrl: string | null;
    lyrics: string | null;
  }): void {
    const youtubeUrl = (project.youtubeUrl || '').trim();
    const audioUrl = (project.audioUrl || '').trim();
    const lyrics = (project.lyrics || '').trim();

    if (!youtubeUrl && !audioUrl && !lyrics) {
      throw new BadRequestException(
        'Pipeline preflight failed: project has no source input (youtubeUrl/audioUrl/lyrics).',
      );
    }
  }

  buildPipelineDefinition(project: {
    youtubeUrl: string | null;
    audioUrl: string | null;
    lyrics: string | null;
  }): PipelineDefinition {
    const youtubeUrl = (project.youtubeUrl || '').trim();
    const audioUrl = (project.audioUrl || '').trim();
    const lyrics = (project.lyrics || '').trim();

    if (youtubeUrl) {
      return {
        source: 'youtube',
        order: [...FULL_PIPELINE_ORDER],
      };
    }

    if (audioUrl && !lyrics) {
      return {
        source: 'audio',
        order: [
          JobType.TRANSCRIPTION,
          JobType.ANALYZE_LYRICS,
          JobType.GENERATE_IMAGES,
          JobType.RENDER_VIDEO,
          JobType.FINALIZE,
        ],
      };
    }

    return {
      source: 'lyrics',
      order: [
        JobType.ANALYZE_LYRICS,
        JobType.GENERATE_IMAGES,
        JobType.RENDER_VIDEO,
        JobType.FINALIZE,
      ],
    };
  }
}

