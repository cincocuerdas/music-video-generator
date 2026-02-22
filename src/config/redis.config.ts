import { registerAs } from '@nestjs/config';

const parsePositiveInt = (
  value: string | undefined,
  fallback: number,
): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (typeof value === 'undefined') {
    return fallback;
  }
  return value.trim().toLowerCase() === 'true';
};

const parseMaxRetriesPerRequest = (value: string | undefined): number | null => {
  if (typeof value === 'undefined' || value.trim() === '') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'null') {
    return null;
  }

  const parsed = Number(normalized);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed;
  }

  return null;
};

export const redisConfig = registerAs('redis', () => ({
  ...(() => {
    const nodeEnv = (process.env.NODE_ENV || 'development').trim().toLowerCase();
    const isProduction = nodeEnv === 'production';
    const host = (process.env.REDIS_HOST || '').trim() || (isProduction ? undefined : '127.0.0.1');
    const port = parseInt(process.env.REDIS_PORT || '6379', 10) || 6379;
    const password = process.env.REDIS_PASSWORD || undefined;
    const explicitUrl = (process.env.REDIS_URL || '').trim();

    let url: string | undefined = explicitUrl || undefined;
    if (!url && host) {
      if (password) {
        url = `redis://:${encodeURIComponent(password)}@${host}:${port}`;
      } else {
        url = `redis://${host}:${port}`;
      }
    }

    return {
      host,
      port,
      password,
      url,
    };
  })(),
  connectTimeoutMs: parsePositiveInt(process.env.REDIS_CONNECT_TIMEOUT_MS, 10_000),
  retryBaseDelayMs: parsePositiveInt(process.env.REDIS_RETRY_BASE_DELAY_MS, 250),
  retryMaxDelayMs: parsePositiveInt(process.env.REDIS_RETRY_MAX_DELAY_MS, 5_000),
  maxRetriesPerRequest: parseMaxRetriesPerRequest(process.env.REDIS_MAX_RETRIES_PER_REQUEST),
  enableOfflineQueue: parseBoolean(process.env.REDIS_ENABLE_OFFLINE_QUEUE, true),
}));
