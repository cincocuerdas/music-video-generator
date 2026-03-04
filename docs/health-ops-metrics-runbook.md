# Health Ops Metrics Runbook

This runbook defines how to read and act on these backend metrics:

- `GET /api/v1/health/ops/duration-by-stage?hours=24`
- `GET /api/v1/health/ops/queue-wait-by-stage?hours=24`
- `GET /api/v1/health/ops/degraded-by-language?hours=24`
- `GET /api/v1/health/ops/pipeline-slo?hours=24`
- `GET /api/v1/health/ops/pipeline-slo-breakdown?hours=24`
- `GET /api/v1/health/ops` (aggregate snapshot includes all above)

## 1) Duration By Stage

Endpoint:

```bash
curl "http://localhost:3000/api/v1/health/ops/duration-by-stage?hours=24"
```

Main fields:

- `stages[].type`
- `stages[].avgMs`
- `stages[].p50Ms`
- `stages[].p95Ms`
- `stages[].maxMs`
- `totalCompletedJobs`

Interpretation:

- `p50Ms` shows normal runtime.
- `p95Ms` shows tail latency (where users feel instability).
- `maxMs` catches extreme stalls/timeouts.

Action rules:

- If only `GENERATE_IMAGES.p95Ms` rises: inspect provider rate limits, scene complexity, image retries.
- If only `TRANSCRIPTION.p95Ms` rises: inspect Whisper model/load and audio file quality.
- If all stages rise together: inspect DB/Redis/host saturation.

## 2) Degraded Rate By Language

Endpoint:

```bash
curl "http://localhost:3000/api/v1/health/ops/degraded-by-language?hours=24"
```

Main fields:

- `byLanguage[].language`
- `byLanguage[].completedWindow`
- `byLanguage[].degradedWindow`
- `byLanguage[].degradedRateWindowPct`

Important behavior:

- Language is taken from the latest completed `TRANSCRIPTION` per pipeline run.
- Aggregation deduplicates by pipeline key (`correlationId`, fallback `projectId`).

Interpretation:

- High degraded in one language usually indicates prompt/analysis routing mismatch for that language.
- Low sample sizes can look noisy; always check `completedWindow`.

Action rules:

- If `completedWindow < 5`: track but do not tune thresholds yet.
- If one language is >2x global degraded rate with `completedWindow >= 10`: prioritize language-specific routing/prompt changes.

## 3) Queue Wait By Stage

Endpoint:

```bash
curl "http://localhost:3000/api/v1/health/ops/queue-wait-by-stage?hours=24"
```

Main fields:

- `stages[].type`
- `stages[].completed.waitMs.p50Ms / p95Ms`
- `stages[].pending.ageMs.p50Ms / p95Ms`
- `stages[].completed.sampled`

Important behavior:

- Completed wait is computed from BullMQ timestamps (`processedOn - timestamp`) for completed jobs.
- Pending age is current queue age (`now - timestamp`) for waiting/delayed jobs.
- Results can be sampled if retained jobs exceed inspect limit.

Environment knobs:

- `HEALTH_OPS_MAX_QUEUE_WAIT_INSPECT`

Action rules:

- If `pending.ageMs.p95Ms` is high in one stage, that queue is your current bottleneck.
- If `completed.waitMs.p95Ms` is high with low pending age, backlog was transient and already draining.

## 4) Pipeline SLO (End-to-End)

Endpoint:

```bash
curl "http://localhost:3000/api/v1/health/ops/pipeline-slo?hours=24"
```

Main fields:

- `status` = `met | warning | critical`
- `metrics.pipelineCount`
- `metrics.p95Ms`
- `thresholds.p95WarnMs` (default 1,200,000 ms = 20 min)
- `thresholds.p95CriticalMs` (default 1,800,000 ms = 30 min)
- `thresholds.minCompletedPipelines` (default 3)

Important behavior:

- SLO is computed per pipeline run using pipeline key (`correlationId`, fallback `projectId`).
- The query only includes runs that reached `FINALIZE`.

Environment knobs:

- `HEALTH_PIPELINE_SLO_P95_WARN_MS`
- `HEALTH_PIPELINE_SLO_P95_CRITICAL_MS`
- `HEALTH_PIPELINE_SLO_MIN_COMPLETED`

Action rules:

- `met`: no action.
- `warning`: inspect top stage from `duration-by-stage` and `queue-wait-by-stage`; monitor next 2-3 hours.
- `critical`: treat as incident; throttle intake or shift provider strategy, then recheck SLO.

## 5) Pipeline SLO Breakdown

Endpoint:

```bash
curl "http://localhost:3000/api/v1/health/ops/pipeline-slo-breakdown?hours=24"
```

Main fields:

- `pipelines[].pipelineKey`
- `pipelines[].totalDurationMs`
- `pipelines[].stages[].durationMs`
- `pipelines[].stages[].retries`
- `pipelines[].stages[].handoffWaitMs`

Use case:

- Identify top slow runs and isolate if time was spent:
  - inside a stage (`durationMs`)
  - between stages (`handoffWaitMs`)
  - on retries (`retries`)

Environment knobs:

- `HEALTH_PIPELINE_SLO_BREAKDOWN_TOP_N`

## 6) Aggregate Snapshot Behavior

`GET /api/v1/health/ops` includes:

- `durationByStage`
- `queueWaitByStage`
- `degradedByLanguage`
- `pipelineSlo`
- `pipelineSloBreakdown`

The aggregate `status` is `degraded` when any critical condition is present:

- critical degraded-stage alerts
- critical latency alerts
- critical pipeline SLO alerts
- collection errors in snapshot dependencies

## 7) Fast Incident Checklist

1. Call `pipeline-slo` and verify `p95Ms`.
2. Call `duration-by-stage` and find highest `p95Ms`.
3. Call `queue-wait-by-stage` and identify queue pressure per stage.
4. Call `pipeline-slo-breakdown` and inspect top slow runs (`durationMs` vs `handoffWaitMs` vs `retries`).
5. Call `degraded-by-language` and detect language outliers.
6. If provider/API saturation is suspected, check recent 429/timeout logs.
7. Apply mitigation, then verify with the same endpoints after 1-2 new completed runs.
