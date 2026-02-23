# Music Video Generator - Backend

AI-powered music video generator that creates literal visual representations of song lyrics.

## Prerequisites

- Node.js 20+
- Python 3.11+
- PostgreSQL 15+
- Redis 7+
- Docker (optional, for PostgreSQL/Redis)

## Quick Start

### 1. Setup Environment

```bash
# Unix/macOS
chmod +x setup_env.sh
./setup_env.sh

# Windows
setup_env.bat
```

### 2. Start Dependencies (Docker)

```bash
# PostgreSQL
docker run -d --name postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=musicvideo \
  -p 5432:5432 \
  postgres:15

# Redis
docker run -d --name redis \
  -p 6379:6379 \
  redis:7
```

### 3. Configure Environment

```bash
cp .env.example .env
# Edit .env with your settings
```

### 4. Initialize Database

```bash
npm run db:generate
npm run db:migrate
npm run db:seed
```

### 5. Start Server

```bash
npm run start:dev
```

### 6. Install local git hooks (recommended)

```bash
npm run hooks:install
```

This enables:

- `pre-commit`: quick hygiene checks (`repo` + `artifact`)
- `pre-push`: critical backend guards (`secret hygiene`, `python runner contract`, `redis client`, `prod guards`)

## E2E Pipeline Test

### Manual Test with curl

```bash
# 0. Login dev session (non-production only)
TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login/dev \
  -H "Content-Type: application/json" \
  -d '{}' | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')

# 1. Check health
curl http://localhost:3000/api/v1/health

# 2. Create a test project (run seed first, or use the response ID)
npm run db:seed

# 3. Start pipeline (replace PROJECT_ID)
curl -X POST http://localhost:3000/api/v1/jobs/pipeline/{PROJECT_ID}/start \
  -H "Authorization: Bearer $TOKEN"

# 4. Check status
curl http://localhost:3000/api/v1/jobs/pipeline/{PROJECT_ID} \
  -H "Authorization: Bearer $TOKEN"

# 5. Cancel (if needed)
curl -X POST http://localhost:3000/api/v1/jobs/pipeline/{PROJECT_ID}/cancel \
  -H "Authorization: Bearer $TOKEN"
```

### Automated Test Script

```bash
# Unix/macOS
chmod +x e2e-test.sh
./e2e-test.sh

# Windows
e2e-test.bat
```

## Pipeline Flow

```
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”    â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”    â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”    â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚ ANALYZE_LYRICS  â”‚â”€â”€â”€â–¶â”‚ GENERATE_IMAGES  â”‚â”€â”€â”€â–¶â”‚ RENDER_VIDEO  â”‚â”€â”€â”€â–¶â”‚ FINALIZE â”‚
â”‚   (3s mock)     â”‚    â”‚    (5s mock)     â”‚    â”‚   (5s mock)   â”‚    â”‚          â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜    â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜    â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜    â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
        â”‚                      â”‚                       â”‚
        â–¼                      â–¼                       â–¼
   analyze_lyrics.py    generate_images.py     render_video.py
```

## Monitoring Logs

When running with `npm run start:dev`, you'll see:

```
[Nest] LOG [JobsService] Pipeline started for project xxx
[Nest] LOG [AnalysisProcessor] Processing ANALYZE_LYRICS job xxx
[Nest] LOG [JobsService] Marking job xxx as PROCESSING
[Nest] LOG [PythonRunnerService] Executing Python script: analyze_lyrics.py
[Nest] LOG [PythonRunnerService] Python script completed successfully
[Nest] LOG [JobsService] Marking job xxx as COMPLETED
[Nest] LOG [JobsService] Advanced pipeline to GENERATE_IMAGES
...
[Nest] LOG [JobsService] Pipeline completed for project xxx
```

## Project Status Flow

```
DRAFT â†’ PROCESSING â†’ COMPLETED
                  â†˜ FAILED
                  â†˜ CANCELLED
```

## Job Status Flow

