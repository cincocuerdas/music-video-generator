import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { JobStatus, JobType } from '@prisma/client';
import { CircuitBreakerService } from '../../../common/services';
import { PrismaService } from '../../prisma';
import { QUEUE_NAMES } from '../../queue';
import { HealthAlertingService } from '../health-alerting.service';
import { SloMitigationService } from './slo-mitigation.service';
import { EventsMetricsService } from '../../events';
import { parsePositiveIntEnv } from '../../../common/utils/env-parsers';
import {
  extractDegradedReasonCodesFromOutputData,
  extractDegradedReasonsFromOutputData,
  isCorePipelineJob,
} from '../../jobs/pipeline-quality.utils';

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

interface DeadLetterByTypeEntry {
  type: string;
  total: number;
  retryable: number;
  nonRetryable: number;
  transient: number;
  permanent: number;
  unknown: number;
  attemptsExhausted: number;
  lastCapturedAt: string | null;
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

interface DurationByStageRow {
  type: string;
  completedWindow: number | bigint | null;
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

interface DegradedByLanguageRow {
  language: string;
  completedTotal: number | bigint | null;
  degradedTotal: number | bigint | null;
  completedWindow: number | bigint | null;
  degradedWindow: number | bigint | null;
}

interface PipelineSloRow {
  pipelineCount: number | bigint | null;
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  minMs: number | null;
}

interface PipelineSloBreakdownRow {
  pipelineKey: string;
  projectId: string | null;
  sourceMode: string | null;
  startedAt: Date | string;
  finishedAt: Date | string;
  totalDurationMs: number | null;
  stageType: string | null;
  stageStatus: string | null;
  stageCreatedAt: Date | string | null;
  stageUpdatedAt: Date | string | null;
  stageDurationMs: number | null;
  attemptCount: number | bigint | null;
  stageDegraded: number | boolean | string | null;
}

type SourceMode = 'youtube' | 'audio' | 'lyrics' | 'unknown';

@Injectable()
export class HealthOpsMetricsService {
  private readonly logger = new Logger(HealthOpsMetricsService.name);
  private readonly retryInspectMax = parsePositiveIntEnv(
    'HEALTH_OPS_MAX_INSPECT_JOBS',
    500,
  );
  private readonly degradedWarnPct = this.parsePercentEnv('HEALTH_DEGRADED_ALERT_WARN_PCT', 5);
  private readonly degradedCriticalPct = this.parsePercentEnv(
    'HEALTH_DEGRADED_ALERT_CRITICAL_PCT',
    20,
  );
  private readonly degradedMinCompletedWindow = parsePositiveIntEnv(
    'HEALTH_DEGRADED_ALERT_MIN_COMPLETED_WINDOW',
    5,
  );
  private readonly p95WarnMs = parsePositiveIntEnv('HEALTH_SLO_P95_WARN_MS', 120000);
  private readonly p95CriticalMs = parsePositiveIntEnv('HEALTH_SLO_P95_CRITICAL_MS', 300000);
  private readonly p95MinCompleted24h = parsePositiveIntEnv(
    'HEALTH_SLO_P95_MIN_COMPLETED_24H',
    3,
  );
  private readonly deadLetterInspectMax = parsePositiveIntEnv(
    'HEALTH_OPS_MAX_DEAD_LETTER_INSPECT',
    500,
  );
  private readonly pipelineSloP95WarnMs = parsePositiveIntEnv(
    'HEALTH_PIPELINE_SLO_P95_WARN_MS',
    1200000, // 20 min
  );
  private readonly pipelineSloP95CriticalMs = parsePositiveIntEnv(
    'HEALTH_PIPELINE_SLO_P95_CRITICAL_MS',
    1800000, // 30 min
  );
  private readonly pipelineSloMinCompleted = parsePositiveIntEnv(
    'HEALTH_PIPELINE_SLO_MIN_COMPLETED',
    3,
  );
  private readonly queueWaitInspectMax = parsePositiveIntEnv('HEALTH_OPS_MAX_QUEUE_WAIT_INSPECT', 1000);
  private readonly pipelineSloBreakdownTopN = Math.min(
    100,
    parsePositiveIntEnv('HEALTH_PIPELINE_SLO_BREAKDOWN_TOP_N', 10),
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly healthAlertingService: HealthAlertingService,
    private readonly sloMitigationService: SloMitigationService,
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
    @InjectQueue(QUEUE_NAMES.DEAD_LETTER)
    private readonly deadLetterQueue: Queue,
  ) {}

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

