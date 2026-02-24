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
        completedTotal: 20,
        degradedTotal: 5,
        completedWindow: 8,
        degradedWindow: 2,
      },
      {
        type: 'RENDER_VIDEO',
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
  });

  it('normalizes invalid windows to safe bounds', async () => {
    const { service, prisma } = createService();
    prisma.$queryRaw.mockResolvedValue([]);

    const low = await service.getDegradedStageSnapshot(0);
    const high = await service.getDegradedStageSnapshot(999999);

    expect(low.windowHours).toBe(1);
    expect(high.windowHours).toBe(24 * 30);
  });

  it('returns ok when there are no critical degraded alerts', async () => {
    const { service, prisma } = createService();
    prisma.$queryRaw.mockResolvedValue([
      {
        type: 'TRANSCRIPTION',
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

  it('returns realtime websocket metrics snapshot', () => {
    const { service } = createService();
    const snapshot = service.getRealtimeEventsSnapshot();

    expect(snapshot.status).toBe('ok');
    expect(snapshot).toHaveProperty('realtimeEvents');
  });

  it('returns pipeline quality summary grouped by stable reason code', async () => {
    const { service, prisma } = createService();
    prisma.job.findMany.mockResolvedValue([
      {
        type: 'GENERATE_IMAGES',
        outputData: {
          status: 'degraded',
          degraded: true,
          degradedReasons: ['image_generation_empty'],
        },
      },
      {
        type: 'RENDER_VIDEO',
        outputData: {
          status: 'degraded',
          message: 'fallback output used',
        },
      },
      {
        type: 'YOUTUBE_DOWNLOAD',
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
    expect(summary).toHaveProperty('byReasonCode');
    const byReasonCode = summary.byReasonCode as Array<Record<string, unknown>>;
    expect(byReasonCode.some((entry) => entry.code === 'generate_images.image_generation_empty')).toBe(true);
  });
});
