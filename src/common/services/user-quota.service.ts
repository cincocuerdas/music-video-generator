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
  scope: 'user' | 'global';
}

const USER_RESOURCE_ENV: Record<QuotaResource, string> = {
  projects: 'QUOTA_DAILY_PROJECTS',
  generations: 'QUOTA_DAILY_GENERATIONS',
  gemini_calls: 'QUOTA_DAILY_GEMINI_CALLS',
};

const USER_DEFAULTS: Record<QuotaResource, number> = {
  projects: 10,
  generations: 5,
  gemini_calls: 50,
};

const GLOBAL_RESOURCE_ENV: Record<QuotaResource, string> = {
  projects: 'QUOTA_GLOBAL_DAILY_PROJECTS',
  generations: 'QUOTA_GLOBAL_DAILY_GENERATIONS',
  gemini_calls: 'QUOTA_GLOBAL_DAILY_GEMINI_CALLS',
};

const GLOBAL_DEFAULTS: Record<QuotaResource, number> = {
  projects: 100,
  generations: 50,
  gemini_calls: 500,
};

const TTL_SECONDS = 48 * 60 * 60; // 48h auto-cleanup

@Injectable()
export class UserQuotaService implements OnModuleDestroy {
  private readonly logger = new Logger(UserQuotaService.name);
  private readonly client: Redis;
  private readonly enabled: boolean;
  private readonly userLimits: Record<QuotaResource, number>;
  private readonly globalLimits: Record<QuotaResource, number>;
  private readonly maxConcurrentGenerations: number;

  constructor(
    private readonly redisClientService: RedisClientService,
    private readonly configService: ConfigService,
  ) {
    this.client = this.redisClientService.createClient('user-quota');
    this.enabled = (
      this.configService.get<string>('quota.enabled') || process.env.QUOTA_ENABLED || 'true'
    ).trim().toLowerCase() === 'true';

    this.userLimits = {
      projects: this.parseLimit('projects', USER_RESOURCE_ENV, USER_DEFAULTS),
      generations: this.parseLimit('generations', USER_RESOURCE_ENV, USER_DEFAULTS),
      gemini_calls: this.parseLimit('gemini_calls', USER_RESOURCE_ENV, USER_DEFAULTS),
    };

    this.globalLimits = {
      projects: this.parseLimit('projects', GLOBAL_RESOURCE_ENV, GLOBAL_DEFAULTS),
      generations: this.parseLimit('generations', GLOBAL_RESOURCE_ENV, GLOBAL_DEFAULTS),
      gemini_calls: this.parseLimit('gemini_calls', GLOBAL_RESOURCE_ENV, GLOBAL_DEFAULTS),
    };

    this.maxConcurrentGenerations = this.parseEnvInt('MAX_CONCURRENT_GENERATIONS', 3);

    this.logger.log(
      `Quota service: enabled=${this.enabled}, user=${JSON.stringify(this.userLimits)}, global=${JSON.stringify(this.globalLimits)}, maxConcurrent=${this.maxConcurrentGenerations}`,
    );
  }

  async onModuleDestroy() {
    await this.redisClientService.releaseClient(this.client, 'user-quota');
  }

  private parseEnvInt(envKey: string, fallback: number): number {
    const raw = this.configService.get<string>(envKey) || process.env[envKey];
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  }

  private parseLimit(
    resource: QuotaResource,
    envMap: Record<QuotaResource, string>,
    defaults: Record<QuotaResource, number>,
  ): number {
    const raw = this.configService.get<string>(envMap[resource]) || process.env[envMap[resource]];
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : defaults[resource];
  }

  private getTodayKey(): string {
    return new Date().toISOString().slice(0, 10);
  }

  // ── Per-user quotas ──────────────────────────────────────────────

  private userKey(userId: string, resource: QuotaResource): string {
    return `quota:user:${userId}:${this.getTodayKey()}:${resource}`;
  }

  async checkUserQuota(userId: string, resource: QuotaResource): Promise<QuotaCheckResult> {
    if (!this.enabled) {
      return { allowed: true, current: 0, limit: this.userLimits[resource], resetsAt: this.getResetsAt(), scope: 'user' };
    }
    const current = await this.getUserUsage(userId, resource);
    return {
      allowed: current < this.userLimits[resource],
      current,
      limit: this.userLimits[resource],
      resetsAt: this.getResetsAt(),
      scope: 'user',
    };
  }

  async getUserUsage(userId: string, resource: QuotaResource): Promise<number> {
    if (!this.enabled) return 0;
    const raw = await this.client.get(this.userKey(userId, resource));
    return raw ? parseInt(raw, 10) || 0 : 0;
  }

