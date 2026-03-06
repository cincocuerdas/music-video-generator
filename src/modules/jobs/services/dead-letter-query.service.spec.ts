import { DeadLetterQueryService } from './dead-letter-query.service';

describe('DeadLetterQueryService', () => {
  it('returns only dead-letter entries for owned projects', async () => {
    const prisma = {
      project: {
        findMany: jest.fn().mockResolvedValue([{ id: 'project-owned' }]),
      },
    };
    const deadLetterService = {
      listJobs: jest.fn().mockResolvedValue([
        {
          id: 'dlq-1',
          name: 'dead-letter',
          attemptsMade: 2,
          failedReason: null,
          timestamp: 111,
          data: { projectId: 'project-owned', jobId: 'job-1' },
          getState: jest.fn().mockResolvedValue('completed'),
        },
        {
          id: 'dlq-2',
          name: 'dead-letter',
          attemptsMade: 1,
          failedReason: 'boom',
          timestamp: 222,
          data: { projectId: 'project-other', jobId: 'job-2' },
          getState: jest.fn().mockResolvedValue('failed'),
        },
      ]),
    };

    const service = new DeadLetterQueryService(prisma as any, deadLetterService as any);

    const result = await service.listForUser('user-1', 25);

    expect(deadLetterService.listJobs).toHaveBeenCalledWith(25);
    expect(result).toEqual({
      total: 1,
      items: [
        {
          deadLetterId: 'dlq-1',
          status: 'completed',
          name: 'dead-letter',
          attemptsMade: 2,
          failedReason: null,
          timestamp: 111,
          data: { projectId: 'project-owned', jobId: 'job-1' },
        },
      ],
    });
  });
});
