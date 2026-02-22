import { createHmac, timingSafeEqual } from 'node:crypto';

export type WebhookVerifyFailureReason =
  | 'missing_secret'
  | 'missing_signature_header'
  | 'invalid_signature_header'
  | 'missing_timestamp_header'
  | 'invalid_timestamp_header'
  | 'timestamp_out_of_range'
  | 'signature_mismatch'
  | 'replay_detected';

export interface WebhookVerifyFailure {
  ok: false;
  reason: WebhookVerifyFailureReason;
}

export interface WebhookVerifySuccess {
  ok: true;
  timestampSec: number;
  signatureHex: string;
}

export type WebhookVerifyResult = WebhookVerifySuccess | WebhookVerifyFailure;

export interface WebhookReplayStore {
  has(key: string, nowMs?: number): boolean;
  set(key: string, expiresAtMs: number): void;
}

export interface VerifySignedWebhookOptions {
  maxSkewSec?: number;
  nowMs?: number;
  replayStore?: WebhookReplayStore;
}

type HeaderRecord = Record<string, string | string[] | undefined>;

export class InMemoryWebhookReplayStore implements WebhookReplayStore {
  private readonly expirations = new Map<string, number>();

  has(key: string, nowMs?: number): boolean {
    this.pruneExpired(typeof nowMs === 'number' ? nowMs : Date.now());
    return this.expirations.has(key);
  }

  set(key: string, expiresAtMs: number): void {
    this.pruneExpired(Date.now());
    this.expirations.set(key, expiresAtMs);
  }

  private pruneExpired(nowMs: number): void {
    for (const [key, expiration] of this.expirations.entries()) {
      if (expiration <= nowMs) {
        this.expirations.delete(key);
      }
    }
  }
}

export function verifySignedWebhook(
  rawBody: string,
  headers: HeaderRecord,
  secret: string,
  options: VerifySignedWebhookOptions = {},
): WebhookVerifyResult {
  const normalizedSecret = secret.trim();
  if (!normalizedSecret) {
    return { ok: false, reason: 'missing_secret' };
  }

  const timestampHeader = readHeader(headers, 'x-mvg-webhook-timestamp');
  if (!timestampHeader) {
    return { ok: false, reason: 'missing_timestamp_header' };
  }
  const timestampSec = Number(timestampHeader);
  if (!Number.isFinite(timestampSec) || timestampSec <= 0) {
    return { ok: false, reason: 'invalid_timestamp_header' };
  }

  const signatureHeader = readHeader(headers, 'x-mvg-webhook-signature');
  if (!signatureHeader) {
    return { ok: false, reason: 'missing_signature_header' };
  }
  if (!signatureHeader.startsWith('sha256=')) {
    return { ok: false, reason: 'invalid_signature_header' };
  }
  const signatureHex = signatureHeader.slice('sha256='.length).trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(signatureHex)) {
    return { ok: false, reason: 'invalid_signature_header' };
  }

  const maxSkewSec =
    typeof options.maxSkewSec === 'number' && options.maxSkewSec > 0
      ? Math.floor(options.maxSkewSec)
      : 300;
  const nowMs = typeof options.nowMs === 'number' ? options.nowMs : Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  if (Math.abs(nowSec - Math.floor(timestampSec)) > maxSkewSec) {
    return { ok: false, reason: 'timestamp_out_of_range' };
  }

  const expectedHex = createHmac('sha256', normalizedSecret)
    .update(`${timestampHeader}.${rawBody}`)
    .digest('hex');

  if (!safeEqualHex(signatureHex, expectedHex)) {
    return { ok: false, reason: 'signature_mismatch' };
  }

  if (options.replayStore) {
    const replayKey = `${timestampHeader}.${signatureHex}`;
    if (options.replayStore.has(replayKey, nowMs)) {
      return { ok: false, reason: 'replay_detected' };
    }
    options.replayStore.set(replayKey, nowMs + maxSkewSec * 1000);
  }

  return { ok: true, timestampSec: Math.floor(timestampSec), signatureHex };
}

function readHeader(headers: HeaderRecord, name: string): string {
  const raw = headers[name.toLowerCase()];
  if (Array.isArray(raw)) {
    return (raw[0] || '').trim();
  }
  return (raw || '').trim();
}

function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}