```
PENDING â†’ PROCESSING â†’ COMPLETED
                    â†˜ FAILED
                    â†˜ CANCELLED
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Environment | `development` |
| `HOST` | Host interface where Nest listens | `0.0.0.0` |
| `PORT` | Server port | `3000` |
| `DATABASE_URL` | PostgreSQL connection | - |
| `THROTTLE_TTL_MS` | Global throttle window in milliseconds | `60000` |
| `THROTTLE_LIMIT` | Global default request limit per window | `120` |
| `THROTTLE_AUTH_DEV_TOKEN_LIMIT` | Per-window limit for `POST /auth/dev-token` | `10` |
| `THROTTLE_AUTH_LOGIN_DEV_LIMIT` | Per-window limit for `POST /auth/login/dev` | `10` |
| `THROTTLE_AUTH_REFRESH_LIMIT` | Per-window limit for `POST /auth/refresh` | `30` |
| `THROTTLE_AUTH_LOGOUT_LIMIT` | Per-window limit for `POST /auth/logout` | `60` |
| `THROTTLE_PROJECTS_CREATE_LIMIT` | Per-window limit for `POST /projects` | `20` |
| `THROTTLE_PROJECTS_GENERATE_LIMIT` | Per-window limit for `POST /projects/:id/generate` | `8` |
| `THROTTLE_PROJECTS_CANCEL_LIMIT` | Per-window limit for `POST /projects/:id/cancel` | `15` |
| `THROTTLE_PROJECTS_FEEDBACK_LIMIT` | Per-window limit for `POST /projects/:id/feedback` | `45` |
| `THROTTLE_PROJECTS_FEEDBACK_STATS_LIMIT` | Per-window limit for `GET /projects/feedback/stats` | `30` |
| `THROTTLE_PROJECTS_PROMPT_OPTIMIZATION_LIMIT` | Per-window limit for `GET /projects/:id/prompt-optimization` | `30` |
| `THROTTLE_PROJECTS_LIVE_SIGNAL_LIMIT` | Per-window limit for `POST /projects/:id/live-signal` | `60` |
| `THROTTLE_JOBS_CREATE_LIMIT` | Per-window limit for `POST /jobs` | `20` |
| `THROTTLE_JOBS_UPDATE_LIMIT` | Per-window limit for `PATCH /jobs/:id` | `30` |
| `THROTTLE_JOBS_DELETE_LIMIT` | Per-window limit for `DELETE /jobs/:id` | `20` |
| `THROTTLE_JOBS_PIPELINE_START_LIMIT` | Per-window limit for `POST /jobs/pipeline/:id/start` | `8` |
| `THROTTLE_JOBS_PIPELINE_CANCEL_LIMIT` | Per-window limit for `POST /jobs/pipeline/:id/cancel` | `15` |
| `THROTTLE_HEALTH_OPS_LIMIT` | Per-window limit for `GET /health/ops` | `30` |
| `THROTTLE_HEALTH_OPS_DEGRADED_LIMIT` | Per-window limit for `GET /health/ops/degraded` | `30` |
| `THROTTLE_WEBHOOKS_HEALTH_ALERT_LIMIT` | Per-window limit for `POST /webhooks/health-alert` | `60` |
| `FEEDBACK_DEDUPE_WINDOW_MS` | Milliseconds window to ignore duplicate feedback submissions | `5000` |
| `PGVECTOR_ANN_CANDIDATE_LIMIT` | ANN nearest-neighbor candidate pool size before style filtering (`getPromptOptimization`) | `250` |
| `PGVECTOR_SIMILARITY_LIMIT` | Maximum similar embedded feedback rows consumed per optimization request | `10` |
| `HEALTH_OPS_MAX_INSPECT_JOBS` | Max jobs inspected per queue status to estimate retrying jobs in `/health/ops` | `500` |
| `HEALTH_DEGRADED_ALERT_WARN_PCT` | Warning threshold (%) for degraded rate in `/health/ops/degraded` | `5` |
| `HEALTH_DEGRADED_ALERT_CRITICAL_PCT` | Critical threshold (%) for degraded rate in `/health/ops/degraded` | `20` |
| `HEALTH_DEGRADED_ALERT_MIN_COMPLETED_WINDOW` | Minimum completed jobs in window required to trigger degraded alerts | `5` |
| `HEALTH_DEGRADED_ALERT_COOLDOWN_MS` | Cooldown before resending the same critical degraded alert signature | `900000` |
| `HEALTH_ALERT_WEBHOOK_URL` | Optional webhook URL for degraded critical/recovery alerts | (empty) |
| `HEALTH_ALERT_WEBHOOK_TIMEOUT_MS` | Timeout for alert webhook HTTP calls (ms) | `5000` |
| `HEALTH_ALERT_WEBHOOK_SECRET` | Optional HMAC secret used to sign health alert webhooks (`X-MVG-Webhook-Signature`) | (empty) |
| `HEALTH_WEBHOOK_RECEIVER_SECRET` | Secret used by `/webhooks/health-alert` to verify inbound HMAC signatures | (empty) |
| `HEALTH_WEBHOOK_RECEIVER_MAX_SKEW_SEC` | Max allowed timestamp skew for inbound health webhooks (seconds) | `300` |
| `HEALTH_SLO_P95_WARN_MS` | Warning p95 latency threshold (ms) for `/health/ops` stage alerts | `120000` |
| `HEALTH_SLO_P95_CRITICAL_MS` | Critical p95 latency threshold (ms) for `/health/ops` stage alerts | `300000` |
| `HEALTH_SLO_P95_MIN_COMPLETED_24H` | Minimum completed jobs (24h) required to evaluate p95 alerts per stage | `3` |
| `REDIS_HOST` | Redis host | `localhost` |
| `REDIS_PORT` | Redis port | `6379` |
| `REDIS_URL` | Redis URL (used as priority source when defined) | `redis://localhost:6379` |
| `REDIS_HOST` / `REDIS_URL` in production | Required explicit Redis config in `NODE_ENV=production` (no implicit localhost fallback) | _required_ |
| `REDIS_CONNECT_TIMEOUT_MS` | Redis connect timeout in ms | `10000` |
| `REDIS_RETRY_BASE_DELAY_MS` | Base delay for Redis reconnect backoff (ms) | `250` |
| `REDIS_RETRY_MAX_DELAY_MS` | Max delay for Redis reconnect backoff (ms) | `5000` |
| `REDIS_MAX_RETRIES_PER_REQUEST` | Max retries per Redis command (`null` recommended for BullMQ) | `null` |
| `REDIS_ENABLE_OFFLINE_QUEUE` | Queue Redis commands while disconnected | `true` |
| `QUEUE_DEFAULT_JOB_ATTEMPTS` | Fallback attempts for jobs enqueued without explicit retry options | `2` |
| `QUEUE_DEFAULT_JOB_BACKOFF_MS` | Fallback exponential backoff base delay (ms) | `10000` |
| `QUEUE_DEFAULT_REMOVE_ON_COMPLETE` | Default amount of completed jobs to keep in BullMQ | `200` |
| `QUEUE_DEFAULT_REMOVE_ON_FAIL` | Default amount of failed jobs to keep in BullMQ | `500` |
| `JOB_RETRY_ATTEMPTS_YOUTUBE_DOWNLOAD` | Retry attempts for `YOUTUBE_DOWNLOAD` jobs | `2` |
| `JOB_RETRY_DELAY_MS_YOUTUBE_DOWNLOAD` | Retry backoff base delay for `YOUTUBE_DOWNLOAD` (ms) | `15000` |
| `JOB_RETRY_ATTEMPTS_TRANSCRIPTION` | Retry attempts for `TRANSCRIPTION` jobs | `2` |
| `JOB_RETRY_DELAY_MS_TRANSCRIPTION` | Retry backoff base delay for `TRANSCRIPTION` (ms) | `20000` |
| `JOB_RETRY_ATTEMPTS_ANALYZE_LYRICS` | Retry attempts for `ANALYZE_LYRICS` jobs | `3` |
| `JOB_RETRY_DELAY_MS_ANALYZE_LYRICS` | Retry backoff base delay for `ANALYZE_LYRICS` (ms) | `10000` |
| `JOB_RETRY_ATTEMPTS_GENERATE_IMAGES` | Retry attempts for `GENERATE_IMAGES` jobs | `3` |
| `JOB_RETRY_DELAY_MS_GENERATE_IMAGES` | Retry backoff base delay for `GENERATE_IMAGES` (ms) | `15000` |
| `JOB_RETRY_ATTEMPTS_RENDER_VIDEO` | Retry attempts for `RENDER_VIDEO` jobs | `2` |
| `JOB_RETRY_DELAY_MS_RENDER_VIDEO` | Retry backoff base delay for `RENDER_VIDEO` (ms) | `20000` |
| `JOB_RETRY_ATTEMPTS_TRAIN_LORA` | Retry attempts for `TRAIN_LORA` jobs | `2` |
| `JOB_RETRY_DELAY_MS_TRAIN_LORA` | Retry backoff base delay for `TRAIN_LORA` (ms) | `60000` |
| `CORS_ORIGIN` | Allowed CORS origin(s), comma-separated | `http://localhost:5173` |
| `GEMINI_API_BASE_URL` | Base URL for Gemini API (override for chaos/local testing) | `https://generativelanguage.googleapis.com` |
| `GEMINI_MODELS_TIMEOUT_SEC` | Timeout (seconds) for Gemini model list request | `10` |
| `GEMINI_REQUEST_TIMEOUT_SEC` | Timeout (seconds) for Gemini generate request | `45` |
| `GEMINI_REQUEST_RETRIES` | Retries for transient Gemini request failures | `2` |
| `SENTRY_DSN` | Sentry DSN for backend error/trace reporting (`empty` = disabled) | (empty) |
| `SENTRY_RELEASE` | Release/version label reported to Sentry | (empty) |
| `SENTRY_TRACES_SAMPLE_RATE` | Sampling rate for Sentry traces (`0.0` to `1.0`) | `0` |
| `SENTRY_PROFILES_SAMPLE_RATE` | Sampling rate for Sentry profiles (`0.0` to `1.0`) | `0` |
| `SENTRY_DEBUG` | Enable verbose Sentry SDK debug logs | `false` |
| `DEV_USER_ID` | Local dev fallback user UUID | `00000000-0000-4000-8000-000000000001` |
| `JWT_SECRET` | Secret used to verify Bearer JWT tokens | - |
| `JWT_REFRESH_SECRET` | Secret used to sign/verify refresh tokens | `JWT_SECRET` |
| `JWT_REFRESH_TOKEN_PEPPER` | Extra pepper for stored refresh token hashes | - |
| `JWT_USER_ID_CLAIM` | JWT claim that contains the UUID user id | `sub` |
| `JWT_EXPIRES_IN` | Expiration used when issuing dev tokens | `1d` |
| `JWT_REFRESH_EXPIRES_IN` | Refresh token expiration for session rotation | `30d` |
| `ALLOW_DEV_AUTH_BYPASS` | Allow fallback to `DEV_USER_ID` when token is missing (non-production only) | `false` |
| `USE_MOCK_PROCESSORS` | Use mock Python scripts | `true` |
| `PYTHON_PATH` | Python executable path | auto-detect |
| `PYTHON_SCRIPT_TIMEOUT_MS` | Global timeout override (ms) for Python worker scripts | per-script defaults |
| `API_BASE_URL` | Base URL used by helper/test scripts that call backend HTTP APIs | `http://localhost:3000/api/v1` |
| `API_BASE_URL` in production | Required explicit backend API base for Python helper/test scripts | _required_ |
| `COMFYUI_URL` | Local ComfyUI server URL used by image generation | `http://127.0.0.1:8188` |
| `COMFYUI_URL` in production | Required explicit ComfyUI endpoint in pipeline scripts (no implicit local fallback) | _required_ |
| `PLACEHOLDER_IMAGE_BASE_URL` | Base URL used for generated fallback placeholder images | `https://placehold.co` |
| `MOCK_VIDEO_URL` | Mock video URL returned when `VIDEO_RENDER` runs in mock mode | (empty) |

