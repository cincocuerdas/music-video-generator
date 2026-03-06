import { BadRequestException, Injectable } from '@nestjs/common';

type PipelineSourceInput = {
  youtubeUrl: string | null;
  audioUrl: string | null;
  lyrics: string | null;
};

@Injectable()
export class PipelinePreflightService {
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

  ensureProjectPreflight(project: PipelineSourceInput): void {
    const youtubeUrl = (project.youtubeUrl || '').trim();
    const audioUrl = (project.audioUrl || '').trim();
    const lyrics = (project.lyrics || '').trim();

    if (!youtubeUrl && !audioUrl && !lyrics) {
      throw new BadRequestException(
        'Pipeline preflight failed: project has no source input (youtubeUrl/audioUrl/lyrics).',
      );
    }
  }
}
