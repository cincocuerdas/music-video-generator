import { NotFoundException } from '@nestjs/common';
import { ProjectsService } from './projects.service';

/**
 * Cross-user authorization tests.
 *
 * User A creates a project. User B must never read, update, or
 * access any sub-resource of that project.  The services use
 * `findFirst({ where: { id, userId } })` so a wrong userId simply
 * means "not found" → NotFoundException (maps to 404 over HTTP).
 */
describe('Cross-user authorization (A/B isolation)', () => {
  const USER_A = '00000000-0000-4000-8000-000000000001';
  const USER_B = '11111111-1111-4000-8000-000000000002';
  const PROJECT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  // ── minimal Prisma mock ──────────────────────────────────────────────

  const createPrismaMock = () => ({
    project: {
      findFirst: jest.fn().mockImplementation(({ where }: any) => {
        // Only User A owns PROJECT_ID
        if (where.id === PROJECT_ID && where.userId === USER_A) {
          return Promise.resolve({
            id: PROJECT_ID,
            userId: USER_A,
            status: 'COMPLETED',
            videoUrl: '/output/videos/test.mp4',
            thumbnailUrl: null,
            jobs: [],
          });
        }
        return Promise.resolve(null);
      }),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: PROJECT_ID, userId: USER_A }),
      count: jest.fn().mockResolvedValue(0),
    },
  });

  const createService = () => {
    const prisma = createPrismaMock();
    const jobsService = { startPipelineForUser: jest.fn() };
    const feedbackService = {
      addFeedback: jest.fn(),
      getFeedback: jest.fn().mockResolvedValue([]),
      getFeedbackStats: jest.fn(),
    };
    const promptOptimization = { getPromptOptimization: jest.fn() };
    const liveSteering = {};

    const service = new ProjectsService(
      prisma as any,
      jobsService as any,
      feedbackService as any,
      promptOptimization as any,
      liveSteering as any,
    );
    return { service, prisma, feedbackService };
  };

  // ── User A (owner) baseline ──────────────────────────────────────────

  it('User A can read their own project', async () => {
    const { service } = createService();
    const project = await service.findOne(PROJECT_ID, USER_A);
    expect(project.id).toBe(PROJECT_ID);
  });

  // ── User B must be denied ────────────────────────────────────────────

  it('User B cannot GET /projects/:id (findOne)', async () => {
    const { service } = createService();
    await expect(service.findOne(PROJECT_ID, USER_B))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('User B cannot GET /projects/:id/video', async () => {
    const { service } = createService();
    await expect(service.getVideo(PROJECT_ID, USER_B))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('User B cannot GET /projects/:id/feedback', async () => {
    const { service } = createService();
    await expect(service.getFeedback(PROJECT_ID, USER_B))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('User B cannot GET /projects/:id/status', async () => {
    const { service } = createService();
    await expect(service.getStatus(PROJECT_ID, USER_B))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('User B cannot GET /projects/:id/download', async () => {
    const { service } = createService();
    await expect(service.getDownloadUrl(PROJECT_ID, USER_B))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('User B cannot PATCH /projects/:id (update)', async () => {
    const { service } = createService();
    await expect(service.update(PROJECT_ID, USER_B, { title: 'hacked' }))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('User B cannot DELETE /projects/:id (remove)', async () => {
    const { service } = createService();
    await expect(service.remove(PROJECT_ID, USER_B))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('User B cannot POST /projects/:id/feedback', async () => {
    const { service } = createService();
    await expect(
      service.addFeedback(PROJECT_ID, USER_B, {
        sceneIndex: 0,
        score: 1,
        prompt: 'test',
      } as any),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
