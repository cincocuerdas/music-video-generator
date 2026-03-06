# Response Envelope Rollout Runbook

> Owner: Backend Team
> Created: 2026-03-04
> Feature flag: `API_RESPONSE_ENVELOPE_ENABLED`

Current production operating model is `Docker Compose` on a host/VM. This runbook reflects the current deployment reality. Any Kubernetes canary procedure is future-state guidance only and must not be treated as the active rollout path unless infrastructure is explicitly migrated.

## 1. Overview

The response envelope wraps every API response in a consistent shape:

| Outcome | Shape |
|---------|-------|
| Success | `{ ok: true, data: T, meta: { timestamp, correlationId, path } }` |
| Error | `{ ok: false, error: { statusCode, message }, meta: { timestamp, correlationId, path } }` |

When disabled (default), legacy shapes are preserved.

## 2. Preconditions

| Item | Status |
|------|--------|
| `ResponseEnvelopeInterceptor` + spec | Merged |
| `AllExceptionsFilter` envelope branch + spec | Merged |
| Frontend `apiEnvelope.ts` dual-shape adapter | Merged |
| Error-path validation (401/404/500) | Passed |
| `test:ops` | Passed |
| Manual smoke with envelope | Passed |

## 3. Staging / Local Validation

```bash
API_RESPONSE_ENVELOPE_ENABLED=true
```

- Validate critical endpoints manually and through `test:ops`.
- Confirm frontend adapter handles both `legacy` and `envelope`.
- Watch `/health`, `/health/ops`, and browser parsing errors.

## 4. Production Rollout (Current: Docker Compose / Host)

### Phase 1 - Release Candidate Validation

Before touching production:

- `test:ops` must be green.
- Manual smoke against a backend with `API_RESPONSE_ENVELOPE_ENABLED=true` must be green.
- Frontend adapter must already be deployed or otherwise verified compatible.

### Phase 2 - Single Instance Rollout

Enable the flag in the production environment and restart the backend:

```bash
# Update the production environment
API_RESPONSE_ENVELOPE_ENABLED=true

# Rebuild/restart the backend stack
docker compose -f docker-compose.prod.yml up -d --build
```

### Phase 3 - Monitor 30 to 60 Minutes

| Metric | Threshold | Action if breached |
|--------|-----------|-------------------|
| 5xx rate | > baseline + 0.5% | Roll back flag to `false` |
| 4xx rate | > baseline + 2% | Hold rollout and investigate |
| Frontend JS parse errors | > 0 new errors | Roll back flag to `false` |
| Envelope parse failures | any | Roll back |
| `/health/ops` and `/health/ops/pipeline-slo` | unstable or non-200 | Hold rollout |

### Phase 4 - Hold for 24 Hours

- If stable, keep the flag enabled.
- Monitor normal product traffic and dead-letter depth.
- Declare GA only after a clean 24h window.

## 5. Monitoring Checklist

- Application/API 4xx and 5xx rates remain near baseline.
- Frontend error tracking shows zero new response-parsing failures.
- Backend logs contain normal request volume with valid `correlationId`.
- Redis queue health and dead-letter depth remain stable.
- `/api/v1/health`, `/api/v1/health/ops`, and `/api/v1/health/ops/pipeline-slo` remain healthy.

## 6. Rollback Procedure

| Step | Command |
|------|---------|
| 1. Disable flag | `API_RESPONSE_ENVELOPE_ENABLED=false` |
| 2. Restart backend | `docker compose -f docker-compose.prod.yml up -d --build` |
| 3. Verify | `curl http://localhost:3000/api/v1/health` returns legacy shape |
| 4. Notify | Post incident/update in the operational channel |

Rollback is safe because the frontend adapter handles both shapes transparently.

## 7. Future-State Variant (Kubernetes Canary)

Use this section only if production migrates to Kubernetes.

### Phase 1 - 10 Percent Traffic

```yaml
envelope_canary_weight: 10
API_RESPONSE_ENVELOPE_ENABLED: "true"
```

### Phase 2 - 25 Percent Traffic

```yaml
envelope_canary_weight: 25
```

### Phase 3 - 100 Percent Traffic

```yaml
envelope_canary_weight: 100
API_RESPONSE_ENVELOPE_ENABLED: "true"
```

Example restart:

```bash
kubectl rollout restart deployment/api-canary
```

## 8. Post-GA Cleanup (Optional)

Once 100 percent usage is stable for more than a week:

1. Remove the legacy-shape fallback paths.
2. Remove the envelope feature flag.
3. Keep the response contract documentation as the single source of truth.
