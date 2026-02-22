import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters';
import { LoggingInterceptor } from './common/interceptors';
import { resolveCorsConfig } from './common/utils/cors.utils';

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

function validateSecurityConfig(configService: ConfigService, logger: Logger) {
  const nodeEnv = (configService.get<string>('app.nodeEnv') || process.env.NODE_ENV || 'development')
    .trim()
    .toLowerCase();
  const isProduction = nodeEnv === 'production';

  const getEnv = (key: string) => (process.env[key] || '').trim();
  const weakValues = new Set([
    '',
    'change_me',
    'change_me_refresh',
    'change_me_pepper',
    'dev_local_secret_123',
    'replace_me',
  ]);

  const jwtSecret = getEnv('JWT_SECRET');
  const jwtRefreshSecret = getEnv('JWT_REFRESH_SECRET') || jwtSecret;
  const jwtPepper = getEnv('JWT_REFRESH_TOKEN_PEPPER') || jwtRefreshSecret || jwtSecret;
  const allowDevAuthBypass = getEnv('ALLOW_DEV_AUTH_BYPASS').toLowerCase() === 'true';

  if (!isProduction) {
    if (!jwtSecret || weakValues.has(jwtSecret.toLowerCase())) {
      logger.warn(
        'JWT_SECRET is missing or weak. Local auth can fail until you set a real secret in .env.',
      );
    }
    return;
  }

  const invalidKeys = [
    ['JWT_SECRET', jwtSecret],
    ['JWT_REFRESH_SECRET', jwtRefreshSecret],
    ['JWT_REFRESH_TOKEN_PEPPER', jwtPepper],
  ].filter(([, value]) => weakValues.has((value || '').toLowerCase()));

  if (invalidKeys.length > 0) {
    const names = invalidKeys.map(([key]) => key).join(', ');
    throw new Error(
      `Unsafe production configuration: ${names} uses empty/placeholder values. Set strong secrets before startup.`,
    );
  }

  if (jwtSecret.length < 32) {
    throw new Error(
      'Unsafe production configuration: JWT_SECRET must be at least 32 characters.',
    );
  }

  if (jwtRefreshSecret.length < 32) {
    throw new Error(
      'Unsafe production configuration: JWT_REFRESH_SECRET must be at least 32 characters.',
    );
  }

  if (jwtPepper.length < 32) {
    throw new Error(
      'Unsafe production configuration: JWT_REFRESH_TOKEN_PEPPER must be at least 32 characters.',
    );
  }

  if (allowDevAuthBypass) {
    throw new Error(
      'Unsafe production configuration: ALLOW_DEV_AUTH_BYPASS must be false in production.',
    );
  }
}

function validateInfrastructureConfig(configService: ConfigService) {
  const nodeEnv = (configService.get<string>('app.nodeEnv') || process.env.NODE_ENV || 'development')
    .trim()
    .toLowerCase();
  const isProduction = nodeEnv === 'production';
  if (!isProduction) {
    return;
  }

  const databaseUrl = (configService.get<string>('database.url') || '').trim();
  const redisUrl = (configService.get<string>('redis.url') || '').trim();
  const corsOrigin = (configService.get<string>('app.corsOrigin') || '').trim();

  if (!databaseUrl) {
    throw new Error(
      'Missing DATABASE_URL in production. Refusing to start with invalid database config.',
    );
  }

  if (!/^(postgres|postgresql):\/\//i.test(databaseUrl)) {
    throw new Error(
      'Invalid DATABASE_URL in production. Expected postgres:// or postgresql://',
    );
  }

  if (usesLoopbackHost(databaseUrl)) {
    throw new Error(
      'Unsafe production configuration: DATABASE_URL cannot use localhost/loopback host in production.',
    );
  }

  if (!redisUrl) {
    throw new Error(
      'Missing Redis configuration in production. Set REDIS_URL or REDIS_HOST/REDIS_PORT.',
    );
  }

  if (!/^rediss?:\/\//i.test(redisUrl)) {
    throw new Error(
      'Invalid REDIS_URL in production. Expected redis:// or rediss://',
    );
  }

  if (usesLoopbackHost(redisUrl)) {
    throw new Error(
      'Unsafe production configuration: REDIS_URL cannot use localhost/loopback host in production.',
    );
  }

  if (!corsOrigin || corsOrigin === '*') {
    throw new Error(
      'Unsafe production configuration: CORS_ORIGIN cannot be empty or "*" in production.',
    );
  }

  const corsOrigins = corsOrigin
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  for (const origin of corsOrigins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(
        `Unsafe production configuration: CORS_ORIGIN contains invalid origin "${origin}".`,
      );
    }

    if (isLoopbackHost(parsed.hostname)) {
      throw new Error(
        'Unsafe production configuration: CORS_ORIGIN cannot target localhost/loopback hosts in production.',
      );
    }
  }
}

function validateAiProviderConfig(configService: ConfigService) {
  const nodeEnv = (configService.get<string>('app.nodeEnv') || process.env.NODE_ENV || 'development')
    .trim()
    .toLowerCase();
  if (nodeEnv !== 'production') {
    return;
  }

  const weakValues = new Set(['', 'replace_me', 'change_me']);
  const llmProvider = (process.env.LLM_PROVIDER || 'gemini').trim().toLowerCase();
  const imageProvider = (process.env.IMAGE_PROVIDER || 'comfyui').trim().toLowerCase();

  const geminiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (llmProvider === 'gemini' && weakValues.has(geminiKey.toLowerCase())) {
    throw new Error(
      'Unsafe production configuration: GEMINI_API_KEY is missing/placeholder while LLM_PROVIDER=gemini.',
    );
  }

  const replicateToken = (process.env.REPLICATE_API_TOKEN || '').trim();
  if (imageProvider === 'replicate' && weakValues.has(replicateToken.toLowerCase())) {
    throw new Error(
      'Unsafe production configuration: REPLICATE_API_TOKEN is missing/placeholder while IMAGE_PROVIDER=replicate.',
    );
  }

  const comfyuiUrl = (process.env.COMFYUI_URL || '').trim();
  if (imageProvider === 'comfyui') {
    if (weakValues.has(comfyuiUrl.toLowerCase())) {
      throw new Error(
        'Unsafe production configuration: COMFYUI_URL is missing/placeholder while IMAGE_PROVIDER=comfyui.',
      );
    }

    if (!/^https?:\/\//i.test(comfyuiUrl)) {
      throw new Error(
        'Unsafe production configuration: COMFYUI_URL must start with http:// or https://',
      );
    }
  }
}

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
  });

  const configService = app.get(ConfigService);
  validateSecurityConfig(configService, logger);
  validateInfrastructureConfig(configService);
  validateAiProviderConfig(configService);
  const host = (configService.get<string>('app.host') || '0.0.0.0').trim();
  const port = configService.get<number>('app.port');

  app.setGlobalPrefix('api/v1');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(app.get(AllExceptionsFilter));
  app.useGlobalInterceptors(new LoggingInterceptor());

  const corsOriginConfig = configService.get<string>('app.corsOrigin', '*');
  const corsConfig = resolveCorsConfig(corsOriginConfig);

  app.enableCors({
    origin: corsConfig.allowWildcard ? true : corsConfig.origins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: !corsConfig.allowWildcard,
  });

  await app.listen(port, host);
  logger.log(`Application running on ${host}:${port}`);
}

bootstrap();
