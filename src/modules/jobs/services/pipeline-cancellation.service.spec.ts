import { JobStatus, ProjectStatus } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';
import { PipelineCancellationService } from './pipeline-cancellation.service';

describe('PipelineCancellationService', () => {
  const projectId = 'project-1';

  const createService = () => {
    const prisma = {
      project: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({ id: projectId, status: ProjectStatus.CANCELLED }),
      },
      job: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      $transaction: jest.fn().mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    };

    const service = new PipelineCancellationService(prisma as any);
    return { service, prisma };
  };

  it('throws NotFoundException when project does not exist', async () => {
    const { service, prisma } = createService();
    prisma.project.findUnique.mockResolvedValue(null);

    await expect(service.cancelPipeline(projectId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('cancels pending and processing jobs, then marks project cancelled', async () => {
    const { service, prisma } = createService();
    prisma.project.findUnique.mockResolvedValue({ id: projectId, status: ProjectStatus.PROCESSING });

    await service.cancelPipeline(projectId);

    expect(prisma.job.updateMany).toHaveBeenCalledWith({
      where: {
        projectId,
        status: { in: [JobStatus.PENDING, JobStatus.PROCESSING] },
      },
      data: { status: JobStatus.CANCELLED },
    });
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: projectId },
      data: { status: ProjectStatus.CANCELLED },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

