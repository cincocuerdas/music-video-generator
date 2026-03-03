import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Job, JobType } from '@prisma/client';
import { JobsOptions, Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import { parsePositiveIntEnv } from '../../../common/utils/env-parsers';
import { QUEUE_NAMES } from '../../queue';

const RETRY_ENV_CONFIG: Partial<
  Record<JobType, { attemptsEnv: string; attemptsDefault: number; delayEnv: string; delayDefault: number }>
> = {
  [JobType.YOUTUBE_DOWNLOAD]: {
    attemptsEnv: 'JOB_RETRY_ATTEMPTS_YOUTUBE_DOWNLOAD',
    attemptsDefault: 2,
    delayEnv: 'JOB_RETRY_DELAY_MS_YOUTUBE_DOWNLOAD',
    delayDefault: 15_000,
  },
  [JobType.TRANSCRIPTION]: {
    attemptsEnv: 'JOB_RETRY_ATTEMPTS_TRANSCRIPTION',
    attemptsDefault: 2,
    delayEnv: 'JOB_RETRY_DELAY_MS_TRANSCRIPTION',
    delayDefault: 20_000,
  },
  [JobType.ANALYZE_LYRICS]: {
    attemptsEnv: 'JOB_RETRY_ATTEMPTS_ANALYZE_LYRICS',
    attemptsDefault: 3,
    delayEnv: 'JOB_RETRY_DELAY_MS_ANALYZE_LYRICS',
    delayDefault: 10_000,
  },
  [JobType.GENERATE_IMAGES]: {
    attemptsEnv: 'JOB_RETRY_ATTEMPTS_GENERATE_IMAGES',
    attemptsDefault: 3,
    delayEnv: 'JOB_RETRY_DELAY_MS_GENERATE_IMAGES',
    delayDefault: 15_000,
  },
  [JobType.RENDER_VIDEO]: {
    attemptsEnv: 'JOB_RETRY_ATTEMPTS_RENDER_VIDEO',
    attemptsDefault: 2,
    delayEnv: 'JOB_RETRY_DELAY_MS_RENDER_VIDEO',
    delayDefault: 20_000,
  },
  [JobType.TRAIN_LORA]: {
    attemptsEnv: 'JOB_RETRY_ATTEMPTS_TRAIN_LORA',
    attemptsDefault: 2,
    delayEnv: 'JOB_RETRY_DELAY_MS_TRAIN_LORA',
    delayDefault: 60_000,
  },
};

@Injectable()
export class JobDispatchService {
  constructor(
    @InjectQueue(QUEUE_NAMES.YOUTUBE_DOWNLOAD)
    private readonly youtubeDownloadQueue: Queue,
    @InjectQueue(QUEUE_NAMES.TRANSCRIPTION)
    private readonly transcriptionQueue: Queue,
    @InjectQueue(QUEUE_NAMES.ANALYSIS)
    private readonly analysisQueue: Queue,
    @InjectQueue(QUEUE_NAMES.IMAGE_GENERATION)
    private readonly imageGenerationQueue: Queue,
    @InjectQueue(QUEUE_NAMES.VIDEO_RENDER)
    private readonly videoRenderQueue: Queue,
    @InjectQueue(QUEUE_NAMES.TRAIN_LORA)
    private readonly trainLoraQueue: Queue,
  ) {}

  private getQueueJobOptions(type: JobType, jobId: string): JobsOptions {
    const envConfig = RETRY_ENV_CONFIG[type];
    const policy = envConfig
      ? {
          attempts: parsePositiveIntEnv(envConfig.attemptsEnv, envConfig.attemptsDefault),
          delayMs: parsePositiveIntEnv(envConfig.delayEnv, envConfig.delayDefault),
        }
      : { attempts: 1, delayMs: 0 };
    return {
      jobId,
      attempts: policy.attempts,
      backoff:
        policy.attempts > 1
          ? {
              type: 'exponential',
              delay: policy.delayMs,
            }
          : undefined,
      removeOnComplete: 200,
      removeOnFail: 500,
    };
  }

  async dispatch(
    job: Job,
    onFinalize: (job: Job) => Promise<void>,
  ): Promise<void> {
    const inputData =
      job.inputData && typeof job.inputData === 'object'
        ? (job.inputData as Record<string, unknown>)
        : {};
    const style = inputData.style;
    const correlationId =
      typeof inputData.correlationId === 'string' && inputData.correlationId.trim()
        ? inputData.correlationId.trim()
        : `${job.projectId}:${job.id}:${randomUUID().slice(0, 8)}`;

    const payload = {
      jobId: job.id,
      projectId: job.projectId,
      style: typeof style === 'string' ? style : undefined,
      correlationId,
    };
    const queueOptions = this.getQueueJobOptions(job.type, job.id);

    switch (job.type) {
      case JobType.YOUTUBE_DOWNLOAD:
        await this.youtubeDownloadQueue.add('process', payload, queueOptions);
        break;
      case JobType.TRANSCRIPTION:
        await this.transcriptionQueue.add('process', payload, queueOptions);
        break;
      case JobType.ANALYZE_LYRICS:
        await this.analysisQueue.add('process', payload, queueOptions);
        break;
      case JobType.GENERATE_IMAGES:
        await this.imageGenerationQueue.add('process', payload, queueOptions);
        break;
      case JobType.RENDER_VIDEO:
        await this.videoRenderQueue.add('process', payload, queueOptions);
        break;
      case JobType.TRAIN_LORA:
        await this.trainLoraQueue.add('process', payload, queueOptions);
        break;
      case JobType.FINALIZE:
        await onFinalize(job);
        break;
    }
  }
}
