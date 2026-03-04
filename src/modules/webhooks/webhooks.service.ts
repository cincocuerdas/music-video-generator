import {
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { SentryService } from '../observability';
import { parsePositiveIntEnv } from '../../common/utils/env-parsers';
import {
  InMemoryWebhookReplayStore,
  verifySignedWebhook,
  type WebhookVerifyFailure,
  type WebhookVerifyFailureReason,
} from '../../common/utils/webhook-security.util';

type HeadersRecord = Record<string, string | string[] | undefined>;

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);
  private readonly replayStore = new InMemoryWebhookReplayStore();
  private readonly receiverSecret = (process.env.HEALTH_WEBHOOK_RECEIVER_SECRET || '').trim();
  private readonly maxSkewSec = parsePositiveIntEnv('HEALTH_WEBHOOK_RECEIVER_MAX_SKEW_SEC', 300);

  constructor(private readonly sentryService: SentryService) {}

  receiveHealthAlert(rawBody: string, headers: HeadersRecord): Record<string, unknown> {
    if (!this.receiverSecret) {
      throw new ServiceUnavailableException('Health webhook receiver secret is not configured');
    }

    const verification = verifySignedWebhook(rawBody, headers, this.receiverSecret, {
      maxSkewSec: this.maxSkewSec,
      replayStore: this.replayStore,
    });

    if (!verification.ok) {
      const failure = verification as WebhookVerifyFailure;
      this.captureRejectedWebhook(rawBody, headers, failure.reason);
      if (failure.reason === 'replay_detected') {
        throw new ConflictException('Rejected replayed webhook');
      }
      throw new UnauthorizedException('Invalid webhook signature');
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new UnauthorizedException('Webhook payload must be valid JSON');
    }

    const event =
      typeof payload.event === 'string' && payload.event.trim()
        ? payload.event.trim()
        : 'unknown_event';

    this.logger.warn(`Received verified health webhook event=${event}`);

    return {
      ok: true,
      event,
      receivedAt: new Date().toISOString(),
    };
  }

  private captureRejectedWebhook(
    rawBody: string,
    headers: HeadersRecord,
    reason: WebhookVerifyFailureReason,
  ): void {
    this.logger.warn(`Rejected health webhook: ${reason}`);
    this.sentryService.captureException(new Error(`health_webhook_rejected:${reason}`), {
      tags: {
        component: 'webhooks_receiver',
        reason,
      },
      extra: {
        headers,
        bodyPreview: rawBody.slice(0, 512),
      },
    });
  }

}
