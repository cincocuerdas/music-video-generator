# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY prisma ./prisma
RUN npm run db:generate
COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
COPY requirements.txt ./
RUN npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV NODE_OPTIONS=--max-old-space-size=4096

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg curl \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/scripts ./scripts
COPY package.json package-lock.json ./

RUN mkdir -p /app/output /app/storage /app/logs \
  && chown -R node:node /app

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3000/api/v1/health || exit 1

CMD ["node", "dist/main.js"]
