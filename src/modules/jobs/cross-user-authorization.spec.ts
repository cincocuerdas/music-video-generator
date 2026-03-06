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

    const stub = {} as any;
    const service = new JobsService(
      jobCrudService as any,  // jobCrudService
      stub,                   // pipelineLifecycleService
      stub,                   // pipelineDispatchCoordinatorService
      stub,                   // pipelineStatusService
      stub,                   // pipelineCancellationService
      stub,                   // jobStateService
      stub,                   // styleLoraService
    );
    return { service, jobCrudService };
  };

  // -- startPipelineForUser --

  it('User A passes ownership on startPipelineForUser', async () => {
    const { service } = createService();
    // Ownership passes; startPipeline will fail on stub but not with 404
    await expect(
      service.startPipelineForUser(PROJECT_ID, USER_A),
    ).rejects.not.toBeInstanceOf(NotFoundException);
  });

  it('User B gets NotFoundException on startPipelineForUser', async () => {
    const { service } = createService();
    await expect(
      service.startPipelineForUser(PROJECT_ID, USER_B),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // -- getPipelineStatusForUser --

  it('User A passes ownership on getPipelineStatusForUser', async () => {
    const { service } = createService();
    await expect(
      service.getPipelineStatusForUser(PROJECT_ID, USER_A),
    ).rejects.not.toBeInstanceOf(NotFoundException);
  });

  it('User B gets NotFoundException on getPipelineStatusForUser', async () => {
    const { service } = createService();
    await expect(
      service.getPipelineStatusForUser(PROJECT_ID, USER_B),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // -- cancelPipelineForUser --

  it('User A passes ownership on cancelPipelineForUser', async () => {
    const { service } = createService();
    await expect(
      service.cancelPipelineForUser(PROJECT_ID, USER_A),
    ).rejects.not.toBeInstanceOf(NotFoundException);
  });

  it('User B gets NotFoundException on cancelPipelineForUser', async () => {
    const { service } = createService();
    await expect(
      service.cancelPipelineForUser(PROJECT_ID, USER_B),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
