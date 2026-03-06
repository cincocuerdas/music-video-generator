# API Data Minimization Audit

> Generated: 2026-03-06
> Scope: All HTTP endpoints in projects, jobs, auth, health modules

## Critical

| # | Endpoint | Over-exposed fields | Risk | Fix |
|---|----------|-------------------|------|-----|
| 1 | `GET /projects/:id` | Full `jobs[]` with `workerId`, `inputData`, `outputData` | **CRITICAL** | Return job summary only (`{id, type, status, progress}`). Never expose `workerId` or raw `outputData`. |
| 2 | `GET /health/ops/**` (public, no auth) | `youtubeUrl`, `audioUrl`, `lyrics` from user projects; `outputData` with internal errors; `projectId` in SLO breakdown | **CRITICAL** | Add `@UseGuards(JwtAuthGuard)` to ops endpoints, or strip all user-scoped fields from aggregations. |

## High

| # | Endpoint | Over-exposed fields | Risk | Fix |
|---|----------|-------------------|------|-----|
| 3 | `GET /projects/:id/status` | `errorMessage` (may contain full stack traces), `outputData` | HIGH | Sanitize `errorMessage` (first line only). Omit raw `outputData`. |
| 4 | `GET /projects/:id/video` | Jobs' `outputData` passed through unfiltered | HIGH | Return only `{projectId, videoUrl, thumbnailUrl, status}`. |
| 5 | `GET/PATCH/DELETE /jobs/:id` | `workerId`, `inputData`, `outputData` | HIGH | Project response to `{id, projectId, type, status, progress, currentStep}`. |
| 6 | `GET /jobs/pipeline/:id` | `errorMessage` unfiltered | HIGH | Sanitize `errorMessage`. |

## Medium

| # | Endpoint | Over-exposed fields | Risk | Fix |
|---|----------|-------------------|------|-----|
| 7 | `GET /projects` (findAll) | Full project objects including `analysisResult`, `lyrics`, `audioUrl` | MEDIUM | Select only `{id, title, status, visualStyle, createdAt, updatedAt, thumbnailUrl}`. |
| 8 | `POST /projects` (create response) | Full project record returned | MEDIUM | Return `{id, title, status, createdAt}`. |
| 9 | `GET /health/ops/pipeline-slo-breakdown` | Exposes specific `projectId` + timing (correlatable to user) | MEDIUM | Anonymize — remove `projectId`, return only aggregated stats. |
| 10 | `GET /auth/me` | `claims` object (JWT payload) | MEDIUM | Verify `claims` only includes `{sub, role}` — currently safe. |

## Low (no action needed)

| Endpoint | Status |
|----------|--------|
| `POST /auth/dev-token` | OK — returns opaque token |
| `POST /auth/login/dev` | OK |
| `POST /auth/refresh` | OK |
| `POST /auth/logout` | OK |
| `POST /projects/:id/generate` | OK — returns `{id, type, status}` |
| `POST /projects/:id/cancel` | OK |
| `GET /projects/:id/download` | OK |
| `GET /health` | OK — `{status, timestamp}` only |

## Recommended Fix Priority

1. **Sanitize `errorMessage`** across all endpoints (strip to first line, remove stack traces)
2. **Stop returning `outputData`** in project status/video/job responses
3. **Project `findOne`** — don't return full jobs array, only summary
4. **Strip `workerId`** from all job responses
5. **Health ops auth** — add guard or filter user-scoped data
6. **Project list projection** — select minimal fields
7. **Anonymize pipeline-slo-breakdown** — remove `projectId`
