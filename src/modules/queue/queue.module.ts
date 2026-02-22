import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { QUEUE_NAMES } from './queue.constants';

const parsePositiveNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        const redisUrl = (configService.get<string>('redis.url') || '').trim();
        const host = (configService.get<string>('redis.host') || '').trim();
        const port = configService.get<number>('redis.port') || 6379;
        const password = configService.get<string>('redis.password') || undefined;
        const connectTimeoutMs =
          configService.get<number>('redis.connectTimeoutMs') ?? 10_000;
        const retryBaseDelayMs =
          configService.get<number>('redis.retryBaseDelayMs') ?? 250;
        const retryMaxDelayMs =
          configService.get<number>('redis.retryMaxDelayMs') ?? 5_000;
        const maxRetriesPerRequest = configService.get<number | null>(
          'redis.maxRetriesPerRequest',
        );
        const enableOfflineQueue =
          configService.get<boolean>('redis.enableOfflineQueue') ?? true;
        const defaultJobAttempts = parsePositiveNumber(
          configService.get<string>('QUEUE_DEFAULT_JOB_ATTEMPTS'),
          2,
        );
        const defaultBackoffMs = parsePositiveNumber(
          configService.get<string>('QUEUE_DEFAULT_JOB_BACKOFF_MS'),
          10_000,
        );
        const defaultRemoveOnComplete = parsePositiveNumber(
          configService.get<string>('QUEUE_DEFAULT_REMOVE_ON_COMPLETE'),
          200,
        );
        const defaultRemoveOnFail = parsePositiveNumber(
          configService.get<string>('QUEUE_DEFAULT_REMOVE_ON_FAIL'),
          500,
        );

        const sharedConnectionOptions = {
          connectTimeout: connectTimeoutMs,
          maxRetriesPerRequest,
          enableOfflineQueue,
          retryStrategy: (attempts: number) =>
            Math.min(
              retryBaseDelayMs * 2 ** Math.max(0, attempts - 1),
              retryMaxDelayMs,
            ),
        };

        if (redisUrl) {
          const parsed = new URL(redisUrl);
          const dbSegment = parsed.pathname?.replace('/', '');
          const parsedDb = Number(dbSegment);

          return {
            connection: {
              host: parsed.hostname || host,
              port: parsed.port ? Number(parsed.port) : port,
              username: parsed.username
                ? decodeURIComponent(parsed.username)
                : undefined,
              password: parsed.password
                ? decodeURIComponent(parsed.password)
                : password,
              db: Number.isFinite(parsedDb) ? parsedDb : undefined,
              tls: parsed.protocol === 'rediss:' ? {} : undefined,
              ...sharedConnectionOptions,
            },
            defaultJobOptions: {
              attempts: defaultJobAttempts,
              backoff:
                defaultJobAttempts > 1
                  ? {
                      type: 'exponential' as const,
                      delay: defaultBackoffMs,
                    }
                  : undefined,
              removeOnComplete: defaultRemoveOnComplete,
              removeOnFail: defaultRemoveOnFail,
            },
          };
        }

        if (!host) {
          throw new Error(
            'Missing Redis configuration. Set REDIS_URL or REDIS_HOST/REDIS_PORT.',
          );
        }

        return {
          connection: {
            host,
            port,
            password,
            ...sharedConnectionOptions,
          },
          defaultJobOptions: {
            attempts: defaultJobAttempts,
            backoff:
              defaultJobAttempts > 1
                ? {
                    type: 'exponential' as const,
                    delay: defaultBackoffMs,
                  }
                : undefined,
            removeOnComplete: defaultRemoveOnComplete,
            removeOnFail: defaultRemoveOnFail,
          },
        };
      },
      inject: [ConfigService],
    }),
    BullModule.registerQueue(
      { name: QUEUE_NAMES.YOUTUBE_DOWNLOAD },
      { name: QUEUE_NAMES.TRANSCRIPTION },
      { name: QUEUE_NAMES.ANALYSIS },
      { name: QUEUE_NAMES.IMAGE_GENERATION },
      { name: QUEUE_NAMES.VIDEO_RENDER },
      { name: QUEUE_NAMES.TRAIN_LORA },
      { name: QUEUE_NAMES.NOTIFICATION },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule { }
