import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { RedisOptions } from 'ioredis';

@Injectable()
export class RedisClientService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisClientService.name);
  private readonly clients = new Set<Redis>();
  private readonly lastErrorLogAtByLabel = new Map<string, number>();
  private readonly lastReconnectLogAtByLabel = new Map<string, number>();
  private readonly errorLogThrottleMs = 10_000;
  private readonly reconnectLogThrottleMs = 5_000;

  constructor(private readonly configService: ConfigService) {}

  createClient(label: string): Redis {
    const redisUrl = this.getRedisUrl();
    const client = new Redis(redisUrl, {
      ...this.getRedisOptions(),
      // Attach listeners before first network attempt to avoid unhandled ioredis error events.
      lazyConnect: true,
    });

    client.on('error', (err) => {
      const now = Date.now();
      const lastLogAt = this.lastErrorLogAtByLabel.get(label) ?? 0;
      if (now - lastLogAt >= this.errorLogThrottleMs) {
        this.lastErrorLogAtByLabel.set(label, now);
        this.logger.error(`[${label}] Redis error: ${err.message}`);
      } else {
        this.logger.debug(`[${label}] Redis error (throttled): ${err.message}`);
      }
    });

    client.on('connect', () => {
      this.logger.debug(`[${label}] Redis socket connected`);
    });

    client.on('ready', () => {
      this.logger.log(`[${label}] Redis ready`);
    });

    client.on('close', () => {
      this.logger.debug(`[${label}] Redis connection closed`);
    });

    client.on('reconnecting', (delayMs: number) => {
      const now = Date.now();
      const lastLogAt = this.lastReconnectLogAtByLabel.get(label) ?? 0;
      if (now - lastLogAt >= this.reconnectLogThrottleMs) {
        this.lastReconnectLogAtByLabel.set(label, now);
        this.logger.warn(`[${label}] Redis reconnecting in ${delayMs}ms`);
      } else {
        this.logger.debug(`[${label}] Redis reconnecting (throttled) in ${delayMs}ms`);
      }
    });

    client.on('end', () => {
      this.logger.warn(`[${label}] Redis connection ended`);
    });

    this.clients.add(client);
    client.connect().catch((err) => {
      const now = Date.now();
      const lastLogAt = this.lastErrorLogAtByLabel.get(label) ?? 0;
      if (now - lastLogAt >= this.errorLogThrottleMs) {
        this.lastErrorLogAtByLabel.set(label, now);
        this.logger.error(`[${label}] Redis connect failed: ${err.message}`);
      } else {
        this.logger.debug(`[${label}] Redis connect failed (throttled): ${err.message}`);
      }
    });
    return client;
  }

  async releaseClient(client: Redis, label?: string): Promise<void> {
    if (!this.clients.has(client)) {
      return;
    }

    try {
      if (client.status === 'end') {
        client.disconnect(false);
      } else {
        await client.quit();
      }
      if (label) {
        this.logger.log(`[${label}] Redis disconnected`);
      }
    } catch (error) {
      this.logger.warn(
        `[${label || 'unknown'}] Failed to close Redis client: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      client.disconnect(false);
    } finally {
      this.clients.delete(client);
      if (label) {
        this.lastErrorLogAtByLabel.delete(label);
        this.lastReconnectLogAtByLabel.delete(label);
      }
    }
  }

  async onModuleDestroy() {
    const clients = Array.from(this.clients);
    await Promise.allSettled(
      clients.map(async (client) => {
        try {
          if (client.status === 'end') {
            client.disconnect(false);
          } else {
            await client.quit();
          }
        } finally {
          this.clients.delete(client);
        }
      }),
    );
    this.lastErrorLogAtByLabel.clear();
    this.lastReconnectLogAtByLabel.clear();
  }

  private getRedisUrl(): string {
    const redisUrl = this.configService.get<string>('redis.url');
    if (!redisUrl) {
      throw new Error('Redis URL is not configured');
    }
    return redisUrl;
  }

  private getRedisOptions(): RedisOptions {
    const connectTimeoutMs =
      this.configService.get<number>('redis.connectTimeoutMs') ?? 10_000;
    const retryBaseDelayMs =
      this.configService.get<number>('redis.retryBaseDelayMs') ?? 250;
    const retryMaxDelayMs =
      this.configService.get<number>('redis.retryMaxDelayMs') ?? 5_000;
    const maxRetriesPerRequest = this.configService.get<number | null>(
      'redis.maxRetriesPerRequest',
    );
    const enableOfflineQueue =
      this.configService.get<boolean>('redis.enableOfflineQueue') ?? true;

    return {
      connectTimeout: connectTimeoutMs,
      maxRetriesPerRequest,
      enableOfflineQueue,
      retryStrategy: (attempts: number) =>
        Math.min(retryBaseDelayMs * 2 ** Math.max(0, attempts - 1), retryMaxDelayMs),
    };
  }
}
