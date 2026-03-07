import { JobType } from '../dto';
import { JobConcurrencyService } from './job-concurrency.service';

describe('JobConcurrencyService', () => {
  const createService = (overrides: Record<string, string> = {}) => {
    const original = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(overrides)) {
      original.set(key, process.env[key]);
      process.env[key] = value;
    }

    const service = new JobConcurrencyService();

    for (const [key, previous] of original.entries()) {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }

    return service;
  };

  it('serializes work when per-job concurrency is 1', async () => {
    const service = createService({
      JOB_CONCURRENCY_TRANSCRIPTION: '1',
    });

    let active = 0;
    let maxActive = 0;

    const work = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
    };

    await Promise.all([
      service.runWithLimits(JobType.TRANSCRIPTION, work),
      service.runWithLimits(JobType.TRANSCRIPTION, work),
      service.runWithLimits(JobType.TRANSCRIPTION, work),
    ]);

    expect(maxActive).toBe(1);
  });

  it('enforces a global heavy-job cap across different heavy job types', async () => {
    const service = createService({
      JOB_CONCURRENCY_GENERATE_IMAGES: '2',
      JOB_CONCURRENCY_RENDER_VIDEO: '2',
      JOB_CONCURRENCY_TRAIN_LORA: '2',
      JOB_CONCURRENCY_HEAVY_GLOBAL: '1',
    });

    let active = 0;
    let maxActive = 0;

    const work = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
    };

    await Promise.all([
      service.runWithLimits(JobType.GENERATE_IMAGES, work),
      service.runWithLimits(JobType.RENDER_VIDEO, work),
      service.runWithLimits(JobType.TRAIN_LORA, work),
    ]);

    expect(maxActive).toBe(1);
  });
});
