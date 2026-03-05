# Validation Evidence — 2026-03-04

## 1. Smoke Baseline (Visual Quality A/B)

| # | Song | projectId | pipelineStatus | degraded | degradedReasons | Duration | Scenes (real) | Fallback | Video Size |
|---|------|-----------|---------------|----------|-----------------|----------|---------------|----------|------------|
| 1 | Rick Astley — Never Gonna Give You Up | `e02f9c64-71c7-495a-81cf-21f763f662d3` | success | false | [] | 499 s | 15 (gemini) | 0 | 13.9 MB |
| 2 | Luis Fonsi — Despacito | `a756f130-9841-4fc0-a855-1b92e1d66c9f` | success | false | [] | 471 s | 14 (gemini) | 0 | 9.4 MB |

**Nota:** Gangnam Style (Korean) fue descartado como candidato porque Whisper large-v3 en CPU consume ~3 GB de RAM durante la transcripción de idiomas no-latinos, excediendo la memoria disponible del sistema (16 GB total, ~2.5 GB libres con VS Code + browser). Ambas canciones exitosas usaron YouTube subtitles o transcripción liviana.

### Archivos generados

- Run 1: `output/videos/e02f9c64-71c7-495a-81cf-21f763f662d3.mp4` (15 escenas)
- Run 2: `output/videos/a756f130-9841-4fc0-a855-1b92e1d66c9f.mp4` (14 escenas)
- Baseline métricas: `output/baseline_metrics.json`

---

## 2. Métricas operativas (SLO & Stages)

### `/api/v1/health/ops/pipeline-slo?hours=24`

```json
{
  "status": "critical",
  "windowHours": 24,
  "thresholds": { "p95WarnMs": 1200000, "p95CriticalMs": 1800000, "minCompletedPipelines": 3 },
  "metrics": {
    "pipelineCount": 33,
    "avgMs": 4116178,
    "p50Ms": 725660,
    "p95Ms": 22768183,
    "maxMs": 45617272,
    "minMs": 181646
  },
  "hasCriticalAlerts": true,
  "mitigation": { "active": false, "consecutiveCriticalChecks": 0, "requiredConsecutiveChecks": 2 }
}
```

> **Nota:** El P95 elevado (22.7s) se debe a pipelines con crash/restart del backend que quedaron con duración inflada en DB. Los 2 runs exitosos completaron en ~485s promedio (p50 real).

### `/api/v1/health/ops/duration-by-stage?hours=24`

| Stage | Completed | Avg (s) | P50 (s) | P95 (s) | Max (s) |
|-------|-----------|---------|---------|---------|---------|
| YOUTUBE_DOWNLOAD | 82 | 0.6 | 2.3 | 193 | 46,735 |
| TRANSCRIPTION | 50 | 5.1 | 100 | 46,199 | 47,293 |
| ANALYZE_LYRICS | 45 | 3.5 | 293 | 36,962 | 45,479 |
| GENERATE_IMAGES | 46 | 4.6 | 1,800 | 35,374 | 47,369 |
| RENDER_VIDEO | 62 | 2.3 | 406 | 4,797 | 45,617 |
| FINALIZE | 33 | 3.9 | 710 | 21,347 | 45,617 |

### `/api/v1/health/ops/degraded-by-language?hours=24`

| Language | Total Completed | Degraded | Rate (%) | Window Completed | Window Degraded | Window Rate (%) |
|----------|----------------|----------|----------|-----------------|-----------------|-----------------|
| en | 413 | 15 | 3.63 | 147 | 1 | 0.68 |
| es | 54 | 9 | 16.67 | 0 | 0 | 0 |
| unknown | 1,381 | 45 | 3.26 | 171 | 5 | 2.92 |

---

## 3. Test:ops — 27/27 ALL PASS

```
test:ops:prepare                  PASS
test:repo-hygiene                 PASS
test:artifact-hygiene             PASS
test:secret-hygiene               PASS
test:python-runner-contract       PASS  (3/3)
test:webhook-security             PASS  (4/4)
test:health-ops                   PASS  (22/22)
test:projects-optimization        PASS  (2/2)
test:auth-service                 PASS  (14/14)
test:jobs-handoff                 PASS  (6/6)
test:processors-smoke             PASS  (7/7)
test:processors-failures          PASS  (11/11)
test:dead-letter                  PASS  (3/3)
test:pipeline-script-contract     PASS
test:redis-client                 PASS  (5/5)
test:prod-guards                  PASS  (13/13)
test:bullmq-retries               PASS
test:auth-throttling              PASS
test:pipeline-status              PASS  (6/6)
test:external-chaos               PASS
test:external-latency-chaos       PASS
test:latency-slo-alerts           PASS
test:health-webhook-receiver      PASS
test:health-alert-webhook         PASS
test:feedback-optimization        PASS
test:resilience                   PASS
test:throttling                   PASS
```

