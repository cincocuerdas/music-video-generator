import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { JobStatus, JobType } from '@prisma/client';
import { CircuitBreakerService } from '../../common/services';
import { PrismaService } from '../prisma';
import { QUEUE_NAMES } from '../queue';
import { HealthAlertingService } from './health-alerting.service';
import { EventsMetricsService } from '../events';
import {
  extractDegradedReasonCodesFromOutputData,
  extractDegradedReasonsFromOutputData,
  isCorePipelineJob,
} from '../jobs/pipeline-quality.utils';

type QueueKey =
  | 'youtubeDownload'
  | 'transcription'
  | 'analysis'
  | 'imageGeneration'
  | 'videoRender'
  | 'trainLora';

interface QueueSnapshot {
  key: QueueKey;
  name: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
  paused: number;
  retrying: number;
  retryingSampled: boolean;
}

interface JobTypeStatsRow {
  type: string;
  failedTotal: number | bigint | null;
  failedLast24h: number | bigint | null;
  completedLast24h: number | bigint | null;
  avgDurationMs24h: number | null;
  p95DurationMs24h: number | null;
}

interface DegradedByTypeRow {
  type: string;
  completedTotal: number | bigint | null;
  degradedTotal: number | bigint | null;
  completedWindow: number | bigint | null;
  degradedWindow: number | bigint | null;
}

