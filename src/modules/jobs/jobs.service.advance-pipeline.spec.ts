import { JobStatus, JobType, ProjectStatus } from '@prisma/client';
import { PipelineLifecycleService } from './services/pipeline-lifecycle.service';
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

describe('PipelineLifecycleService.advancePipeline handoff', () => {
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
    const pipelineTransitionService = new PipelineTransitionService();
    const projectPipelineQualityService = {
      appendDegradedMeta: jest.fn().mockResolvedValue(undefined),
      appendStageMetrics: jest.fn().mockResolvedValue(undefined),
      clearMeta: jest.fn().mockResolvedValue(undefined),
    };

    const service = new PipelineLifecycleService(
      prisma as any,
      pipelineOrchestrator as any,
      pipelineTransitionService as any,
      projectPipelineQualityService as any,
    );

    return {
      service,
      prisma,
      dispatchJob: jest.fn().mockResolvedValue(undefined),
    };
  };

  const runHandoffCase = async (params: {
    completed: JobType;
    next: JobType;
  }) => {
    const { service, prisma, dispatchJob } = createService();
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

    const advanced = await service.advancePipeline(projectId, dispatchJob);

    expect(advanced?.type).toBe(params.next);
    expect(dispatchJob).toHaveBeenCalledTimes(1);
    expect(dispatchJob).toHaveBeenCalledWith(
      expect.objectContaining({ projectId, id: 'job-next', type: params.next }),
    );
  };

  it('advances YOUTUBE_DOWNLOAD -> TRANSCRIPTION', async () => {
    await runHandoffCase({
      completed: JobType.YOUTUBE_DOWNLOAD,
      next: JobType.TRANSCRIPTION,
    });
  });

  it('advances TRANSCRIPTION -> ANALYZE_LYRICS', async () => {
    await runHandoffCase({
      completed: JobType.TRANSCRIPTION,
      next: JobType.ANALYZE_LYRICS,
    });
  });

  it('advances ANALYZE_LYRICS -> GENERATE_IMAGES', async () => {
    await runHandoffCase({
      completed: JobType.ANALYZE_LYRICS,
      next: JobType.GENERATE_IMAGES,
    });
  });

  it('advances GENERATE_IMAGES -> RENDER_VIDEO', async () => {
    await runHandoffCase({
      completed: JobType.GENERATE_IMAGES,
      next: JobType.RENDER_VIDEO,
    });
  });

  it('advances RENDER_VIDEO -> FINALIZE and marks pipeline complete', async () => {
    const { service, prisma, dispatchJob } = createService();
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

    const next = await service.advancePipeline(projectId, dispatchJob);
    expect(next?.type).toBe(JobType.FINALIZE);
    expect(dispatchJob).toHaveBeenCalledTimes(1);
    expect(dispatchJob).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-finalize', type: JobType.FINALIZE }),
    );

    const completion = await service.advancePipeline(projectId, dispatchJob);
    expect(completion).toBeNull();
    expect(prisma.project.update).toHaveBeenCalledTimes(1);
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: projectId },
      data: { status: ProjectStatus.COMPLETED },
    });
  });

  it('returns null when pipeline has running jobs and no pending jobs', async () => {
    const { service, prisma, dispatchJob } = createService();
    prisma.job.findMany.mockResolvedValue([
      makeJob({
        id: 'job-running',
        projectId,
        type: JobType.ANALYZE_LYRICS,
        status: JobStatus.PROCESSING,
      }),
    ]);

    const result = await service.advancePipeline(projectId, dispatchJob);

    expect(result).toBeNull();
    expect(prisma.project.update).not.toHaveBeenCalled();
    expect(dispatchJob).not.toHaveBeenCalled();
  });
});
