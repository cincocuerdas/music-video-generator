import { NotFoundException } from '@nestjs/common';
import { JobsService } from './jobs.service';

/**
 * Cross-user authorization -- JobsService.
 *
 * All user-scoped methods delegate ownership to
 * jobCrudService.assertProjectOwnership(projectId, userId).
 * Wrong userId -> NotFoundException (404).
 */
describe('Cross-user authorization -- JobsService', () => {
  const USER_A = '00000000-0000-4000-8000-000000000001';
  const USER_B = '11111111-1111-4000-8000-000000000002';
  const PROJECT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  const createService = () => {
    const jobCrudService = {
      assertProjectOwnership: jest.fn().mockImplementation(
        (projectId: string, userId: string) => {
          if (projectId === PROJECT_ID && userId === USER_A) {
            return Promise.resolve();
          }
          return Promise.reject(
            new NotFoundException(`Project with id ${projectId} not found`),
          );
        },
      ),
    };

    const pipelineLifecycleService = {
      startPipeline: jest.fn().mockResolvedValue([{ id: 'job-1', projectId: PROJECT_ID }]),
    };
    const pipelineStatusService = {
      getPipelineStatus: jest.fn().mockResolvedValue({
        projectId: PROJECT_ID,
        status: 'success',
        jobs: [],
      }),
    };
    const pipelineCancellationService = {
      cancelPipeline: jest.fn().mockResolvedValue(undefined),
    };
    const stub = {} as any;
    const service = new JobsService(
      jobCrudService as any,  // jobCrudService
      pipelineLifecycleService as any,
      stub,                   // pipelineDispatchCoordinatorService
      pipelineStatusService as any,
      pipelineCancellationService as any,
      stub,                   // jobStateService
      stub,                   // styleLoraService
    );
    return {
      service,
      jobCrudService,
      pipelineLifecycleService,
      pipelineStatusService,
      pipelineCancellationService,
    };
  };

  // -- startPipelineForUser --

  it('User A passes ownership on startPipelineForUser', async () => {
    const { service, pipelineLifecycleService } = createService();
    await expect(service.startPipelineForUser(PROJECT_ID, USER_A)).resolves.toEqual([
      { id: 'job-1', projectId: PROJECT_ID },
    ]);
    expect(pipelineLifecycleService.startPipeline).toHaveBeenCalledTimes(1);
  });

  it('User B gets NotFoundException on startPipelineForUser', async () => {
    const { service } = createService();
    await expect(
      service.startPipelineForUser(PROJECT_ID, USER_B),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // -- getPipelineStatusForUser --

  it('User A passes ownership on getPipelineStatusForUser', async () => {
    const { service, pipelineStatusService } = createService();
    await expect(service.getPipelineStatusForUser(PROJECT_ID, USER_A)).resolves.toEqual({
      projectId: PROJECT_ID,
      status: 'success',
      jobs: [],
    });
    expect(pipelineStatusService.getPipelineStatus).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('User B gets NotFoundException on getPipelineStatusForUser', async () => {
    const { service } = createService();
    await expect(
      service.getPipelineStatusForUser(PROJECT_ID, USER_B),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // -- cancelPipelineForUser --

  it('User A passes ownership on cancelPipelineForUser', async () => {
    const { service, pipelineCancellationService } = createService();
    await expect(service.cancelPipelineForUser(PROJECT_ID, USER_A)).resolves.toBeUndefined();
    expect(pipelineCancellationService.cancelPipeline).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('User B gets NotFoundException on cancelPipelineForUser', async () => {
    const { service } = createService();
    await expect(
      service.cancelPipelineForUser(PROJECT_ID, USER_B),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
