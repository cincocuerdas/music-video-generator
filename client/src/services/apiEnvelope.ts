/**
 * Response Envelope Adapter
 *
 * Normalizes API responses regardless of whether the backend sends the
 * new envelope shape `{ ok, data|error, meta }` or the legacy shape.
 *
 * Usage:
 *   import { unwrapData, unwrapError } from './apiEnvelope';
 *
 *   // Success path (in response interceptor)
 *   const data = unwrapData(response.data);
 *
 *   // Error path (in error interceptor)
 *   const { statusCode, message } = unwrapError(error.response.data);
 */

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface EnvelopeMeta {
  timestamp: string;
  correlationId?: string;
  path?: string;
}

export interface EnvelopeSuccess<T = unknown> {
  ok: true;
  data: T;
  meta: EnvelopeMeta;
}

export interface EnvelopeError {
  ok: false;
  error: { statusCode: number; message: string };
  meta: EnvelopeMeta;
}

export interface NormalizedError {
  statusCode: number;
  message: string;
  meta?: EnvelopeMeta;
}

// ─── Guards ─────────────────────────────────────────────────────────────────────

function isEnvelopeSuccess(data: unknown): data is EnvelopeSuccess {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return d.ok === true && 'data' in d && 'meta' in d;
}

function isEnvelopeError(data: unknown): data is EnvelopeError {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return d.ok === false && 'error' in d && 'meta' in d;
}

// ─── Public helpers ─────────────────────────────────────────────────────────────

/**
 * Unwrap a successful API response.
 *
 * - Envelope:  `{ ok: true, data: T, meta }` → returns `T`
 * - Legacy:    raw payload → returns as-is
 */
export function unwrapData<T = unknown>(payload: unknown): T {
  if (isEnvelopeSuccess(payload)) {
    return payload.data as T;
  }
  return payload as T;
}

/**
 * Unwrap an error API response into a consistent shape.
 *
 * - Envelope:  `{ ok: false, error: { statusCode, message }, meta }` → normalized
 * - Legacy:    `{ statusCode, message, ... }` → normalized
 * - Unknown:   fallback to 500 + generic message
 */
export function unwrapError(payload: unknown): NormalizedError {
  // New envelope error shape
  if (isEnvelopeError(payload)) {
    return {
      statusCode: payload.error.statusCode,
      message: payload.error.message,
      meta: payload.meta,
    };
  }

  // Legacy error shape: { statusCode, message, timestamp, path, correlationId }
  if (payload && typeof payload === 'object') {
    const legacy = payload as Record<string, unknown>;
    if (typeof legacy.statusCode === 'number' && typeof legacy.message === 'string') {
      return {
        statusCode: legacy.statusCode,
        message: legacy.message,
        meta: legacy.timestamp
          ? {
              timestamp: String(legacy.timestamp),
              correlationId: legacy.correlationId as string | undefined,
              path: legacy.path as string | undefined,
            }
          : undefined,
      };
    }
  }

  // Unknown shape — fallback
  return { statusCode: 500, message: 'Unknown server error' };
}
