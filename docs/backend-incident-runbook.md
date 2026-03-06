# Backend Incident Runbook

This runbook covers incidents in the pipeline:
`YOUTUBE_DOWNLOAD -> TRANSCRIPTION -> ANALYZE_LYRICS -> GENERATE_IMAGES -> RENDER_VIDEO`.

Current production operating model is `Docker Compose` on a host/VM. Commands below assume that runtime unless a section explicitly says otherwise.

## 1. Severity

- `SEV-1`: API down or global pipeline unavailable.
- `SEV-2`: pipeline running but major degraded/latency impact.
- `SEV-3`: isolated project/user failures.

## 2. First 5 Minutes (Command Checklist)

### Health and status

```bash
# Health
curl -s http://localhost:3000/api/v1/health

# Ops summary (queues, stages, latency)
curl -s http://localhost:3000/api/v1/health/ops

# Degraded trend (last hour)
curl -s "http://localhost:3000/api/v1/health/ops/degraded?hours=1"
```

### Local runtime state

```bash
npm run backend:status
docker compose ps
docker compose logs --tail=120 postgres redis
```

### Queue and DB quick checks

```bash
# Redis reachable?
docker exec -it musicvideo-redis redis-cli ping

# Postgres reachable?
docker exec -it musicvideo-postgres pg_isready -U postgres -d musicvideo
```

### Dead-letter review / replay (authenticated)

```bash
# List last dead-letter entries for current user
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/api/v1/jobs/dead-letter?limit=25"

# Replay one dead-letter item
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/api/v1/jobs/dead-letter/{DEAD_LETTER_ID}/replay"
```

## 3. Decision Tree

### A) `failed` spikes in one stage

1. Find failing `jobType` in backend logs.
2. Check circuit breaker snapshot in `/health/ops` (`circuitBreakers.entries`):
   - if a stage is `open`, wait cooldown or restore dependency first.
2. Validate external dependency:
   - `YOUTUBE_DOWNLOAD`: source URL present and reachable.
   - `TRANSCRIPTION`/`ANALYZE_LYRICS`: Gemini key/quota/latency.
   - `GENERATE_IMAGES`: ComfyUI endpoint/model/LoRA availability.
   - `RENDER_VIDEO`: FFmpeg path/runtime.
3. If dependency outage persists:
   - keep pipeline in fallback/degraded mode (do not hard stop globally),
   - communicate partial availability.

### B) `degraded` spikes with successful completion

1. Inspect `/health/ops/degraded` `alerts.critical`.
2. Verify whether fallbacks are expected or quality regression.
3. If critical > 15m:
   - reduce load (`THROTTLE_*` temporarily),
   - recover dependency first,
   - track incident in webhook/Sentry thread.

### C) Latency SLO breach

1. Inspect `/health/ops` `latencyAlerts`.
2. Identify stage with highest `p95DurationMs24h`.
3. Mitigate:
   - tune `IMAGE_GENERATION_CONCURRENCY` (or reduce if dependency saturates),
   - rebalance worker/process resources,
   - avoid draining queues destructively.

## 4. Known Incident Playbooks

### Redis unavailable (`ECONNREFUSED 6379`)

```bash
docker compose up -d redis
npm run backend:status
curl -s http://localhost:3000/api/v1/health/ops
```

If still unstable, restart backend workers:

```bash
npm run backend:down
npm run backend:up
```

### Postgres unavailable (`P1001` / cannot reach `localhost:5432`)

```bash
docker compose up -d postgres
docker exec -it musicvideo-postgres pg_isready -U postgres -d musicvideo
npm run backend:up
```

### ComfyUI image generation `404` / model path issues

1. Verify ComfyUI base URL in env (`COMFYUI_BASE_URL`).
2. Validate model/LoRA file existence in `ComfyUI/models`.
3. Run quick script probe:

```bash
python scripts/test_comfyui.py
```

Fallback safety remains active (`status=degraded` instead of hard crash).

### Gemini failures / timeouts

1. Validate `GEMINI_API_KEY`.
2. Inspect timeout/config:
   - `GEMINI_MODELS_TIMEOUT_SEC`
   - `GEMINI_API_BASE_URL`
3. Re-run health alerts and degraded trend endpoints after adjustment.

## 5. Safe Mitigation Rules (No Data Loss)

- Do not flush Redis queues during incident triage.
- Do not run destructive DB resets on production data.
- Prefer explicit degraded completion over hanging jobs.
- Keep retries enabled; avoid forcing manual fail unless poison-job confirmed.

## 6. Recovery Verification

1. New projects complete end-to-end.
2. `/health/ops` returns `status=ok`.
3. `/health/ops/degraded` clears critical alerts.
4. Sentry issue rate returns to baseline.

## 7. Postmortem (Within 24h)

- UTC timeline, impact, root cause, trigger conditions.
- Why alerting did/did not fire in time.
- Follow-up actions:
  - new regression tests,
  - config guards,
  - SLO threshold updates,
  - runbook updates.

## 8. Automation

- Weekly benchmark + SLO guard workflow:
  - `.github/workflows/ops-benchmark-fire-drill.yml` (`Benchmark + SLO Regression Guard`)
- Weekly fire drill workflow:
  - `.github/workflows/ops-benchmark-fire-drill.yml` (`Weekly Fire Drill`)

Local equivalents:

```bash
npm run bench:image-generation-full
npm run drill:fire
npm run ops:cleanup
```
