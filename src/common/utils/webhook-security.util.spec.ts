import { createHmac } from 'node:crypto';
import {
  InMemoryWebhookReplayStore,
  verifySignedWebhook,
} from './webhook-security.util';

describe('verifySignedWebhook', () => {
  const secret = 'receiver-test-secret';
  const rawBody = JSON.stringify({
    event: 'pipeline_degraded_alert',
    timestamp: new Date().toISOString(),
  });
  const nowMs = 1_700_000_000_000;
  const timestampSec = Math.floor(nowMs / 1000);

  function buildHeaders(body: string, ts = timestampSec) {
    const signature = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
    return {
      'x-mvg-webhook-timestamp': String(ts),
      'x-mvg-webhook-signature': `sha256=${signature}`,
    };
  }

  it('accepts a valid signed webhook', () => {
    const result = verifySignedWebhook(rawBody, buildHeaders(rawBody), secret, {
      nowMs,
      maxSkewSec: 300,
    });
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        timestampSec,
      }),
    );
  });

  it('rejects when signature is invalid', () => {
    const badHeaders = {
      ...buildHeaders(rawBody),
      'x-mvg-webhook-signature': 'sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    };
    const result = verifySignedWebhook(rawBody, badHeaders, secret, {
      nowMs,
      maxSkewSec: 300,
    });
    expect(result).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });

  it('rejects stale timestamps outside skew window', () => {
    const staleTs = timestampSec - 301;
    const result = verifySignedWebhook(rawBody, buildHeaders(rawBody, staleTs), secret, {
      nowMs,
      maxSkewSec: 300,
    });
    expect(result).toEqual({
      ok: false,
      reason: 'timestamp_out_of_range',
    });
  });

  it('rejects replayed webhook signature+timestamp pair', () => {
    const replayStore = new InMemoryWebhookReplayStore();
    const headers = buildHeaders(rawBody);

    const first = verifySignedWebhook(rawBody, headers, secret, {
      nowMs,
      maxSkewSec: 300,
      replayStore,
    });
    expect(first.ok).toBe(true);

    const second = verifySignedWebhook(rawBody, headers, secret, {
      nowMs: nowMs + 1000,
      maxSkewSec: 300,
      replayStore,
    });
    expect(second).toEqual({
      ok: false,
      reason: 'replay_detected',
    });
  });
});
