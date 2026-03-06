# Cloud Deployment Prep — Vercel + VM/Docker Compose

> Status: **planning** — no infrastructure changes made yet.
> Target architecture: Frontend on Vercel, API + workers on VM with Docker Compose.

---

## Architecture Overview

```
┌─────────────────┐       HTTPS        ┌──────────────────────────────┐
│   Vercel CDN    │ ──────────────────▶ │  VM (Docker Compose)         │
│  (React SPA)    │                     │                              │
│                 │                     │  ┌──────────────────────┐   │
│  - Static build │                     │  │ NestJS API (port 3000)│   │
│  - CSP headers  │                     │  └──────────┬───────────┘   │
│  - Proxy /api/* │                     │             │               │
│    → VM origin  │                     │  ┌──────────▼───────────┐   │
└─────────────────┘                     │  │ PostgreSQL (pgvector) │   │
                                        │  └──────────────────────┘   │
                                        │  ┌──────────────────────┐   │
                                        │  │ Redis (BullMQ)        │   │
                                        │  └──────────────────────┘   │
                                        │  ┌──────────────────────┐   │
                                        │  │ Python workers        │   │
                                        │  │ (generate_images.py)  │   │
                                        │  └──────────────────────┘   │
                                        └──────────────────────────────┘
```

---

## Environment Variable Separation

### Tier 1: Local development (current `.env`)

```env
NODE_ENV=development
HOST=127.0.0.1
PORT=3000
CORS_ORIGIN=http://localhost:5173
ALLOW_DEV_AUTH_BYPASS=false
USE_MOCK_PROCESSORS=false
SWAGGER_ENABLED=true
HELMET_ENABLED=true
API_RESPONSE_ENVELOPE_ENABLED=true
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/musicvideo
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_REQUIRE_PASSWORD=false
IMAGE_PROVIDER=gemini
```

### Tier 2: Cloud-hybrid (VM with Docker Compose)

```env
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
CORS_ORIGIN=https://your-app.vercel.app
ALLOW_DEV_AUTH_BYPASS=false
USE_MOCK_PROCESSORS=false
SWAGGER_ENABLED=false
HELMET_ENABLED=true
API_RESPONSE_ENVELOPE_ENABLED=true

# Database — same VM, internal Docker network
DATABASE_URL=postgresql://mvg_admin:STRONG_PASSWORD@postgres:5432/musicvideo

# Redis — same VM, internal Docker network
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_REQUIRE_PASSWORD=true
REDIS_PASSWORD=STRONG_REDIS_PASSWORD

# Auth — MUST change from dev defaults
JWT_SECRET=GENERATE_RANDOM_64_CHAR
JWT_REFRESH_SECRET=GENERATE_RANDOM_64_CHAR
JWT_REFRESH_TOKEN_PEPPER=GENERATE_RANDOM_64_CHAR
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d

# AI providers
GEMINI_API_KEY=real_key_here
IMAGE_PROVIDER=gemini
GEMINI_IMAGE_MODEL=gemini-3-pro-image-preview

# Sentry (optional)
SENTRY_DSN=https://xxx@sentry.io/yyy
SENTRY_TRACES_SAMPLE_RATE=0.1
```

### Tier 3: Future — dedicated video provider (LTX/Seedance)

```env
# Add when ready — DO NOT implement yet
# VIDEO_PROVIDER=ltx
# LTX_API_URL=https://...
# LTX_API_KEY=...
# SEEDANCE_API_URL=https://...
# SEEDANCE_API_KEY=...
```

---

## Deployment Checklist

### Pre-deploy (one-time setup)

- [ ] Provision VM (Ubuntu 22.04+ recommended, 4GB+ RAM, 50GB+ disk)
- [ ] Install Docker Engine + Docker Compose v2
- [ ] Clone repo to `/opt/musicvideo/`
- [ ] Copy `.env.production` from `.env.example`, fill real values
- [ ] Generate secrets: `openssl rand -base64 48` for JWT_SECRET, JWT_REFRESH_SECRET, JWT_REFRESH_TOKEN_PEPPER
- [ ] Generate DB password: `openssl rand -base64 32`
- [ ] Generate Redis password: `openssl rand -base64 32`
- [ ] Install Python 3.11+ and pip dependencies (`pip install -r requirements.txt`)
- [ ] Install FFmpeg (`apt install ffmpeg`)
- [ ] Create Vercel project and connect to frontend repo/subdirectory
- [ ] Configure Vercel environment variable `VITE_API_BASE_URL=https://api.yourdomain.com`
- [ ] Set up DNS: `api.yourdomain.com` → VM IP
- [ ] Set up TLS certificate (Let's Encrypt / Caddy / nginx with certbot)

### Deploy (each release)

- [ ] `git pull` on VM
- [ ] `docker compose up -d postgres redis` (if not running)
- [ ] `npx prisma migrate deploy` (run migrations)
- [ ] `npm run build` (compile NestJS)
- [ ] `npm run start:prod` (or use PM2 / systemd)
- [ ] Verify: `curl https://api.yourdomain.com/api/v1/health`
- [ ] Deploy frontend: `vercel --prod` (or auto-deploy on push)
- [ ] Verify: open app, create project, start pipeline

### Post-deploy validation

- [ ] `/api/v1/health` returns `{ status: 'ok' }`
- [ ] Swagger is NOT accessible (`/api/docs` → 404)
- [ ] `persistAuthorization` is disabled
- [ ] CORS only allows Vercel origin
- [ ] CSP headers present (check via browser DevTools → Network → Response Headers)
- [ ] Auth flow works (login → create project → generate → view)
- [ ] Redis queue processing (check `/api/v1/health/ops` or logs)
- [ ] No dev endpoints accessible (`/auth/dev-token` → 403 in production)

### Security hardening

- [ ] Firewall: only ports 80, 443 open externally
- [ ] PostgreSQL and Redis listen on Docker internal network only (127.0.0.1 bind)
- [ ] `no-new-privileges` set in docker-compose (already done)
- [ ] `mem_limit` set for containers (already done)
- [ ] Rate limiting active (Throttle decorators already in place)
- [ ] HSTS enabled via reverse proxy
- [ ] Log rotation configured

---

## Docker Compose — Production Overlay

When ready, add a `docker-compose.prod.yml` overlay:

```yaml
# docker-compose.prod.yml — use with: docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
services:
  postgres:
    ports: []  # remove host binding, internal only
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}

  redis:
    ports: []  # remove host binding, internal only
    environment:
      REDIS_REQUIRE_PASSWORD: "true"
      REDIS_PASSWORD: ${REDIS_PASSWORD}
```

---

## What NOT to do yet

- Do NOT implement LTX/Seedance video providers
- Do NOT move to managed database (RDS/Cloud SQL) — Docker Compose is sufficient for MVP
- Do NOT add Kubernetes — single VM is the right scale
- Do NOT add CI/CD pipeline — manual deploy until traffic justifies it
