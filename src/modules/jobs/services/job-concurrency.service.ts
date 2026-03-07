import { Injectable, Logger } from '@nestjs/common';
import { JobType } from '../dto';
import { parsePositiveIntEnv } from '../../../common/utils/env-parsers';

class PermitPool {
  private inUse = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.inUse < this.limit) {
      this.inUse += 1;
      return () => this.release();
    }

    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });

    this.inUse += 1;
    return () => this.release();
  }

  private release(): void {
    if (this.inUse > 0) {
      this.inUse -= 1;
    }

    const next = this.waiters.shift();
    if (next) {
      next();
    }
  }
}

const HEAVY_JOB_TYPES = new Set<JobType>([
  JobType.GENERATE_IMAGES,
  JobType.RENDER_VIDEO,
  JobType.TRAIN_LORA,
]);

const JOB_TYPE_LIMIT_ENV: Record<JobType, string> = {
  [JobType.YOUTUBE_DOWNLOAD]: 'JOB_CONCURRENCY_YOUTUBE_DOWNLOAD',
  [JobType.TRANSCRIPTION]: 'JOB_CONCURRENCY_TRANSCRIPTION',
  [JobType.ANALYZE_LYRICS]: 'JOB_CONCURRENCY_ANALYZE_LYRICS',
  [JobType.GENERATE_IMAGES]: 'JOB_CONCURRENCY_GENERATE_IMAGES',
  [JobType.RENDER_VIDEO]: 'JOB_CONCURRENCY_RENDER_VIDEO',
  [JobType.TRAIN_LORA]: 'JOB_CONCURRENCY_TRAIN_LORA',
  [JobType.FINALIZE]: 'JOB_CONCURRENCY_FINALIZE',
};

const JOB_TYPE_LIMIT_DEFAULT: Record<JobType, number> = {
  [JobType.YOUTUBE_DOWNLOAD]: 4,
  [JobType.TRANSCRIPTION]: 2,
  [JobType.ANALYZE_LYRICS]: 4,
  [JobType.GENERATE_IMAGES]: 1,
  [JobType.RENDER_VIDEO]: 1,
  [JobType.TRAIN_LORA]: 1,
  [JobType.FINALIZE]: 2,
};

@Injectable()
export class JobConcurrencyService {
  private readonly logger = new Logger(JobConcurrencyService.name);
  private readonly pools = new Map<JobType, PermitPool>();
  private readonly heavyPool = new PermitPool(
    parsePositiveIntEnv('JOB_CONCURRENCY_HEAVY_GLOBAL', 1),
  );

  constructor() {
    for (const jobType of Object.values(JobType)) {
      this.pools.set(
        jobType,
        new PermitPool(
          parsePositiveIntEnv(
            JOB_TYPE_LIMIT_ENV[jobType],
            JOB_TYPE_LIMIT_DEFAULT[jobType],
          ),
        ),
      );
    }
  }

  async runWithLimits<T>(jobType: JobType, work: () => Promise<T>): Promise<T> {
    const releases: Array<() => void> = [];

    try {
      if (HEAVY_JOB_TYPES.has(jobType)) {
        releases.push(await this.heavyPool.acquire());
      }

      const pool = this.pools.get(jobType);
      if (!pool) {
        this.logger.warn(`No concurrency pool configured for ${jobType}, running without cap.`);
        return await work();
      }

      releases.push(await pool.acquire());
      return await work();
    } finally {
      while (releases.length > 0) {
        const release = releases.pop();
        release?.();
      }
    }
  }
}
