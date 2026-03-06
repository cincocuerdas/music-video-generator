import { Injectable } from '@nestjs/common';
import { JobType } from '@prisma/client';

export type PipelineSourceMode = 'youtube' | 'audio' | 'lyrics';

export interface PipelineDefinition {
  source: PipelineSourceMode;
  order: JobType[];
}

type PipelineSourceInput = {
  youtubeUrl: string | null;
  audioUrl: string | null;
  lyrics: string | null;
};

const FULL_PIPELINE_ORDER: JobType[] = [
  JobType.YOUTUBE_DOWNLOAD,
  JobType.TRANSCRIPTION,
  JobType.ANALYZE_LYRICS,
  JobType.GENERATE_IMAGES,
  JobType.RENDER_VIDEO,
  JobType.FINALIZE,
];

@Injectable()
export class PipelineDefinitionService {
  resolveProjectSourceMode(project: PipelineSourceInput): PipelineSourceMode | 'unknown' {
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

  buildPipelineDefinition(project: PipelineSourceInput): PipelineDefinition {
    const sourceMode = this.resolveProjectSourceMode(project);

    if (sourceMode === 'youtube') {
      return {
        source: 'youtube',
        order: [...FULL_PIPELINE_ORDER],
      };
    }

    if (sourceMode === 'audio') {
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
