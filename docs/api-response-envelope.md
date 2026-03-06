# API Response Envelope Contract

This document defines the optional response envelope contract controlled by:

`API_RESPONSE_ENVELOPE_ENABLED=true|false`

Default is `false` (legacy response shapes preserved).

## Feature Flag Behavior

- `API_RESPONSE_ENVELOPE_ENABLED=false`:
  - Success responses keep current controller return shapes.
  - Error responses keep legacy filter shape:
    - `{ statusCode, timestamp, path, correlationId, message }`

- `API_RESPONSE_ENVELOPE_ENABLED=true`:
  - Success responses are wrapped by `ResponseEnvelopeInterceptor`:
    - `{ ok: true, data, meta }`
  - Error responses are wrapped by `AllExceptionsFilter`:
    - `{ ok: false, error, meta }`

## Success Envelope

```json
{
  "ok": true,
  "data": {
    "projectId": "uuid",
    "pipelineStatus": "success"
  },
  "meta": {
    "timestamp": "2026-03-05T01:10:00.000Z",
    "correlationId": "req-abc123",
    "path": "/api/v1/jobs/pipeline/uuid"
  }
}
```

## Error Envelope

```json
{
  "ok": false,
  "error": {
    "statusCode": 401,
    "message": "Invalid or expired token"
  },
  "meta": {
    "timestamp": "2026-03-05T01:10:00.000Z",
    "correlationId": "req-abc123",
    "path": "/api/v1/projects"
  }
}
```

## Legacy Error Shape (flag disabled)

```json
{
  "statusCode": 401,
  "timestamp": "2026-03-05T01:10:00.000Z",
  "path": "/api/v1/projects",
  "correlationId": "req-abc123",
  "message": "Invalid or expired token"
}
```

## Non-Wrapped Responses

The envelope interceptor intentionally bypasses:

- `Buffer`
- `StreamableFile`
- stream-like objects (`pipe` / `on`)
- already wrapped payloads (`{ ok, data, meta }`)

This prevents breaking downloads/video streaming.

## Recommended Rollout

1. Staging: enable flag and validate critical endpoints.
2. Frontend adaptation: consume `{ ok, data, meta }` and `{ ok: false, error, meta }`.
3. Production: switch flag to `true` only after compatibility verification.

Current production rollout is documented for `Docker Compose / host` operation. Kubernetes canary remains a future-state variant only.

See [envelope-rollout-runbook.md](envelope-rollout-runbook.md) for the active rollout procedure.

## Frontend Adapter

The dual-shape adapter in `client/src/services/apiEnvelope.ts` normalizes both
envelope and legacy responses so callers always see a consistent shape:

```ts
import { unwrapData, unwrapError } from './apiEnvelope';

// Success: extracts T from { ok: true, data: T, meta } OR returns raw legacy
const projects = unwrapData<Project[]>(response.data);

// Error: normalizes { ok: false, error, meta } OR { statusCode, message, ... }
const { statusCode, message, meta } = unwrapError(error.response.data);
```
