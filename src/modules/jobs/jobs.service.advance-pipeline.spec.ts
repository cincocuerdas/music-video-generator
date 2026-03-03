import { JobStatus, JobType, ProjectStatus } from '@prisma/client';
import { JobsService } from './jobs.service';
import { PipelineTransitionService } from './services/pipeline-transition.service';

const now = () => new Date('2026-03-02T00:00:00.000Z');

const makeJob = (params: {
  id: string;
  projectId: string;
  type: JobType;
  status: JobStatus;
  correlationId?: string;
  createdOffsetMs?: number;
}) =>
  ({
    id: params.id,
    projectId: params.projectId,
    type: params.type,
    status: params.status,
    progress: 0,
    currentStep: null,
    workerId: null,
    errorMessage: null,
    inputData: {
      correlationId: params.correlationId || `cid-${params.projectId}`,
    },
    outputData: null,
    createdAt: new Date(now().getTime() + (params.createdOffsetMs || 0)),
    updatedAt: new Date(now().getTime() + (params.createdOffsetMs || 0)),
  }) as any;

describe('JobsService.advancePipeline handoff', () => {
  const projectId = 'project-1';

  const createService = () => {
    const prisma = {
      job: {
        findMany: jest.fn(),
      },
      project: {
        update: jest.fn().mockResolvedValue({ id: projectId, status: ProjectStatus.COMPLETED }),
      },
    };

    const pipelineOrchestrator = {
      ensureProviderPreflight: jest.fn(),
      ensureProjectPreflight: jest.fn(),
      buildPipelineDefinition: jest.fn(),
      resolveProjectSourceMode: jest.fn(),
    };
    const jobDispatchService = {
      dispatch: jest.fn().mockResolvedValue(undefined),
    };
    const pipelineTransitionService = new PipelineTransitionService();
    const projectPipelineQualityService = {
      appendDegradedMeta: jest.fn().mockResolvedValue(undefined),
      appendStageMetrics: jest.fn().mockResolvedValue(undefined),
      clearMeta: jest.fn().mockResolvedValue(undefined),
    };
    const styleLoraService = {
      triggerStyleLoraTraining: jest.fn(),
      updateStyleLoraConfig: jest.fn(),
    };
    const pipelineCancellationService = {
      cancelPipeline: jest.fn(),
    };
    const pipelineStatusService = {
      getPipelineStatus: jest.fn(),
    };

    const service = new JobsService(
      prisma as any,
      pipelineOrchestrator as any,
      pipelineTransitionService as any,
      pipelineStatusService as any,
      pipelineCancellationService as any,
      jobDispatchService as any,
      projectPipelineQualityService as any,
      styleLoraService as any,
    );

    return {
      service,
      prisma,
      queues: {
        jobDispatchService,
      },
    };
  };

  const runHandoffCase = async (params: {
    completed: JobType;
    next: JobType;
      assertQueue: (queues: ReturnType<typeof createService>['queues']) => jest.Mock;
  }) => {
    const { service, prisma, queues } = createService();
    prisma.job.findMany.mockResolvedValue([
      makeJob({
        id: 'job-completed',
        projectId,
        type: params.completed,
        status: JobStatus.COMPLETED,
        createdOffsetMs: 0,
      }),
      makeJob({
        id: 'job-next',
        projectId,
        type: params.next,
        status: JobStatus.PENDING,
        createdOffsetMs: 1,
      }),
    ]);

    const advanced = await service.advancePipeline(projectId);

    expect(advanced?.type).toBe(params.next);
    const targetQueueAdd = params.assertQueue(queues);
    expect(targetQueueAdd).toHaveBeenCalledTimes(1);
    const [payload] = targetQueueAdd.mock.calls[0];
    expect(payload.projectId).toBe(projectId);
    expect(payload.id).toBe('job-next');
    expect(payload.type).toBe(params.next);
  };

  it('advances YOUTUBE_DOWNLOAD -> TRANSCRIPTION', async () => {
    await runHandoffCase({
      completed: JobType.YOUTUBE_DOWNLOAD,
      next: JobType.TRANSCRIPTION,
      assertQueue: (queues) => queues.jobDispatchService.dispatch,
    });
  });

  it('advances TRANSCRIPTION -> ANALYZE_LYRICS', async () => {
    await runHandoffCase({
      completed: JobType.TRANSCRIPTION,
      next: JobType.ANALYZE_LYRICS,
      assertQueue: (queues) => queues.jobDispatchService.dispatch,
    });
  });

  it('advances ANALYZE_LYRICS -> GENERATE_IMAGES', async () => {
    await runHandoffCase({
      completed: JobType.ANALYZE_LYRICS,
      next: JobType.GENERATE_IMAGES,
      assertQueue: (queues) => queues.jobDispatchService.dispatch,
    });
  });

  it('advances GENERATE_IMAGES -> RENDER_VIDEO', async () => {
    await runHandoffCase({
      completed: JobType.GENERATE_IMAGES,
      next: JobType.RENDER_VIDEO,
      assertQueue: (queues) => queues.jobDispatchService.dispatch,
    });
  });

  it('advances RENDER_VIDEO -> FINALIZE and marks pipeline complete', async () => {
    const { service, prisma, queues } = createService();
    const dispatchSpy = jest
      .spyOn(service as any, 'dispatchJob')
      .mockResolvedValue(undefined);
    prisma.job.findMany
      .mockResolvedValueOnce([
        makeJob({
          id: 'job-render',
          projectId,
          type: JobType.RENDER_VIDEO,
          status: JobStatus.COMPLETED,
          createdOffsetMs: 0,
        }),
        makeJob({
          id: 'job-finalize',
          projectId,
          type: JobType.FINALIZE,
          status: JobStatus.PENDING,
          createdOffsetMs: 1,
        }),
      ])
      .mockResolvedValueOnce([
        makeJob({
          id: 'job-render',
          projectId,
          type: JobType.RENDER_VIDEO,
          status: JobStatus.COMPLETED,
          createdOffsetMs: 0,
        }),
        makeJob({
          id: 'job-finalize',
          projectId,
          type: JobType.FINALIZE,
          status: JobStatus.COMPLETED,
          createdOffsetMs: 1,
        }),
      ]);

    const next = await service.advancePipeline(projectId);
    expect(next?.type).toBe(JobType.FINALIZE);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-finalize', type: JobType.FINALIZE }),
    );

    const completion = await service.advancePipeline(projectId);
    expect(completion).toBeNull();
    expect(prisma.project.update).toHaveBeenCalledTimes(1);
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: projectId },
      data: { status: ProjectStatus.COMPLETED },
    });

    expect(queues.jobDispatchService.dispatch).not.toHaveBeenCalled();
  });

  it('returns null when pipeline has running jobs and no pending jobs', async () => {
    const { service, prisma, queues } = createService();
    prisma.job.findMany.mockResolvedValue([
      makeJob({
        id: 'job-running',
        projectId,
        type: JobType.ANALYZE_LYRICS,
        status: JobStatus.PROCESSING,
      }),
    ]);

    const result = await service.advancePipeline(projectId);

    expect(result).toBeNull();
    expect(prisma.project.update).not.toHaveBeenCalled();
    expect(queues.jobDispatchService.dispatch).not.toHaveBeenCalled();
  });
});
