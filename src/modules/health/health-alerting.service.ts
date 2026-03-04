import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { createHmac } from 'node:crypto';
import { SentryService } from '../observability';
import { parsePositiveIntEnv } from '../../common/utils/env-parsers';

interface DegradedAlertRow {
  severity: 'warning' | 'critical';
  type: string;
  degradedRateWindowPct: number;
  degradedWindow: number;
  completedWindow: number;
}

interface DegradedBySourceModeRow {
  sourceMode: string;
  degradedRateWindowPct: number;
  degradedWindow: number;
  completedWindow: number;
}

interface DegradedSourceModeAlertRow extends DegradedBySourceModeRow {
  severity: 'warning' | 'critical';
}

interface DegradedSnapshotLike {
  status?: string;
  timestamp?: string;
  windowHours?: number;
  totals?: {
    degradedRateWindowPct?: number;
    degradedWindow?: number;
    completedWindow?: number;
  };
  alerts?: {
    critical?: DegradedAlertRow[];
    warnings?: DegradedAlertRow[];
    hasCriticalAlerts?: boolean;
    criticalCount?: number;
    warningCount?: number;
    warningThresholdPct?: number;
    criticalThresholdPct?: number;
    minCompletedWindow?: number;
  };
  bySourceMode?: DegradedBySourceModeRow[];
}

@Injectable()
export class HealthAlertingService {
  private readonly logger = new Logger(HealthAlertingService.name);
  private readonly webhookUrl = (process.env.HEALTH_ALERT_WEBHOOK_URL || '').trim();
  private readonly cooldownMs = parsePositiveIntEnv(
    'HEALTH_DEGRADED_ALERT_COOLDOWN_MS',
    15 * 60 * 1000,
  );
  private readonly requestTimeoutMs = parsePositiveIntEnv(
    'HEALTH_ALERT_WEBHOOK_TIMEOUT_MS',
    5000,
  );
  private readonly webhookSecret = (process.env.HEALTH_ALERT_WEBHOOK_SECRET || '').trim();
  private readonly appEnv = (process.env.NODE_ENV || 'development').trim().toLowerCase();

  private lastSentAtBySignature = new Map<string, number>();
  private lastCriticalSignature: string | null = null;

  constructor(private readonly sentryService: SentryService) {}

  async notifyDegradedStageIfNeeded(snapshot: DegradedSnapshotLike): Promise<void> {
    if (!this.webhookUrl) {
      return;
    }

    const critical = Array.isArray(snapshot?.alerts?.critical)
      ? snapshot.alerts.critical
      : [];
    const warnings = Array.isArray(snapshot?.alerts?.warnings)
      ? snapshot.alerts.warnings
      : [];
    const sourceModeAlerts = this.buildSourceModeAlerts(snapshot);
    const hasCriticalStageAlerts = critical.length > 0;
    const hasCriticalSourceModeAlerts = sourceModeAlerts.critical.length > 0;
    const hasAnyCriticalAlerts = hasCriticalStageAlerts || hasCriticalSourceModeAlerts;

    if (!hasAnyCriticalAlerts) {
      if (this.lastCriticalSignature) {
        const recoveryPayload = {
          event: 'pipeline_degraded_recovered',
          environment: this.appEnv,
          timestamp: snapshot.timestamp || new Date().toISOString(),
          windowHours: snapshot.windowHours || 24,
          previousCriticalSignature: this.lastCriticalSignature,
          totals: snapshot.totals || {},
        };
        await this.postWebhook(recoveryPayload);
        this.lastCriticalSignature = null;
      }
      return;
    }

    const signature = this.buildSignature(critical, sourceModeAlerts.critical);
    const now = Date.now();
    const lastSentAt = this.lastSentAtBySignature.get(signature) || 0;
    if (now - lastSentAt < this.cooldownMs) {
      return;
    }

    const payload = {
      event: 'pipeline_degraded_alert',
      environment: this.appEnv,
      timestamp: snapshot.timestamp || new Date().toISOString(),
      windowHours: snapshot.windowHours || 24,
      status: snapshot.status || 'degraded',
      totals: snapshot.totals || {},
      alerts: {
        criticalCount: critical.length,
        warningCount: warnings.length,
        critical,
        warnings,
        sourceMode: {
          criticalCount: sourceModeAlerts.critical.length,
          warningCount: sourceModeAlerts.warnings.length,
          critical: sourceModeAlerts.critical,
          warnings: sourceModeAlerts.warnings,
        },
        hasCriticalSourceModeAlerts,
      },
      signature,
      cooldownMs: this.cooldownMs,
    };

    await this.postWebhook(payload);
    this.lastSentAtBySignature.set(signature, now);
    this.lastCriticalSignature = signature;
  }

