import { JobType } from '../dto';
import { AnalysisProcessor } from './analysis.processor';
import { ImageGenerationProcessor } from './image-generation.processor';
import { TrainLoraProcessor } from './train-lora.processor';
import { TranscriptionProcessor } from './transcription.processor';
import { VideoRenderProcessor } from './video-render.processor';
import { YouTubeDownloadProcessor } from './youtube-download.processor';

const okResult = {
  status: 'success',
  success: true,
  degraded: false,
  degradedReasons: [],
};

const createJob = (overrides?: Record<string, unknown>) =>
  ({
    data: {
      jobId: 'job-1',
      projectId: 'project-1',
      correlationId: 'cid-1',
      ...(overrides || {}),
    },
    attemptsMade: 0,
    opts: { attempts: 2 },
  }) as any;

const createDeps = () => {
  const jobsService = {
    markAsProcessing: jest.fn().mockResolvedValue(undefined),
    updateProgress: jest.fn().mockResolvedValue(undefined),
    markAsCompleted: jest.fn().mockResolvedValue(undefined),
    markAsFailed: jest.fn().mockResolvedValue(undefined),
    advancePipeline: jest.fn().mockResolvedValue(null),
    updateStyleLoraConfig: jest.fn().mockResolvedValue(undefined),
  };
  const deadLetterOrchestrator = {
    enqueue: jest.fn().mockResolvedValue(undefined),
  };

  const pythonRunner = {
    runScript: jest.fn().mockResolvedValue(okResult),
    runScriptWithProgress: jest
      .fn()
      .mockImplementation(async (_script: string, _args: string[], onProgress?: (event: any) => void) => {
        if (onProgress) {
          onProgress({ type: 'progress', data: { progress: 30, message: 'progress...' } });
        }
        return okResult;
      }),
  };

  const circuitBreaker = {
    canExecute: jest.fn().mockReturnValue({ allowed: true, retryAfterMs: 0 }),
    recordSuccess: jest.fn(),
    recordFailure: jest.fn(),
  };

  const eventsGateway = {
    emitJobUpdate: jest.fn(),
    emitImageGenerated: jest.fn(),
  };

  const projectsService = {
    getPromptOptimization: jest.fn().mockResolvedValue({
      qualityBoost: '',
      negativeBoost: '',
      confidence: 0,
    }),
  };

  const jobConcurrencyService = {
    runWithLimits: jest.fn().mockImplementation(async (_jobType: JobType, work: () => Promise<unknown>) => work()),
  };

  const sentryService = {
    captureException: jest.fn(),
  };

  return {
    jobsService,
    deadLetterOrchestrator,
    pythonRunner,
    circuitBreaker,
    eventsGateway,
    projectsService,
    jobConcurrencyService,
    sentryService,
  };
};

