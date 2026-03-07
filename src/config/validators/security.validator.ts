import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export function validateSecurityConfig(configService: ConfigService, logger: Logger) {
  const nodeEnv = (configService.get<string>('app.nodeEnv') || process.env.NODE_ENV || 'development').trim().toLowerCase();
  const isProduction = nodeEnv === 'production';

  const getEnv = (key: string) => (process.env[key] || '').trim();
  const weakValues = new Set(['', 'change_me', 'change_me_refresh', 'change_me_pepper', 'dev_local_secret_123', 'replace_me']);

  const jwtSecret = getEnv('JWT_SECRET');
  const jwtRefreshSecret = getEnv('JWT_REFRESH_SECRET') || jwtSecret;
  const jwtPepper = getEnv('JWT_REFRESH_TOKEN_PEPPER') || jwtRefreshSecret || jwtSecret;
  const allowDevAuthBypass = getEnv('ALLOW_DEV_AUTH_BYPASS').toLowerCase() === 'true';

  if (!isProduction) {
    if (!jwtSecret || weakValues.has(jwtSecret.toLowerCase())) {
      logger.warn('JWT_SECRET is missing or weak. Local auth can fail until you set a real secret in .env.');
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
    throw new Error(`Unsafe production configuration: ${names} uses empty/placeholder values. Set strong secrets before startup.`);
  }

  if (jwtSecret.length < 32) {
    throw new Error('Unsafe production configuration: JWT_SECRET must be at least 32 characters.');
  }
  if (jwtRefreshSecret.length < 32) {
    throw new Error('Unsafe production configuration: JWT_REFRESH_SECRET must be at least 32 characters.');
  }
  if (jwtPepper.length < 32) {
    throw new Error('Unsafe production configuration: JWT_REFRESH_TOKEN_PEPPER must be at least 32 characters.');
  }
  if (allowDevAuthBypass) {
    throw new Error('Unsafe production configuration: ALLOW_DEV_AUTH_BYPASS must be false in production.');
  }
}