  private toEpochMs(value: Date | string | null | undefined): number | null {
    if (!value) {
      return null;
    }
    if (value instanceof Date) {
      const time = value.getTime();
      return Number.isFinite(time) ? time : null;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private percentileFromSorted(values: number[], percentile: number): number {
    if (!values.length) {
      return 0;
    }
    const safePercentile = Math.min(1, Math.max(0, percentile));
    const index = (values.length - 1) * safePercentile;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) {
      return values[lower];
    }
    const weight = index - lower;
    return values[lower] * (1 - weight) + values[upper] * weight;
  }

  private summarizeDurations(values: number[]): {
    count: number;
    avgMs: number;
    p50Ms: number;
    p95Ms: number;
    minMs: number;
    maxMs: number;
  } {
    if (!values.length) {
      return {
        count: 0,
        avgMs: 0,
        p50Ms: 0,
        p95Ms: 0,
        minMs: 0,
        maxMs: 0,
      };
    }
    const sorted = [...values].sort((a, b) => a - b);
    const total = sorted.reduce((sum, value) => sum + value, 0);
    return {
      count: sorted.length,
      avgMs: Math.round(total / sorted.length),
      p50Ms: Math.round(this.percentileFromSorted(sorted, 0.5)),
      p95Ms: Math.round(this.percentileFromSorted(sorted, 0.95)),
      minMs: Math.round(sorted[0]),
      maxMs: Math.round(sorted[sorted.length - 1]),
    };
  }

  private getStageOrder(type: string): number {
    const order: Record<string, number> = {
      YOUTUBE_DOWNLOAD: 1,
      TRANSCRIPTION: 2,
      ANALYZE_LYRICS: 3,
      GENERATE_IMAGES: 4,
      RENDER_VIDEO: 5,
      FINALIZE: 6,
      TRAIN_LORA: 99,
    };
    return order[type] ?? 999;
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
    title?: string | null;
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
      title?: string | null;
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

  private isSyntheticInputData(inputData: unknown): boolean {
    if (!inputData || typeof inputData !== 'object' || Array.isArray(inputData)) {
      return false;
    }
    const payload = inputData as Record<string, unknown>;
    const isSyntheticRaw = payload.isSynthetic;
    if (
      isSyntheticRaw === true ||
      isSyntheticRaw === 1 ||
      (typeof isSyntheticRaw === 'string' &&
        ['true', '1', 'yes', 'synthetic'].includes(isSyntheticRaw.trim().toLowerCase()))
    ) {
      return true;
    }
    const syntheticRunType =
      typeof payload.syntheticRunType === 'string' ? payload.syntheticRunType.trim().toLowerCase() : '';
    if (['smoke', 'chaos', 'synthetic'].includes(syntheticRunType)) {
      return true;
    }
    return false;
  }

  private isSyntheticProjectTitle(title?: string | null): boolean {
    const normalized = (title || '').trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    return (
      normalized.includes('[synthetic:') ||
      normalized.includes('smoke baseline') ||
      normalized.includes('external chaos') ||
      normalized.includes('latency chaos')
    );
  }

  private isSyntheticJob(
    inputData: unknown,
    project?: { title?: string | null } | null,
  ): boolean {
    return this.isSyntheticInputData(inputData) || this.isSyntheticProjectTitle(project?.title);
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

  private async getDeadLetterByJobType(): Promise<{
    total: number;
    inspected: number;
    sampled: boolean;
    byType: DeadLetterByTypeEntry[];
  }> {
    const statuses = ['waiting', 'active', 'delayed', 'completed', 'failed'] as const;
    const total = await this.deadLetterQueue.getJobCountByTypes(...statuses);
    const inspected = Math.min(total, this.deadLetterInspectMax);
    if (inspected <= 0) {
      return {
        total,
        inspected: 0,
        sampled: false,
        byType: [],
      };
    }

    const jobs = await this.deadLetterQueue.getJobs([...statuses], 0, inspected - 1, true);
    const byTypeMap = new Map<string, DeadLetterByTypeEntry>();
    for (const queueJob of jobs) {
      const data =
        queueJob.data && typeof queueJob.data === 'object'
          ? (queueJob.data as Record<string, unknown>)
          : {};
      const typeValue = typeof data.jobType === 'string' ? data.jobType.trim() : '';
      const type = typeValue || 'UNKNOWN';
      const category =
        typeof data.category === 'string' ? data.category.trim().toLowerCase() : 'unknown';
      const retryable = Boolean(data.retryable);
      const attemptsMade =
        typeof data.attemptsMade === 'number'
          ? data.attemptsMade
          : typeof queueJob.attemptsMade === 'number'
            ? queueJob.attemptsMade
            : 0;
      const maxAttempts =
        typeof data.maxAttempts === 'number'
          ? data.maxAttempts
          : typeof queueJob.opts?.attempts === 'number'
            ? queueJob.opts.attempts
            : 0;
      const capturedAtRaw = typeof data.capturedAt === 'string' ? data.capturedAt : null;
      const fallbackCapturedAt = new Date(queueJob.timestamp).toISOString();
      const capturedAt = capturedAtRaw && capturedAtRaw.trim().length > 0 ? capturedAtRaw : fallbackCapturedAt;
      const entry = byTypeMap.get(type) || {
        type,
        total: 0,
        retryable: 0,
        nonRetryable: 0,
        transient: 0,
        permanent: 0,
        unknown: 0,
        attemptsExhausted: 0,
        lastCapturedAt: null,
      };

      entry.total += 1;
      if (retryable) {
        entry.retryable += 1;
      } else {
        entry.nonRetryable += 1;
      }
      if (category === 'transient') {
        entry.transient += 1;
      } else if (category === 'permanent') {
        entry.permanent += 1;
      } else {
        entry.unknown += 1;
      }
      if (maxAttempts > 0 && attemptsMade >= maxAttempts) {
        entry.attemptsExhausted += 1;
      }
      if (!entry.lastCapturedAt || capturedAt > entry.lastCapturedAt) {
        entry.lastCapturedAt = capturedAt;
      }

      byTypeMap.set(type, entry);
    }

    const byType = Array.from(byTypeMap.values()).sort((a, b) => a.type.localeCompare(b.type));
    return {
      total,
      inspected,
      sampled: total > inspected,
      byType,
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

  async getDurationByStage(hours = 24, includeSynthetic = false): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    const windowHours = this.normalizeWindowHours(hours);

    const rows = await this.prisma.$queryRaw<DurationByStageRow[]>`
      SELECT
        j."type",
        COUNT(*) FILTER (
          WHERE j."status" = 'COMPLETED'
            AND j."updatedAt" >= NOW() - (${windowHours}::int * INTERVAL '1 hour')
        ) AS "completedWindow",
        COALESCE(
          AVG(EXTRACT(EPOCH FROM (j."updatedAt" - j."createdAt")) * 1000)
            FILTER (
              WHERE j."status" = 'COMPLETED'
                AND j."updatedAt" >= NOW() - (${windowHours}::int * INTERVAL '1 hour')
            ),
          0
        ) AS "avgMs",
        COALESCE(
          PERCENTILE_CONT(0.50) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (j."updatedAt" - j."createdAt")) * 1000
          ) FILTER (
            WHERE j."status" = 'COMPLETED'
              AND j."updatedAt" >= NOW() - (${windowHours}::int * INTERVAL '1 hour')
          ),
          0
        ) AS "p50Ms",
        COALESCE(
          PERCENTILE_CONT(0.95) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (j."updatedAt" - j."createdAt")) * 1000
          ) FILTER (
            WHERE j."status" = 'COMPLETED'
              AND j."updatedAt" >= NOW() - (${windowHours}::int * INTERVAL '1 hour')
          ),
          0
        ) AS "p95Ms",
        COALESCE(
          MAX(EXTRACT(EPOCH FROM (j."updatedAt" - j."createdAt")) * 1000)
            FILTER (
              WHERE j."status" = 'COMPLETED'
                AND j."updatedAt" >= NOW() - (${windowHours}::int * INTERVAL '1 hour')
            ),
          0
        ) AS "maxMs"
      FROM "Job" j
      LEFT JOIN "Project" p ON p."id" = j."projectId"
      WHERE j."type" IN ('YOUTUBE_DOWNLOAD', 'TRANSCRIPTION', 'ANALYZE_LYRICS', 'GENERATE_IMAGES', 'RENDER_VIDEO', 'FINALIZE')
        AND (
          ${includeSynthetic}::boolean = TRUE
          OR NOT (
            LOWER(COALESCE(j."inputData"->>'isSynthetic', 'false')) IN ('true', '1', 't', 'yes')
            OR LOWER(COALESCE(j."inputData"->>'syntheticRunType', '')) IN ('smoke', 'chaos', 'synthetic')
            OR LOWER(COALESCE(p."title", '')) LIKE '%[synthetic:%'
            OR LOWER(COALESCE(p."title", '')) LIKE '%smoke baseline%'
            OR LOWER(COALESCE(p."title", '')) LIKE '%external chaos%'
            OR LOWER(COALESCE(p."title", '')) LIKE '%latency chaos%'
          )
        )
      GROUP BY j."type"
      ORDER BY j."type" ASC
    `;

    const stages = rows.map((row) => ({
      type: row.type,
      completedWindow: this.toNumber(row.completedWindow),
      avgMs: Math.round(Number(row.avgMs || 0)),
      p50Ms: Math.round(Number(row.p50Ms || 0)),
      p95Ms: Math.round(Number(row.p95Ms || 0)),
      maxMs: Math.round(Number(row.maxMs || 0)),
    }));

    const totalCompleted = stages.reduce((sum, s) => sum + s.completedWindow, 0);

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      windowHours,
      includeSynthetic,
      totalCompletedJobs: totalCompleted,
      stages,
      collectionMs: Date.now() - startedAt,
    };
  }

  async getDegradedStageSnapshot(
    hours = 24,
    sourceMode?: string,
    includeSynthetic = false,
  ): Promise<Record<string, unknown>> {
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
          END AS "sourceMode",
          CASE
            WHEN LOWER(COALESCE(j."inputData"->>'isSynthetic', 'false')) IN ('true', '1', 't', 'yes') THEN 1
            WHEN LOWER(COALESCE(j."inputData"->>'syntheticRunType', '')) IN ('smoke', 'chaos', 'synthetic') THEN 1
            WHEN LOWER(COALESCE(p."title", '')) LIKE '%[synthetic:%' THEN 1
            WHEN LOWER(COALESCE(p."title", '')) LIKE '%smoke baseline%' THEN 1
            WHEN LOWER(COALESCE(p."title", '')) LIKE '%external chaos%' THEN 1
            WHEN LOWER(COALESCE(p."title", '')) LIKE '%latency chaos%' THEN 1
            ELSE 0
          END AS "isSynthetic"
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
        AND (${includeSynthetic}::boolean = TRUE OR "isSynthetic" = 0)
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
      includeSynthetic,
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

  async getDegradedStageSnapshotWithAlerts(
    hours = 24,
    sourceMode?: string,
    includeSynthetic = false,
  ): Promise<Record<string, unknown>> {
    const snapshot = await this.getDegradedStageSnapshot(hours, sourceMode, includeSynthetic);
    // Avoid webhook spam from ad-hoc filtered queries; alerting should run on global snapshot.
    if ((!sourceMode || sourceMode.trim().length === 0) && !includeSynthetic) {
      await this.healthAlertingService.notifyDegradedStageIfNeeded(snapshot);
    }
    return snapshot;
  }

  async getDegradedRateByLanguage(
    hours = 24,
    includeSynthetic = false,
  ): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    const windowHours = this.normalizeWindowHours(hours);

    const rows = await this.prisma.$queryRaw<DegradedByLanguageRow[]>`
      WITH transcription_language AS (
        SELECT
          COALESCE(NULLIF(j."inputData"->>'correlationId', ''), j."projectId"::text) AS "pipelineKey",
          COALESCE(NULLIF(LOWER(TRIM(j."outputData"->>'language')), ''), 'unknown') AS "language",
          j."updatedAt",
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(NULLIF(j."inputData"->>'correlationId', ''), j."projectId"::text)
            ORDER BY j."updatedAt" DESC
          ) AS "rn"
        FROM "Job" j
        LEFT JOIN "Project" p ON p."id" = j."projectId"
        WHERE j."type" = 'TRANSCRIPTION'
          AND j."status" = 'COMPLETED'
          AND (
            ${includeSynthetic}::boolean = TRUE
            OR NOT (
              LOWER(COALESCE(j."inputData"->>'isSynthetic', 'false')) IN ('true', '1', 't', 'yes')
              OR LOWER(COALESCE(j."inputData"->>'syntheticRunType', '')) IN ('smoke', 'chaos', 'synthetic')
              OR LOWER(COALESCE(p."title", '')) LIKE '%[synthetic:%'
              OR LOWER(COALESCE(p."title", '')) LIKE '%smoke baseline%'
              OR LOWER(COALESCE(p."title", '')) LIKE '%external chaos%'
              OR LOWER(COALESCE(p."title", '')) LIKE '%latency chaos%'
            )
          )
      ),
      project_language AS (
        SELECT
          "pipelineKey",
          "language"
        FROM transcription_language
        WHERE "rn" = 1
      ),
      core_jobs AS (
        SELECT
          j."projectId",
          j."type",
          j."status",
          j."updatedAt",
          COALESCE(NULLIF(j."inputData"->>'correlationId', ''), j."projectId"::text) AS "pipelineKey",
          COALESCE(pl."language", 'unknown') AS "language",
          CASE
            WHEN LOWER(COALESCE(j."outputData"->>'status', '')) = 'degraded' THEN 1
            WHEN LOWER(COALESCE(j."outputData"->>'degraded', 'false')) IN ('true', '1', 't', 'yes') THEN 1
            ELSE 0
          END AS "isDegraded"
        FROM "Job" j
        LEFT JOIN "Project" p ON p."id" = j."projectId"
        LEFT JOIN project_language pl
          ON pl."pipelineKey" = COALESCE(NULLIF(j."inputData"->>'correlationId', ''), j."projectId"::text)
        WHERE j."type" IN ('YOUTUBE_DOWNLOAD', 'TRANSCRIPTION', 'ANALYZE_LYRICS', 'GENERATE_IMAGES', 'RENDER_VIDEO', 'FINALIZE')
          AND (
            ${includeSynthetic}::boolean = TRUE
            OR NOT (
              LOWER(COALESCE(j."inputData"->>'isSynthetic', 'false')) IN ('true', '1', 't', 'yes')
              OR LOWER(COALESCE(j."inputData"->>'syntheticRunType', '')) IN ('smoke', 'chaos', 'synthetic')
              OR LOWER(COALESCE(p."title", '')) LIKE '%[synthetic:%'
              OR LOWER(COALESCE(p."title", '')) LIKE '%smoke baseline%'
              OR LOWER(COALESCE(p."title", '')) LIKE '%external chaos%'
              OR LOWER(COALESCE(p."title", '')) LIKE '%latency chaos%'
            )
          )
      )
      SELECT
        "language",
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
      GROUP BY "language"
      ORDER BY "language" ASC
    `;

    const byLanguage = rows.map((row) => {
      const completedTotal = this.toNumber(row.completedTotal);
      const degradedTotal = this.toNumber(row.degradedTotal);
      const completedWindow = this.toNumber(row.completedWindow);
      const degradedWindow = this.toNumber(row.degradedWindow);
      return {
        language: row.language,
        completedTotal,
        degradedTotal,
        degradedRateTotalPct:
          completedTotal > 0
            ? Number(((degradedTotal / completedTotal) * 100).toFixed(2))
            : 0,
        completedWindow,
        degradedWindow,
        degradedRateWindowPct:
          completedWindow > 0
            ? Number(((degradedWindow / completedWindow) * 100).toFixed(2))
            : 0,
      };
    });

    const totals = byLanguage.reduce(
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
      status: 'ok',
      timestamp: new Date().toISOString(),
      windowHours,
      includeSynthetic,
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
      byLanguage,
      collectionMs: Date.now() - startedAt,
    };
  }

  async getPipelineSlo(hours = 24, includeSynthetic = false): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    const windowHours = this.normalizeWindowHours(hours);

    const sloRows = await this.prisma.$queryRaw<PipelineSloRow[]>`
      WITH core_jobs AS (
        SELECT
          COALESCE(NULLIF(j."inputData"->>'correlationId', ''), j."projectId"::text) AS "pipelineKey",
          j."projectId",
          j."type",
          j."status",
          j."createdAt",
          j."updatedAt"
        FROM "Job" j
        LEFT JOIN "Project" p ON p."id" = j."projectId"
        WHERE j."type" IN ('YOUTUBE_DOWNLOAD', 'TRANSCRIPTION', 'ANALYZE_LYRICS', 'GENERATE_IMAGES', 'RENDER_VIDEO', 'FINALIZE')
          AND (
            ${includeSynthetic}::boolean = TRUE
            OR NOT (
              LOWER(COALESCE(j."inputData"->>'isSynthetic', 'false')) IN ('true', '1', 't', 'yes')
              OR LOWER(COALESCE(j."inputData"->>'syntheticRunType', '')) IN ('smoke', 'chaos', 'synthetic')
              OR LOWER(COALESCE(p."title", '')) LIKE '%[synthetic:%'
              OR LOWER(COALESCE(p."title", '')) LIKE '%smoke baseline%'
              OR LOWER(COALESCE(p."title", '')) LIKE '%external chaos%'
              OR LOWER(COALESCE(p."title", '')) LIKE '%latency chaos%'
            )
          )
      ),
      pipeline_timing AS (
        SELECT
          "pipelineKey",
          MIN("createdAt") AS "startedAt",
          MAX("updatedAt") AS "finishedAt",
          EXTRACT(EPOCH FROM (MAX("updatedAt") - MIN("createdAt"))) * 1000 AS "durationMs",
          COUNT(DISTINCT "type") AS "stageCount"
        FROM core_jobs
        WHERE "status" = 'COMPLETED'
        GROUP BY "pipelineKey"
        HAVING BOOL_OR("type" = 'FINALIZE') = TRUE
      )
      SELECT
        COUNT(*) AS "pipelineCount",
        COALESCE(AVG("durationMs"), 0) AS "avgMs",
        COALESCE(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY "durationMs"), 0) AS "p50Ms",
        COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY "durationMs"), 0) AS "p95Ms",
        COALESCE(MAX("durationMs"), 0) AS "maxMs",
        COALESCE(MIN("durationMs"), 0) AS "minMs"
      FROM pipeline_timing
      WHERE "finishedAt" >= NOW() - (${windowHours}::int * INTERVAL '1 hour')
    `;

    const slo = sloRows[0] || {
      pipelineCount: 0,
      avgMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      maxMs: 0,
      minMs: 0,
    };

    const pipelineCount = this.toNumber(slo.pipelineCount);
    const p95Ms = Math.round(Number(slo.p95Ms || 0));
    const warnThresholdMs = Math.min(this.pipelineSloP95WarnMs, this.pipelineSloP95CriticalMs);
    const criticalThresholdMs = Math.max(this.pipelineSloP95WarnMs, this.pipelineSloP95CriticalMs);

    let sloStatus: 'met' | 'warning' | 'critical' = 'met';
    const alerts: Array<{
      severity: 'warning' | 'critical';
      p95Ms: number;
      thresholdMs: number;
      pipelineCount: number;
    }> = [];

    if (pipelineCount >= this.pipelineSloMinCompleted) {
      if (p95Ms >= criticalThresholdMs) {
        sloStatus = 'critical';
        alerts.push({
          severity: 'critical',
          p95Ms,
          thresholdMs: criticalThresholdMs,
          pipelineCount,
        });
      } else if (p95Ms >= warnThresholdMs) {
        sloStatus = 'warning';
        alerts.push({
          severity: 'warning',
          p95Ms,
          thresholdMs: warnThresholdMs,
          pipelineCount,
        });
      }
    }

    return {
      status: sloStatus,
      timestamp: new Date().toISOString(),
      windowHours,
      includeSynthetic,
      thresholds: {
        p95WarnMs: warnThresholdMs,
        p95CriticalMs: criticalThresholdMs,
        minCompletedPipelines: this.pipelineSloMinCompleted,
      },
      metrics: {
        pipelineCount,
        avgMs: Math.round(Number(slo.avgMs || 0)),
        p50Ms: Math.round(Number(slo.p50Ms || 0)),
        p95Ms,
        maxMs: Math.round(Number(slo.maxMs || 0)),
        minMs: Math.round(Number(slo.minMs || 0)),
      },
      alerts,
      hasCriticalAlerts: alerts.some((a) => a.severity === 'critical'),
      mitigation: this.sloMitigationService.snapshot(),
      collectionMs: Date.now() - startedAt,
    };
  }

  async getQueueWaitByStage(hours = 24): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    const windowHours = this.normalizeWindowHours(hours);
    const nowMs = Date.now();
    const windowStartMs = nowMs - windowHours * 60 * 60 * 1000;
    const queueTypeByKey: Record<QueueKey, string> = {
      youtubeDownload: 'YOUTUBE_DOWNLOAD',
      transcription: 'TRANSCRIPTION',
      analysis: 'ANALYZE_LYRICS',
      imageGeneration: 'GENERATE_IMAGES',
      videoRender: 'RENDER_VIDEO',
      trainLora: 'TRAIN_LORA',
    };

    const stages = await Promise.all(
      this.getManagedQueues().map(async ({ key, queue }) => {
        const counts = await queue.getJobCounts('waiting', 'delayed', 'completed');

        const completedCount = counts.completed || 0;
        const inspectCompleted = Math.min(completedCount, this.queueWaitInspectMax);
        const completedJobs =
          inspectCompleted > 0
            ? await queue.getJobs(['completed'], 0, inspectCompleted - 1, true)
            : [];
        const completedWaitMs: number[] = [];
        for (const queueJob of completedJobs) {
          const queuedAt = typeof queueJob.timestamp === 'number' ? queueJob.timestamp : 0;
          const processedAt =
            typeof (queueJob as { processedOn?: number }).processedOn === 'number'
              ? ((queueJob as { processedOn?: number }).processedOn as number)
              : 0;
          if (queuedAt > 0 && processedAt > 0 && processedAt >= windowStartMs) {
            completedWaitMs.push(Math.max(0, processedAt - queuedAt));
          }
        }

        const pendingCount = (counts.waiting || 0) + (counts.delayed || 0);
        const inspectPending = Math.min(pendingCount, this.queueWaitInspectMax);
        const pendingJobs =
          inspectPending > 0
            ? await queue.getJobs(['waiting', 'delayed'], 0, inspectPending - 1, true)
            : [];
        const pendingAgeMs: number[] = [];
        for (const queueJob of pendingJobs) {
          const queuedAt = typeof queueJob.timestamp === 'number' ? queueJob.timestamp : 0;
          if (queuedAt > 0) {
            pendingAgeMs.push(Math.max(0, nowMs - queuedAt));
          }
        }

        return {
          queueKey: key,
          queueName: queue.name,
          type: queueTypeByKey[key],
          completed: {
            totalAvailable: completedCount,
            inspected: inspectCompleted,
            sampled: completedCount > inspectCompleted,
            inWindow: completedWaitMs.length,
            waitMs: this.summarizeDurations(completedWaitMs),
          },
          pending: {
            totalAvailable: pendingCount,
            inspected: inspectPending,
            sampled: pendingCount > inspectPending,
            ageMs: this.summarizeDurations(pendingAgeMs),
          },
        };
      }),
    );

    stages.sort((a, b) => this.getStageOrder(a.type) - this.getStageOrder(b.type));

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      windowHours,
      inspectLimitPerQueue: this.queueWaitInspectMax,
      stages,
      collectionMs: Date.now() - startedAt,
    };
  }

