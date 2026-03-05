import { JobStatus, JobType } from '@prisma/client';
import { PipelineDispatchCoordinatorService } from './pipeline-dispatch-coordinator.service';

describe('PipelineDispatchCoordinatorService', () => {
  const baseJob = {
    id: 'job-1',
    projectId: 'project-1',
    type: JobType.FINALIZE,
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

  it('handles finalize callback by marking completed and advancing pipeline', async () => {
    const jobDispatchService = {
      dispatch: jest.fn(async (_job: any, onFinalize: (job: any) => Promise<void>) => {
        await onFinalize(baseJob);
      }),
    };
    const jobStateService = {
      markAsCompleted: jest.fn().mockResolvedValue(undefined),
    };
    const pipelineLifecycleService = {
      advancePipeline: jest.fn().mockResolvedValue(null),
    };

    const service = new PipelineDispatchCoordinatorService(
      jobDispatchService as any,
      jobStateService as any,
      pipelineLifecycleService as any,
    );

    await service.dispatch(baseJob as any);

    expect(jobDispatchService.dispatch).toHaveBeenCalledTimes(1);
    expect(jobStateService.markAsCompleted).toHaveBeenCalledWith(baseJob.id, { finalized: true });
    expect(pipelineLifecycleService.advancePipeline).toHaveBeenCalledTimes(1);
    expect(pipelineLifecycleService.advancePipeline).toHaveBeenCalledWith(
      baseJob.projectId,
      expect.any(Function),
    );
  });
});