Per-endpoint throttle TTL override is optional using `{LIMIT_ENV}_TTL_MS` (for example `THROTTLE_PROJECTS_CREATE_LIMIT_TTL_MS`).

## Scripts Structure

```
scripts/
├── youtube_download.py      # Download audio + thumbnail
├── transcribe_audio.py      # Whisper transcription
├── analyze_lyrics.py        # Lyrics analysis
├── generate_images.py       # Image generation
└── render_video.py          # Video rendering
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/health` | Health check |
| GET | `/api/v1/health/ops` | Operational metrics (queues, retries, failed/completed stats, latencies) |
| GET | `/api/v1/health/ops/degraded?hours=24` | Degraded output metrics by pipeline stage (`JobType`) with totals, window stats, and rates |
| GET | `/api/v1/health/ops/realtime` | Realtime websocket/event metrics snapshot (connections, joins, emits, parse errors) |
| GET | `/api/v1/health/ops/pipeline-quality?hours=24` | Pipeline quality summary grouped by stable degraded reason codes |
| POST | `/api/v1/webhooks/health-alert` | Signed inbound health alert receiver (HMAC + anti-replay) |
| POST | `/api/v1/auth/dev-token` | Legacy dev access token (non-production only) |
| POST | `/api/v1/auth/login/dev` | Issue access+refresh tokens (non-production only) |
| POST | `/api/v1/auth/refresh` | Rotate refresh session and issue fresh access token |
| POST | `/api/v1/auth/logout` | Revoke refresh session |
| GET | `/api/v1/auth/me` | Return current JWT identity |
| POST | `/api/v1/jobs/pipeline/:projectId/start` | Start pipeline |
| GET | `/api/v1/jobs/pipeline/:projectId` | Get pipeline status |
| POST | `/api/v1/jobs/pipeline/:projectId/cancel` | Cancel pipeline |

## Operations

- Incident response runbook: `docs/backend-incident-runbook.md`
- Backend quality gate setup: `docs/backend-quality-gate.md`
- Health webhook signing:
  - Sender includes `X-MVG-Webhook-Timestamp` and `X-MVG-Webhook-Signature: sha256=<hex>` when `HEALTH_ALERT_WEBHOOK_SECRET` is configured.
  - Receiver verifies HMAC over `${timestamp}.${rawBody}` and rejects replay attempts (recommended skew window: 5 minutes).

## Development

```bash
# Run in watch mode
npm run start:dev

# Run production startup guard checks (must fail-fast on insecure env)
npm run test:prod-guards

# Run feedback optimization regression (stats + prompt optimization from feedback)
npm run test:feedback-optimization

# Run operational robustness suite (prod guards + feedback optimization + resilience + throttling abuse)
npm run test:ops

# Managed backend lifecycle (stable local runner with PID lock + health check)
npm run backend:up
npm run backend:status
npm run backend:down

# Browser regression for pipeline (requires Playwright)
npm run test:e2e-pipeline

# Format code
npm run format

# Lint
npm run lint

# Reset database
npm run db:reset
```

