import { JobType } from '../dto';
import { AnalysisProcessor } from './analysis.processor';
import { ImageGenerationProcessor } from './image-generation.processor';
import { TrainLoraProcessor } from './train-lora.processor';
import { TranscriptionProcessor } from './transcription.processor';
import { VideoRenderProcessor } from './video-render.processor';
import { YouTubeDownloadProcessor } from './youtube-download.processor';

type ProcessorInstance = {
  process: (job: any) => Promise<any>;
};

const createJob = (
  overrides?: Record<string, unknown>,
  attemptsMade = 1,
  attempts = 2,
) =>
  ({
    data: {
      jobId: 'job-1',
      projectId: 'project-1',
      correlationId: 'cid-1',
      ...(overrides || {}),
    },
    attemptsMade,
    opts: { attempts },
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
    runScript: jest.fn(),
    runScriptWithProgress: jest.fn(),
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
    sentryService,
  };
};

const mockWorker = (processor: object) => {
  jest.spyOn(processor as any, 'worker', 'get').mockReturnValue({ id: 'worker-1' } as any);
};

describe('Job processors failure paths', () => {
  const processors = [
    {
      name: 'YouTubeDownloadProcessor',
      jobType: JobType.YOUTUBE_DOWNLOAD,
      create: (deps: ReturnType<typeof createDeps>) =>
        new YouTubeDownloadProcessor(
          deps.jobsService as any,
          deps.deadLetterOrchestrator as any,
          deps.pythonRunner as any,
          deps.circuitBreaker as any,
          deps.eventsGateway as any,
          deps.sentryService as any,
        ),
      jobOverrides: {},
      triggerError: (deps: ReturnType<typeof createDeps>, error: Error) => {
        deps.pythonRunner.runScript.mockRejectedValue(error);
      },
    },
    {
      name: 'TranscriptionProcessor',
      jobType: JobType.TRANSCRIPTION,
      create: (deps: ReturnType<typeof createDeps>) =>
        new TranscriptionProcessor(
          deps.jobsService as any,
          deps.deadLetterOrchestrator as any,
          deps.pythonRunner as any,
          deps.circuitBreaker as any,
          deps.eventsGateway as any,
          deps.sentryService as any,
        ),
      jobOverrides: {},
      triggerError: (deps: ReturnType<typeof createDeps>, error: Error) => {
        deps.pythonRunner.runScriptWithProgress.mockRejectedValue(error);
      },
    },
    {
      name: 'AnalysisProcessor',
      jobType: JobType.ANALYZE_LYRICS,
      create: (deps: ReturnType<typeof createDeps>) =>
        new AnalysisProcessor(
          deps.jobsService as any,
          deps.deadLetterOrchestrator as any,
          deps.pythonRunner as any,
          deps.circuitBreaker as any,
          deps.eventsGateway as any,
          deps.sentryService as any,
        ),
      jobOverrides: {},
      triggerError: (deps: ReturnType<typeof createDeps>, error: Error) => {
        deps.pythonRunner.runScript.mockRejectedValue(error);
      },
    },
    {
      name: 'ImageGenerationProcessor',
      jobType: JobType.GENERATE_IMAGES,
      create: (deps: ReturnType<typeof createDeps>) =>
        new ImageGenerationProcessor(
          deps.jobsService as any,
          deps.deadLetterOrchestrator as any,
          deps.pythonRunner as any,
          deps.circuitBreaker as any,
          deps.eventsGateway as any,
          deps.projectsService as any,
          deps.sentryService as any,
        ),
      jobOverrides: {},
      triggerError: (deps: ReturnType<typeof createDeps>, error: Error) => {
        deps.pythonRunner.runScriptWithProgress.mockRejectedValue(error);
      },
    },
    {
      name: 'VideoRenderProcessor',
      jobType: JobType.RENDER_VIDEO,
      create: (deps: ReturnType<typeof createDeps>) =>
        new VideoRenderProcessor(
          deps.jobsService as any,
          deps.deadLetterOrchestrator as any,
          deps.pythonRunner as any,
          deps.circuitBreaker as any,
          deps.eventsGateway as any,
          deps.sentryService as any,
        ),
      jobOverrides: {},
      triggerError: (deps: ReturnType<typeof createDeps>, error: Error) => {
        deps.pythonRunner.runScript.mockRejectedValue(error);
      },
    },
    {
      name: 'TrainLoraProcessor',
      jobType: JobType.TRAIN_LORA,
      create: (deps: ReturnType<typeof createDeps>) =>
        new TrainLoraProcessor(
          deps.jobsService as any,
          deps.deadLetterOrchestrator as any,
          deps.pythonRunner as any,
          deps.circuitBreaker as any,
          deps.eventsGateway as any,
          deps.sentryService as any,
        ),
      jobOverrides: { style: 'cinematic' },
      triggerError: (deps: ReturnType<typeof createDeps>, error: Error) => {
        deps.pythonRunner.runScript.mockRejectedValue(error);
      },
    },
  ] as const;

  it.each(processors)(
    '$name marks permanent errors as final failure + dead letter',
    async ({ create, triggerError, jobOverrides, jobType }) => {
      const deps = createDeps();
      const processor = create(deps) as ProcessorInstance;
      mockWorker(processor as any);
      triggerError(deps, new Error('No YouTube URL found for project'));

      await expect(processor.process(createJob(jobOverrides, 1, 2))).rejects.toThrow(
        'No YouTube URL found for project',
      );

      expect(deps.circuitBreaker.recordFailure).not.toHaveBeenCalled();
      expect(deps.jobsService.markAsFailed).toHaveBeenCalledWith(
        'job-1',
        'No YouTube URL found for project',
      );
      expect(deps.deadLetterOrchestrator.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'project-1',
          jobId: 'job-1',
          jobType,
          retryable: false,
          category: 'permanent',
        }),
      );
      expect(deps.sentryService.captureException).toHaveBeenCalled();
    },
  );

  it('retries transient errors while attempts remain (image generation)', async () => {
    const deps = createDeps();
    const processor = new ImageGenerationProcessor(
      deps.jobsService as any,
      deps.deadLetterOrchestrator as any,
      deps.pythonRunner as any,
      deps.circuitBreaker as any,
      deps.eventsGateway as any,
      deps.projectsService as any,
      deps.sentryService as any,
    );
    mockWorker(processor);
    deps.pythonRunner.runScriptWithProgress.mockRejectedValue(
      new Error('Request timed out while waiting for provider'),
    );

    await expect(processor.process(createJob({}, 0, 3))).rejects.toThrow(
      'Request timed out while waiting for provider',
    );

    expect(deps.circuitBreaker.recordFailure).toHaveBeenCalledWith(
      'image-generation',
      'Request timed out while waiting for provider',
    );
    expect(deps.jobsService.updateProgress).toHaveBeenCalledWith(
      'job-1',
      0,
      expect.stringContaining('Retrying (1/3)'),
    );
    expect(deps.jobsService.markAsFailed).not.toHaveBeenCalled();
    expect(deps.deadLetterOrchestrator.enqueue).not.toHaveBeenCalled();
  });

  it('circuit open triggers retry path when attempts remain (video render)', async () => {
    const deps = createDeps();
    const processor = new VideoRenderProcessor(
      deps.jobsService as any,
      deps.deadLetterOrchestrator as any,
      deps.pythonRunner as any,
      deps.circuitBreaker as any,
      deps.eventsGateway as any,
      deps.sentryService as any,
    );
    mockWorker(processor);
    deps.circuitBreaker.canExecute.mockReturnValue({ allowed: false, retryAfterMs: 9000 });

    await expect(processor.process(createJob({}, 0, 2))).rejects.toThrow(
      'Circuit open for video-render. Retry after 9000ms',
    );

    expect(deps.pythonRunner.runScript).not.toHaveBeenCalled();
    expect(deps.circuitBreaker.recordFailure).toHaveBeenCalledWith(
      'video-render',
      'Circuit open for video-render. Retry after 9000ms',
    );
    expect(deps.jobsService.updateProgress).toHaveBeenCalledWith(
      'job-1',
      0,
      expect.stringContaining('Retrying (1/2)'),
    );
    expect(deps.jobsService.markAsFailed).not.toHaveBeenCalled();
    expect(deps.deadLetterOrchestrator.enqueue).not.toHaveBeenCalled();
  });
});
