import { BadRequestException } from '@nestjs/common';
import { HealthPipelineClassificationService } from './health-pipeline-classification.service';

describe('HealthPipelineClassificationService', () => {
  let service: HealthPipelineClassificationService;

  beforeEach(() => {
    service = new HealthPipelineClassificationService();
  });

  it('resolves source mode from project, payload, and fallback fields', () => {
    expect(service.resolveSourceMode({}, { sourceMode: 'youtube' })).toBe('youtube');
    expect(service.resolveSourceMode({ sourceMode: 'audio' }, { sourceMode: null })).toBe('audio');
    expect(service.resolveSourceMode({}, { audioUrl: 'file.wav', lyrics: 'hola' })).toBe('lyrics');
    expect(service.resolveSourceMode({}, { youtubeUrl: 'https://youtube.com/watch?v=x' })).toBe('youtube');
  });

  it('parses valid source mode filters and rejects invalid ones', () => {
    expect(service.parseSourceModeFilter(undefined)).toBeNull();
    expect(service.parseSourceModeFilter('lyrics')).toBe('lyrics');
    expect(() => service.parseSourceModeFilter('video')).toThrow(BadRequestException);
  });

  it('detects synthetic jobs from payload flags and project title markers', () => {
    expect(service.isSyntheticInputData({ isSynthetic: true })).toBe(true);
    expect(service.isSyntheticInputData({ syntheticRunType: 'chaos' })).toBe(true);
    expect(service.isSyntheticProjectTitle('Smoke Baseline - Despacito')).toBe(true);
    expect(service.isSyntheticJob({}, { title: 'external chaos / sample' })).toBe(true);
    expect(service.isSyntheticJob({}, { title: 'real project' })).toBe(false);
  });

  it('returns stable stage ordering for core pipeline stages', () => {
    expect(service.getStageOrder('YOUTUBE_DOWNLOAD')).toBeLessThan(
      service.getStageOrder('GENERATE_IMAGES'),
    );
    expect(service.getStageOrder('UNKNOWN_STAGE')).toBe(999);
  });
});
