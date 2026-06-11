import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisClientService } from '../../modules/redis';
import Redis from 'ioredis';

export type QuotaResource = 'projects' | 'generations' | 'gemini_calls';

export interface QuotaCheckResult {
  allowed: boolean;
  current: number;
  limit: number;
  resetsAt: string;
}

const RESOURCE_ENV_MAP: Record<QuotaResource, string> = {
  projects: 'QUOTA_DAILY_PROJECTS',
  generations: 'QUOTA_DAILY_GENERATIONS',
  gemini_calls: 'QUOTA_DAILY_GEMINI_CALLS',
};

const DEFAULT_LIMITS: Record<QuotaResource, number> = {
  projects: 10,
  generations: 5,
  gemini_calls: 50,
};

const TTL_SECONDS = 48 * 60 * 60; // 48h — auto-cleanup

@Injectable()
export class UserQuotaService implements OnModuleDestroy {
  private readonly logger = new Logger(UserQuotaService.name);
  private readonly client: Redis;
  private readonly limits: Record<QuotaResource, number>;
  private readonly enabled: boolean;

  constructor(
    private readonly redisClientService: RedisClientService,
    private readonly configService: ConfigService,
  ) {
    this.client = this.redisClientService.createClient('user-quota');
    this.enabled = (
      this.configService.get<string>('quota.enabled') || process.env.QUOTA_ENABLED || 'true'
    ).trim().toLowerCase() === 'true';

    this.limits = {
      projects: this.parseLimit('projects'),
      generations: this.parseLimit('generations'),
      gemini_calls: this.parseLimit('gemini_calls'),
    };

    this.logger.log(
      `User quota service initialized (enabled=${this.enabled}, limits=${JSON.stringify(this.limits)})`,
    );
  }

  async onModuleDestroy() {
    await this.redisClientService.releaseClient(this.client, 'user-quota');
  }

  private parseLimit(resource: QuotaResource): number {
    const envKey = RESOURCE_ENV_MAP[resource];
    const raw = this.configService.get<string>(envKey) || process.env[envKey];
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
    return DEFAULT_LIMITS[resource];
  }

  private getTodayKey(): string {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  }

  private getRedisKey(userId: string, resource: QuotaResource): string {
    return `quota:${userId}:${this.getTodayKey()}:${resource}`;
  }

  async getCurrentUsage(userId: string, resource: QuotaResource): Promise<number> {
    if (!this.enabled) return 0;
    const key = this.getRedisKey(userId, resource);
    const raw = await this.client.get(key);
    return raw ? parseInt(raw, 10) || 0 : 0;
  }

  async checkQuota(userId: string, resource: QuotaResource): Promise<QuotaCheckResult> {
    const current = await this.getCurrentUsage(userId, resource);
    const limit = this.limits[resource];
    const today = this.getTodayKey();
    const resetsAt = `${today}T23:59:59Z`;

    return {
      allowed: current < limit,
      current,
      limit,
      resetsAt,
    };
  }

  async incrementAndCheck(userId: string, resource: QuotaResource): Promise<QuotaCheckResult> {
    if (!this.enabled) {
      return {
        allowed: true,
        current: 0,
        limit: this.limits[resource],
        resetsAt: `${this.getTodayKey()}T23:59:59Z`,
      };
    }

    const key = this.getRedisKey(userId, resource);
    const newVal = await this.client.incr(key);

    if (newVal === 1) {
      await this.client.expire(key, TTL_SECONDS);
    }

    const limit = this.limits[resource];
    const today = this.getTodayKey();
    const resetsAt = `${today}T23:59:59Z`;

    return {
      allowed: newVal <= limit,
      current: newVal,
      limit,
      resetsAt,
    };
  }

  async getQuotaStatus(userId: string): Promise<Record<QuotaResource, QuotaCheckResult>> {
    const [projects, generations, gemini_calls] = await Promise.all([
      this.checkQuota(userId, 'projects'),
      this.checkQuota(userId, 'generations'),
      this.checkQuota(userId, 'gemini_calls'),
    ]);

    return { projects, generations, gemini_calls };
  }

  getLimits(): Record<QuotaResource, number> {
    return { ...this.limits };
  }
}