  async getPipelineSloBreakdown(hours = 24, includeSynthetic = false): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    const windowHours = this.normalizeWindowHours(hours);
    const topN = Math.max(1, this.pipelineSloBreakdownTopN);

    const rows = await this.prisma.$queryRaw<PipelineSloBreakdownRow[]>`
      WITH core_jobs AS (
        SELECT
          COALESCE(NULLIF(j."inputData"->>'correlationId', ''), j."projectId"::text) AS "pipelineKey",
          j."projectId"::text AS "projectId",
          j."type",
          j."status",
          j."createdAt",
          j."updatedAt",
          j."inputData",
          j."outputData"
        FROM "Job" j
        LEFT JOIN "Project" p ON p."id" = j."projectId"
        WHERE j."type" IN ('YOUTUBE_DOWNLOAD', 'TRANSCRIPTION', 'ANALYZE_LYRICS', 'GENERATE_IMAGES', 'RENDER_VIDEO', 'FINALIZE')
          AND (
            ${includeSynthetic}::boolean = TRUE
            OR NOT (
              LOWER(COALESCE(j."inputData"->>'isSynthetic', 'false')) IN ('true', '1', 't', 'yes')
              OR LOWER(COALESCE(j."inputData"->>'syntheticRunType', '')) IN ('smoke', 'chaos', 'synthetic')
              OR LOWER(COALESCE(p."title", '')) LIKE '%[synthetic:%'
              OR LOWER(COALESCE(p."title", '')) LIKE '%smoke baseline%'
              OR LOWER(COALESCE(p."title", '')) LIKE '%external chaos%'
              OR LOWER(COALESCE(p."title", '')) LIKE '%latency chaos%'
            )
          )
      ),
      pipeline_source AS (
        SELECT
          "pipelineKey",
          COALESCE(
            MAX(
              CASE
                WHEN LOWER(COALESCE("inputData"->>'sourceMode', '')) IN ('youtube', 'audio', 'lyrics')
                  THEN LOWER("inputData"->>'sourceMode')
                ELSE NULL
              END
            ),
            'unknown'
          ) AS "sourceMode"
        FROM core_jobs
        GROUP BY "pipelineKey"
      ),
      pipeline_totals AS (
        SELECT
          "pipelineKey",
          MIN("createdAt") AS "startedAt",
          MAX("updatedAt") AS "finishedAt",
          EXTRACT(EPOCH FROM (MAX("updatedAt") - MIN("createdAt"))) * 1000 AS "totalDurationMs"
        FROM core_jobs
        WHERE "status" = 'COMPLETED'
        GROUP BY "pipelineKey"
        HAVING BOOL_OR("type" = 'FINALIZE') = TRUE
      ),
      top_pipelines AS (
        SELECT *
        FROM pipeline_totals
        WHERE "finishedAt" >= NOW() - (${windowHours}::int * INTERVAL '1 hour')
        ORDER BY "totalDurationMs" DESC
        LIMIT ${topN}
      ),
      stage_attempts AS (
        SELECT
          "pipelineKey",
          "type",
          COUNT(*) AS "attemptCount"
        FROM core_jobs
        GROUP BY "pipelineKey", "type"
      ),
      stage_latest AS (
        SELECT *
        FROM (
          SELECT
            cj."pipelineKey",
            cj."projectId",
            cj."type",
            cj."status",
            cj."createdAt",
            cj."updatedAt",
            cj."outputData",
            ROW_NUMBER() OVER (
              PARTITION BY cj."pipelineKey", cj."type"
              ORDER BY cj."updatedAt" DESC, cj."createdAt" DESC
            ) AS "rn"
          FROM core_jobs cj
          INNER JOIN top_pipelines tp ON tp."pipelineKey" = cj."pipelineKey"
        ) ranked
        WHERE "rn" = 1
      )
      SELECT
        tp."pipelineKey",
        sl."projectId",
        ps."sourceMode",
        tp."startedAt",
        tp."finishedAt",
        tp."totalDurationMs",
        sl."type" AS "stageType",
        sl."status" AS "stageStatus",
        sl."createdAt" AS "stageCreatedAt",
        sl."updatedAt" AS "stageUpdatedAt",
        EXTRACT(EPOCH FROM (sl."updatedAt" - sl."createdAt")) * 1000 AS "stageDurationMs",
        COALESCE(sa."attemptCount", 1) AS "attemptCount",
        CASE
          WHEN LOWER(COALESCE(sl."outputData"->>'status', '')) = 'degraded' THEN 1
          WHEN LOWER(COALESCE(sl."outputData"->>'degraded', 'false')) IN ('true', '1', 't', 'yes') THEN 1
          ELSE 0
        END AS "stageDegraded"
      FROM top_pipelines tp
      LEFT JOIN stage_latest sl ON sl."pipelineKey" = tp."pipelineKey"
      LEFT JOIN stage_attempts sa ON sa."pipelineKey" = sl."pipelineKey" AND sa."type" = sl."type"
      LEFT JOIN pipeline_source ps ON ps."pipelineKey" = tp."pipelineKey"
      ORDER BY
        tp."totalDurationMs" DESC,
        CASE sl."type"
          WHEN 'YOUTUBE_DOWNLOAD' THEN 1
          WHEN 'TRANSCRIPTION' THEN 2
          WHEN 'ANALYZE_LYRICS' THEN 3
          WHEN 'GENERATE_IMAGES' THEN 4
          WHEN 'RENDER_VIDEO' THEN 5
          WHEN 'FINALIZE' THEN 6
          ELSE 999
        END ASC
    `;

