import { JobType } from '@prisma/client';
import { PipelineDefinitionService } from './pipeline-definition.service';

describe('PipelineDefinitionService', () => {
  const service = new PipelineDefinitionService();

  it('resolves youtube source mode', () => {
    expect(
      service.resolveProjectSourceMode({
        youtubeUrl: 'https://youtube.com/watch?v=abc',
        audioUrl: null,
        lyrics: null,
      }),
    ).toBe('youtube');
  });

  it('resolves audio source mode when only audio is present', () => {
    expect(
      service.resolveProjectSourceMode({
        youtubeUrl: null,
        audioUrl: 'https://cdn.test/audio.mp3',
        lyrics: null,
      }),
    ).toBe('audio');
  });

  it('resolves lyrics source mode when lyrics exist', () => {
    expect(
      service.resolveProjectSourceMode({
        youtubeUrl: null,
        audioUrl: null,
        lyrics: 'hello world',
      }),
    ).toBe('lyrics');
  });

  it('builds full youtube pipeline definition', () => {
    expect(
      service.buildPipelineDefinition({
        youtubeUrl: 'https://youtube.com/watch?v=abc',
        audioUrl: null,
        lyrics: null,
      }),
    ).toEqual({
      source: 'youtube',
      order: [
        JobType.YOUTUBE_DOWNLOAD,
        JobType.TRANSCRIPTION,
        JobType.ANALYZE_LYRICS,
        JobType.GENERATE_IMAGES,
        JobType.RENDER_VIDEO,
        JobType.FINALIZE,
      ],
    });
  });

  it('builds audio pipeline definition without youtube download', () => {
    expect(
      service.buildPipelineDefinition({
        youtubeUrl: null,
        audioUrl: 'https://cdn.test/audio.mp3',
        lyrics: null,
      }),
    ).toEqual({
      source: 'audio',
      order: [
        JobType.TRANSCRIPTION,
        JobType.ANALYZE_LYRICS,
        JobType.GENERATE_IMAGES,
        JobType.RENDER_VIDEO,
        JobType.FINALIZE,
      ],
    });
  });

  it('builds lyrics pipeline definition', () => {
    expect(
      service.buildPipelineDefinition({
        youtubeUrl: null,
        audioUrl: null,
        lyrics: 'hello world',
      }),
    ).toEqual({
      source: 'lyrics',
      order: [
        JobType.ANALYZE_LYRICS,
        JobType.GENERATE_IMAGES,
        JobType.RENDER_VIDEO,
        JobType.FINALIZE,
      ],
    });
  });
});
