import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Sentry from '@sentry/node';

export interface SentryCaptureContext {
  tags?: Record<string, string | number | boolean>;
  extra?: Record<string, unknown>;
  user?: {
    id?: string;
    username?: string;
    email?: string;
    ip_address?: string;
  };
  level?: Sentry.SeverityLevel;
}

@Injectable()
export class SentryService implements OnModuleDestroy {
  private readonly logger = new Logger(SentryService.name);
  private readonly enabled: boolean;

  constructor(private readonly configService: ConfigService) {
    const dsn = (process.env.SENTRY_DSN || '').trim();
    this.enabled = Boolean(dsn);

    if (!this.enabled) {
      this.logger.log('Sentry disabled (SENTRY_DSN not configured)');
      return;
    }

    const environment = (
      this.configService.get<string>('app.nodeEnv') ||
      process.env.NODE_ENV ||
      'development'
    )
      .trim()
      .toLowerCase();

    const release = (process.env.SENTRY_RELEASE || '').trim() || undefined;
    const tracesSampleRate = this.parseSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE, 0);
    const profilesSampleRate = this.parseSampleRate(process.env.SENTRY_PROFILES_SAMPLE_RATE, 0);
    const debug = (process.env.SENTRY_DEBUG || '').trim().toLowerCase() === 'true';

    Sentry.init({
      dsn,
      environment,
      release,
      tracesSampleRate,
      profilesSampleRate,
      debug,
      sendDefaultPii: false,
    });

    this.logger.log(
      `Sentry enabled (env=${environment}, tracesSampleRate=${tracesSampleRate}, profilesSampleRate=${profilesSampleRate})`,
    );
  }

  captureException(error: unknown, context?: SentryCaptureContext): void {
    if (!this.enabled) {
      return;
    }

    Sentry.withScope((scope) => {
      this.applyScopeContext(scope, context);
      Sentry.captureException(error);
    });
  }

  captureMessage(message: string, context?: SentryCaptureContext): void {
    if (!this.enabled) {
      return;
    }

    Sentry.withScope((scope) => {
      this.applyScopeContext(scope, context);
      Sentry.captureMessage(message, context?.level || 'info');
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.enabled) {
      return;
    }

    await Sentry.close(2_000);
  }

  private parseSampleRate(rawValue: string | undefined, fallback: number): number {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    if (parsed < 0) {
      return 0;
    }
    if (parsed > 1) {
      return 1;
    }
    return parsed;
  }

  private applyScopeContext(scope: Sentry.Scope, context?: SentryCaptureContext): void {
    if (!context) {
      return;
    }

    if (context.tags) {
      for (const [key, value] of Object.entries(context.tags)) {
        scope.setTag(key, String(value));
      }
    }

    if (context.extra) {
      for (const [key, value] of Object.entries(context.extra)) {
        scope.setExtra(key, value as any);
      }
    }

    if (context.user) {
      scope.setUser(context.user);
    }

    if (context.level) {
      scope.setLevel(context.level);
    }
  }
}
