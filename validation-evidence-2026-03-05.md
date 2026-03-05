# Validation Evidence — 2026-03-05

## Scope
Local envelope rollout closure with backend primary on `:3000` and E2E verification.

## Changes included
1. `package.json`
- Fixed prod entrypoint:
  - from `dist/main`
  - to `dist/src/main.js`

2. `scripts/generate_images.py`
- Hardened RESULT_JSON contract in fallback/error branches:
  - `degradedReasons` always array
  - explicit `errorCode` for timeout/http/unhandled branches
  - missing project id fallback now emits explicit `success` + degraded reason
- Restored fail-safe degraded semantics for external chaos:
  - if image output exists, return useful degraded output (`success=true`) instead of failed.

3. `scripts/dev-tools/test_e2e_pipeline_playwright.js`
- Added envelope-aware API unwrap in `apiRequest()`.
- E2E script now works with both legacy and envelope backend responses.

## Runtime verification (local)
### Envelope shape (backend primary `:3000`)
- `GET /api/v1/health` (200)
```json
{"ok":true,"data":{"status":"ok","timestamp":"2026-03-05T05:51:51.171Z"},"meta":{"timestamp":"2026-03-05T05:51:51.171Z","correlationId":"req-73b976ac-324","path":"/api/v1/health"}}
```

- `GET /api/v1/auth/me` with invalid token (401)
```json
{"ok":false,"error":{"statusCode":401,"message":"Invalid or expired token"},"meta":{"timestamp":"2026-03-05T05:51:51.257Z","path":"/api/v1/auth/me","correlationId":null}}
```

- `GET /nonexistent/route` (404)
```json
{"ok":false,"error":{"statusCode":404,"message":"Cannot GET /nonexistent/route"},"meta":{"timestamp":"2026-03-05T05:51:51.373Z","path":"/nonexistent/route","correlationId":null}}
```

## E2E result
Command:
- `npm run test:e2e-pipeline`

Result:
- `seed_project=18adf574-a23d-471a-8db4-aa5c4709d6ed`
- `pipeline_status=success`
- `case_scene_sync=PASS expected=11 current=12.61`
- `case_feedback_persisted=PASS`
- `e2e_pipeline_playwright_test_status=PASS`

## Conclusion
Rollout-ready local state is validated:
- Envelope response contract active in backend primary.
- Error-path and success-path shapes are stable.
- End-to-end UI flow passes with scene seek + feedback persistence.
