import { BadRequestException, Injectable, Logger } from '@nestjs/common';
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
  sourceMode: string;
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

type SourceMode = 'youtube' | 'audio' | 'lyrics' | 'unknown';

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

  private normalizeSourceMode(value: unknown): SourceMode {
    if (typeof value !== 'string') {
      return 'unknown';
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === 'youtube' || normalized === 'audio' || normalized === 'lyrics') {
      return normalized;
    }
    return 'unknown';
  }

  private inferSourceModeFromProject(project: {
    sourceMode?: string | null;
    youtubeUrl?: string | null;
    audioUrl?: string | null;
    lyrics?: string | null;
  } | null | undefined): SourceMode {
    if (!project) {
      return 'unknown';
    }
    const persistedSourceMode = this.normalizeSourceMode(project.sourceMode);
    if (persistedSourceMode !== 'unknown') {
      return persistedSourceMode;
    }
    const youtubeUrl = (project.youtubeUrl || '').trim();
    const audioUrl = (project.audioUrl || '').trim();
    const lyrics = (project.lyrics || '').trim();

    if (youtubeUrl) {
      return 'youtube';
    }
    if (audioUrl && !lyrics) {
      return 'audio';
    }
    if (lyrics || audioUrl) {
      return 'lyrics';
    }
    return 'unknown';
  }

  private resolveSourceMode(
    inputData: unknown,
    project: {
      sourceMode?: string | null;
      youtubeUrl?: string | null;
      audioUrl?: string | null;
      lyrics?: string | null;
    } | null,
  ): SourceMode {
    const persistedSourceMode = this.normalizeSourceMode(project?.sourceMode);
    if (persistedSourceMode !== 'unknown') {
      return persistedSourceMode;
    }
    const payloadSourceMode =
      inputData && typeof inputData === 'object' && !Array.isArray(inputData)
        ? (inputData as Record<string, unknown>).sourceMode
        : null;
    const normalizedPayloadSource = this.normalizeSourceMode(payloadSourceMode);
    if (normalizedPayloadSource !== 'unknown') {
      return normalizedPayloadSource;
    }
    return this.inferSourceModeFromProject(project);
  }

  private parseSourceModeFilter(sourceMode?: string): SourceMode | null {
    if (typeof sourceMode !== 'string' || sourceMode.trim().length === 0) {
      return null;
    }
    const normalized = sourceMode.trim().toLowerCase();
    if (normalized === 'youtube' || normalized === 'audio' || normalized === 'lyrics' || normalized === 'unknown') {
      return normalized;
    }
    throw new BadRequestException(
      `Invalid sourceMode "${sourceMode}". Allowed values: youtube, audio, lyrics, unknown.`,
    );
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

  async getDegradedStageSnapshot(hours = 24, sourceMode?: string): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    const windowHours = this.normalizeWindowHours(hours);
    const sourceModeFilter = this.parseSourceModeFilter(sourceMode);
    const rows = await this.prisma.$queryRaw<DegradedByTypeRow[]>`
      WITH core_jobs AS (
        SELECT
          j."type",
          j."status",
          j."updatedAt",
          CASE
            WHEN LOWER(COALESCE(j."outputData"->>'status', '')) = 'degraded' THEN 1
            WHEN LOWER(COALESCE(j."outputData"->>'degraded', 'false')) IN ('true', '1', 't', 'yes') THEN 1
            ELSE 0
          END AS "isDegraded",
          CASE
            WHEN LOWER(COALESCE(p."sourceMode", '')) IN ('youtube', 'audio', 'lyrics')
              THEN LOWER(COALESCE(p."sourceMode", ''))
            WHEN LOWER(COALESCE(j."inputData"->>'sourceMode', '')) IN ('youtube', 'audio', 'lyrics')
              THEN LOWER(COALESCE(j."inputData"->>'sourceMode', ''))
            WHEN TRIM(COALESCE(p."youtubeUrl", '')) <> '' THEN 'youtube'
            WHEN TRIM(COALESCE(p."audioUrl", '')) <> '' AND TRIM(COALESCE(p."lyrics", '')) = '' THEN 'audio'
            WHEN TRIM(COALESCE(p."lyrics", '')) <> '' OR TRIM(COALESCE(p."audioUrl", '')) <> '' THEN 'lyrics'
            ELSE 'unknown'
          END AS "sourceMode"
        FROM "Job" j
        LEFT JOIN "Project" p ON p."id" = j."projectId"
        WHERE j."type" IN ('YOUTUBE_DOWNLOAD', 'TRANSCRIPTION', 'ANALYZE_LYRICS', 'GENERATE_IMAGES', 'RENDER_VIDEO', 'FINALIZE')
      )
      SELECT
        "type",
        "sourceMode",
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
      WHERE (${sourceModeFilter}::text IS NULL OR "sourceMode" = ${sourceModeFilter}::text)
      GROUP BY "type", "sourceMode"
      ORDER BY "type" ASC, "sourceMode" ASC
    `;

    const byTypeAndSource = rows.map((row) => {
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
        sourceMode: this.normalizeSourceMode(row.sourceMode),
        completedTotal,
        degradedTotal,
        degradedRateTotalPct,
        completedWindow,
        degradedWindow,
        degradedRateWindowPct,
      };
    });

    const byTypeMap = new Map<
      string,
      { completedTotal: number; degradedTotal: number; completedWindow: number; degradedWindow: number }
    >();
    const bySourceModeMap = new Map<
      string,
      { completedTotal: number; degradedTotal: number; completedWindow: number; degradedWindow: number }
    >();

    for (const row of byTypeAndSource) {
      const byType = byTypeMap.get(row.type) || {
        completedTotal: 0,
        degradedTotal: 0,
        completedWindow: 0,
        degradedWindow: 0,
      };
      byType.completedTotal += row.completedTotal;
      byType.degradedTotal += row.degradedTotal;
      byType.completedWindow += row.completedWindow;
      byType.degradedWindow += row.degradedWindow;
      byTypeMap.set(row.type, byType);

      const bySourceMode = bySourceModeMap.get(row.sourceMode) || {
        completedTotal: 0,
        degradedTotal: 0,
        completedWindow: 0,
        degradedWindow: 0,
      };
      bySourceMode.completedTotal += row.completedTotal;
      bySourceMode.degradedTotal += row.degradedTotal;
      bySourceMode.completedWindow += row.completedWindow;
      bySourceMode.degradedWindow += row.degradedWindow;
      bySourceModeMap.set(row.sourceMode, bySourceMode);
    }

    const mapToRateRows = (
      entries: Array<
        [string, { completedTotal: number; degradedTotal: number; completedWindow: number; degradedWindow: number }]
      >,
      keyName: 'type' | 'sourceMode',
    ) =>
      entries.map(([key, value]) => ({
        [keyName]: key,
        completedTotal: value.completedTotal,
        degradedTotal: value.degradedTotal,
        degradedRateTotalPct:
          value.completedTotal > 0
            ? Number(((value.degradedTotal / value.completedTotal) * 100).toFixed(2))
            : 0,
        completedWindow: value.completedWindow,
        degradedWindow: value.degradedWindow,
        degradedRateWindowPct:
          value.completedWindow > 0
            ? Number(((value.degradedWindow / value.completedWindow) * 100).toFixed(2))
            : 0,
      }));

    const byType = mapToRateRows(
      Array.from(byTypeMap.entries()).sort(([a], [b]) => a.localeCompare(b)),
      'type',
    ) as Array<{
      type: string;
      completedTotal: number;
      degradedTotal: number;
      degradedRateTotalPct: number;
      completedWindow: number;
      degradedWindow: number;
      degradedRateWindowPct: number;
    }>;
    const sourceSortOrder = ['youtube', 'audio', 'lyrics', 'unknown'];
    const bySourceMode = mapToRateRows(
      Array.from(bySourceModeMap.entries()).sort(
        ([a], [b]) => sourceSortOrder.indexOf(a) - sourceSortOrder.indexOf(b),
      ),
      'sourceMode',
    ) as Array<{
      sourceMode: string;
      completedTotal: number;
      degradedTotal: number;
      degradedRateTotalPct: number;
      completedWindow: number;
      degradedWindow: number;
      degradedRateWindowPct: number;
    }>;

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
      sourceModeFilter: sourceModeFilter ?? 'all',
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
      bySourceMode,
      byTypeAndSource,
      collectionMs: Date.now() - startedAt,
    };
  }

  async getDegradedStageSnapshotWithAlerts(hours = 24, sourceMode?: string): Promise<Record<string, unknown>> {
    const snapshot = await this.getDegradedStageSnapshot(hours, sourceMode);
    // Avoid webhook spam from ad-hoc filtered queries; alerting should run on global snapshot.
    if (!sourceMode || sourceMode.trim().length === 0) {
      await this.healthAlertingService.notifyDegradedStageIfNeeded(snapshot);
    }
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
    const sourceModeSummary24h =
      degradedByStage &&
      typeof degradedByStage === 'object' &&
      Array.isArray((degradedByStage as Record<string, unknown>).bySourceMode)
        ? (degradedByStage as Record<string, unknown>).bySourceMode
        : [];
    return {
      status: errors.length > 0 || hasCriticalDegradedAlerts || hasCriticalLatencyAlerts ? 'degraded' : 'ok',
      timestamp: now,
      uptimeSec: Math.round(process.uptime()),
      collectionMs: Date.now() - startedAt,
      queueTotals,
      queues,
      jobsByType,
      degradedByStage,
      sourceModeSummary24h,
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

  async getPipelineQualitySummary(hours = 24, sourceMode?: string): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    const windowHours = this.normalizeWindowHours(hours);
    const windowStart = new Date(Date.now() - windowHours * 60 * 60 * 1000);
    const sourceModeFilter = this.parseSourceModeFilter(sourceMode);

    const jobs = await this.prisma.job.findMany({
      where: {
        status: JobStatus.COMPLETED,
        updatedAt: { gte: windowStart },
      },
      select: {
        type: true,
        outputData: true,
        inputData: true,
        project: {
          select: {
            sourceMode: true,
            youtubeUrl: true,
            audioUrl: true,
            lyrics: true,
          },
        },
      },
    });

    const coreJobs = jobs.filter((job) => isCorePipelineJob(job.type as JobType));

    const byTypeAccumulator = new Map<
      string,
      { completedWindow: number; degradedWindow: number }
    >();
    const bySourceModeAccumulator = new Map<
      string,
      { completedWindow: number; degradedWindow: number }
    >();
    const byTypeAndSourceAccumulator = new Map<
      string,
      { type: string; sourceMode: string; completedWindow: number; degradedWindow: number }
    >();
    const byReasonAccumulator = new Map<
      string,
      { count: number; jobTypes: Set<string>; sampleReason: string }
    >();

    for (const job of coreJobs) {
      const jobType = String(job.type);
      const resolvedSourceMode = this.resolveSourceMode(job.inputData, job.project);
      if (sourceModeFilter && resolvedSourceMode !== sourceModeFilter) {
        continue;
      }
      const byType = byTypeAccumulator.get(jobType) || { completedWindow: 0, degradedWindow: 0 };
      byType.completedWindow += 1;
      const bySourceMode = bySourceModeAccumulator.get(resolvedSourceMode) || {
        completedWindow: 0,
        degradedWindow: 0,
      };
      bySourceMode.completedWindow += 1;
      const byTypeAndSourceKey = `${jobType}:${resolvedSourceMode}`;
      const byTypeAndSource = byTypeAndSourceAccumulator.get(byTypeAndSourceKey) || {
        type: jobType,
        sourceMode: resolvedSourceMode,
        completedWindow: 0,
        degradedWindow: 0,
      };
      byTypeAndSource.completedWindow += 1;

      const reasonCodes = extractDegradedReasonCodesFromOutputData(job.outputData, job.type as JobType);
      const reasons = extractDegradedReasonsFromOutputData(job.outputData, job.type as JobType);

      if (reasonCodes.length > 0) {
        byType.degradedWindow += 1;
        bySourceMode.degradedWindow += 1;
        byTypeAndSource.degradedWindow += 1;
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
      bySourceModeAccumulator.set(resolvedSourceMode, bySourceMode);
      byTypeAndSourceAccumulator.set(byTypeAndSourceKey, byTypeAndSource);
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
    const sourceSortOrder = ['youtube', 'audio', 'lyrics', 'unknown'];
    const bySourceMode = Array.from(bySourceModeAccumulator.entries())
      .map(([sourceMode, value]) => ({
        sourceMode,
        completedWindow: value.completedWindow,
        degradedWindow: value.degradedWindow,
        degradedRateWindowPct:
          value.completedWindow > 0
            ? Number(((value.degradedWindow / value.completedWindow) * 100).toFixed(2))
            : 0,
      }))
      .sort(
        (a, b) =>
          sourceSortOrder.indexOf(a.sourceMode) - sourceSortOrder.indexOf(b.sourceMode),
      );
    const byTypeAndSource = Array.from(byTypeAndSourceAccumulator.values())
      .map((value) => ({
        type: value.type,
        sourceMode: value.sourceMode,
        completedWindow: value.completedWindow,
        degradedWindow: value.degradedWindow,
        degradedRateWindowPct:
          value.completedWindow > 0
            ? Number(((value.degradedWindow / value.completedWindow) * 100).toFixed(2))
            : 0,
      }))
      .sort(
        (a, b) =>
          a.type.localeCompare(b.type) ||
          sourceSortOrder.indexOf(a.sourceMode) - sourceSortOrder.indexOf(b.sourceMode),
      );

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
      sourceModeFilter: sourceModeFilter ?? 'all',
      totals: {
        ...totals,
        degradedRateWindowPct:
          totals.completedWindow > 0
            ? Number(((totals.degradedWindow / totals.completedWindow) * 100).toFixed(2))
            : 0,
      },
      byType,
      bySourceMode,
      byTypeAndSource,
      byReasonCode,
      collectionMs: Date.now() - startedAt,
    };
  }
}
