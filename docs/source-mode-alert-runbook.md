# Source Mode Alert Runbook

This runbook is for degraded/latency incidents segmented by pipeline source mode:

- `youtube`
- `audio`
- `lyrics`
- `unknown`

## 1. Quick Triage

```bash
# Global ops summary (includes sourceModeSummary24h)
curl -s http://localhost:3000/api/v1/health/ops

# Degraded by source mode (last hour)
curl -s "http://localhost:3000/api/v1/health/ops/degraded?hours=1&sourceMode=youtube"
curl -s "http://localhost:3000/api/v1/health/ops/degraded?hours=1&sourceMode=audio"
curl -s "http://localhost:3000/api/v1/health/ops/degraded?hours=1&sourceMode=lyrics"

# Pipeline quality by source mode (last hour)
curl -s "http://localhost:3000/api/v1/health/ops/pipeline-quality?hours=1&sourceMode=youtube"
```

## 2. Decision Matrix

### `youtube` degraded

1. Validate source URL ingestion and downloader stage.
2. Check `YOUTUBE_DOWNLOAD` failures and rate limits.
3. Confirm downstream jobs are not blocked by missing download artifacts.

### `audio` degraded

1. Focus on `TRANSCRIPTION` and `ANALYZE_LYRICS`.
2. Verify audio input path integrity and duration metadata.
3. Check Gemini timeout/429 patterns.

### `lyrics` degraded

1. Focus on `ANALYZE_LYRICS` and `GENERATE_IMAGES`.
2. Validate prompt optimization and embedding fallback behavior.
3. Check ComfyUI/provider fallback status.

### `unknown` degraded

1. Treat as data quality/config issue.
2. Verify project records are storing `sourceMode`.
3. Backfill/fix malformed projects and re-run health snapshots.

## 3. Recovery Verification

1. `GET /health/ops` returns stable `sourceModeSummary24h`.
2. `GET /health/ops/degraded?...&sourceMode=<mode>` shows decreasing degraded rate.
3. Alert webhook events stop repeating after cooldown and recovery event is emitted.
4. New projects of affected source mode complete with expected pipeline status.

## 4. Data Integrity Checks

```sql
-- Source mode distribution
SELECT "sourceMode", COUNT(*) FROM "Project" GROUP BY "sourceMode" ORDER BY 1;

-- Projects missing source mode (should be 0 or legacy only)
SELECT COUNT(*) FROM "Project" WHERE "sourceMode" IS NULL;
```

## 5. Notes

- Filtered health queries (`sourceMode=...`) are for investigation and do not trigger outbound health webhooks.
- Global `/health/ops/degraded` remains the alerting source of truth.