    const pipelineMap = new Map<
      string,
      {
        pipelineKey: string;
        projectId: string | null;
        sourceMode: string;
        startedAt: string;
        finishedAt: string;
        totalDurationMs: number;
        stageCount: number;
        retriesTotal: number;
        handoffWaitMsTotal: number;
        stages: Array<Record<string, unknown>>;
      }
    >();

    for (const row of rows) {
      if (!pipelineMap.has(row.pipelineKey)) {
        const startedAtMs = this.toEpochMs(row.startedAt) || 0;
        const finishedAtMs = this.toEpochMs(row.finishedAt) || 0;
        pipelineMap.set(row.pipelineKey, {
          pipelineKey: row.pipelineKey,
          projectId: row.projectId,
          sourceMode: this.normalizeSourceMode(row.sourceMode),
          startedAt: new Date(startedAtMs).toISOString(),
          finishedAt: new Date(finishedAtMs).toISOString(),
          totalDurationMs: Math.round(Number(row.totalDurationMs || 0)),
          stageCount: 0,
          retriesTotal: 0,
          handoffWaitMsTotal: 0,
          stages: [],
        });
      }

      if (!row.stageType) {
        continue;
      }

      const pipeline = pipelineMap.get(row.pipelineKey);
      if (!pipeline) {
        continue;
      }
      const stageCreatedAtMs = this.toEpochMs(row.stageCreatedAt);
      const stageUpdatedAtMs = this.toEpochMs(row.stageUpdatedAt);
      const retries = Math.max(0, this.toNumber(row.attemptCount) - 1);
      const stageDegraded =
        row.stageDegraded === true ||
        row.stageDegraded === 1 ||
        row.stageDegraded === '1' ||
        row.stageDegraded === 'true';

      pipeline.stages.push({
        type: row.stageType,
        status: row.stageStatus || 'unknown',
        durationMs: Math.round(Number(row.stageDurationMs || 0)),
        retries,
        degraded: stageDegraded,
        stageOrder: this.getStageOrder(row.stageType),
        stageCreatedAt: stageCreatedAtMs ? new Date(stageCreatedAtMs).toISOString() : null,
        stageUpdatedAt: stageUpdatedAtMs ? new Date(stageUpdatedAtMs).toISOString() : null,
        stageCreatedAtMs,
        stageUpdatedAtMs,
        handoffWaitMs: 0,
      });
    }

