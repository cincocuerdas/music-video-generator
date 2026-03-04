import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { RedisClientService } from '../../redis';
import { QUEUE_NAMES } from '../../queue';
import { parsePositiveIntEnv } from '../../../common/utils/env-parsers';

export interface MitigationSnapshot {
  active: boolean;
  activatedAt: string | null;
  deactivatedAt: string | null;
  reason: string | null;
  actions: string[];
  imageQueuePaused: boolean;
  earlyFailoverActive: boolean;
  /** Minimum seconds between re-evaluation to avoid flapping */
  cooldownMs: number;
  consecutiveCriticalChecks: number;
  requiredConsecutiveChecks: number;
}

interface MitigationState {
  active: boolean;
  activatedAt: number | null;
  deactivatedAt: number | null;
  reason: string | null;
  actions: string[];
}

const REDIS_KEY = 'mvg:slo_mitigation';
const REDIS_TTL_SECONDS = 3600; // 1 hour — auto-expire as safety net

@Injectable()
export class SloMitigationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SloMitigationService.name);
  private redisClient: Redis | null = null;

  /** Minimum ms between state transitions to avoid flapping */
  private readonly cooldownMs = parsePositiveIntEnv(
    'SLO_MITIGATION_COOLDOWN_MS',
    5 * 60 * 1000, // 5 min
  );

  /** Require N consecutive critical checks before activating mitigation */
  private readonly requiredConsecutiveChecks = parsePositiveIntEnv(
    'SLO_MITIGATION_CONSECUTIVE_CHECKS',
    2,
  );

  private state: MitigationState = {
    active: false,
    activatedAt: null,
    deactivatedAt: null,
    reason: null,
    actions: [],
  };

  private lastTransitionAtMs = 0;
  private consecutiveCriticalChecks = 0;

  constructor(
    private readonly redisClientService: RedisClientService,
    @InjectQueue(QUEUE_NAMES.IMAGE_GENERATION)
    private readonly imageGenerationQueue: Queue,
  ) {
    this.initRedis();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Called after each SLO evaluation. Automatically activates or deactivates
   * mitigation based on the SLO status.
   */
  async evaluateAndMitigate(sloResult: Record<string, unknown>): Promise<void> {
    const status = String(sloResult.status || 'met');
    const hasCritical = Boolean(sloResult.hasCriticalAlerts);
    const metrics = (sloResult.metrics || {}) as Record<string, unknown>;
    const p95Ms = Number(metrics.p95Ms || 0);
    const pipelineCount = Number(metrics.pipelineCount || 0);

    if (status === 'critical' && hasCritical) {
      this.consecutiveCriticalChecks += 1;

      if (
        !this.state.active &&
        this.consecutiveCriticalChecks >= this.requiredConsecutiveChecks &&
        this.canTransition()
      ) {
        await this.activate(
          `Pipeline SLO critical: p95=${Math.round(p95Ms / 1000)}s over ${pipelineCount} pipelines`,
        );
      }
    } else {
      this.consecutiveCriticalChecks = 0;

      if (this.state.active && this.canTransition()) {
        await this.deactivate();
      }
    }
  }

  snapshot(): MitigationSnapshot {
    return {
      active: this.state.active,
      activatedAt: this.state.activatedAt
        ? new Date(this.state.activatedAt).toISOString()
        : null,
      deactivatedAt: this.state.deactivatedAt
        ? new Date(this.state.deactivatedAt).toISOString()
        : null,
      reason: this.state.reason,
      actions: [...this.state.actions],
      imageQueuePaused: this.state.active,
      earlyFailoverActive: this.state.active,
      cooldownMs: this.cooldownMs,
      consecutiveCriticalChecks: this.consecutiveCriticalChecks,
      requiredConsecutiveChecks: this.requiredConsecutiveChecks,
    };
  }

  isActive(): boolean {
    return this.state.active;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * On startup: ensure the image queue is NOT paused and clear any stale
   * Redis mitigation flag. This prevents leftover pause state from a prior
   * process that crashed while mitigation was active.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.imageGenerationQueue.resume();
      this.logger.log('[SLO-MITIGATION] Startup: image-generation queue ensured resumed');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[SLO-MITIGATION] Startup: failed to resume queue: ${msg}`);
    }
    try {
      await this.clearRedisFlag();
      this.logger.log('[SLO-MITIGATION] Startup: stale Redis flag cleared');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[SLO-MITIGATION] Startup: failed to clear Redis flag: ${msg}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.state.active) {
      await this.deactivate();
    }
    if (this.redisClient) {
      await this.redisClientService.releaseClient(this.redisClient, 'slo-mitigation');
      this.redisClient = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MITIGATION ACTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  private async activate(reason: string): Promise<void> {
    const actions: string[] = [];

    // 1. Pause the image-generation queue so no *new* image jobs start
    try {
      await this.imageGenerationQueue.pause();
      actions.push('image_queue_paused');
      this.logger.warn(`[SLO-MITIGATION] Paused image-generation queue`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`[SLO-MITIGATION] Failed to pause image queue: ${msg}`);
      actions.push(`image_queue_pause_failed:${msg}`);
    }

    // 2. Write Redis flag for early failover (Python scripts read this)
    try {
      await this.setRedisFlag({
        active: true,
        reason,
        activatedAt: new Date().toISOString(),
        earlyFailover: true,
        maxConcurrency: 1,
      });
      actions.push('redis_early_failover_flag_set');
      this.logger.warn(`[SLO-MITIGATION] Redis early-failover flag set`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`[SLO-MITIGATION] Failed to set Redis flag: ${msg}`);
      actions.push(`redis_flag_set_failed:${msg}`);
    }

    this.state = {
      active: true,
      activatedAt: Date.now(),
      deactivatedAt: null,
      reason,
      actions,
    };
    this.lastTransitionAtMs = Date.now();

    this.logger.warn(`[SLO-MITIGATION] ACTIVATED — ${reason}`);

    // Auto-resume after a safety window so we don't stay paused forever
    const autoResumeMs = parsePositiveIntEnv('SLO_MITIGATION_AUTO_RESUME_MS', 15 * 60 * 1000);
    const activationStartedAt = this.state.activatedAt;
    setTimeout(async () => {
      if (this.state.active && this.state.activatedAt === activationStartedAt) {
        this.logger.warn(`[SLO-MITIGATION] Auto-resuming after ${autoResumeMs / 1000}s safety timeout`);
        await this.deactivate();
      }
    }, autoResumeMs).unref();
  }

  private async deactivate(): Promise<void> {
    const actions: string[] = [];

    // 1. Resume the image-generation queue
    try {
      await this.imageGenerationQueue.resume();
      actions.push('image_queue_resumed');
      this.logger.log(`[SLO-MITIGATION] Resumed image-generation queue`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`[SLO-MITIGATION] Failed to resume image queue: ${msg}`);
      actions.push(`image_queue_resume_failed:${msg}`);
    }

    // 2. Clear Redis flag
    try {
      await this.clearRedisFlag();
      actions.push('redis_early_failover_flag_cleared');
      this.logger.log(`[SLO-MITIGATION] Redis early-failover flag cleared`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`[SLO-MITIGATION] Failed to clear Redis flag: ${msg}`);
      actions.push(`redis_flag_clear_failed:${msg}`);
    }

    const previousReason = this.state.reason;
    this.state = {
      active: false,
      activatedAt: this.state.activatedAt,
      deactivatedAt: Date.now(),
      reason: null,
      actions,
    };
    this.lastTransitionAtMs = Date.now();
    this.consecutiveCriticalChecks = 0;

    this.logger.log(`[SLO-MITIGATION] DEACTIVATED — previously: ${previousReason}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  private canTransition(): boolean {
    const elapsed = Date.now() - this.lastTransitionAtMs;
    return elapsed >= this.cooldownMs;
  }

  private initRedis(): void {
    try {
      this.redisClient = this.redisClientService.createClient('slo-mitigation');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[SLO-MITIGATION] Redis not available: ${msg}`);
    }
  }

  private async setRedisFlag(value: Record<string, unknown>): Promise<void> {
    if (!this.redisClient) {
      return;
    }
    await this.redisClient.set(
      REDIS_KEY,
      JSON.stringify(value),
      'EX',
      REDIS_TTL_SECONDS,
    );
  }

  private async clearRedisFlag(): Promise<void> {
    if (!this.redisClient) {
      return;
    }
    await this.redisClient.del(REDIS_KEY);
  }
}