  private async postWebhook(payload: Record<string, unknown>): Promise<void> {
    try {
      const serializedPayload = JSON.stringify(payload);
      const webhookTimestamp = String(Math.floor(Date.now() / 1000));
      const signature = this.webhookSecret
        ? this.buildWebhookSignature(serializedPayload, webhookTimestamp)
        : '';

      await axios.post(this.webhookUrl, payload, {
        timeout: this.requestTimeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'music-video-generator-health-alert/1.0',
          'X-MVG-Webhook-Timestamp': webhookTimestamp,
          ...(signature ? { 'X-MVG-Webhook-Signature': `sha256=${signature}` } : {}),
        },
      });
      this.logger.warn(
        `Health alert webhook sent (${String(payload.event || 'unknown_event')})`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to send health alert webhook: ${message}`);
      this.sentryService.captureException(error, {
        tags: {
          component: 'health_alerting',
          action: 'webhook_send',
        },
        extra: {
          webhookConfigured: Boolean(this.webhookUrl),
          timeoutMs: this.requestTimeoutMs,
          payload,
        },
      });
    }
  }

  private buildSourceModeAlerts(snapshot: DegradedSnapshotLike): {
    critical: DegradedSourceModeAlertRow[];
    warnings: DegradedSourceModeAlertRow[];
  } {
    const rows = Array.isArray(snapshot?.bySourceMode) ? snapshot.bySourceMode : [];
    const warningThresholdPct = Number(snapshot?.alerts?.warningThresholdPct ?? 5);
    const criticalThresholdPct = Number(snapshot?.alerts?.criticalThresholdPct ?? 20);
    const minCompletedWindow = Number(snapshot?.alerts?.minCompletedWindow ?? 5);

    const critical: DegradedSourceModeAlertRow[] = [];
    const warnings: DegradedSourceModeAlertRow[] = [];

    for (const row of rows) {
      const sourceMode = typeof row?.sourceMode === 'string' ? row.sourceMode.trim().toLowerCase() : '';
      const degradedRateWindowPct = Number(row?.degradedRateWindowPct || 0);
      const degradedWindow = Number(row?.degradedWindow || 0);
      const completedWindow = Number(row?.completedWindow || 0);

      if (!sourceMode || !Number.isFinite(completedWindow) || completedWindow < minCompletedWindow) {
        continue;
      }

      const entryBase: DegradedBySourceModeRow = {
        sourceMode,
        degradedRateWindowPct: Number.isFinite(degradedRateWindowPct) ? degradedRateWindowPct : 0,
        degradedWindow: Number.isFinite(degradedWindow) ? degradedWindow : 0,
        completedWindow,
      };

      if (entryBase.degradedRateWindowPct >= criticalThresholdPct) {
        critical.push({
          severity: 'critical',
          ...entryBase,
        });
        continue;
      }
      if (entryBase.degradedRateWindowPct >= warningThresholdPct) {
        warnings.push({
          severity: 'warning',
          ...entryBase,
        });
      }
    }

    return { critical, warnings };
  }

  private buildSignature(
    criticalByType: DegradedAlertRow[],
    criticalBySourceMode: DegradedSourceModeAlertRow[],
  ): string {
    const stageSignature = criticalByType
      .map(
        (item) =>
          `type:${item.type}:${Number(item.degradedRateWindowPct || 0).toFixed(2)}:${item.degradedWindow}/${item.completedWindow}`,
      )
      .sort();
    const sourceSignature = criticalBySourceMode
      .map(
        (item) =>
          `source:${item.sourceMode}:${Number(item.degradedRateWindowPct || 0).toFixed(2)}:${item.degradedWindow}/${item.completedWindow}`,
      )
      .sort();
    return [...stageSignature, ...sourceSignature].join('|');
  }

  private buildWebhookSignature(payload: string, timestamp: string): string {
    return createHmac('sha256', this.webhookSecret)
      .update(`${timestamp}.${payload}`)
      .digest('hex');
  }

}
