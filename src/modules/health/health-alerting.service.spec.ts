import axios from 'axios';
import { HealthAlertingService } from './health-alerting.service';

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: jest.fn(),
  },
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('HealthAlertingService', () => {
  const originalEnv = { ...process.env };

  const createService = () => {
    const sentryStub = {
      captureException: jest.fn(),
    };
    const service = new HealthAlertingService(sentryStub as any);
    return { service, sentryStub };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.HEALTH_ALERT_WEBHOOK_URL = 'https://alerts.example.com/hook';
    process.env.HEALTH_DEGRADED_ALERT_COOLDOWN_MS = '60000';
    process.env.HEALTH_ALERT_WEBHOOK_TIMEOUT_MS = '5000';
    process.env.HEALTH_ALERT_WEBHOOK_SECRET = 'test-webhook-secret';
    process.env.NODE_ENV = 'test';
    mockedAxios.post.mockResolvedValue({ status: 200, data: { ok: true } } as any);
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('emits alert when sourceMode is critical even if stage critical list is empty', async () => {
    const { service } = createService();
    await service.notifyDegradedStageIfNeeded({
      status: 'ok',
      timestamp: new Date().toISOString(),
      windowHours: 1,
      totals: { degradedRateWindowPct: 20, degradedWindow: 2, completedWindow: 10 },
      alerts: {
        critical: [],
        warnings: [],
        warningThresholdPct: 5,
        criticalThresholdPct: 20,
        minCompletedWindow: 5,
      },
      bySourceMode: [
        {
          sourceMode: 'lyrics',
          degradedRateWindowPct: 25,
          degradedWindow: 2,
          completedWindow: 8,
        },
      ],
    });

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    const payload = mockedAxios.post.mock.calls[0][1] as Record<string, any>;
    expect(payload.event).toBe('pipeline_degraded_alert');
    expect(payload.alerts.criticalCount).toBe(0);
    expect(payload.alerts.sourceMode.criticalCount).toBe(1);
    expect(payload.alerts.sourceMode.critical[0]).toMatchObject({
      severity: 'critical',
      sourceMode: 'lyrics',
      degradedRateWindowPct: 25,
    });
    expect(payload.alerts.hasCriticalSourceModeAlerts).toBe(true);
  });

  it('respects cooldown for identical sourceMode critical signatures', async () => {
    const { service } = createService();
    const snapshot = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      windowHours: 1,
      totals: { degradedRateWindowPct: 20, degradedWindow: 2, completedWindow: 10 },
      alerts: {
        critical: [],
        warnings: [],
        warningThresholdPct: 5,
        criticalThresholdPct: 20,
        minCompletedWindow: 1,
      },
      bySourceMode: [
        {
          sourceMode: 'audio',
          degradedRateWindowPct: 22,
          degradedWindow: 2,
          completedWindow: 9,
        },
      ],
    };

    await service.notifyDegradedStageIfNeeded(snapshot);
    await service.notifyDegradedStageIfNeeded(snapshot);

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });

  it('sends recovery event after sourceMode critical condition clears', async () => {
    const { service } = createService();

    await service.notifyDegradedStageIfNeeded({
      status: 'ok',
      timestamp: new Date().toISOString(),
      windowHours: 1,
      totals: { degradedRateWindowPct: 20, degradedWindow: 2, completedWindow: 10 },
      alerts: {
        critical: [],
        warnings: [],
        warningThresholdPct: 5,
        criticalThresholdPct: 20,
        minCompletedWindow: 1,
      },
      bySourceMode: [
        {
          sourceMode: 'youtube',
          degradedRateWindowPct: 30,
          degradedWindow: 3,
          completedWindow: 10,
        },
      ],
    });

    await service.notifyDegradedStageIfNeeded({
      status: 'ok',
      timestamp: new Date().toISOString(),
      windowHours: 1,
      totals: { degradedRateWindowPct: 0, degradedWindow: 0, completedWindow: 10 },
      alerts: {
        critical: [],
        warnings: [],
        warningThresholdPct: 5,
        criticalThresholdPct: 20,
        minCompletedWindow: 1,
      },
      bySourceMode: [
        {
          sourceMode: 'youtube',
          degradedRateWindowPct: 0,
          degradedWindow: 0,
          completedWindow: 10,
        },
      ],
    });

    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    const recoveryPayload = mockedAxios.post.mock.calls[1][1] as Record<string, any>;
    expect(recoveryPayload.event).toBe('pipeline_degraded_recovered');
    expect(typeof recoveryPayload.previousCriticalSignature).toBe('string');
    expect(recoveryPayload.previousCriticalSignature).toContain('source:youtube:30.00');
  });
});
