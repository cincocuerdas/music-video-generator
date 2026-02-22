import { ProjectsService } from './projects.service';

describe('ProjectsService.getPromptOptimization', () => {
  const createService = () => {
    const prisma = {
      project: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
      },
      $queryRawUnsafe: jest.fn(),
      $queryRaw: jest.fn(),
    };

    const jobsService = {};
    const eventsGateway = {};
    const embeddingsService = {
      generateEmbedding: jest.fn(),
    };
    const redisClientService = {
      createClient: jest.fn().mockReturnValue(null),
      releaseClient: jest.fn(),
    };

    const service = new ProjectsService(
      prisma as any,
      jobsService as any,
      eventsGateway as any,
      embeddingsService as any,
      redisClientService as any,
    );

    return { service, prisma, embeddingsService };
  };

  it('filters embedding similarity by project style', async () => {
    const { service, prisma, embeddingsService } = createService();

    prisma.project.findUnique.mockResolvedValue({ visualStyle: 'cinematic' });
    embeddingsService.generateEmbedding.mockResolvedValue([0.12, 0.34, 0.56]);
    prisma.$queryRawUnsafe.mockResolvedValue([
      { id: '1', prompt: 'cinematic dramatic lighting detail', score: 1, distance: 0.08 },
      { id: '2', prompt: 'cinematic dramatic lighting portrait', score: 1, distance: 0.09 },
      { id: '3', prompt: 'cinematic volumetric lighting detail', score: 1, distance: 0.11 },
      { id: '4', prompt: 'amateur artifacts distorted framing', score: -1, distance: 0.13 },
      { id: '5', prompt: 'distorted artifacts low quality', score: -1, distance: 0.14 },
    ]);

    const fallbackSpy = jest
      .spyOn(service, 'optimizePromptFromFeedback')
      .mockResolvedValue({ qualityBoost: 'fallback', negativeBoost: 'fallback', confidence: 0.4 });

    const result = await service.getPromptOptimization('project-1');

    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, vectorLiteral, styleArg] = prisma.$queryRawUnsafe.mock.calls[0];
    expect(String(sql)).toContain('"style" = $2::text');
    expect(styleArg).toBe('cinematic');
    expect(typeof vectorLiteral).toBe('string');
    expect(result.confidence).toBeGreaterThan(0);
    expect(fallbackSpy).not.toHaveBeenCalled();
  });

  it('falls back once when similar embedded feedback is insufficient', async () => {
    const { service, prisma, embeddingsService } = createService();

    prisma.project.findUnique.mockResolvedValue({ visualStyle: 'cinematic' });
    embeddingsService.generateEmbedding.mockResolvedValue([0.22, 0.44, 0.66]);
    prisma.$queryRawUnsafe.mockResolvedValue([]);

    const fallbackSpy = jest
      .spyOn(service, 'optimizePromptFromFeedback')
      .mockResolvedValue({ qualityBoost: 'masterpiece', negativeBoost: 'artifacts', confidence: 0.5 });

    const result = await service.getPromptOptimization('project-2');

    expect(fallbackSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ qualityBoost: 'masterpiece', negativeBoost: 'artifacts', confidence: 0.5 });
  });

  it('falls back when embedding provider throws (e.g. HTTP 404)', async () => {
    const { service, prisma, embeddingsService } = createService();

    prisma.project.findUnique.mockResolvedValue({ visualStyle: 'cinematic' });
    embeddingsService.generateEmbedding.mockRejectedValue(
      new Error('Request failed with status code 404'),
    );

    const fallbackSpy = jest
      .spyOn(service, 'optimizePromptFromFeedback')
      .mockResolvedValue({ qualityBoost: 'safe-fallback', negativeBoost: 'distorted', confidence: 0.2 });

    const result = await service.getPromptOptimization('project-404');

    expect(fallbackSpy).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(result).toEqual({
      qualityBoost: 'safe-fallback',
      negativeBoost: 'distorted',
      confidence: 0.2,
    });
  });
});