    const pipelines = Array.from(pipelineMap.values()).map((pipeline) => {
      pipeline.stages.sort(
        (a, b) => Number((a.stageOrder as number) || 999) - Number((b.stageOrder as number) || 999),
      );

      let totalHandoffWaitMs = 0;
      for (let index = 1; index < pipeline.stages.length; index += 1) {
        const prev = pipeline.stages[index - 1] as Record<string, unknown>;
        const current = pipeline.stages[index] as Record<string, unknown>;
        const prevUpdatedAtMs =
          typeof prev.stageUpdatedAtMs === 'number' ? (prev.stageUpdatedAtMs as number) : null;
        const currentCreatedAtMs =
          typeof current.stageCreatedAtMs === 'number' ? (current.stageCreatedAtMs as number) : null;
        if (prevUpdatedAtMs && currentCreatedAtMs) {
          const handoffWaitMs = Math.max(0, currentCreatedAtMs - prevUpdatedAtMs);
          current.handoffWaitMs = handoffWaitMs;
          totalHandoffWaitMs += handoffWaitMs;
        }
      }

      const stages = pipeline.stages.map((stage) => {
        const normalized = { ...stage };
        delete normalized.stageOrder;
        delete normalized.stageCreatedAtMs;
        delete normalized.stageUpdatedAtMs;
        return normalized;
      });

      return {
        ...pipeline,
        stageCount: stages.length,
        retriesTotal: stages.reduce((sum, stage) => sum + Number(stage.retries || 0), 0),
        handoffWaitMsTotal: totalHandoffWaitMs,
        stages,
      };
    });

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      windowHours,
      includeSynthetic,
      topN,
      pipelineCount: pipelines.length,
      pipelines,
      collectionMs: Date.now() - startedAt,
    };
  }

