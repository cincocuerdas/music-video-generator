# Validation Evidence - 2026-03-05

## Release: `v0.12.1-local-envelope-rollout`

**Tag:** `0af91f8`  
**Date:** 2026-03-05  
**Envelope:** `API_RESPONSE_ENVELOPE_ENABLED=true`

> Scope note: this document captures local or staging-style validation against a backend running with the response envelope enabled. It is evidence for pre-rollout readiness and post-change verification. It is not evidence of a real production Kubernetes canary.

---

## 1. Frontend Build

```text
tsc -b && vite build
+ 2229 modules transformed
+ 0 TypeScript errors
+ Built in 12.45s
```

Key bundles: `vendor-react-dom` (184 KB), `vendor-motion` (123 KB), `vendor-axios` (36 KB), `index` (41 KB).

---

## 2. Envelope API Evidence (3/3 pass)

### 2.1 Health (200 - success envelope)

```json
{
  "ok": true,
  "data": { "status": "ok", "timestamp": "2026-03-05T05:16:41.770Z" },
  "meta": {
    "timestamp": "2026-03-05T05:16:41.770Z",
    "correlationId": "req-b18ede9e-f35",
    "path": "/api/v1/health"
  }
}
```

### 2.2 Auth 401 (error envelope)

```json
{
  "ok": false,
  "error": { "statusCode": 401, "message": "Invalid or expired token" },
  "meta": {
    "timestamp": "2026-03-05T05:16:41.787Z",
    "path": "/api/v1/auth/me",
    "correlationId": null
  }
}
```

### 2.3 404 (error envelope)

```json
{
  "ok": false,
  "error": { "statusCode": 404, "message": "Cannot GET /api/v1/nonexistent/route" },
  "meta": {
    "timestamp": "2026-03-05T05:16:41.792Z",
    "path": "/api/v1/nonexistent/route",
    "correlationId": null
  }
}
```

---

## 3. Quality Gate - `test:ops` 28/28

| Suite | Status |
|-------|--------|
| test:ops:prepare | PASS |
| test:repo-hygiene | PASS |
| test:artifact-hygiene | PASS |
| test:secret-hygiene | PASS |
| test:python-runner-contract | PASS (3 tests) |
| test:webhook-security | PASS (4 tests) |
| test:health-ops | PASS (22 tests) |
| test:envelope-contract | PASS |
| test:projects-optimization | PASS (2 tests) |
| test:auth-service | PASS (14 tests) |
| test:jobs-handoff | PASS (6 tests) |
| test:processors-smoke | PASS (7 tests) |
| test:processors-failures | PASS (11 tests) |
| test:dead-letter | PASS (3 tests) |
| test:pipeline-script-contract | PASS |
| test:redis-client | PASS (5 tests) |
| test:prod-guards | PASS (15 scenarios) |
| test:bullmq-retries | PASS |
| test:auth-throttling | PASS |
| test:pipeline-status | PASS (6 cases) |
| test:external-chaos | PASS |
| test:external-latency-chaos | PASS |
| test:latency-slo-alerts | PASS |
| test:health-webhook-receiver | PASS (4 cases) |
| test:health-alert-webhook | PASS (4 cases) |
| test:feedback-optimization | PASS |
| test:resilience | PASS |
| test:throttling | PASS |

**Exit code: 0**

---

## 4. Smoke Baseline (post-release, envelope=true)

Songs: Rick Astley + Despacito (Gangnam Style excluded - Whisper large-v3 CPU OOM on Korean).

| # | Song | projectId | pipelineStatus | degraded | Duration | Fallback |
|---|------|-----------|---------------|----------|----------|----------|
| 1 | Rick Astley - Never Gonna Give You Up | `6ba89540-02dd-4d3f-8fd0-30cf365c86cc` | completed | false | 614s | 0 |
| 2 | Luis Fonsi - Despacito | `e5fc8296-378b-4369-b0a9-d20e0d9ee5a7` | completed | false | 1158s | 0 |

**Aggregate:** 2/2 completed, 0 failed, total 1783s.

### Ops Metrics (24h window)

| Metric | Value |
|--------|-------|
| pipeline_count | 30 |
| p50 | 516s |
| p95 | 27,364s (critical - includes historical outliers) |
| max | 45,617s |
| degraded_rate | 0% (both runs non-degraded) |
| fallback_count | 0 |

### Duration by Stage (p50)

| Stage | p50 | p95 |
|-------|-----|-----|
| YOUTUBE_DOWNLOAD | 2.2s | 224s |
| TRANSCRIPTION | 295s | 46,339s |
| ANALYZE_LYRICS | 356s | 45,309s |
| GENERATE_IMAGES | 1,800s | 30,571s |
| RENDER_VIDEO | 167s | 4,058s |
| FINALIZE | 516s | 27,364s |

> Note: p95 values are inflated by historical outliers from stress tests and chaos testing (`test:external-chaos`, `test:external-latency-chaos`). The two clean smoke runs completed in 614s and 1158s respectively, which is within the expected operational band for local validation.

---

## 5. Commit History

```text
0af91f8 chore: finalize local envelope rollout validation
de6f5c7 fix(client): exclude spec files from tsconfig.app build
bd5df02 ci(gate): add test:envelope-contract to quality gate + test:ops chain
51530e6 feat(envelope): frontend dual-shape adapter + rollout runbook + test:ops 27/27
2c7aa97 feat(api): response-envelope error-path validation (P5) + service decomposition
29016b0 feat(health): SLO auto-mitigation + service decomposition + P1/P4 test coverage
1711d2e refactor(jobs): extract orchestration services and add processor test coverage
```
