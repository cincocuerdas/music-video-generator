import { JobStatus, JobType, ProjectStatus } from '@prisma/client';
import { JobStateService } from './job-state.service';

describe('JobStateService', () => {
  const baseJob = {
    id: 'job-1',
    projectId: 'project-1',
    type: JobType.GENERATE_IMAGES,
    status: JobStatus.PENDING,
    progress: 0,
    currentStep: null,
    workerId: null,
    errorMessage: null,
    inputData: null,
    outputData: null,
    createdAt: new Date('2026-03-01T00:00:00.000Z'),
    updatedAt: new Date('2026-03-01T00:00:00.000Z'),
  };

  const createService = () => {
    const prisma = {
      job: {
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      project: {
        update: jest.fn(),
      },
      $transaction: jest.fn(async (cb: any) =>
        cb({
          job: {
            update: prisma.job.update,
            updateMany: prisma.job.updateMany,
          },
          project: {
            update: prisma.project.update,
          },
        }),
      ),
    };

    const qualityService = {
      appendDegradedMeta: jest.fn().mockResolvedValue(undefined),
      appendStageMetrics: jest.fn().mockResolvedValue(undefined),
    };

    const service = new JobStateService(prisma as any, qualityService as any);
    return { service, prisma, qualityService };
  };

  it('marks job as processing', async () => {
    const { service, prisma } = createService();
    prisma.job.findUnique.mockResolvedValue(baseJob);
    prisma.job.update.mockResolvedValue({
      ...baseJob,
      status: JobStatus.PROCESSING,
      workerId: 'worker-1',
    });

    const result = await service.markAsProcessing(baseJob.id, 'worker-1');

    expect(result.status).toBe(JobStatus.PROCESSING);
    expect(prisma.job.update).toHaveBeenCalledWith({
      where: { id: baseJob.id },
      data: { status: JobStatus.PROCESSING, workerId: 'worker-1' },
    });
  });

  it('marks job as completed and appends quality metrics for pipeline stages', async () => {
    const { service, prisma, qualityService } = createService();
    prisma.job.findUnique.mockResolvedValue(baseJob);
    prisma.job.update.mockResolvedValue({
      ...baseJob,
      status: JobStatus.COMPLETED,
      progress: 100,
      outputData: { status: 'success' },
    });

    await service.markAsCompleted(baseJob.id, { status: 'success' });

    expect(qualityService.appendDegradedMeta).toHaveBeenCalledTimes(1);
    expect(qualityService.appendStageMetrics).toHaveBeenCalledTimes(1);
  });

  it('marks job as failed and cancels pending pipeline jobs', async () => {
    const { service, prisma } = createService();
    prisma.job.update.mockResolvedValue({
      ...baseJob,
      status: JobStatus.FAILED,
    });
    prisma.job.updateMany.mockResolvedValue({ count: 2 });
    prisma.project.update.mockResolvedValue({
      id: baseJob.projectId,
      status: ProjectStatus.FAILED,
    });

    const result = await service.markAsFailed(baseJob.id, 'boom');

    expect(result.status).toBe(JobStatus.FAILED);
    expect(prisma.job.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: baseJob.projectId },
      data: { status: ProjectStatus.FAILED },
    });
  });

  it('updates progress', async () => {
    const { service, prisma } = createService();
    prisma.job.findUnique.mockResolvedValue(baseJob);
    prisma.job.update.mockResolvedValue({
      ...baseJob,
      progress: 42,
      currentStep: 'working',
    });

    const result = await service.updateProgress(baseJob.id, 42, 'working');

    expect(result.progress).toBe(42);
    expect(result.currentStep).toBe('working');
  });

  it('does not cancel pipeline for non-pipeline job failure', async () => {
    const { service, prisma } = createService();
    prisma.job.update.mockResolvedValue({
      ...baseJob,
      type: JobType.TRAIN_LORA,
      status: JobStatus.FAILED,
    });

    await service.markAsFailed(baseJob.id, 'dead-letter failure');

    expect(prisma.job.updateMany).not.toHaveBeenCalled();
    expect(prisma.project.update).not.toHaveBeenCalled();
  });
});
