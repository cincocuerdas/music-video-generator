# Backend API Reference (Local)

Base URL: `/api/v1` (same origin as the app host/proxy)

## Health

- `GET /health`

## Auth (dev/local focused)

- `POST /auth/login/dev`
- `POST /auth/refresh`
- `POST /auth/logout`
- `GET /auth/me`

## Pipeline

- `POST /jobs/pipeline/:projectId/start`
- `GET /jobs/pipeline/:projectId`
- `POST /jobs/pipeline/:projectId/cancel`

## Static Artifacts

- `GET /output/videos/<project-id>.mp4`
- `GET /output/images/...`

## Websocket/Event Notes

- The UI also consumes live updates for generated scenes/progress.
- During processing, scene previews can be streamed before final render.
