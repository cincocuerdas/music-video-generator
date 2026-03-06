import { JobStatus, JobType } from '@prisma/client';
import { DeadLetterReplayService } from './dead-letter-replay.service';

describe('DeadLetterReplayService', () => {
  const originalJob = {
    id: 'job-1',
    projectId: 'project-1',
    type: JobType.ANALYZE_LYRICS,
    status: JobStatus.FAILED,
    progress: 100,
    currentStep: 'failed',
    workerId: 'worker-1',
    errorMessage: 'boom',
    inputData: null,
    outputData: null,
    createdAt: new Date('2026-03-01T00:00:00.000Z'),
    updatedAt: new Date('2026-03-01T00:00:00.000Z'),
  };

  it('replays a failed job and dispatches it back into the pipeline coordinator', async () => {
    const prisma = {
      project: {
        findFirst: jest.fn().mockResolvedValue({ id: 'project-1' }),
      },
      job: {
        findUnique: jest.fn().mockResolvedValue(originalJob),
        update: jest.fn().mockResolvedValue({
          ...originalJob,
          status: JobStatus.PENDING,
          progress: 0,
          currentStep: 'Replay requested from dead-letter queue',
          workerId: null,
          errorMessage: null,
        }),
      },
    };
    const deadLetterService = {
      getJob: jest.fn().mockResolvedValue({
        id: 'dlq-1',
        data: {
          projectId: 'project-1',
          jobId: 'job-1',
          sourceQueue: 'analysis',
          jobType: JobType.ANALYZE_LYRICS,
        },
      }),
      updateJobData: jest.fn().mockResolvedValue(undefined),
    };
    const pipelineDispatchCoordinatorService = {
      dispatch: jest.fn().mockResolvedValue(undefined),
    };

    const service = new DeadLetterReplayService(
      prisma as any,
      deadLetterService as any,
      pipelineDispatchCoordinatorService as any,
    );

    const result = await service.replayForUser('dlq-1', 'user-1');

    expect(prisma.project.findFirst).toHaveBeenCalledWith({
      where: { id: 'project-1', userId: 'user-1' },
      select: { id: true },
    });
    expect(prisma.job.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: {
        status: JobStatus.PENDING,
        progress: 0,
        currentStep: 'Replay requested from dead-letter queue',
        errorMessage: null,
        workerId: null,
      },
    });
    expect(pipelineDispatchCoordinatorService.dispatch).toHaveBeenCalledTimes(1);
    expect(deadLetterService.updateJobData).toHaveBeenCalledWith(
      'dlq-1',
      expect.objectContaining({
        projectId: 'project-1',
        jobId: 'job-1',
        replayedOriginalJobId: 'job-1',
      }),
    );
    expect(result).toEqual({
      replayed: true,
      deadLetterId: 'dlq-1',
      jobId: 'job-1',
      projectId: 'project-1',
      type: JobType.ANALYZE_LYRICS,
    });
  });

  it('does not replay jobs that are already active', async () => {
    const prisma = {
      project: {
        findFirst: jest.fn().mockResolvedValue({ id: 'project-1' }),
      },
      job: {
        findUnique: jest.fn().mockResolvedValue({
          ...originalJob,
          status: JobStatus.PROCESSING,
        }),
      },
    };
    const deadLetterService = {
      getJob: jest.fn().mockResolvedValue({
        id: 'dlq-1',
        data: { projectId: 'project-1', jobId: 'job-1' },
      }),
      updateJobData: jest.fn(),
    };
    const pipelineDispatchCoordinatorService = {
      dispatch: jest.fn(),
    };

    const service = new DeadLetterReplayService(
      prisma as any,
      deadLetterService as any,
      pipelineDispatchCoordinatorService as any,
    );

    const result = await service.replayForUser('dlq-1', 'user-1');

    expect(result).toEqual({
      replayed: false,
      reason: 'Job job-1 is already PROCESSING',
      jobId: 'job-1',
    });
    expect(pipelineDispatchCoordinatorService.dispatch).not.toHaveBeenCalled();
    expect(deadLetterService.updateJobData).not.toHaveBeenCalled();
  });
});