interface DegradedStageAlert {
  severity: 'warning' | 'critical';
  type: string;
  degradedRateWindowPct: number;
  degradedWindow: number;
  completedWindow: number;
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly retryInspectMax = this.parsePositiveIntEnv(
    'HEALTH_OPS_MAX_INSPECT_JOBS',
    500,
  );
  private readonly degradedWarnPct = this.parsePercentEnv('HEALTH_DEGRADED_ALERT_WARN_PCT', 5);
  private readonly degradedCriticalPct = this.parsePercentEnv(
    'HEALTH_DEGRADED_ALERT_CRITICAL_PCT',
    20,
  );
  private readonly degradedMinCompletedWindow = this.parsePositiveIntEnv(
    'HEALTH_DEGRADED_ALERT_MIN_COMPLETED_WINDOW',
    5,
  );
  private readonly p95WarnMs = this.parsePositiveIntEnv('HEALTH_SLO_P95_WARN_MS', 120000);
  private readonly p95CriticalMs = this.parsePositiveIntEnv('HEALTH_SLO_P95_CRITICAL_MS', 300000);
  private readonly p95MinCompleted24h = this.parsePositiveIntEnv(
    'HEALTH_SLO_P95_MIN_COMPLETED_24H',
    3,
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly healthAlertingService: HealthAlertingService,
    private readonly eventsMetricsService: EventsMetricsService,
    private readonly circuitBreakerService: CircuitBreakerService,
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

  private parsePositiveIntEnv(key: string, fallback: number): number {
    const raw = process.env[key];
    if (!raw) {
      return fallback;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  }

  private toNumber(value: number | bigint | null | undefined): number {
    if (typeof value === 'bigint') {
      return Number(value);
    }
    return Number(value || 0);
  }

  private parsePercentEnv(key: string, fallback: number): number {
    const raw = process.env[key];
    if (!raw) {
      return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.min(100, Math.max(0, parsed));
  }

  private normalizeWindowHours(hours: number): number {
    if (!Number.isFinite(hours)) {
      return 24;
    }
    return Math.max(1, Math.min(24 * 30, Math.floor(hours)));
  }

  private getManagedQueues(): Array<{ key: QueueKey; queue: Queue }> {
    return [
      { key: 'youtubeDownload', queue: this.youtubeDownloadQueue },
      { key: 'transcription', queue: this.transcriptionQueue },
      { key: 'analysis', queue: this.analysisQueue },
      { key: 'imageGeneration', queue: this.imageGenerationQueue },
      { key: 'videoRender', queue: this.videoRenderQueue },
      { key: 'trainLora', queue: this.trainLoraQueue },
    ];
  }

  private async getRetryingCount(queue: Queue): Promise<{ count: number; sampled: boolean }> {
    const statuses: Array<'delayed' | 'waiting' | 'active'> = ['delayed', 'waiting', 'active'];
    const ids = new Set<string>();
    let sampled = false;

    for (const status of statuses) {
      const statusCount = await queue.getJobCountByTypes(status);
      const inspectCount = Math.min(statusCount, this.retryInspectMax);
      sampled = sampled || statusCount > inspectCount;
      if (inspectCount <= 0) {
        continue;
      }

      const jobs = await queue.getJobs([status], 0, inspectCount - 1, true);
      for (const job of jobs) {
        if ((job.attemptsMade || 0) > 0) {
          ids.add(String(job.id));
        }
      }
    }

    return { count: ids.size, sampled };
  }

  private async getQueueSnapshot(key: QueueKey, queue: Queue): Promise<QueueSnapshot> {
    const counts = await queue.getJobCounts(
      'waiting',
      'active',
      'delayed',
      'failed',
      'completed',
      'paused',
    );
    const retrying = await this.getRetryingCount(queue);

    return {
      key,
      name: queue.name,
      waiting: counts.waiting || 0,
      active: counts.active || 0,
      delayed: counts.delayed || 0,
      failed: counts.failed || 0,
      completed: counts.completed || 0,
      paused: counts.paused || 0,
      retrying: retrying.count,
      retryingSampled: retrying.sampled,
    };
  }

  private async getJobTypeStats(): Promise<
    Array<{
      type: string;
      failedTotal: number;
      failedLast24h: number;
      completedLast24h: number;
      avgDurationMs24h: number;
      p95DurationMs24h: number;
    }>
  > {
    const rows = await this.prisma.$queryRaw<JobTypeStatsRow[]>`
      SELECT
        "type",
        COUNT(*) FILTER (WHERE "status" = 'FAILED') AS "failedTotal",
        COUNT(*) FILTER (
          WHERE "status" = 'FAILED'
            AND "createdAt" >= NOW() - INTERVAL '24 hours'
        ) AS "failedLast24h",
        COUNT(*) FILTER (
          WHERE "status" = 'COMPLETED'
            AND "updatedAt" >= NOW() - INTERVAL '24 hours'
        ) AS "completedLast24h",
        COALESCE(
          AVG(EXTRACT(EPOCH FROM ("updatedAt" - "createdAt")) * 1000)
            FILTER (
              WHERE "status" = 'COMPLETED'
                AND "updatedAt" >= NOW() - INTERVAL '24 hours'
            ),
          0
        ) AS "avgDurationMs24h",
        COALESCE(
          PERCENTILE_CONT(0.95) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM ("updatedAt" - "createdAt")) * 1000
          ) FILTER (
            WHERE "status" = 'COMPLETED'
              AND "updatedAt" >= NOW() - INTERVAL '24 hours'
          ),
          0
        ) AS "p95DurationMs24h"
      FROM "Job"
      GROUP BY "type"
      ORDER BY "type" ASC
    `;

    return rows.map((row) => ({
      type: row.type,
      failedTotal: this.toNumber(row.failedTotal),
      failedLast24h: this.toNumber(row.failedLast24h),
      completedLast24h: this.toNumber(row.completedLast24h),
      avgDurationMs24h: Number(row.avgDurationMs24h || 0),
      p95DurationMs24h: Number(row.p95DurationMs24h || 0),
    }));
  }

  async getDegradedStageSnapshot(hours = 24): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    const windowHours = this.normalizeWindowHours(hours);
    const rows = await this.prisma.$queryRaw<DegradedByTypeRow[]>`
      WITH core_jobs AS (
        SELECT
          "type",
          "status",
          "updatedAt",
          CASE
            WHEN LOWER(COALESCE("outputData"->>'status', '')) = 'degraded' THEN 1
            WHEN LOWER(COALESCE("outputData"->>'degraded', 'false')) IN ('true', '1', 't', 'yes') THEN 1
            ELSE 0
          END AS "isDegraded"
        FROM "Job"
        WHERE "type" IN ('YOUTUBE_DOWNLOAD', 'TRANSCRIPTION', 'ANALYZE_LYRICS', 'GENERATE_IMAGES', 'RENDER_VIDEO', 'FINALIZE')
      )
      SELECT
        "type",
        COUNT(*) FILTER (WHERE "status" = 'COMPLETED') AS "completedTotal",
        COUNT(*) FILTER (WHERE "status" = 'COMPLETED' AND "isDegraded" = 1) AS "degradedTotal",
        COUNT(*) FILTER (
          WHERE "status" = 'COMPLETED'
            AND "updatedAt" >= NOW() - (${windowHours}::int * INTERVAL '1 hour')
        ) AS "completedWindow",
        COUNT(*) FILTER (
          WHERE "status" = 'COMPLETED'
            AND "updatedAt" >= NOW() - (${windowHours}::int * INTERVAL '1 hour')
            AND "isDegraded" = 1
        ) AS "degradedWindow"
      FROM core_jobs
      GROUP BY "type"
      ORDER BY "type" ASC
    `;

    const byType = rows.map((row) => {
      const completedTotal = this.toNumber(row.completedTotal);
      const degradedTotal = this.toNumber(row.degradedTotal);
      const completedWindow = this.toNumber(row.completedWindow);
      const degradedWindow = this.toNumber(row.degradedWindow);
      const degradedRateTotalPct =
        completedTotal > 0 ? Number(((degradedTotal / completedTotal) * 100).toFixed(2)) : 0;
      const degradedRateWindowPct =
        completedWindow > 0 ? Number(((degradedWindow / completedWindow) * 100).toFixed(2)) : 0;

      return {
        type: row.type,
        completedTotal,
        degradedTotal,
        degradedRateTotalPct,
        completedWindow,
        degradedWindow,
        degradedRateWindowPct,
      };
    });

    const warningThreshold = Math.min(this.degradedWarnPct, this.degradedCriticalPct);
    const criticalThreshold = Math.max(this.degradedWarnPct, this.degradedCriticalPct);

    const alerts = byType.reduce<DegradedStageAlert[]>((acc, row) => {
      if (row.completedWindow < this.degradedMinCompletedWindow) {
        return acc;
      }
      if (row.degradedRateWindowPct >= criticalThreshold) {
        acc.push({
          severity: 'critical',
          type: row.type,
          degradedRateWindowPct: row.degradedRateWindowPct,
          degradedWindow: row.degradedWindow,
          completedWindow: row.completedWindow,
        });
        return acc;
      }
      if (row.degradedRateWindowPct >= warningThreshold) {
        acc.push({
          severity: 'warning',
          type: row.type,
          degradedRateWindowPct: row.degradedRateWindowPct,
          degradedWindow: row.degradedWindow,
          completedWindow: row.completedWindow,
        });
      }
      return acc;
    }, []);

    const criticalAlerts = alerts.filter((alert) => alert.severity === 'critical');
    const warningAlerts = alerts.filter((alert) => alert.severity === 'warning');

    const totals = byType.reduce(
      (acc, row) => {
        acc.completedTotal += row.completedTotal;
        acc.degradedTotal += row.degradedTotal;
        acc.completedWindow += row.completedWindow;
        acc.degradedWindow += row.degradedWindow;
        return acc;
      },
      { completedTotal: 0, degradedTotal: 0, completedWindow: 0, degradedWindow: 0 },
    );

    return {
      status: criticalAlerts.length > 0 ? 'degraded' : 'ok',
      timestamp: new Date().toISOString(),
      windowHours,
      totals: {
        ...totals,
        degradedRateTotalPct:
          totals.completedTotal > 0
            ? Number(((totals.degradedTotal / totals.completedTotal) * 100).toFixed(2))
            : 0,
        degradedRateWindowPct:
          totals.completedWindow > 0
            ? Number(((totals.degradedWindow / totals.completedWindow) * 100).toFixed(2))
            : 0,
      },
      alerts: {
        warningThresholdPct: warningThreshold,
        criticalThresholdPct: criticalThreshold,
        minCompletedWindow: this.degradedMinCompletedWindow,
        criticalCount: criticalAlerts.length,
        warningCount: warningAlerts.length,
        critical: criticalAlerts,
        warnings: warningAlerts,
        hasCriticalAlerts: criticalAlerts.length > 0,
      },
      byType,
      collectionMs: Date.now() - startedAt,
    };
  }

  async getDegradedStageSnapshotWithAlerts(hours = 24): Promise<Record<string, unknown>> {
    const snapshot = await this.getDegradedStageSnapshot(hours);
    await this.healthAlertingService.notifyDegradedStageIfNeeded(snapshot);
    return snapshot;
  }

  async getOpsSnapshot() {
    const startedAt = Date.now();
    const errors: string[] = [];

    let queues: QueueSnapshot[] = [];
    let jobsByType: Array<{
      type: string;
      failedTotal: number;
      failedLast24h: number;
      completedLast24h: number;
      avgDurationMs24h: number;
      p95DurationMs24h: number;
    }> = [];
    let degradedByStage: Record<string, unknown> | null = null;

    try {
      const queueResults = await Promise.all(
        this.getManagedQueues().map(({ key, queue }) => this.getQueueSnapshot(key, queue)),
      );
      queues = queueResults;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`queue_metrics_error:${message}`);
      this.logger.warn(`Failed to collect queue metrics: ${message}`);
    }

    try {
      jobsByType = await this.getJobTypeStats();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`job_type_metrics_error:${message}`);
      this.logger.warn(`Failed to collect job type metrics: ${message}`);
    }

    try {
      degradedByStage = await this.getDegradedStageSnapshotWithAlerts(24);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`degraded_stage_metrics_error:${message}`);
      this.logger.warn(`Failed to collect degraded-by-stage metrics: ${message}`);
    }

