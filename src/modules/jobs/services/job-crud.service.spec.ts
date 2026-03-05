import { JobStatus, JobType } from '@prisma/client';
import { JobCrudService } from './job-crud.service';

describe('JobCrudService', () => {
  const baseJob = {
    id: 'job-1',
    projectId: 'project-1',
    type: JobType.TRANSCRIPTION,
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
      project: {
        findFirst: jest.fn(),
      },
      job: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
    };
    return { service: new JobCrudService(prisma as any), prisma };
  };

  it('asserts project ownership', async () => {
    const { service, prisma } = createService();
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    await expect(service.assertProjectOwnership('project-1', 'user-1')).resolves.toBeUndefined();
  });

  it('creates and finds jobs', async () => {
    const { service, prisma } = createService();
    prisma.job.create.mockResolvedValue(baseJob);
    prisma.job.findUnique.mockResolvedValue(baseJob);
    const created = await service.create({
      projectId: 'project-1',
      type: JobType.TRANSCRIPTION,
      inputData: { foo: 'bar' },
    });
    const found = await service.findOne('job-1');
    expect(created.id).toBe('job-1');
    expect(found.id).toBe('job-1');
  });

  it('updates and removes for user', async () => {
    const { service, prisma } = createService();
    prisma.job.findFirst.mockResolvedValue(baseJob);
    prisma.job.update.mockResolvedValue({ ...baseJob, progress: 50 });
    prisma.job.delete.mockResolvedValue(baseJob);

    const updated = await service.updateForUser('job-1', 'user-1', { progress: 50 });
    const removed = await service.removeForUser('job-1', 'user-1');

    expect(updated.progress).toBe(50);
    expect(removed.id).toBe('job-1');
  });
});
