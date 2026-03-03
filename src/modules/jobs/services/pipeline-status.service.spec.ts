import { JobStatus, JobType, ProjectStatus } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';
import { PipelineStatusService } from './pipeline-status.service';

const now = () => new Date('2026-03-02T00:00:00.000Z');

const makeJob = (params: {
  id: string;
  projectId: string;
  type: JobType;
  status: JobStatus;
  progress?: number;
  outputData?: Record<string, unknown> | null;
  createdOffsetMs?: number;
}) =>
  ({
    id: params.id,
    projectId: params.projectId,
    type: params.type,
    status: params.status,
    progress: params.progress ?? 0,
    currentStep: null,
    workerId: null,
    errorMessage: null,
    inputData: null,
    outputData: params.outputData ?? null,
    createdAt: new Date(now().getTime() + (params.createdOffsetMs ?? 0)),
    updatedAt: new Date(now().getTime() + (params.createdOffsetMs ?? 0)),
  }) as any;

describe('PipelineStatusService', () => {
  const projectId = 'project-1';

  const createService = () => {
    const prisma = {
      project: {
        findUnique: jest.fn(),
      },
      job: {
        findMany: jest.fn(),
      },
    };
    const service = new PipelineStatusService(prisma as any);
    return { service, prisma };
  };

  it('throws NotFoundException when project does not exist', async () => {
    const { service, prisma } = createService();
    prisma.project.findUnique.mockResolvedValue(null);

    await expect(service.getPipelineStatus(projectId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns processing status with normalized overall progress', async () => {
    const { service, prisma } = createService();
    prisma.project.findUnique.mockResolvedValue({
      id: projectId,
      status: ProjectStatus.PROCESSING,
    });
    prisma.job.findMany.mockResolvedValue([
      makeJob({
        id: 'job-1',
        projectId,
        type: JobType.YOUTUBE_DOWNLOAD,
        status: JobStatus.COMPLETED,
        createdOffsetMs: 0,
      }),
      makeJob({
        id: 'job-2',
        projectId,
        type: JobType.TRANSCRIPTION,
        status: JobStatus.PROCESSING,
        progress: 40,
        createdOffsetMs: 1,
      }),
      makeJob({
        id: 'job-3',
        projectId,
        type: JobType.ANALYZE_LYRICS,
        status: JobStatus.PENDING,
        createdOffsetMs: 2,
      }),
      makeJob({
        id: 'job-4',
        projectId,
        type: JobType.TRAIN_LORA,
        status: JobStatus.PROCESSING,
        progress: 100,
        createdOffsetMs: 3,
      }),
    ]);

    const result = await service.getPipelineStatus(projectId);

    expect(result.pipelineStatus).toBe('processing');
    expect(result.currentJob).toBe(JobType.TRANSCRIPTION);
    expect(result.overallProgress).toBe(47);
    expect(result.degraded).toBe(false);
    expect(result.degradedReasons).toEqual([]);
    expect(result.jobs).toHaveLength(4);
  });

  it('returns degraded status for completed project with degraded stage outputs', async () => {
    const { service, prisma } = createService();
    prisma.project.findUnique.mockResolvedValue({
      id: projectId,
      status: ProjectStatus.COMPLETED,
    });
    prisma.job.findMany.mockResolvedValue([
      makeJob({
        id: 'job-1',
        projectId,
        type: JobType.YOUTUBE_DOWNLOAD,
        status: JobStatus.COMPLETED,
        outputData: { status: 'ok' },
      }),
      makeJob({
        id: 'job-2',
        projectId,
        type: JobType.TRANSCRIPTION,
        status: JobStatus.COMPLETED,
        outputData: {
          status: 'degraded',
          degradedReasons: ['fallback transcript'],
        },
      }),
      makeJob({
        id: 'job-3',
        projectId,
        type: JobType.ANALYZE_LYRICS,
        status: JobStatus.COMPLETED,
        outputData: { status: 'ok' },
      }),
    ]);

    const result = await service.getPipelineStatus(projectId);

    expect(result.pipelineStatus).toBe('degraded');
    expect(result.degraded).toBe(true);
    expect(result.degradedReasons).toEqual(['TRANSCRIPTION: fallback transcript']);
    expect(result.degradedReasonCodes).toEqual(['transcription.fallback_transcript']);
    expect(result.overallProgress).toBe(100);
    expect(result.currentJob).toBeNull();
  });
});

