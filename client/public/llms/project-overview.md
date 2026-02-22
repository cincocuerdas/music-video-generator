# Project Overview

Music Video Generator is a full-stack app that converts a song into a video sequence:

1. Analyze lyrics into timed scenes.
2. Generate one image per scene.
3. Render a final video synced with audio.
4. Allow "director" feedback to regenerate weak scenes.

## Stack

- Frontend: React + Vite + React Router (`client/`)
- Backend: NestJS (`src/`)
- Database: PostgreSQL (Prisma)
- Queue: BullMQ + Redis
- AI/Image scripts: Python (`scripts/`)
- Local image generation: ComfyUI (optional but preferred in this project)

## Core Entities

- `Project`: source song, analysis result, generated images, final video URL.
- `Job`: pipeline stage status (`PENDING`, `PROCESSING`, `COMPLETED`, `FAILED`, `CANCELLED`).
- `analysisResult`: timed scenes, prompts, generated image metadata.

## Runtime URLs

- Frontend: app origin (environment-dependent)
- Backend API: `/api/v1` (through same-origin proxy in local/dev setup)
- Video/image artifacts: `/output/...`