  async getOpsSnapshot(includeSynthetic = false) {
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
    let deadLetterByType = {
      total: 0,
      inspected: 0,
      sampled: false,
      byType: [] as DeadLetterByTypeEntry[],
    };
    let durationByStage: Record<string, unknown> | null = null;
    let degradedByLanguage: Record<string, unknown> | null = null;
    let pipelineSlo: Record<string, unknown> | null = null;
    let queueWaitByStage: Record<string, unknown> | null = null;
    let pipelineSloBreakdown: Record<string, unknown> | null = null;

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
      degradedByStage = await this.getDegradedStageSnapshotWithAlerts(24, undefined, includeSynthetic);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`degraded_stage_metrics_error:${message}`);
      this.logger.warn(`Failed to collect degraded-by-stage metrics: ${message}`);
    }

    try {
      deadLetterByType = await this.getDeadLetterByJobType();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`dead_letter_metrics_error:${message}`);
      this.logger.warn(`Failed to collect dead-letter metrics: ${message}`);
    }

    try {
      durationByStage = await this.getDurationByStage(24, includeSynthetic);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`duration_by_stage_error:${message}`);
      this.logger.warn(`Failed to collect duration-by-stage metrics: ${message}`);
    }

    try {
      degradedByLanguage = await this.getDegradedRateByLanguage(24, includeSynthetic);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`degraded_by_language_error:${message}`);
      this.logger.warn(`Failed to collect degraded-by-language metrics: ${message}`);
    }

    try {
      pipelineSlo = await this.getPipelineSlo(24, includeSynthetic);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`pipeline_slo_error:${message}`);
      this.logger.warn(`Failed to collect pipeline SLO metrics: ${message}`);
    }

    try {
      queueWaitByStage = await this.getQueueWaitByStage(24);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`queue_wait_by_stage_error:${message}`);
      this.logger.warn(`Failed to collect queue wait by stage metrics: ${message}`);
    }

    try {
      pipelineSloBreakdown = await this.getPipelineSloBreakdown(24, includeSynthetic);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`pipeline_slo_breakdown_error:${message}`);
      this.logger.warn(`Failed to collect pipeline SLO breakdown metrics: ${message}`);
    }

    // Auto-mitigation: evaluate SLO and activate/deactivate mitigation
    if (pipelineSlo) {
      try {
        await this.sloMitigationService.evaluateAndMitigate(pipelineSlo);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`slo_mitigation_error:${message}`);
        this.logger.warn(`Failed to evaluate SLO mitigation: ${message}`);
      }
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

    const queueJobTypeByKey: Record<QueueKey, string> = {
      youtubeDownload: 'YOUTUBE_DOWNLOAD',
      transcription: 'TRANSCRIPTION',
      analysis: 'ANALYZE_LYRICS',
      imageGeneration: 'GENERATE_IMAGES',
      videoRender: 'RENDER_VIDEO',
      trainLora: 'TRAIN_LORA',
    };
    const queueByType = new Map<string, QueueSnapshot>();
    for (const queue of queues) {
      const mappedType = queueJobTypeByKey[queue.key];
      if (mappedType) {
        queueByType.set(mappedType, queue);
      }
    }
    const jobStatsByType = new Map(jobsByType.map((row) => [row.type, row]));
    const deadLetterStatsByType = new Map(
      deadLetterByType.byType.map((row) => [row.type, row]),
    );
    const retryTypes = Array.from(
      new Set([
        ...Array.from(queueByType.keys()),
        ...Array.from(jobStatsByType.keys()),
        ...Array.from(deadLetterStatsByType.keys()),
      ]),
    ).sort((a, b) => a.localeCompare(b));
    const retryByJobType = retryTypes.map((type) => {
      const queue = queueByType.get(type);
      const dbStats = jobStatsByType.get(type);
      const deadLetterStats = deadLetterStatsByType.get(type);
      return {
        type,
        queueRetrying: queue?.retrying ?? 0,
        queueFailed: queue?.failed ?? 0,
        failedLast24h: dbStats?.failedLast24h ?? 0,
        completedLast24h: dbStats?.completedLast24h ?? 0,
        deadLetterTotal: deadLetterStats?.total ?? 0,
        deadLetterRetryable: deadLetterStats?.retryable ?? 0,
        deadLetterAttemptsExhausted: deadLetterStats?.attemptsExhausted ?? 0,
      };
    });

    const hasCriticalPipelineSlo =
      pipelineSlo &&
      typeof pipelineSlo === 'object' &&
      Boolean((pipelineSlo as Record<string, unknown>).hasCriticalAlerts);

    return {
      status:
        errors.length > 0 || hasCriticalDegradedAlerts || hasCriticalLatencyAlerts || hasCriticalPipelineSlo
          ? 'degraded'
          : 'ok',
      timestamp: now,
      includeSynthetic,
      uptimeSec: Math.round(process.uptime()),
      collectionMs: Date.now() - startedAt,
      queueTotals,
      queues,
      jobsByType,
      deadLetterByType,
      retryByJobType,
      degradedByStage,
      sourceModeSummary24h,
      durationByStage,
      degradedByLanguage,
      pipelineSlo,
      queueWaitByStage,
      pipelineSloBreakdown,
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
      sloMitigation: this.sloMitigationService.snapshot(),
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

  async getPipelineQualitySummary(
    hours = 24,
    sourceMode?: string,
    includeSynthetic = false,
  ): Promise<Record<string, unknown>> {
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
            title: true,
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
      if (!includeSynthetic && this.isSyntheticJob(job.inputData, job.project)) {
        continue;
      }
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
      includeSynthetic,
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