describe('Job processors smoke tests', () => {
  const mockWorker = (processor: object) => {
    jest.spyOn(processor as any, 'worker', 'get').mockReturnValue({ id: 'worker-1' } as any);
  };

  it('YouTubeDownloadProcessor success path', async () => {
    const deps = createDeps();
    const processor = new YouTubeDownloadProcessor(
      deps.jobsService as any,
      deps.deadLetterOrchestrator as any,
      deps.pythonRunner as any,
      deps.circuitBreaker as any,
      deps.eventsGateway as any,
      deps.jobConcurrencyService as any,
      deps.sentryService as any,
    );
    mockWorker(processor);

    const result = await processor.process(createJob());

    expect(result).toEqual(okResult);
    expect(deps.pythonRunner.runScript).toHaveBeenCalledWith('youtube_download.py', ['project-1']);
    expect(deps.jobsService.markAsCompleted).toHaveBeenCalledWith('job-1', okResult);
    expect(deps.jobsService.advancePipeline).toHaveBeenCalledWith('project-1');
    expect(deps.circuitBreaker.recordSuccess).toHaveBeenCalledWith('youtube-download');
  });

  it('TranscriptionProcessor success path', async () => {
    const deps = createDeps();
    deps.pythonRunner.runScriptWithProgress.mockImplementation(
      async (_script: string, _args: string[], onProgress?: (event: any) => void) => {
        if (onProgress) {
          onProgress({ type: 'progress', data: { message: 'Transcribed 5 segments' } });
        }
        return okResult;
      },
    );

    const processor = new TranscriptionProcessor(
      deps.jobsService as any,
      deps.deadLetterOrchestrator as any,
      deps.pythonRunner as any,
      deps.circuitBreaker as any,
      deps.eventsGateway as any,
      deps.jobConcurrencyService as any,
      deps.sentryService as any,
    );
    mockWorker(processor);

    const result = await processor.process(createJob());

    expect(result).toEqual(okResult);
    expect(deps.pythonRunner.runScriptWithProgress).toHaveBeenCalled();
    expect(deps.jobsService.markAsCompleted).toHaveBeenCalledWith('job-1', okResult);
    expect(deps.jobsService.advancePipeline).toHaveBeenCalledWith('project-1');
    expect(deps.circuitBreaker.recordSuccess).toHaveBeenCalledWith('transcription');
  });

  it('AnalysisProcessor success path', async () => {
    const deps = createDeps();
    const processor = new AnalysisProcessor(
      deps.jobsService as any,
      deps.deadLetterOrchestrator as any,
      deps.pythonRunner as any,
      deps.circuitBreaker as any,
      deps.eventsGateway as any,
      deps.jobConcurrencyService as any,
      deps.sentryService as any,
    );
    mockWorker(processor);

    const result = await processor.process(createJob());

    expect(result).toEqual(okResult);
    expect(deps.pythonRunner.runScript).toHaveBeenCalledWith('analyze_lyrics.py', ['project-1']);
    expect(deps.jobsService.markAsCompleted).toHaveBeenCalledWith('job-1', okResult);
    expect(deps.jobsService.advancePipeline).toHaveBeenCalledWith('project-1');
    expect(deps.circuitBreaker.recordSuccess).toHaveBeenCalledWith('analysis');
  });

  it('ImageGenerationProcessor success path', async () => {
    const deps = createDeps();
    const processor = new ImageGenerationProcessor(
      deps.jobsService as any,
      deps.deadLetterOrchestrator as any,
      deps.pythonRunner as any,
      deps.circuitBreaker as any,
      deps.eventsGateway as any,
      deps.projectsService as any,
      deps.jobConcurrencyService as any,
      deps.sentryService as any,
    );
    mockWorker(processor);

    const result = await processor.process(createJob());

    expect(result).toEqual(okResult);
    expect(deps.projectsService.getPromptOptimization).toHaveBeenCalledWith('project-1');
    expect(deps.pythonRunner.runScriptWithProgress).toHaveBeenCalled();
    expect(deps.jobsService.markAsCompleted).toHaveBeenCalledWith('job-1', okResult);
    expect(deps.jobsService.advancePipeline).toHaveBeenCalledWith('project-1');
    expect(deps.circuitBreaker.recordSuccess).toHaveBeenCalledWith('image-generation');
  });

  it('VideoRenderProcessor success path', async () => {
    const deps = createDeps();
    const processor = new VideoRenderProcessor(
      deps.jobsService as any,
      deps.deadLetterOrchestrator as any,
      deps.pythonRunner as any,
      deps.circuitBreaker as any,
      deps.eventsGateway as any,
      deps.jobConcurrencyService as any,
      deps.sentryService as any,
    );
    mockWorker(processor);

    const result = await processor.process(createJob());

    expect(result).toEqual(okResult);
    expect(deps.pythonRunner.runScript).toHaveBeenCalledWith('render_video.py', ['project-1', 'job-1']);
    expect(deps.jobsService.markAsCompleted).toHaveBeenCalledWith('job-1', okResult);
    expect(deps.jobsService.advancePipeline).toHaveBeenCalledWith('project-1');
    expect(deps.circuitBreaker.recordSuccess).toHaveBeenCalledWith('video-render');
  });

  it('TrainLoraProcessor success path', async () => {
    const deps = createDeps();
    const loraResult = {
      ...okResult,
      loraFilename: 'style_cinematic_20260302.safetensors',
      loraPath: 'ComfyUI/models/loras/style_cinematic_20260302.safetensors',
      likesCount: 50,
    };
    deps.pythonRunner.runScript.mockResolvedValue(loraResult);

    const processor = new TrainLoraProcessor(
      deps.jobsService as any,
      deps.deadLetterOrchestrator as any,
      deps.pythonRunner as any,
      deps.circuitBreaker as any,
      deps.eventsGateway as any,
      deps.jobConcurrencyService as any,
      deps.sentryService as any,
    );
    mockWorker(processor);

    const result = await processor.process(createJob({ style: 'cinematic' }));

    expect(result).toEqual(loraResult);
    expect(deps.pythonRunner.runScript).toHaveBeenCalledWith('train_style_lora.py', ['cinematic', 'job-1']);
    expect(deps.jobsService.updateStyleLoraConfig).toHaveBeenCalledWith('cinematic', {
      loraFilename: 'style_cinematic_20260302.safetensors',
      loraPath: 'ComfyUI/models/loras/style_cinematic_20260302.safetensors',
      likesUsed: 50,
    });
    expect(deps.jobsService.markAsCompleted).toHaveBeenCalledWith('job-1', loraResult);
    expect(deps.circuitBreaker.recordSuccess).toHaveBeenCalledWith('train-lora');
  });

  it('TrainLoraProcessor skips zombie/malformed payload', async () => {
    const deps = createDeps();
    const processor = new TrainLoraProcessor(
      deps.jobsService as any,
      deps.deadLetterOrchestrator as any,
      deps.pythonRunner as any,
      deps.circuitBreaker as any,
      deps.eventsGateway as any,
      deps.jobConcurrencyService as any,
      deps.sentryService as any,
    );
    mockWorker(processor);

    const result = await processor.process(createJob({ style: undefined }));

    expect(result).toEqual({ skipped: true, reason: 'missing job data' });
    expect(deps.pythonRunner.runScript).not.toHaveBeenCalled();
    expect(deps.jobsService.markAsProcessing).not.toHaveBeenCalled();
  });
});
