import { HealthService } from './health.service';
import { HealthOpsMetricsService } from './services/health-ops-metrics.service';
import { SloMitigationService } from './services/slo-mitigation.service';

describe('HealthOpsMetricsService', () => {
  const createOpsService = () => {
    const prisma = {
      $queryRaw: jest.fn(),
      job: {
        findMany: jest.fn(),
      },
    };

    const queueStub = {
      name: 'stub-queue',
      getJobCounts: jest.fn().mockResolvedValue({
        waiting: 0,
        active: 0,
        delayed: 0,
        failed: 0,
        completed: 0,
        paused: 0,
      }),
      getJobCountByTypes: jest.fn().mockResolvedValue(0),
      getJobs: jest.fn().mockResolvedValue([]),
    };

    const alertingStub = {
      notifyDegradedStageIfNeeded: jest.fn().mockResolvedValue(undefined),
    };

    const eventsMetricsStub = {
      snapshot: jest.fn().mockReturnValue({
        activeConnections: 0,
        totalConnections: 0,
        totalDisconnections: 0,
        authFailures: 0,
        joinRequests: 0,
        joinSuccess: 0,
        joinDenied: 0,
        joinInvalid: 0,
        leaveRequests: 0,
        inboundMessages: 0,
        inboundParseErrors: 0,
        emittedEvents: 0,
        emittedByType: {},
        inboundByType: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    };

    const circuitBreakerStub = {
      snapshot: jest.fn().mockReturnValue({
        generatedAt: new Date().toISOString(),
        failureThreshold: 3,
        cooldownMs: 60000,
        entries: [],
      }),
    };

    const sloMitigationStub = {
      evaluateAndMitigate: jest.fn().mockResolvedValue(undefined),
      snapshot: jest.fn().mockReturnValue({
        active: false,
        activatedAt: null,
        deactivatedAt: null,
        reason: null,
        actions: [],
        imageQueuePaused: false,
        earlyFailoverActive: false,
        cooldownMs: 300000,
        consecutiveCriticalChecks: 0,
        requiredConsecutiveChecks: 2,
      }),
      isActive: jest.fn().mockReturnValue(false),
    };

    const opsService = new HealthOpsMetricsService(
      prisma as any,
      alertingStub as any,
      sloMitigationStub as any,
      eventsMetricsStub as any,
      circuitBreakerStub as any,
      queueStub as any,
      queueStub as any,
      queueStub as any,
      queueStub as any,
      queueStub as any,
      queueStub as any,
      queueStub as any,
    );

    return { opsService, prisma, alertingStub, sloMitigationStub };
  };

  it('returns degraded metrics by stage with computed rates', async () => {
    const { opsService, prisma } = createOpsService();

    prisma.$queryRaw.mockResolvedValue([
      {
        type: 'GENERATE_IMAGES',
        sourceMode: 'youtube',
        completedTotal: 12,
        degradedTotal: 3,
        completedWindow: 4,
        degradedWindow: 1,
      },
      {
        type: 'GENERATE_IMAGES',
        sourceMode: 'lyrics',
        completedTotal: 8,
        degradedTotal: 2,
        completedWindow: 4,
        degradedWindow: 1,
      },
      {
        type: 'RENDER_VIDEO',
        sourceMode: 'audio',
        completedTotal: 10,
        degradedTotal: 1,
        completedWindow: 5,
        degradedWindow: 1,
      },
    ]);

    const snapshot = await opsService.getDegradedStageSnapshot(24);

    expect(snapshot.status).toBe('degraded');
    expect(snapshot.windowHours).toBe(24);
    expect(snapshot).toMatchObject({
      totals: {
        completedTotal: 30,
        degradedTotal: 6,
        completedWindow: 13,
        degradedWindow: 3,
        degradedRateTotalPct: 20,
      },
      alerts: {
        criticalCount: 2,
        warningCount: 0,
        hasCriticalAlerts: true,
      },
    });

    expect(Array.isArray(snapshot.byType)).toBe(true);
    expect((snapshot.byType as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: 'GENERATE_IMAGES',
      degradedRateTotalPct: 25,
      degradedRateWindowPct: 25,
    });
    expect(Array.isArray(snapshot.bySourceMode)).toBe(true);
    expect((snapshot.bySourceMode as Array<Record<string, unknown>>)[0]).toMatchObject({
      sourceMode: 'youtube',
      completedTotal: 12,
      degradedTotal: 3,
    });
    expect(Array.isArray(snapshot.byTypeAndSource)).toBe(true);
    expect(
      (snapshot.byTypeAndSource as Array<Record<string, unknown>>).some(
        (row) => row.type === 'GENERATE_IMAGES' && row.sourceMode === 'lyrics',
      ),
    ).toBe(true);
  });

  it('normalizes invalid windows to safe bounds', async () => {
    const { opsService, prisma } = createOpsService();
    prisma.$queryRaw.mockResolvedValue([]);

    const low = await opsService.getDegradedStageSnapshot(0);
    const high = await opsService.getDegradedStageSnapshot(999999);

    expect(low.windowHours).toBe(1);
    expect(high.windowHours).toBe(24 * 30);
  });

  it('rejects invalid sourceMode filters', async () => {
    const { opsService, prisma } = createOpsService();
    prisma.$queryRaw.mockResolvedValue([]);

    await expect(opsService.getDegradedStageSnapshot(24, 'bad-source')).rejects.toThrow(
      'Invalid sourceMode',
    );
    await expect(opsService.getPipelineQualitySummary(24, 'bad-source')).rejects.toThrow(
      'Invalid sourceMode',
    );
  });

  it('returns ok when there are no critical degraded alerts', async () => {
    const { opsService, prisma } = createOpsService();
    prisma.$queryRaw.mockResolvedValue([
      {
        type: 'TRANSCRIPTION',
        sourceMode: 'audio',
        completedTotal: 50,
        degradedTotal: 2,
        completedWindow: 20,
        degradedWindow: 1,
      },
    ]);

    const snapshot = await opsService.getDegradedStageSnapshot(24);
    expect(snapshot.status).toBe('ok');
    expect(snapshot).toMatchObject({
      alerts: {
        criticalCount: 0,
        hasCriticalAlerts: false,
      },
    });
  });

  it('notifies alerting service when using snapshot with alerts helper', async () => {
    const { opsService, prisma, alertingStub } = createOpsService();
    prisma.$queryRaw.mockResolvedValue([]);

    const snapshot = await opsService.getDegradedStageSnapshotWithAlerts(24);
    expect(snapshot.status).toBe('ok');
    expect(alertingStub.notifyDegradedStageIfNeeded).toHaveBeenCalledTimes(1);
  });

  it('skips alert notifications for filtered sourceMode degraded snapshots', async () => {
    const { opsService, prisma, alertingStub } = createOpsService();
    prisma.$queryRaw.mockResolvedValue([]);

    const snapshot = await opsService.getDegradedStageSnapshotWithAlerts(24, 'lyrics');
    expect(snapshot.status).toBe('ok');
    expect(alertingStub.notifyDegradedStageIfNeeded).not.toHaveBeenCalled();
  });

  it('returns realtime websocket metrics snapshot', () => {
    const { opsService } = createOpsService();
    const snapshot = opsService.getRealtimeEventsSnapshot();

    expect(snapshot.status).toBe('ok');
    expect(snapshot).toHaveProperty('realtimeEvents');
  });

  it('includes sourceModeSummary24h in ops snapshot', async () => {
    const { opsService } = createOpsService();
    jest.spyOn(opsService as any, 'getManagedQueues').mockReturnValue([]);
    jest.spyOn(opsService as any, 'getJobTypeStats').mockResolvedValue([]);
    jest.spyOn(opsService as any, 'getDeadLetterByJobType').mockResolvedValue({
      total: 2,
      inspected: 2,
      sampled: false,
      byType: [
        {
          type: 'GENERATE_IMAGES',
          total: 2,
          retryable: 1,
          nonRetryable: 1,
          transient: 1,
          permanent: 1,
          unknown: 0,
          attemptsExhausted: 1,
          lastCapturedAt: new Date().toISOString(),
        },
      ],
    });
    jest.spyOn(opsService, 'getDegradedStageSnapshotWithAlerts').mockResolvedValue({
      status: 'ok',
      alerts: { hasCriticalAlerts: false },
      bySourceMode: [
        {
          sourceMode: 'lyrics',
          completedTotal: 10,
          degradedTotal: 2,
          degradedRateTotalPct: 20,
          completedWindow: 6,
          degradedWindow: 2,
          degradedRateWindowPct: 33.33,
        },
      ],
    } as any);
    jest.spyOn(opsService, 'getDurationByStage').mockResolvedValue({
      status: 'ok',
      stages: [],
    });
    jest.spyOn(opsService, 'getDegradedRateByLanguage').mockResolvedValue({
      status: 'ok',
      byLanguage: [],
    });
    jest.spyOn(opsService, 'getPipelineSlo').mockResolvedValue({
      status: 'met',
      hasCriticalAlerts: false,
      alerts: [],
    });
    jest.spyOn(opsService, 'getQueueWaitByStage').mockResolvedValue({
      status: 'ok',
      stages: [],
    });
    jest.spyOn(opsService, 'getPipelineSloBreakdown').mockResolvedValue({
      status: 'ok',
      pipelines: [],
    });

    const snapshot = await opsService.getOpsSnapshot();
    expect(snapshot.status).toBe('ok');
    expect(snapshot).toHaveProperty('sloMitigation');
    expect(Array.isArray(snapshot.sourceModeSummary24h)).toBe(true);
    expect((snapshot.sourceModeSummary24h as Array<Record<string, unknown>>)[0]).toMatchObject({
      sourceMode: 'lyrics',
      completedWindow: 6,
      degradedWindow: 2,
    });
    expect(snapshot).toHaveProperty('deadLetterByType');
    expect(snapshot).toHaveProperty('retryByJobType');
    expect(snapshot).toHaveProperty('queueWaitByStage');
    expect(snapshot).toHaveProperty('pipelineSloBreakdown');
    expect((snapshot.deadLetterByType as Record<string, unknown>).total).toBe(2);
  });

  it('returns pipeline quality summary grouped by stable reason code', async () => {
    const { opsService, prisma } = createOpsService();
    prisma.job.findMany.mockResolvedValue([
      {
        type: 'GENERATE_IMAGES',
        inputData: { sourceMode: 'youtube' },
        project: { youtubeUrl: 'https://youtube.com/watch?v=abc', audioUrl: null, lyrics: null, sourceMode: null },
        outputData: {
          status: 'degraded',
          degraded: true,
          degradedReasons: ['image_generation_empty'],
        },
      },
      {
        type: 'RENDER_VIDEO',
        inputData: { sourceMode: 'lyrics' },
        project: { youtubeUrl: null, audioUrl: null, lyrics: 'hello', sourceMode: null },
        outputData: {
          status: 'degraded',
          message: 'fallback output used',
        },
      },
      {
        type: 'YOUTUBE_DOWNLOAD',
        inputData: { sourceMode: 'youtube' },
        project: { youtubeUrl: 'https://youtube.com/watch?v=abc', audioUrl: null, lyrics: null, sourceMode: null },
        outputData: { status: 'success' },
      },
    ]);

    const summary = await opsService.getPipelineQualitySummary(24);
    expect(summary.status).toBe('ok');
    expect(summary).toMatchObject({
      totals: {
        completedWindow: 3,
        degradedWindow: 2,
      },
    });
    expect(summary).toHaveProperty('byType');
    expect(summary).toHaveProperty('bySourceMode');
    expect(summary).toHaveProperty('byTypeAndSource');
    expect(summary).toHaveProperty('byReasonCode');
    const bySourceMode = summary.bySourceMode as Array<Record<string, unknown>>;
    expect(bySourceMode.some((entry) => entry.sourceMode === 'youtube' && entry.completedWindow === 2)).toBe(
      true,
    );
    const byReasonCode = summary.byReasonCode as Array<Record<string, unknown>>;
    expect(byReasonCode.some((entry) => entry.code === 'generate_images.image_generation_empty')).toBe(true);
  });

  it('filters pipeline quality summary by sourceMode', async () => {
    const { opsService, prisma } = createOpsService();
    prisma.job.findMany.mockResolvedValue([
      {
        type: 'GENERATE_IMAGES',
        inputData: { sourceMode: 'youtube' },
        project: { youtubeUrl: 'https://youtube.com/watch?v=abc', audioUrl: null, lyrics: null, sourceMode: null },
        outputData: {
          status: 'degraded',
          degraded: true,
          degradedReasons: ['image_generation_empty'],
        },
      },
      {
        type: 'RENDER_VIDEO',
        inputData: { sourceMode: 'lyrics' },
        project: { youtubeUrl: null, audioUrl: null, lyrics: 'hello', sourceMode: null },
        outputData: {
          status: 'degraded',
          message: 'fallback output used',
        },
      },
    ]);

    const summary = await opsService.getPipelineQualitySummary(24, 'lyrics');
    expect(summary).toMatchObject({
      sourceModeFilter: 'lyrics',
      totals: {
        completedWindow: 1,
        degradedWindow: 1,
      },
    });
    expect(summary.byType).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'RENDER_VIDEO',
          completedWindow: 1,
        }),
      ]),
    );
    expect(summary.byType).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'GENERATE_IMAGES',
        }),
      ]),
    );
  });

  it('returns duration by stage with percentiles', async () => {
    const { opsService, prisma } = createOpsService();

    prisma.$queryRaw.mockResolvedValue([
      {
        type: 'GENERATE_IMAGES',
        completedWindow: 10,
        avgMs: 45000.5,
        p50Ms: 42000.3,
        p95Ms: 85000.7,
        maxMs: 120000.0,
      },
      {
        type: 'TRANSCRIPTION',
        completedWindow: 8,
        avgMs: 12000.2,
        p50Ms: 11000.1,
        p95Ms: 25000.9,
        maxMs: 35000.0,
      },
    ]);

    const result = await opsService.getDurationByStage(24);

    expect(result.status).toBe('ok');
    expect(result.windowHours).toBe(24);
    expect(result.totalCompletedJobs).toBe(18);
    expect(Array.isArray(result.stages)).toBe(true);
    const stages = result.stages as Array<Record<string, unknown>>;
    expect(stages).toHaveLength(2);
    expect(stages[0]).toMatchObject({
      type: 'GENERATE_IMAGES',
      completedWindow: 10,
      avgMs: 45001,
      p50Ms: 42000,
      p95Ms: 85001,
      maxMs: 120000,
    });
    expect(stages[1]).toMatchObject({
      type: 'TRANSCRIPTION',
      completedWindow: 8,
    });
  });

  it('returns degraded rate by language', async () => {
    const { opsService, prisma } = createOpsService();

    prisma.$queryRaw.mockResolvedValue([
      {
        language: 'en',
        completedTotal: 20,
        degradedTotal: 2,
        completedWindow: 10,
        degradedWindow: 1,
      },
      {
        language: 'es',
        completedTotal: 15,
        degradedTotal: 5,
        completedWindow: 8,
        degradedWindow: 3,
      },
      {
        language: 'ko',
        completedTotal: 5,
        degradedTotal: 3,
        completedWindow: 3,
        degradedWindow: 2,
      },
    ]);

    const result = await opsService.getDegradedRateByLanguage(24);

    expect(result.status).toBe('ok');
    expect(result.windowHours).toBe(24);
    expect(result).toMatchObject({
      totals: {
        completedTotal: 40,
        degradedTotal: 10,
        completedWindow: 21,
        degradedWindow: 6,
      },
    });
    const byLanguage = result.byLanguage as Array<Record<string, unknown>>;
    expect(byLanguage).toHaveLength(3);
    expect(byLanguage[0]).toMatchObject({
      language: 'en',
      completedTotal: 20,
      degradedTotal: 2,
      degradedRateTotalPct: 10,
      degradedRateWindowPct: 10,
    });
    expect(byLanguage[1]).toMatchObject({
      language: 'es',
      degradedRateTotalPct: 33.33,
      degradedRateWindowPct: 37.5,
    });
    expect(byLanguage[2]).toMatchObject({
      language: 'ko',
      degradedRateTotalPct: 60,
    });
  });

  it('returns pipeline SLO met when p95 is under threshold', async () => {
    const { opsService, prisma } = createOpsService();

    prisma.$queryRaw.mockResolvedValue([
      {
        pipelineCount: 5,
        avgMs: 300000,
        p50Ms: 280000,
        p95Ms: 600000,
        maxMs: 900000,
        minMs: 200000,
      },
    ]);

    const result = await opsService.getPipelineSlo(24);

    expect(result.status).toBe('met');
    expect(result).toMatchObject({
      thresholds: {
        p95WarnMs: 1200000,
        p95CriticalMs: 1800000,
        minCompletedPipelines: 3,
      },
      metrics: {
        pipelineCount: 5,
        p95Ms: 600000,
      },
    });
    expect(result.hasCriticalAlerts).toBe(false);
    expect((result.alerts as unknown[]).length).toBe(0);
  });

  it('returns pipeline SLO warning when p95 exceeds warn threshold', async () => {
    const { opsService, prisma } = createOpsService();

    prisma.$queryRaw.mockResolvedValue([
      {
        pipelineCount: 5,
        avgMs: 900000,
        p50Ms: 850000,
        p95Ms: 1300000,
        maxMs: 1500000,
        minMs: 700000,
      },
    ]);

    const result = await opsService.getPipelineSlo(24);

    expect(result.status).toBe('warning');
    expect(result.hasCriticalAlerts).toBe(false);
    const alerts = result.alerts as Array<Record<string, unknown>>;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      severity: 'warning',
      p95Ms: 1300000,
      thresholdMs: 1200000,
    });
  });

  it('returns pipeline SLO critical when p95 exceeds critical threshold', async () => {
    const { opsService, prisma } = createOpsService();

    prisma.$queryRaw.mockResolvedValue([
      {
        pipelineCount: 5,
        avgMs: 1200000,
        p50Ms: 1100000,
        p95Ms: 1900000,
        maxMs: 2400000,
        minMs: 800000,
      },
    ]);

    const result = await opsService.getPipelineSlo(24);

    expect(result.status).toBe('critical');
    expect(result.hasCriticalAlerts).toBe(true);
    const alerts = result.alerts as Array<Record<string, unknown>>;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      severity: 'critical',
      p95Ms: 1900000,
      thresholdMs: 1800000,
    });
  });

  it('skips SLO alerting when not enough completed pipelines', async () => {
    const { opsService, prisma } = createOpsService();

    prisma.$queryRaw.mockResolvedValue([
      {
        pipelineCount: 1,
        avgMs: 2000000,
        p50Ms: 2000000,
        p95Ms: 2000000,
        maxMs: 2000000,
        minMs: 2000000,
      },
    ]);

    const result = await opsService.getPipelineSlo(24);

    expect(result.status).toBe('met');
    expect((result.alerts as unknown[]).length).toBe(0);
  });

  it('returns queue wait by stage metrics', async () => {
    const { opsService } = createOpsService();
    const nowMs = Date.now();
    const queue = {
      name: 'image-generation',
      getJobCounts: jest.fn().mockResolvedValue({
        waiting: 1,
        delayed: 1,
        completed: 3,
      }),
      getJobs: jest.fn().mockImplementation(async (statuses: string[]) => {
        if (statuses.includes('completed')) {
          return [
            { timestamp: nowMs - 120000, processedOn: nowMs - 100000 },
            { timestamp: nowMs - 180000, processedOn: nowMs - 150000 },
            { timestamp: nowMs - 240000, processedOn: nowMs - 200000 },
          ];
        }
        return [{ timestamp: nowMs - 60000 }, { timestamp: nowMs - 90000 }];
      }),
    };
    jest.spyOn(opsService as any, 'getManagedQueues').mockReturnValue([
      { key: 'imageGeneration', queue },
    ]);

    const result = await opsService.getQueueWaitByStage(24);
    expect(result.status).toBe('ok');
    expect(result.inspectLimitPerQueue).toBeGreaterThan(0);
    expect(result.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'GENERATE_IMAGES',
          completed: expect.objectContaining({
            inWindow: 3,
          }),
          pending: expect.objectContaining({
            totalAvailable: 2,
          }),
        }),
      ]),
    );
  });

  it('returns pipeline SLO breakdown with per-stage retries and handoff waits', async () => {
    const { opsService, prisma } = createOpsService();
    const base = new Date('2026-03-04T10:00:00.000Z');
    prisma.$queryRaw.mockResolvedValue([
      {
        pipelineKey: 'cid-1',
        projectId: 'project-1',
        sourceMode: 'youtube',
        startedAt: base,
        finishedAt: new Date(base.getTime() + 600000),
        totalDurationMs: 600000,
        stageType: 'TRANSCRIPTION',
        stageStatus: 'COMPLETED',
        stageCreatedAt: new Date(base.getTime() + 5000),
        stageUpdatedAt: new Date(base.getTime() + 65000),
        stageDurationMs: 60000,
        attemptCount: 2,
        stageDegraded: 0,
      },
      {
        pipelineKey: 'cid-1',
        projectId: 'project-1',
        sourceMode: 'youtube',
        startedAt: base,
        finishedAt: new Date(base.getTime() + 600000),
        totalDurationMs: 600000,
        stageType: 'GENERATE_IMAGES',
        stageStatus: 'COMPLETED',
        stageCreatedAt: new Date(base.getTime() + 70000),
        stageUpdatedAt: new Date(base.getTime() + 370000),
        stageDurationMs: 300000,
        attemptCount: 3,
        stageDegraded: 1,
      },
    ]);

    const result = await opsService.getPipelineSloBreakdown(24);
    expect(result.status).toBe('ok');
    expect(result.pipelineCount).toBe(1);
    const pipelines = result.pipelines as Array<Record<string, unknown>>;
    expect(pipelines[0]).toMatchObject({
      pipelineKey: 'cid-1',
      retriesTotal: 3,
    });
    const stages = pipelines[0].stages as Array<Record<string, unknown>>;
    expect(stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'TRANSCRIPTION', retries: 1 }),
        expect.objectContaining({ type: 'GENERATE_IMAGES', retries: 2, degraded: true }),
      ]),
    );
    expect((stages.find((s) => s.type === 'GENERATE_IMAGES') || {}).handoffWaitMs).toBe(5000);
  });

  it('uses pipeline-key dedupe strategy in degraded-by-language query', async () => {
    const { opsService, prisma } = createOpsService();
    prisma.$queryRaw.mockResolvedValue([]);

    await opsService.getDegradedRateByLanguage(24);

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const [queryParts] = prisma.$queryRaw.mock.calls[0];
    const sql = Array.isArray(queryParts) ? queryParts.join('?') : String(queryParts);

    expect(sql).toContain('COALESCE(NULLIF("inputData"->>\'correlationId\', \'\'), "projectId"::text)');
    expect(sql).toContain('ROW_NUMBER() OVER');
    expect(sql).toContain('PARTITION BY COALESCE(NULLIF("inputData"->>\'correlationId\', \'\'), "projectId"::text)');
    expect(sql).toContain('WHERE "rn" = 1');
  });

  it('evaluates SLO mitigation during ops snapshot', async () => {
    const { opsService, sloMitigationStub } = createOpsService();
    jest.spyOn(opsService as any, 'getManagedQueues').mockReturnValue([]);
    jest.spyOn(opsService as any, 'getJobTypeStats').mockResolvedValue([]);
    jest.spyOn(opsService as any, 'getDeadLetterByJobType').mockResolvedValue({
      total: 0, inspected: 0, sampled: false, byType: [],
    });
    jest.spyOn(opsService, 'getDegradedStageSnapshotWithAlerts').mockResolvedValue({
      status: 'ok', alerts: { hasCriticalAlerts: false }, bySourceMode: [],
    } as any);
    jest.spyOn(opsService, 'getDurationByStage').mockResolvedValue({ status: 'ok', stages: [] });
    jest.spyOn(opsService, 'getDegradedRateByLanguage').mockResolvedValue({ status: 'ok', byLanguage: [] });
    jest.spyOn(opsService, 'getQueueWaitByStage').mockResolvedValue({ status: 'ok', stages: [] });
    jest.spyOn(opsService, 'getPipelineSloBreakdown').mockResolvedValue({ status: 'ok', pipelines: [] });

    const sloResult = {
      status: 'critical',
      hasCriticalAlerts: true,
      alerts: [{ severity: 'critical', p95Ms: 1900000, thresholdMs: 1800000 }],
    };
    jest.spyOn(opsService, 'getPipelineSlo').mockResolvedValue(sloResult);

    await opsService.getOpsSnapshot();

    expect(sloMitigationStub.evaluateAndMitigate).toHaveBeenCalledWith(sloResult);
    expect(sloMitigationStub.snapshot).toHaveBeenCalled();
  });

  it('computes pipeline SLO grouped by pipeline key (correlationId fallback)', async () => {
    const { opsService, prisma } = createOpsService();
    prisma.$queryRaw.mockResolvedValue([
      {
        pipelineCount: 0,
        avgMs: 0,
        p50Ms: 0,
        p95Ms: 0,
        maxMs: 0,
        minMs: 0,
      },
    ]);

    await opsService.getPipelineSlo(24);

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const [queryParts] = prisma.$queryRaw.mock.calls[0];
    const sql = Array.isArray(queryParts) ? queryParts.join('?') : String(queryParts);

    expect(sql).toContain('COALESCE(NULLIF("inputData"->>\'correlationId\', \'\'), "projectId"::text) AS "pipelineKey"');
    expect(sql).toContain('GROUP BY "pipelineKey"');
    expect(sql).toContain('HAVING BOOL_OR("type" = \'FINALIZE\') = TRUE');
  });
});

