import { ProjectsService } from './projects.service';

describe('ProjectsService.getPromptOptimization', () => {
  const createService = () => {
    const repo = {};
    const jobsService = {};
    const feedbackService = {};
    const promptOptimization = {
      getPromptOptimization: jest.fn(),
    };
    const liveSteering = {};

    const service = new ProjectsService(
      repo as any,
      jobsService as any,
      feedbackService as any,
      promptOptimization as any,
      liveSteering as any,
    );

    return { service, promptOptimization };
  };

  it('delegates optimization to PromptOptimizationService', async () => {
    const { service, promptOptimization } = createService();
    promptOptimization.getPromptOptimization.mockResolvedValue({
      qualityBoost: 'masterpiece',
      negativeBoost: 'artifacts',
      confidence: 0.7,
    });

    const result = await service.getPromptOptimization('project-1');

    expect(promptOptimization.getPromptOptimization).toHaveBeenCalledWith(
      'project-1',
      undefined,
      undefined,
    );
    expect(result).toEqual({
      qualityBoost: 'masterpiece',
      negativeBoost: 'artifacts',
      confidence: 0.7,
    });
  });

  it('forwards userId and currentPrompt when provided', async () => {
    const { service, promptOptimization } = createService();
    promptOptimization.getPromptOptimization.mockResolvedValue({
      qualityBoost: 'cinematic',
      negativeBoost: 'distorted',
      confidence: 0.5,
    });

    const result = await service.getPromptOptimization(
      'project-2',
      'user-1',
      'close-up portrait with clean hands',
    );

    expect(promptOptimization.getPromptOptimization).toHaveBeenCalledWith(
      'project-2',
      'user-1',
      'close-up portrait with clean hands',
    );
    expect(result.confidence).toBe(0.5);
  });
});