    const queueTotals = queues.reduce(
      (acc, queue) => {
        acc.waiting += queue.waiting;
        acc.active += queue.active;
        acc.delayed += queue.delayed;
        acc.failed += queue.failed;
        acc.retrying += queue.retrying;
        return acc;
      },
      { waiting: 0, active: 0, delayed: 0, failed: 0, retrying: 0 },
    );

    const hasCriticalDegradedAlerts =
      degradedByStage &&
      typeof degradedByStage === 'object' &&
      (degradedByStage as Record<string, unknown>).alerts &&
      typeof (degradedByStage as Record<string, unknown>).alerts === 'object' &&
      Boolean(((degradedByStage as Record<string, unknown>).alerts as Record<string, unknown>).hasCriticalAlerts);

    const latencyAlerts = jobsByType.reduce<
      Array<{
        severity: 'warning' | 'critical';
        type: string;
        p95DurationMs24h: number;
        completedLast24h: number;
      }>
    >((acc, row) => {
      if (row.completedLast24h < this.p95MinCompleted24h) {
        return acc;
      }
      if (row.p95DurationMs24h >= this.p95CriticalMs) {
        acc.push({
          severity: 'critical',
          type: row.type,
          p95DurationMs24h: row.p95DurationMs24h,
          completedLast24h: row.completedLast24h,
        });
        return acc;
      }
      if (row.p95DurationMs24h >= this.p95WarnMs) {
        acc.push({
          severity: 'warning',
          type: row.type,
          p95DurationMs24h: row.p95DurationMs24h,
          completedLast24h: row.completedLast24h,
        });
      }
      return acc;
    }, []);

