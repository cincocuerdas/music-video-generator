# Dev Tools

Scripts moved from project root to keep the repository clean.

- `test_config.js`: shared config resolver for dev-tools JS scripts (`API_BASE_URL`, Redis/Postgres container names, prod-guard base env, Redis connection options).
- `clear_projects.js`: wipes `project` and `job` tables (dev only).
- `check_user_and_today.js`: checks default user and today's projects.
- `seed_user.js`: upserts the default local dev user.
- `test_full_workflow.js`: local workflow smoke check with Prisma/BullMQ.
- `test_resilience.js`: Redis resilience e2e (Redis down/up + pipeline recovery).
- `test_throttling.js`: endpoint abuse e2e (`429` expected on create/start/feedback limits).
- `test_prod_guards.js`: production startup guard checks (must fail-fast on weak/missing secrets/config).
- `test_repo_hygiene.js`: root hygiene check (fails if known stray/debug files reappear at repo root).
- `test_secret_hygiene.js`: secret leakage check (token patterns + sensitive env assignments in tracked files).
- `test_bullmq_retries.js`: BullMQ retry regression (transient failure retries and permanent failure exhausts attempts).
- `test_auth_throttling.js`: auth rate-limit regression for `auth/dev-token`, `auth/login/dev`, `auth/refresh`, `auth/logout`, and `auth/me`.
- `test_envelope_contract.js`: integration contract for API response shape in both legacy and envelope modes (`API_RESPONSE_ENVELOPE_ENABLED=false|true`) for success and error paths.
- `test_pipeline_status.js`: regression for derived pipeline status projection (`success|degraded|failed`) across `/projects/:id/status`, `/projects/:id/video`, and `/jobs/pipeline/:id`.
- `test_feedback_optimization.js`: regression for feedback stats + prompt optimization boosts from seeded likes/dislikes.
- `test_ops_prepare.js`: deterministic test preflight (kills stale listeners on configured ports before integration tests).
- `backend_runtime.js`: managed backend lifecycle runner (`up|down|status`) with PID lock and health check.
- `test_pipeline_script_contract.js`: contract test for entry scripts (`youtube_download.py`, `transcribe_audio.py`) to ensure fail-safe `RESULT_JSON` with exit code `0` even on invalid input.
- `test_e2e_pipeline_playwright.js`: browser E2E regression (project create -> pipeline complete -> scene seek sync -> feedback persistence).
- `benchmark_generate_images_concurrency.js`: benchmark harness for image-generation stage concurrency (p50/p95 + recommendation report).
- `benchmark_update_history.js`: appends latest benchmark result to rolling history (`ndjson` + markdown).
- `benchmark_assert_slo.js`: validates benchmark SLO thresholds and p95 regression window.
- `run_fire_drill.js`: executes outage recovery scenarios (Redis, Postgres restart, external dependency degradation) and writes recovery-time report.
- `cleanup_retention.js`: retention cleanup for old jobs/sessions and stale artifacts under `output/` + `storage/tmp-tests` (supports dry-run).
- `pre_push_guard.js`: critical fast checks used by local `pre-push` hook.
- `pre_push_full_guard.js`: full `test:ops` execution for release-grade local push gate.
- `projects.service.spec.ts`: unit regression for embedding prompt optimization (style-scoped similarity query and single fallback behavior).
- `test_analysis.py`: legacy lyrics analysis test helper.
- `hello_world.py`: minimal Python runner sanity check.
- `python_runner_result_contract.py`: helper script used by `python-runner.integration.spec.ts` to validate `RESULT_JSON` parsing/fallback.
- `redis-client.service.spec.ts`: unit regression for Redis client behavior (lazy connect, error/reconnect throttling, release semantics).
- `quitar_fondo.py`: ad-hoc local image cleanup helper.
- `query.sql`: manual SQL scratch file for local diagnostics.

Run from repo root, e.g.:

```bash
node scripts/dev-tools/clear_projects.js
node scripts/dev-tools/seed_user.js
npm run test:resilience
npm run test:throttling
npm run test:prod-guards
npm run test:repo-hygiene
npm run test:secret-hygiene
npm run test:python-runner-contract
npm run test:health-ops
npm run test:envelope-contract
npm run test:redis-client
npm run test:bullmq-retries
npm run test:auth-throttling
npm run test:pipeline-status
npm run test:feedback-optimization
npm run test:projects-optimization
npm run test:pipeline-script-contract
npm run test:ops:prepare
npm run backend:up
npm run backend:status
npm run backend:down
npm run test:e2e-pipeline
npm run bench:image-generation-concurrency
npm run bench:image-generation-history
npm run bench:image-generation-slo
npm run bench:image-generation-full
npm run drill:fire
npm run ops:cleanup
npm run test:pre-push-guard
npm run test:pre-push-full
npm run test:ops
```

Useful env vars for these scripts:

- `API_BASE_URL`
- `FRONTEND_BASE_URL`
- `E2E_PIPELINE_TIMEOUT_MS`
- `RESILIENCE_POSTGRES_CONTAINER`
- `RESILIENCE_REDIS_CONTAINER`
- `TEST_OPS_CLEAN_PORTS`
- `PROD_GUARD_*` (optional overrides for production guard scenarios)
## Summarize source helper
- `summarize_source.js`: wraps `@steipete/summarize` and writes JSON output under `output/summaries/`.
- `audit_scene_with_smolvlm.py`: optional visual QA helper using `HuggingFaceTB/SmolVLM2-500M-Video-Instruct`; writes JSON output under `output/audit/smolvlm/`.
- `audit_binary_with_smolvlm.py`: optional yes/no/unclear scene checker using `HuggingFaceTB/SmolVLM2-500M-Video-Instruct`; better for simple per-scene verification than full semantic audits.
- Safe default mode is `extract` (no LLM key required).
- Use `--mode summary` when `GEMINI_API_KEY`, `OPENAI_API_KEY`, or another supported provider key is configured.
- `agent-scripts` was intentionally not integrated as a runtime dependency because there is no stable npm package to pin; treat it as a reference repo, not an application dependency.
- SmolVLM dependencies are intentionally isolated in `scripts/dev-tools/requirements-smolvlm.txt`; do not add them to the main Python environment unless you want local visual QA.
