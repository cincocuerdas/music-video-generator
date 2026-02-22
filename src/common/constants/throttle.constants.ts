import { ExecutionContext } from '@nestjs/common';

type NumericEnvFallback = number | (() => number);

const resolveFallback = (fallback: NumericEnvFallback): number =>
  typeof fallback === 'function' ? fallback() : fallback;

const parsePositiveInt = (value: string | undefined, fallback: NumericEnvFallback): number => {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  return resolveFallback(fallback);
};

const getEnvLimit = (envKey: string, fallback: NumericEnvFallback) => () =>
  parsePositiveInt(process.env[envKey], fallback);

const globalThrottleTtl = () => parsePositiveInt(process.env.THROTTLE_TTL_MS, 60_000);

const getThrottleRule = (
  limitEnv: string,
  defaultLimit: number,
  ttlEnv?: string,
  defaultTtl: NumericEnvFallback = globalThrottleTtl,
) => ({
  default: {
    limit: (_context: ExecutionContext) =>
      getEnvLimit(limitEnv, defaultLimit)(),
    ttl: (_context: ExecutionContext) =>
      getEnvLimit(ttlEnv || `${limitEnv}_TTL_MS`, defaultTtl)(),
  },
});

export const THROTTLE_RULES = {
  authDevToken: getThrottleRule('THROTTLE_AUTH_DEV_TOKEN_LIMIT', 10),
  authLoginDev: getThrottleRule('THROTTLE_AUTH_LOGIN_DEV_LIMIT', 10),
  authRefresh: getThrottleRule('THROTTLE_AUTH_REFRESH_LIMIT', 30),
  authLogout: getThrottleRule('THROTTLE_AUTH_LOGOUT_LIMIT', 60),
  authMe: getThrottleRule('THROTTLE_AUTH_ME_LIMIT', 120),

  projectsCreate: getThrottleRule('THROTTLE_PROJECTS_CREATE_LIMIT', 20),
  projectsGenerate: getThrottleRule('THROTTLE_PROJECTS_GENERATE_LIMIT', 8),
  projectsCancel: getThrottleRule('THROTTLE_PROJECTS_CANCEL_LIMIT', 15),
  projectsFeedback: getThrottleRule('THROTTLE_PROJECTS_FEEDBACK_LIMIT', 45),
  projectsFeedbackStats: getThrottleRule('THROTTLE_PROJECTS_FEEDBACK_STATS_LIMIT', 30),
  projectsPromptOptimization: getThrottleRule('THROTTLE_PROJECTS_PROMPT_OPTIMIZATION_LIMIT', 30),
  projectsLiveSignal: getThrottleRule('THROTTLE_PROJECTS_LIVE_SIGNAL_LIMIT', 60),

  jobsCreate: getThrottleRule('THROTTLE_JOBS_CREATE_LIMIT', 20),
  jobsUpdate: getThrottleRule('THROTTLE_JOBS_UPDATE_LIMIT', 30),
  jobsDelete: getThrottleRule('THROTTLE_JOBS_DELETE_LIMIT', 20),
  jobsPipelineStart: getThrottleRule('THROTTLE_JOBS_PIPELINE_START_LIMIT', 8),
  jobsPipelineCancel: getThrottleRule('THROTTLE_JOBS_PIPELINE_CANCEL_LIMIT', 15),

  healthOps: getThrottleRule('THROTTLE_HEALTH_OPS_LIMIT', 30),
  healthOpsDegraded: getThrottleRule('THROTTLE_HEALTH_OPS_DEGRADED_LIMIT', 30),
  webhooksHealthAlert: getThrottleRule('THROTTLE_WEBHOOKS_HEALTH_ALERT_LIMIT', 60),
} as const;
