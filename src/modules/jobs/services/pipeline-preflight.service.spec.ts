import { BadRequestException } from '@nestjs/common';
import { PipelinePreflightService } from './pipeline-preflight.service';

describe('PipelinePreflightService', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('passes when comfyui and gemini env are present', () => {
    process.env.IMAGE_PROVIDER = 'comfyui';
    process.env.LLM_PROVIDER = 'gemini';
    process.env.COMFYUI_URL = 'http://localhost:8188';
    process.env.GEMINI_API_KEY = 'test-key';

    const service = new PipelinePreflightService();

    expect(() => service.ensureProviderPreflight()).not.toThrow();
  });

  it('fails when comfyui provider is missing COMFYUI_URL', () => {
    process.env.IMAGE_PROVIDER = 'comfyui';
    process.env.LLM_PROVIDER = 'gemini';
    process.env.COMFYUI_URL = '';
    process.env.GEMINI_API_KEY = 'test-key';

    const service = new PipelinePreflightService();

    expect(() => service.ensureProviderPreflight()).toThrow(BadRequestException);
  });

  it('fails when replicate provider is missing token', () => {
    process.env.IMAGE_PROVIDER = 'replicate';
    process.env.LLM_PROVIDER = 'gemini';
    process.env.REPLICATE_API_TOKEN = '';
    process.env.GEMINI_API_KEY = 'test-key';

    const service = new PipelinePreflightService();

    expect(() => service.ensureProviderPreflight()).toThrow(BadRequestException);
  });

  it('fails when project has no source input', () => {
    const service = new PipelinePreflightService();

    expect(() =>
      service.ensureProjectPreflight({
        youtubeUrl: null,
        audioUrl: null,
        lyrics: null,
      }),
    ).toThrow(BadRequestException);
  });
});
