import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  ThrottlerStorage,
  ThrottlerStorageService,
} from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import Redis from 'ioredis';
import { RedisClientService } from './redis-client.service';

@Injectable()
export class RedisThrottlerStorageService implements ThrottlerStorage, OnModuleDestroy {
  private readonly logger = new Logger(RedisThrottlerStorageService.name);
  private readonly fallbackStorage = new ThrottlerStorageService();
  private client: Redis | null = null;
  private fallbackWarned = false;

  constructor(private readonly redisClientService: RedisClientService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    try {
      return await this.incrementWithRedis(
        key,
        ttl,
        limit,
        blockDuration,
        throttlerName,
      );
    } catch (error) {
      if (!this.fallbackWarned) {
        this.fallbackWarned = true;
        this.logger.warn(
          `Redis throttler unavailable, falling back to in-memory storage: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return this.fallbackStorage.increment(
        key,
        ttl,
        limit,
        blockDuration,
        throttlerName,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.fallbackStorage.onApplicationShutdown();
    if (!this.client) {
      return;
    }
    await this.redisClientService.releaseClient(this.client, 'throttler-storage');
    this.client = null;
  }

  private async incrementWithRedis(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const client = this.getClient();
    const countKey = this.getCountKey(throttlerName, key);
    const blockKey = this.getBlockKey(throttlerName, key);
    const effectiveBlockDuration = blockDuration > 0 ? blockDuration : ttl;

    const multiResult = await client
      .multi()
      .incr(countKey)
      .pttl(countKey)
      .pttl(blockKey)
      .exec();

    if (!multiResult) {
      throw new Error('Redis throttler multi pipeline returned null');
    }

    const [incrReply, countTtlReply, blockTtlReply] = multiResult;
    const totalHits = this.parseReplyNumber(incrReply);
    let countTtlMs = this.parseReplyNumber(countTtlReply);
    let blockTtlMs = this.parseReplyNumber(blockTtlReply);

    if (countTtlMs < 0) {
      await client.pexpire(countKey, ttl);
      countTtlMs = ttl;
    }

    let isBlocked = blockTtlMs > 0;
    if (!isBlocked && totalHits > limit) {
      await client.set(blockKey, '1', 'PX', effectiveBlockDuration, 'NX');
      blockTtlMs = await client.pttl(blockKey);
      if (blockTtlMs < 0) {
        blockTtlMs = effectiveBlockDuration;
      }
      isBlocked = true;
    }

    return {
      totalHits,
      timeToExpire: this.toSeconds(countTtlMs),
      isBlocked,
      timeToBlockExpire: isBlocked ? this.toSeconds(blockTtlMs) : 0,
    };
  }

  private getClient(): Redis {
    if (!this.client) {
      this.client = this.redisClientService.createClient('throttler-storage');
    }
    return this.client;
  }

  private getCountKey(throttlerName: string, key: string): string {
    return `throttler:${throttlerName}:${key}:count`;
  }

  private getBlockKey(throttlerName: string, key: string): string {
    return `throttler:${throttlerName}:${key}:block`;
  }

  private parseReplyNumber(reply: [Error | null, unknown]): number {
    const [error, value] = reply;
    if (error) {
      throw error;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Unexpected Redis reply value: ${String(value)}`);
    }
    return parsed;
  }

  private toSeconds(ttlMs: number): number {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      return 0;
    }
    return Math.ceil(ttlMs / 1000);
  }
}
