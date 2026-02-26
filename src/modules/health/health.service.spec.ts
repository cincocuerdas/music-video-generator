import { HealthService } from './health.service';

describe('HealthService.getDegradedStageSnapshot', () => {
  const createService = () => {
    const prisma = {
      $queryRaw: jest.fn(),
      job: {
        findMany: jest.fn(),
      },
    };

    const queueStub = {};
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

    const service = new HealthService(
      prisma as any,
      alertingStub as any,
      eventsMetricsStub as any,
      circuitBreakerStub as any,
      queueStub as any,
      queueStub as any,
      queueStub as any,
      queueStub as any,
      queueStub as any,
      queueStub as any,
    );

    return { service, prisma, alertingStub };
  };

  it('returns degraded metrics by stage with computed rates', async () => {
    const { service, prisma } = createService();

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

    const snapshot = await service.getDegradedStageSnapshot(24);

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
    const { service, prisma } = createService();
    prisma.$queryRaw.mockResolvedValue([]);

    const low = await service.getDegradedStageSnapshot(0);
    const high = await service.getDegradedStageSnapshot(999999);

    expect(low.windowHours).toBe(1);
    expect(high.windowHours).toBe(24 * 30);
  });

  it('rejects invalid sourceMode filters', async () => {
    const { service, prisma } = createService();
    prisma.$queryRaw.mockResolvedValue([]);

    await expect(service.getDegradedStageSnapshot(24, 'bad-source')).rejects.toThrow(
      'Invalid sourceMode',
    );
    await expect(service.getPipelineQualitySummary(24, 'bad-source')).rejects.toThrow(
      'Invalid sourceMode',
    );
  });

  it('returns ok when there are no critical degraded alerts', async () => {
    const { service, prisma } = createService();
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

    const snapshot = await service.getDegradedStageSnapshot(24);
    expect(snapshot.status).toBe('ok');
    expect(snapshot).toMatchObject({
      alerts: {
        criticalCount: 0,
        hasCriticalAlerts: false,
      },
    });
  });

  it('notifies alerting service when using snapshot with alerts helper', async () => {
    const { service, prisma, alertingStub } = createService();
    prisma.$queryRaw.mockResolvedValue([]);

    const snapshot = await service.getDegradedStageSnapshotWithAlerts(24);
    expect(snapshot.status).toBe('ok');
    expect(alertingStub.notifyDegradedStageIfNeeded).toHaveBeenCalledTimes(1);
  });

  it('skips alert notifications for filtered sourceMode degraded snapshots', async () => {
    const { service, prisma, alertingStub } = createService();
    prisma.$queryRaw.mockResolvedValue([]);

    const snapshot = await service.getDegradedStageSnapshotWithAlerts(24, 'lyrics');
    expect(snapshot.status).toBe('ok');
    expect(alertingStub.notifyDegradedStageIfNeeded).not.toHaveBeenCalled();
  });

  it('returns realtime websocket metrics snapshot', () => {
    const { service } = createService();
    const snapshot = service.getRealtimeEventsSnapshot();

    expect(snapshot.status).toBe('ok');
    expect(snapshot).toHaveProperty('realtimeEvents');
  });

  it('includes sourceModeSummary24h in ops snapshot', async () => {
    const { service } = createService();
    jest.spyOn(service as any, 'getManagedQueues').mockReturnValue([]);
    jest.spyOn(service as any, 'getJobTypeStats').mockResolvedValue([]);
    jest.spyOn(service, 'getDegradedStageSnapshotWithAlerts').mockResolvedValue({
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

    const snapshot = await service.getOpsSnapshot();
    expect(snapshot.status).toBe('ok');
    expect(Array.isArray(snapshot.sourceModeSummary24h)).toBe(true);
    expect((snapshot.sourceModeSummary24h as Array<Record<string, unknown>>)[0]).toMatchObject({
      sourceMode: 'lyrics',
      completedWindow: 6,
      degradedWindow: 2,
    });
  });

  it('returns pipeline quality summary grouped by stable reason code', async () => {
    const { service, prisma } = createService();
    prisma.job.findMany.mockResolvedValue([
      {
        type: 'GENERATE_IMAGES',
        inputData: { sourceMode: 'youtube' },
        project: { youtubeUrl: 'https://youtube.com/watch?v=abc', audioUrl: null, lyrics: null },
        outputData: {
          status: 'degraded',
          degraded: true,
          degradedReasons: ['image_generation_empty'],
        },
      },
      {
        type: 'RENDER_VIDEO',
        inputData: { sourceMode: 'lyrics' },
        project: { youtubeUrl: null, audioUrl: null, lyrics: 'hello' },
        outputData: {
          status: 'degraded',
          message: 'fallback output used',
        },
      },
      {
        type: 'YOUTUBE_DOWNLOAD',
        inputData: { sourceMode: 'youtube' },
        project: { youtubeUrl: 'https://youtube.com/watch?v=abc', audioUrl: null, lyrics: null },
        outputData: { status: 'success' },
      },
    ]);

    const summary = await service.getPipelineQualitySummary(24);
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
    const { service, prisma } = createService();
    prisma.job.findMany.mockResolvedValue([
      {
        type: 'GENERATE_IMAGES',
        inputData: { sourceMode: 'youtube' },
        project: { youtubeUrl: 'https://youtube.com/watch?v=abc', audioUrl: null, lyrics: null },
        outputData: {
          status: 'degraded',
          degraded: true,
          degradedReasons: ['image_generation_empty'],
        },
      },
      {
        type: 'RENDER_VIDEO',
        inputData: { sourceMode: 'lyrics' },
        project: { youtubeUrl: null, audioUrl: null, lyrics: 'hello' },
        outputData: {
          status: 'degraded',
          message: 'fallback output used',
        },
      },
    ]);

    const summary = await service.getPipelineQualitySummary(24, 'lyrics');
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
});
