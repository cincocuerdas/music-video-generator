# Backend Incident Runbook

This runbook is for production incidents in the backend pipeline (`YOUTUBE_DOWNLOAD -> TRANSCRIPTION -> ANALYZE_LYRICS -> GENERATE_IMAGES -> RENDER_VIDEO`).

## 1. Classify Incident Severity

- `SEV-1`: Pipeline globally unavailable, persistent `failed`, API down.
- `SEV-2`: Pipeline works with heavy degradation (`degraded` spikes, latency SLO breached).
- `SEV-3`: Isolated failures for specific projects/users.

## 2. First 5 Minutes Checklist

1. Check API health:
   - `GET /api/v1/health`
   - `GET /api/v1/health/ops`
   - `GET /api/v1/health/ops/degraded?hours=1`
2. Check queue pressure (`waiting`, `active`, `retrying`, `failed`) in `/health/ops`.
3. Check latest backend logs for processor final failures.
4. Check Sentry for new issues grouped by:
   - `component=http`
   - `component=job_processor`
   - `jobType=*`

## 3. Decision Tree

### A) `status=failed` spikes in one stage

- Inspect processor logs for that `jobType`.
- Validate external dependency:
  - `YOUTUBE_DOWNLOAD`: YouTube access/rate limit.
  - `TRANSCRIPTION`/`ANALYZE_LYRICS`: Gemini key/quota.
  - `GENERATE_IMAGES`: ComfyUI availability/checkpoint.
  - `RENDER_VIDEO`: FFmpeg availability/path.
- If dependency outage persists:
  - Keep pipeline in degraded/fallback mode (do not hard-fail global system).
  - Communicate partial-service status.

### B) `status=degraded` spikes but system still completes

- Check `/health/ops/degraded` `alerts.critical`.
- Validate if this is expected fallback or quality regression.
- If critical for > 15 min:
  - Reduce load (throttle queue entry points temporarily).
  - Prioritize dependency recovery.
  - Keep webhook/Sentry alert thread updated.

### C) Latency SLO breached (`/health/ops` `latencyAlerts`)

- Identify stage with highest `p95DurationMs24h`.
- Check if queue backlog is increasing.
- Mitigate:
  - Temporarily reduce concurrency of expensive stages.
  - Rebalance worker resources.

## 4. Safe Mitigations (No Data Loss)

- Pause only affected queue workers, not entire API.
- Keep existing jobs retriable; do not drop queues.
- Avoid destructive DB operations during incident.
- Prefer explicit degraded completion over silent hang.

## 5. Recovery Verification

1. New projects complete end-to-end.
2. `/health/ops` back to `status=ok`.
3. `/health/ops/degraded` critical alerts clear.
4. Sentry issue rate returns to baseline.

## 6. Postmortem (Within 24h)

- Timeline (UTC), impact, root cause.
- Why detection did/did not trigger quickly.
- Permanent action items:
  - tests,
  - config guardrails,
  - alert thresholds,
  - runbook updates.
