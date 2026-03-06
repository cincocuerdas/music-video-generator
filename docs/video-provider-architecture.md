# Video Provider Architecture

This document defines the future video-generation module for cloud providers such as:

- `ltx_cloud`
- `seedance_api`

The goal is to keep the current application architecture stable:

- frontend on `Vercel`
- backend/workers on `VM + Docker Compose`
- video generation as a remote provider behind a stable interface

## Goals

1. Add video providers without rewriting frontend or the main backend pipeline.
2. Keep local development usable when cloud video is disabled.
3. Prevent cost runaway with hard budget and concurrency guardrails.
4. Support fallback when a video provider fails, rate-limits, or exceeds budget.

## Non-goals

1. Running LTX or Seedance locally on the current laptop hardware.
2. Binding the main backend process to GPU-heavy runtime.
3. Building Kubernetes-specific orchestration first.

## High-level architecture

```text
Frontend (Vercel)
    |
    v
Backend API (NestJS)
    |
    v
Jobs / BullMQ
    |
    +--> Image pipeline (current)
    |
    +--> VideoProviderService
             |
             +--> ltx_cloud
             +--> seedance_api
             +--> local_stub / disabled
             +--> fallback strategy
```

## Module layout

Proposed future backend layout:

```text
src/modules/video/
  video.module.ts
  video.constants.ts
  interfaces/
    video-provider.interface.ts
  services/
    video-provider.service.ts
    video-cost-guard.service.ts
    video-fallback.service.ts
  providers/
    ltx-cloud.provider.ts
    seedance-api.provider.ts
    disabled-video.provider.ts
  dto/
    create-video-job.dto.ts
    video-provider-result.dto.ts
```

## Core interface

```ts
export type VideoProviderName =
  | "disabled"
  | "ltx_cloud"
  | "seedance_api";

export type VideoJobStatus =
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "degraded";

export interface VideoGenerationRequest {
  projectId: string;
  sceneId?: string;
  prompt: string;
  negativePrompt?: string;
  style?: string;
  durationSeconds: number;
  aspectRatio?: "16:9" | "9:16" | "1:1";
  sourceImageUrl?: string;
  sourceVideoUrl?: string;
  providerOptions?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface VideoGenerationResult {
  provider: VideoProviderName;
  modelName: string;
  status: VideoJobStatus;
  remoteJobId?: string;
  outputUrl?: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
  estimatedCostUsd?: number;
  degraded?: boolean;
  degradedReasons: string[];
  error?: string;
  raw?: Record<string, unknown>;
}

export interface VideoProvider {
  readonly name: VideoProviderName;

  estimateCost(request: VideoGenerationRequest): Promise<number>;

  submit(request: VideoGenerationRequest): Promise<VideoGenerationResult>;

  poll(remoteJobId: string): Promise<VideoGenerationResult>;

  cancel(remoteJobId: string): Promise<void>;

  isRetryableError(error: unknown): boolean;
}
```

## Orchestration service

`VideoProviderService` is the only service used by jobs/processors.

Responsibilities:

1. Resolve active provider from config.
2. Ask `VideoCostGuardService` whether the request is allowed.
3. Submit to provider.
4. Poll provider until terminal state.
5. Delegate retry/fallback decisions to `VideoFallbackService`.
6. Persist metrics:
   - provider
   - model
   - latency
   - estimated cost
   - degraded reasons

Example shape:

```ts
export class VideoProviderService {
  async generate(request: VideoGenerationRequest): Promise<VideoGenerationResult> {
    const provider = this.resolveProvider();
    await this.costGuard.assertAllowed(provider.name, request);

    try {
      const submitted = await provider.submit(request);
      return await this.waitForCompletion(provider, submitted);
    } catch (error) {
      return await this.fallbackService.handle(provider, request, error);
    }
  }
}
```

## Providers

### `ltx_cloud`

Use when:

- high-quality text-to-video or image-to-video is needed
- cost budget allows it
- provider is healthy

Expected config:

```env
VIDEO_PROVIDER=ltx_cloud
LTX_API_KEY=...
LTX_API_BASE_URL=...
LTX_DEFAULT_MODEL=ltx-2.3-fast
LTX_MAX_COST_USD_PER_JOB=12
```

### `seedance_api`

Use when:

- alternate provider is needed for redundancy or quality testing
- LTX is unavailable or cost-blocked

Expected config:

