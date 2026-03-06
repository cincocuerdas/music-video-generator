import { BadRequestException, Injectable } from '@nestjs/common';

export type HealthSourceMode = 'youtube' | 'audio' | 'lyrics' | 'unknown';

interface ProjectLike {
  sourceMode?: string | null;
  youtubeUrl?: string | null;
  audioUrl?: string | null;
  lyrics?: string | null;
  title?: string | null;
}

@Injectable()
export class HealthPipelineClassificationService {
  getStageOrder(type: string): number {
    const order: Record<string, number> = {
      YOUTUBE_DOWNLOAD: 1,
      TRANSCRIPTION: 2,
      ANALYZE_LYRICS: 3,
      GENERATE_IMAGES: 4,
      RENDER_VIDEO: 5,
      FINALIZE: 6,
      TRAIN_LORA: 99,
    };
    return order[type] ?? 999;
  }

  normalizeSourceMode(value: unknown): HealthSourceMode {
    if (typeof value !== 'string') {
      return 'unknown';
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === 'youtube' || normalized === 'audio' || normalized === 'lyrics') {
      return normalized;
    }
    return 'unknown';
  }

  inferSourceModeFromProject(project: ProjectLike | null | undefined): HealthSourceMode {
    if (!project) {
      return 'unknown';
    }
    const persistedSourceMode = this.normalizeSourceMode(project.sourceMode);
    if (persistedSourceMode !== 'unknown') {
      return persistedSourceMode;
    }
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

  resolveSourceMode(inputData: unknown, project: ProjectLike | null): HealthSourceMode {
    const persistedSourceMode = this.normalizeSourceMode(project?.sourceMode);
    if (persistedSourceMode !== 'unknown') {
      return persistedSourceMode;
    }
    const payloadSourceMode =
      inputData && typeof inputData === 'object' && !Array.isArray(inputData)
        ? (inputData as Record<string, unknown>).sourceMode
        : null;
    const normalizedPayloadSource = this.normalizeSourceMode(payloadSourceMode);
    if (normalizedPayloadSource !== 'unknown') {
      return normalizedPayloadSource;
    }
    return this.inferSourceModeFromProject(project);
  }

  parseSourceModeFilter(sourceMode?: string): HealthSourceMode | null {
    if (typeof sourceMode !== 'string' || sourceMode.trim().length === 0) {
      return null;
    }
    const normalized = sourceMode.trim().toLowerCase();
    if (normalized === 'youtube' || normalized === 'audio' || normalized === 'lyrics' || normalized === 'unknown') {
      return normalized;
    }
    throw new BadRequestException(
      `Invalid sourceMode "${sourceMode}". Allowed values: youtube, audio, lyrics, unknown.`,
    );
  }

  isSyntheticInputData(inputData: unknown): boolean {
    if (!inputData || typeof inputData !== 'object' || Array.isArray(inputData)) {
      return false;
    }
    const payload = inputData as Record<string, unknown>;
    const isSyntheticRaw = payload.isSynthetic;
    if (
      isSyntheticRaw === true ||
      isSyntheticRaw === 1 ||
      (typeof isSyntheticRaw === 'string' &&
        ['true', '1', 'yes', 'synthetic'].includes(isSyntheticRaw.trim().toLowerCase()))
    ) {
      return true;
    }
    const syntheticRunType =
      typeof payload.syntheticRunType === 'string' ? payload.syntheticRunType.trim().toLowerCase() : '';
    return ['smoke', 'chaos', 'synthetic'].includes(syntheticRunType);
  }

  isSyntheticProjectTitle(title?: string | null): boolean {
    const normalized = (title || '').trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    return (
      normalized.includes('[synthetic:') ||
      normalized.includes('smoke baseline') ||
      normalized.includes('external chaos') ||
      normalized.includes('latency chaos')
    );
  }

  isSyntheticJob(inputData: unknown, project?: { title?: string | null } | null): boolean {
    return this.isSyntheticInputData(inputData) || this.isSyntheticProjectTitle(project?.title);
  }
}