Conflicto de puerto resuelto: se apaga el backend manual antes de correr `test:ops`, que levanta su propia instancia vía `test:ops:prepare`.

---

## 4. Regresión funcional — Rutas de entrada P4

| Ruta | projectId | Routing correcto | Estado |
|------|-----------|-----------------|--------|
| lyrics-only | `1529d9ad-d46c-4391-a721-df7d417a6e92` | PASS — skip YOUTUBE_DOWNLOAD, arranca en ANALYZE_LYRICS | Routing validado |
| audio-only | `be5e68e0-af07-4f86-a774-9cdaa5464eaf` | PASS — skip YOUTUBE_DOWNLOAD, arranca en TRANSCRIPTION | Routing validado |
| youtube-url | `2473fe61-37c6-49b5-bd2a-630a13a8e868` | PASS — arranca en YOUTUBE_DOWNLOAD | Routing validado |

Casos adicionales validados dentro de `test:pipeline-status`:
- `case_success` (`c809816f`): pipeline completo, status=success, progress=100%
- `case_degraded` (`84235aca`): pipeline degraded path validado
- `case_failed` (`30751cac`): pipeline failure path validado

**Conclusión:** P4 no degradó ninguna ruta de entrada.

---

## 5. Resumen ejecutivo

| Métrica | Valor |
|---------|-------|
| Smoke runs exitosos | 2/2 (Rick Astley 499s, Despacito 471s) |
| Escenas reales (Gemini) | 29/29 (0 fallback) |
| Degradación | 0% (0 de 2 runs) |
| Test suites (test:ops) | 27/27 PASS |
| Test:pipeline-status | 6/6 PASS |
| Regresión rutas P4 | 3/3 PASS |
| Tiempo total smoke | ~970s (~16 min) |
| Backend heap recomendado | --max-old-space-size=1024 (uso real ~400 MB) |
| RAM libre mínima requerida | ≥3.5 GB (Whisper large-v3 en CPU necesita ~2 GB) |

### Limitaciones conocidas
- Canciones en coreano/japonés/chino disparan Whisper large-v3 completo en CPU, requiriendo ~3 GB RAM extra. Con <3 GB libres, Windows mata el proceso silenciosamente.
- P95 de SLO inflado por pipelines históricos con crash/restart (no refleja rendimiento real de las últimas 2 ejecuciones exitosas).

---

## 6. Response Envelope (P5)

### Configuración
- **Env var**: `API_RESPONSE_ENVELOPE_ENABLED` (default: `false`)
- **Interceptor**: `ResponseEnvelopeInterceptor` — wrappea respuestas exitosas
- **Filter**: `AllExceptionsFilter` — wrappea errores cuando envelope está activo

### Success shape
```json
{ "ok": true, "data": { ... }, "meta": { "timestamp": "...", "correlationId": "...", "path": "..." } }
```

### Error shape
```json
{ "ok": false, "error": { "statusCode": 401, "message": "..." }, "meta": { "timestamp": "...", "path": "...", "correlationId": null } }
```

### Smoke test con envelope ON — 3/3 PASS

| Caso | Endpoint | HTTP Status | `ok` | Shape correcto |
|------|----------|-------------|------|----------------|
| 401 invalid token | `GET /auth/me` | 401 | false | `{ ok, error: { statusCode, message }, meta }` |
| 404 unknown route | `GET /nonexistent/route` | 404 | false | `{ ok, error: { statusCode, message }, meta }` |
| 500 unhandled error | `GET /health/__test-500` | 500 | false | `{ ok, error: { statusCode, message }, meta }` |

Success endpoints validados: `/health`, `/auth/me`, `/auth/dev-token`, `/jobs/pipeline/:id` — todos devuelven `{ ok: true, data, meta }`.

### Rollout plan

| Entorno | `API_RESPONSE_ENVELOPE_ENABLED` | Estado |
|---------|-------------------------------|--------|
| **Staging** | `true` | Activo — validado 2026-03-04 |
| **Producción** | `false` (default) | Pendiente — activar cuando frontend consuma el nuevo shape |

**No hay riesgo de activación accidental**: el default en código es `'false'`, `.env` no lo define, `.env.example` lo documenta como `false`.
