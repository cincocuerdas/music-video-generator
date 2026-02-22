/* eslint-disable no-console */

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:3000/api/v1';
const DEFAULT_POSTGRES_CONTAINER = 'musicvideo-postgres';
const DEFAULT_REDIS_CONTAINER = 'musicvideo-redis';

function isProduction() {
  return (process.env.NODE_ENV || 'development').trim().toLowerCase() === 'production';
}

function getApiBaseUrl() {
  const configured = (process.env.API_BASE_URL || '').trim();
  if (configured) {
    return configured.replace(/\/$/, '');
  }
  if (isProduction()) {
    throw new Error('API_BASE_URL is required in production for dev-tools test scripts.');
  }
  return DEFAULT_API_BASE_URL;
}

function getPostgresContainerName() {
  return (
    (process.env.RESILIENCE_POSTGRES_CONTAINER || '').trim() || DEFAULT_POSTGRES_CONTAINER
  );
}

function getRedisContainerName() {
  return (
    (process.env.RESILIENCE_REDIS_CONTAINER || '').trim() || DEFAULT_REDIS_CONTAINER
  );
}

function getProdGuardBaseEnv() {
  return {
    NODE_ENV: 'production',
    HOST: process.env.PROD_GUARD_HOST || '127.0.0.1',
    PORT: process.env.PROD_GUARD_PORT || '3901',
    DATABASE_URL:
      process.env.PROD_GUARD_DATABASE_URL ||
      'postgresql://postgres:postgres@db.internal:5432/musicvideo',
    REDIS_URL: process.env.PROD_GUARD_REDIS_URL || 'redis://redis.internal:6379',
    JWT_SECRET:
      process.env.PROD_GUARD_JWT_SECRET ||
      'this_is_a_strong_jwt_secret_for_prod_guard_tests_12345',
    JWT_REFRESH_SECRET:
      process.env.PROD_GUARD_JWT_REFRESH_SECRET ||
      'this_is_a_strong_refresh_secret_for_prod_guard_tests_12345',
    JWT_REFRESH_TOKEN_PEPPER:
      process.env.PROD_GUARD_JWT_REFRESH_PEPPER ||
      'this_is_a_strong_refresh_pepper_for_prod_guard_tests_12345',
    ALLOW_DEV_AUTH_BYPASS:
      process.env.PROD_GUARD_ALLOW_DEV_AUTH_BYPASS || 'false',
    GEMINI_API_KEY: process.env.PROD_GUARD_GEMINI_API_KEY || 'valid_test_gemini_key',
    REPLICATE_API_TOKEN:
      process.env.PROD_GUARD_REPLICATE_API_TOKEN || 'valid_test_replicate_token',
    CORS_ORIGIN: process.env.PROD_GUARD_CORS_ORIGIN || 'https://app.example.com',
    LLM_PROVIDER: process.env.PROD_GUARD_LLM_PROVIDER || 'gemini',
    IMAGE_PROVIDER: process.env.PROD_GUARD_IMAGE_PROVIDER || 'comfyui',
    COMFYUI_URL: process.env.PROD_GUARD_COMFYUI_URL || 'http://comfyui.internal:8188',
  };
}

function getRedisConnectionOptions() {
  const redisUrl = (process.env.REDIS_URL || '').trim();
  if (redisUrl) {
    return { url: redisUrl };
  }

  const host = (process.env.REDIS_HOST || '').trim() || '127.0.0.1';
  const port = Number(process.env.REDIS_PORT || '6379');
  const password = (process.env.REDIS_PASSWORD || '').trim() || undefined;
  return {
    host,
    port: Number.isFinite(port) && port > 0 ? port : 6379,
    password,
  };
}

module.exports = {
  getApiBaseUrl,
  getPostgresContainerName,
  getRedisContainerName,
  getProdGuardBaseEnv,
  getRedisConnectionOptions,
};
