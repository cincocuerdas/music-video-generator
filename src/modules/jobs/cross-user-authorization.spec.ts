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
      assertProjectOwnership: jest.fn().mockImplementation((projectId: string, userId: string) => {
        if (projectId === PROJECT_ID && userId === USER_A) {
          return Promise.resolve();
        }
        return Promise.reject(new NotFoundException(`Project with id ${projectId} not found`));
      }),
    };

    const pipelineLifecycleService = {} as any;
    const pipelineDispatchCoordinatorService = {} as any;
    const pipelineStatusService = {} as any;
    const pipelineCancellationService = {} as any;
    const jobStateService = {} as any;
    const styleLoraService = {} as any;

    const service = new JobsService(
      jobCrudService as any,
      pipelineLifecycleService,
      pipelineDispatchCoordinatorService,
      pipelineStatusService,
      pipelineCancellationService,
      jobStateService,
      styleLoraService,
    );

    return {
      service,
      jobCrudService,
    };
  };

  it('User A passes ownership on startPipelineForUser', async () => {
    const { service } = createService();
    const startPipelineSpy = jest
      .spyOn(service, 'startPipeline')
      .mockResolvedValue([{ id: 'job-1', projectId: PROJECT_ID }] as any);

    await expect(service.startPipelineForUser(PROJECT_ID, USER_A)).resolves.toEqual([
      { id: 'job-1', projectId: PROJECT_ID },
    ]);
    expect(startPipelineSpy).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('User B gets NotFoundException on startPipelineForUser', async () => {
    const { service } = createService();
    const startPipelineSpy = jest.spyOn(service, 'startPipeline');

    await expect(service.startPipelineForUser(PROJECT_ID, USER_B)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(startPipelineSpy).not.toHaveBeenCalled();
  });

  it('User A passes ownership on getPipelineStatusForUser', async () => {
    const { service } = createService();
    const getPipelineStatusSpy = jest.spyOn(service, 'getPipelineStatus').mockResolvedValue({
      projectId: PROJECT_ID,
      status: 'success',
      jobs: [],
    } as any);

    await expect(service.getPipelineStatusForUser(PROJECT_ID, USER_A)).resolves.toEqual({
      projectId: PROJECT_ID,
      status: 'success',
      jobs: [],
    });
    expect(getPipelineStatusSpy).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('User B gets NotFoundException on getPipelineStatusForUser', async () => {
    const { service } = createService();
    const getPipelineStatusSpy = jest.spyOn(service, 'getPipelineStatus');

    await expect(service.getPipelineStatusForUser(PROJECT_ID, USER_B)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(getPipelineStatusSpy).not.toHaveBeenCalled();
  });

  it('User A passes ownership on cancelPipelineForUser', async () => {
    const { service } = createService();
    const cancelPipelineSpy = jest.spyOn(service, 'cancelPipeline').mockResolvedValue(undefined);

    await expect(service.cancelPipelineForUser(PROJECT_ID, USER_A)).resolves.toBeUndefined();
    expect(cancelPipelineSpy).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('User B gets NotFoundException on cancelPipelineForUser', async () => {
    const { service } = createService();
    const cancelPipelineSpy = jest.spyOn(service, 'cancelPipeline');

    await expect(service.cancelPipelineForUser(PROJECT_ID, USER_B)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(cancelPipelineSpy).not.toHaveBeenCalled();
  });
});