    const hasCriticalLatencyAlerts = latencyAlerts.some((alert) => alert.severity === 'critical');

    const now = new Date().toISOString();
    const realtimeEvents = this.eventsMetricsService.snapshot();
    return {
      status: errors.length > 0 || hasCriticalDegradedAlerts || hasCriticalLatencyAlerts ? 'degraded' : 'ok',
      timestamp: now,
      uptimeSec: Math.round(process.uptime()),
      collectionMs: Date.now() - startedAt,
      queueTotals,
      queues,
      jobsByType,
      degradedByStage,
      latencyAlerts: {
        warningThresholdMs: this.p95WarnMs,
        criticalThresholdMs: this.p95CriticalMs,
        minCompleted24h: this.p95MinCompleted24h,
        criticalCount: latencyAlerts.filter((alert) => alert.severity === 'critical').length,
        warningCount: latencyAlerts.filter((alert) => alert.severity === 'warning').length,
        alerts: latencyAlerts,
        hasCriticalAlerts: hasCriticalLatencyAlerts,
      },
      retryingIsSampled: queues.some((queue) => queue.retryingSampled),
      realtimeEvents,
      circuitBreakers: this.circuitBreakerService.snapshot(),
      errors,
    };
  }

  getRealtimeEventsSnapshot(): Record<string, unknown> {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      realtimeEvents: this.eventsMetricsService.snapshot(),
    };
  }

  async getPipelineQualitySummary(hours = 24): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    const windowHours = this.normalizeWindowHours(hours);
    const windowStart = new Date(Date.now() - windowHours * 60 * 60 * 1000);

    const jobs = await this.prisma.job.findMany({
      where: {
        status: JobStatus.COMPLETED,
        updatedAt: { gte: windowStart },
      },
      select: {
        type: true,
        outputData: true,
      },
    });

    const coreJobs = jobs.filter((job) => isCorePipelineJob(job.type as JobType));

    const byTypeAccumulator = new Map<
      string,
      { completedWindow: number; degradedWindow: number }
    >();
    const byReasonAccumulator = new Map<
      string,
      { count: number; jobTypes: Set<string>; sampleReason: string }
    >();

    for (const job of coreJobs) {
      const jobType = String(job.type);
      const byType = byTypeAccumulator.get(jobType) || { completedWindow: 0, degradedWindow: 0 };
      byType.completedWindow += 1;

      const reasonCodes = extractDegradedReasonCodesFromOutputData(job.outputData, job.type as JobType);
      const reasons = extractDegradedReasonsFromOutputData(job.outputData, job.type as JobType);

      if (reasonCodes.length > 0) {
        byType.degradedWindow += 1;
        reasonCodes.forEach((reasonCode, index) => {
          const existing = byReasonAccumulator.get(reasonCode) || {
            count: 0,
            jobTypes: new Set<string>(),
            sampleReason: reasons[index] || reasons[0] || reasonCode,
          };
          existing.count += 1;
          existing.jobTypes.add(jobType);
          if (!existing.sampleReason && (reasons[index] || reasons[0])) {
            existing.sampleReason = reasons[index] || reasons[0];
          }
          byReasonAccumulator.set(reasonCode, existing);
        });
      }

      byTypeAccumulator.set(jobType, byType);
    }

    const byType = Array.from(byTypeAccumulator.entries())
      .map(([type, value]) => ({
        type,
        completedWindow: value.completedWindow,
        degradedWindow: value.degradedWindow,
        degradedRateWindowPct:
          value.completedWindow > 0
            ? Number(((value.degradedWindow / value.completedWindow) * 100).toFixed(2))
            : 0,
      }))
      .sort((a, b) => a.type.localeCompare(b.type));

    const byReasonCode = Array.from(byReasonAccumulator.entries())
      .map(([code, value]) => ({
        code,
        count: value.count,
        jobTypes: Array.from(value.jobTypes).sort(),
        sampleReason: value.sampleReason,
      }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

    const totals = byType.reduce(
      (acc, row) => {
        acc.completedWindow += row.completedWindow;
        acc.degradedWindow += row.degradedWindow;
        return acc;
      },
      { completedWindow: 0, degradedWindow: 0 },
    );

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      windowHours,
      totals: {
        ...totals,
        degradedRateWindowPct:
          totals.completedWindow > 0
            ? Number(((totals.degradedWindow / totals.completedWindow) * 100).toFixed(2))
            : 0,
      },
      byType,
      byReasonCode,
      collectionMs: Date.now() - startedAt,
    };
  }
}
