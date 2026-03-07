import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

function isLoopbackHost(hostname: string): boolean {
  const normalized = (hostname || '').trim().toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function usesLoopbackHost(urlValue: string): boolean {
  try {
    const parsed = new URL(urlValue);
    return isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

function decodeUrlComponent(value: string): string {
  try {
    return decodeURIComponent(value || '');
  } catch {
    return value || '';
  }
}

function isWeakCredential(value: string): boolean {
  const normalized = (value || '').trim().toLowerCase();
  if (!normalized) return true;
  const weak = new Set(['postgres', 'password', 'changeme', 'change_me', 'replace_me', 'default', 'admin', 'root']);
  return weak.has(normalized);
}

export function validateInfrastructureConfig(configService: ConfigService) {
  const nodeEnv = (configService.get<string>('app.nodeEnv') || process.env.NODE_ENV || 'development').trim().toLowerCase();
  if (nodeEnv !== 'production') return;

  const databaseUrl = (configService.get<string>('database.url') || '').trim();
  const redisUrl = (configService.get<string>('redis.url') || '').trim();
  const corsOrigin = (configService.get<string>('app.corsOrigin') || '').trim();

  if (!databaseUrl) {
    throw new Error('Missing DATABASE_URL in production. Refusing to start with invalid database config.');
  }
  if (!/^(postgres|postgresql):\/\//i.test(databaseUrl)) {
    throw new Error('Invalid DATABASE_URL in production. Expected postgres:// or postgresql://');
  }

  let parsedDatabaseUrl: URL;
  try {
    parsedDatabaseUrl = new URL(databaseUrl);
  } catch {
    throw new Error('Invalid DATABASE_URL in production. URL parsing failed.');
  }

  if (usesLoopbackHost(databaseUrl)) {
    throw new Error('Unsafe production configuration: DATABASE_URL cannot use localhost/loopback host in production.');
  }

  const dbUser = decodeUrlComponent(parsedDatabaseUrl.username || '');
  const dbPassword = decodeUrlComponent(parsedDatabaseUrl.password || '');
  if (isWeakCredential(dbUser) || isWeakCredential(dbPassword)) {
    throw new Error('Unsafe production configuration: DATABASE_URL uses weak/default database credentials.');
  }

  if (!redisUrl) {
    throw new Error('Missing Redis configuration in production. Set REDIS_URL or REDIS_HOST/REDIS_PORT.');
  }
  if (!/^rediss?:\/\//i.test(redisUrl)) {
    throw new Error('Invalid REDIS_URL in production. Expected redis:// or rediss://');
  }
  if (usesLoopbackHost(redisUrl)) {
    throw new Error('Unsafe production configuration: REDIS_URL cannot use localhost/loopback host in production.');
  }

  let parsedRedisUrl: URL;
  try {
    parsedRedisUrl = new URL(redisUrl);
  } catch {
    throw new Error('Invalid REDIS_URL in production. URL parsing failed.');
  }

  const redisPassword = decodeUrlComponent(parsedRedisUrl.password || '');
  if (isWeakCredential(redisPassword)) {
    throw new Error('Unsafe production configuration: REDIS_URL must include a strong password.');
  }

  if (!corsOrigin || corsOrigin === '*') {
    throw new Error('Unsafe production configuration: CORS_ORIGIN cannot be empty or "*" in production.');
  }

  const corsOrigins = corsOrigin.split(',').map(v => v.trim()).filter(Boolean);
  for (const origin of corsOrigins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`Unsafe production configuration: CORS_ORIGIN contains invalid origin "${origin}".`);
    }
    if (isLoopbackHost(parsed.hostname)) {
      throw new Error('Unsafe production configuration: CORS_ORIGIN cannot target localhost/loopback hosts in production.');
    }
  }
}
