# README Extract (Operational Notes)

## Prerequisites

- Node.js 20+
- Python 3.11+
- PostgreSQL 15+
- Redis 7+

## Quick Start Summary

1. Configure `.env`.
2. Initialize DB with Prisma.
3. Start backend (`npm run start:dev`).
4. Start frontend (`npm --prefix client run dev`).

## Relevant Python Scripts

- `scripts/youtube_download.py`
- `scripts/transcribe_audio.py`
- `scripts/analyze_lyrics.py`
- `scripts/generate_images.py`
- `scripts/render_video.py`

## Typical Status Flows

- Project: `DRAFT -> PROCESSING -> COMPLETED` (or `FAILED` / `CANCELLED`)
- Job: `PENDING -> PROCESSING -> COMPLETED` (or `FAILED` / `CANCELLED`)
