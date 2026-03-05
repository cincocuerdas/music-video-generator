# Response Envelope Rollout Runbook

> Owner: Backend Team  
> Created: 2026-03-04  
> Feature flag: `API_RESPONSE_ENVELOPE_ENABLED`

---

## 1. Overview

The response envelope wraps every API response in a consistent shape:

| Outcome | Shape |
|---------|-------|
| Success | `{ ok: true, data: T, meta: { timestamp, correlationId, path } }` |
| Error   | `{ ok: false, error: { statusCode, message }, meta: { timestamp, correlationId, path } }` |

When disabled (default), legacy shapes are preserved.

## 2. Pre-requisites

| Item | Status |
|------|--------|
| `ResponseEnvelopeInterceptor` + spec | ✅ Merged (2c7aa97) |
| `AllExceptionsFilter` envelope branch + spec | ✅ Merged (2c7aa97) |
| Frontend `apiEnvelope.ts` dual-shape adapter | ✅ Merged |
| 401/404/500 envelope validation (staging) | ✅ Passed (evidence §6) |
| `test:ops` 27/27 pass | ✅ Passed |

## 3. Staging (current)

```
API_RESPONSE_ENVELOPE_ENABLED=true
```

- Already validated with smoke tests.
- Frontend adapter (`unwrapData` / `unwrapError`) handles both shapes.
- Monitor `/health` and application logs for unexpected 4xx/5xx spikes.

## 4. Production — Canary Rollout

### Phase 1 — 10% traffic (Day 1)

```yaml
# Load balancer / feature flag config
envelope_canary_weight: 10
API_RESPONSE_ENVELOPE_ENABLED: "true"   # canary pods only
```

**Monitor (30 min minimum):**

| Metric | Threshold | Action if breached |
|--------|-----------|-------------------|
| 5xx rate | > baseline + 0.5% | Rollback canary → `false` |
| 4xx rate | > baseline + 2% | Investigate, hold canary |
| Frontend JS errors (parsing) | > 0 new errors | Rollback canary → `false` |
| Response envelope parse failures | any | Rollback |

**Rollback:**
```bash
# Set canary pods back to legacy
API_RESPONSE_ENVELOPE_ENABLED=false
# Restart canary pods
kubectl rollout restart deployment/api-canary
```

### Phase 2 — 25% traffic (Day 2, if Phase 1 clean)

```yaml
envelope_canary_weight: 25
```

- Same monitoring thresholds.
- Hold 2 hours minimum before advancing.

### Phase 3 — 100% traffic (Day 3+, if Phase 2 clean)

```yaml
envelope_canary_weight: 100
# Or simply set in all pods:
API_RESPONSE_ENVELOPE_ENABLED: "true"
```

- Monitor 24 hours before declaring GA.
- After GA: the flag can remain (no code removal needed).

## 5. Monitoring Checklist

```
□  Grafana/Datadog dashboard: 4xx/5xx rate per pod group
□  Frontend error tracker (Sentry/Datadog RUM): new JS parse errors
□  Backend structured logs: search for "envelope" or "correlationId"
□  Redis queue health: dead-letter queue depth unchanged
```

## 6. Rollback Procedure

| Step | Command |
|------|---------|
| 1. Disable flag | `API_RESPONSE_ENVELOPE_ENABLED=false` |
| 2. Restart affected pods | `kubectl rollout restart deployment/api` |
| 3. Verify | `curl /api/v1/health` returns legacy shape |
| 4. Notify | Post in #incidents channel |

Rollback is **instant and safe** — the frontend adapter (`apiEnvelope.ts`) handles both shapes transparently.

## 7. Post-GA Cleanup (Optional)

Once 100% is stable for > 1 week:

1. Remove `isAlreadyEnvelope()` guard (no longer needed).
2. Remove legacy branch from `AllExceptionsFilter`.
3. Remove `unwrapData`/`unwrapError` legacy fallback paths.
4. Hard-code envelope as the only shape.
5. Delete `API_RESPONSE_ENVELOPE_ENABLED` env var references.

These are **optional** — the flag adds negligible overhead.