```env
VIDEO_PROVIDER=seedance_api
SEEDANCE_API_KEY=...
SEEDANCE_API_BASE_URL=...
SEEDANCE_DEFAULT_MODEL=seedance-2.0
SEEDANCE_MAX_COST_USD_PER_JOB=12
```

### `disabled`

Use when:

- cloud video is not configured
- local/dev environments should not attempt remote billing

Behavior:

- return `failed` or `degraded` with a clear reason
- never block the rest of the application startup

## Fallback strategy

`VideoFallbackService` decides what to do when the primary provider fails.

Priority order:

1. retry same provider if error is transient
2. switch to secondary provider if enabled and allowed by budget
3. degrade to current image+render pipeline
4. fail clearly if no safe fallback exists

Example policy:

```text
ltx_cloud transient failure
  -> retry with backoff
  -> if still failing, try seedance_api
  -> if unavailable, fall back to image slideshow render
```

### Retry policy

- max attempts per provider: `2` or `3`
- exponential backoff with jitter
- respect provider `429` cooldowns
- mark degraded if fallback provider is used

## Cost guardrails

`VideoCostGuardService` should hard-block unsafe requests before billing happens.

### Guardrails

1. Max cost per job
2. Max cost per project
3. Max daily cost
4. Max monthly cost
5. Max concurrent cloud video jobs
6. Provider cooldown after repeated failures or rate limits

Example config:

```env
VIDEO_MAX_COST_USD_PER_JOB=12
VIDEO_MAX_COST_USD_PER_PROJECT=30
VIDEO_MAX_COST_USD_PER_DAY=50
VIDEO_MAX_COST_USD_PER_MONTH=500
VIDEO_MAX_CONCURRENT_JOBS=2
VIDEO_PROVIDER_FAIL_COOLDOWN_MS=300000
VIDEO_SECONDARY_PROVIDER=seedance_api
VIDEO_FALLBACK_MODE=image_render
```

### Decision examples

- estimated job cost is `$14` and limit is `$12` -> reject before submit
- month budget exceeded -> degrade to existing image+render pipeline
- provider hit with repeated `429` -> temporary cooldown and fallback

## Persistence and metrics

Add provider-level tracking for each video job.

Suggested fields:

- `videoProvider`
- `videoModel`
- `videoRemoteJobId`
- `videoStatus`
- `videoEstimatedCostUsd`
- `videoDegraded`
- `videoDegradedReasons`
- `videoLatencyMs`

Operational metrics:

- cost per video
- cost per minute of output
- success rate by provider
- degraded rate by provider
- fallback usage rate
- p50/p95 provider latency

## Job integration

There are two valid future integration modes.

### Mode A: new pipeline stage

```text
YOUTUBE_DOWNLOAD
TRANSCRIPTION
ANALYZE_LYRICS
GENERATE_IMAGES
GENERATE_VIDEO_CLIPS
RENDER_VIDEO
FINALIZE
```

Use this if the provider generates scene-level clips.

### Mode B: alternate render branch

```text
ANALYZE_LYRICS
GENERATE_IMAGES
RENDER_VIDEO
  or
GENERATE_CLOUD_VIDEO
FINALIZE
```

Use this if one provider generates the full output directly.

For this application, `Mode A` is safer because it preserves the current scene-based architecture.

## Failure semantics

Map provider failures into the same contract style already used in the app.

Examples:

- `status=completed`
- `status=degraded` when fallback provider or image-render fallback is used
- `status=failed` when no useful output can be produced

Never report `success` if the provider output was silently replaced by a lower-quality fallback.

## Recommended phased rollout

### Phase 1

- implement interfaces and `disabled` provider
- wire config and guardrails
- no production traffic

### Phase 2

- add `ltx_cloud`
- allow internal test jobs only
- collect cost and latency metrics

### Phase 3

- add `seedance_api` as secondary provider
- enable fallback chain

### Phase 4

- expose product-level option only if unit economics are acceptable

## Recommendation for this app

Use:

- `Vercel` for frontend
- `VM + Docker Compose` for backend, jobs, Redis, Postgres
- remote cloud provider for heavy video generation

Do not:

- run LTX or Seedance on the same general-purpose VM unless it is intentionally provisioned with the required GPU tier
- entangle video provider billing logic directly inside frontend flows

## Decision checklist before implementation

Implement cloud video only if all answers are `yes`:

1. Do we have a cost ceiling per video?
2. Do we have a fallback path when the provider fails?
3. Do we have provider metrics and alerts?
4. Do we know whether the product can absorb the marginal cost?
5. Do we want scene-level clips or full-video generation?