describe('HealthService facade delegation', () => {
  it('delegates ops methods to HealthOpsMetricsService', async () => {
    const opsMetricsMock = {
      getOpsSnapshot: jest.fn().mockResolvedValue({ status: 'ok' }),
      getRealtimeEventsSnapshot: jest.fn().mockReturnValue({ status: 'ok' }),
      getDegradedStageSnapshot: jest.fn().mockResolvedValue({ status: 'ok' }),
      getDegradedStageSnapshotWithAlerts: jest.fn().mockResolvedValue({ status: 'ok' }),
      getPipelineQualitySummary: jest.fn().mockResolvedValue({ status: 'ok' }),
      getDurationByStage: jest.fn().mockResolvedValue({ status: 'ok' }),
      getDegradedRateByLanguage: jest.fn().mockResolvedValue({ status: 'ok' }),
      getPipelineSlo: jest.fn().mockResolvedValue({ status: 'met' }),
      getQueueWaitByStage: jest.fn().mockResolvedValue({ status: 'ok' }),
      getPipelineSloBreakdown: jest.fn().mockResolvedValue({ status: 'ok' }),
    } as unknown as HealthOpsMetricsService;

    const sloMitigationMock = {
      snapshot: jest.fn().mockReturnValue({ active: false }),
      evaluateAndMitigate: jest.fn().mockResolvedValue(undefined),
    } as unknown as SloMitigationService;

    const service = new HealthService(opsMetricsMock, sloMitigationMock);

    await expect(service.getOpsSnapshot()).resolves.toEqual({ status: 'ok' });
    expect(service.getRealtimeEventsSnapshot()).toEqual({ status: 'ok' });
    await expect(service.getDegradedStageSnapshot(12, 'lyrics')).resolves.toEqual({ status: 'ok' });
    await expect(service.getDegradedStageSnapshotWithAlerts(24)).resolves.toEqual({ status: 'ok' });
    await expect(service.getPipelineQualitySummary(24)).resolves.toEqual({ status: 'ok' });
    await expect(service.getDurationByStage(24)).resolves.toEqual({ status: 'ok' });
    await expect(service.getDegradedRateByLanguage(12)).resolves.toEqual({ status: 'ok' });
    await expect(service.getPipelineSlo(24)).resolves.toEqual({ status: 'met' });
    await expect(service.getQueueWaitByStage(24)).resolves.toEqual({ status: 'ok' });
    await expect(service.getPipelineSloBreakdown(24)).resolves.toEqual({ status: 'ok' });

    expect((opsMetricsMock.getOpsSnapshot as jest.Mock)).toHaveBeenCalledTimes(1);
    expect((opsMetricsMock.getRealtimeEventsSnapshot as jest.Mock)).toHaveBeenCalledTimes(1);
    expect((opsMetricsMock.getDegradedStageSnapshot as jest.Mock)).toHaveBeenCalledWith(12, 'lyrics');
    expect((opsMetricsMock.getDegradedStageSnapshotWithAlerts as jest.Mock)).toHaveBeenCalledWith(24, undefined);
    expect((opsMetricsMock.getPipelineQualitySummary as jest.Mock)).toHaveBeenCalledWith(24, undefined);
    expect((opsMetricsMock.getDurationByStage as jest.Mock)).toHaveBeenCalledWith(24);
    expect((opsMetricsMock.getDegradedRateByLanguage as jest.Mock)).toHaveBeenCalledWith(12);
    expect((opsMetricsMock.getPipelineSlo as jest.Mock)).toHaveBeenCalledWith(24);
    expect((opsMetricsMock.getQueueWaitByStage as jest.Mock)).toHaveBeenCalledWith(24);
    expect((opsMetricsMock.getPipelineSloBreakdown as jest.Mock)).toHaveBeenCalledWith(24);

    expect(service.getSloMitigationSnapshot()).toEqual({ active: false });
    expect((sloMitigationMock.snapshot as jest.Mock)).toHaveBeenCalledTimes(1);
  });
});