  async incrementUser(userId: string, resource: QuotaResource): Promise<QuotaCheckResult> {
    if (!this.enabled) {
      return { allowed: true, current: 0, limit: this.userLimits[resource], resetsAt: this.getResetsAt(), scope: 'user' };
    }
    const key = this.userKey(userId, resource);
    const newVal = await this.client.incr(key);
    if (newVal === 1) await this.client.expire(key, TTL_SECONDS);
    return {
      allowed: newVal <= this.userLimits[resource],
      current: newVal,
      limit: this.userLimits[resource],
      resetsAt: this.getResetsAt(),
      scope: 'user',
    };
  }

  // ── Global quotas (all users combined) ───────────────────────────

  private globalKey(resource: QuotaResource): string {
    return `quota:global:${this.getTodayKey()}:${resource}`;
  }

  async checkGlobalQuota(resource: QuotaResource): Promise<QuotaCheckResult> {
    if (!this.enabled) {
      return { allowed: true, current: 0, limit: this.globalLimits[resource], resetsAt: this.getResetsAt(), scope: 'global' };
    }
    const current = await this.getGlobalUsage(resource);
    return {
      allowed: current < this.globalLimits[resource],
      current,
      limit: this.globalLimits[resource],
      resetsAt: this.getResetsAt(),
      scope: 'global',
    };
  }

  async getGlobalUsage(resource: QuotaResource): Promise<number> {
    if (!this.enabled) return 0;
    const raw = await this.client.get(this.globalKey(resource));
    return raw ? parseInt(raw, 10) || 0 : 0;
  }

  async incrementGlobal(resource: QuotaResource): Promise<QuotaCheckResult> {
    if (!this.enabled) {
      return { allowed: true, current: 0, limit: this.globalLimits[resource], resetsAt: this.getResetsAt(), scope: 'global' };
    }
    const key = this.globalKey(resource);
    const newVal = await this.client.incr(key);
    if (newVal === 1) await this.client.expire(key, TTL_SECONDS);
    return {
      allowed: newVal <= this.globalLimits[resource],
      current: newVal,
      limit: this.globalLimits[resource],
      resetsAt: this.getResetsAt(),
      scope: 'global',
    };
  }

  // ── Combined check (user + global) ───────────────────────────────

  async checkAndIncrement(userId: string, resource: QuotaResource): Promise<{ ok: boolean; reason?: string; user: QuotaCheckResult; global: QuotaCheckResult }> {
    const userCheck = await this.checkUserQuota(userId, resource);
    if (!userCheck.allowed) {
      return { ok: false, reason: `Daily ${resource} limit reached (${userCheck.current}/${userCheck.limit})`, user: userCheck, global: await this.checkGlobalQuota(resource) };
    }

    const globalCheck = await this.checkGlobalQuota(resource);
    if (!globalCheck.allowed) {
      return { ok: false, reason: `Global daily ${resource} limit reached (${globalCheck.current}/${globalCheck.limit})`, user: userCheck, global: globalCheck };
    }

    const userResult = await this.incrementUser(userId, resource);
    const globalResult = await this.incrementGlobal(resource);

    if (!userResult.allowed) {
      return { ok: false, reason: `Daily ${resource} limit reached (${userResult.current}/${userResult.limit})`, user: userResult, global: globalResult };
    }
    if (!globalResult.allowed) {
      return { ok: false, reason: `Global daily ${resource} limit reached (${globalResult.current}/${globalResult.limit})`, user: userResult, global: globalResult };
    }

    return { ok: true, user: userResult, global: globalResult };
  }

  // ── Concurrent generations (hardware protection) ─────────────────

  private readonly CONCURRENT_KEY = 'quota:concurrent:generations';

  async acquireGenerationSlot(): Promise<{ allowed: boolean; current: number; limit: number }> {
    if (!this.enabled) {
      return { allowed: true, current: 0, limit: this.maxConcurrentGenerations };
    }
    const current = parseInt((await this.client.get(this.CONCURRENT_KEY)) || '0', 10);
    if (current >= this.maxConcurrentGenerations) {
      return { allowed: false, current, limit: this.maxConcurrentGenerations };
    }
    const newVal = await this.client.incr(this.CONCURRENT_KEY);
    if (newVal === 1) await this.client.expire(this.CONCURRENT_KEY, 60 * 60); // 1h safety TTL
    return {
      allowed: newVal <= this.maxConcurrentGenerations,
      current: newVal,
      limit: this.maxConcurrentGenerations,
    };
  }

  async releaseGenerationSlot(): Promise<void> {
    if (!this.enabled) return;
    const current = parseInt((await this.client.get(this.CONCURRENT_KEY)) || '0', 10);
    if (current > 0) {
      await this.client.set(this.CONCURRENT_KEY, String(current - 1));
    }
  }

  // ── Status ───────────────────────────────────────────────────────

  private getResetsAt(): string {
    return `${this.getTodayKey()}T23:59:59Z`;
  }

  getLimits(): { user: Record<QuotaResource, number>; global: Record<QuotaResource, number>; maxConcurrent: number } {
    return {
      user: { ...this.userLimits },
      global: { ...this.globalLimits },
      maxConcurrent: this.maxConcurrentGenerations,
    };
  }
}
