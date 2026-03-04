#!/usr/bin/env node
/**
 * smoke_baseline_real.js
 *
 * Real (non-mock) smoke test that runs one or more songs through the full
 * pipeline and records baseline timing/quality metrics.
 *
 * Usage:
 *   node scripts/dev-tools/smoke_baseline_real.js [youtubeUrl]
 *   node scripts/dev-tools/smoke_baseline_real.js url1 url2 url3
 *   node scripts/dev-tools/smoke_baseline_real.js --runs 3
 *   node scripts/dev-tools/smoke_baseline_real.js --runs 2 urlA urlB
 *
 * --runs N   Run N projects sequentially.  If fewer URLs are provided than
 *            N, the built-in DEFAULT_URLS list fills the remaining slots.
 *
 * Requirements:
 *   - Backend running with USE_MOCK_PROCESSORS=false
 *   - Redis, PostgreSQL, Python env with Whisper, Gemini/ComfyUI configured
 *
 * Outputs:
 *   - Console metrics summary (per run + aggregate)
 *   - output/baseline_metrics.json (persisted for future comparison)
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────────────

const getTestConfig = (() => {
  try {
    const mod = require('./test_config');
    if (typeof mod.getTestConfig === 'function') return mod.getTestConfig;
  } catch {
    // no test_config module – fine
  }
  return () => ({
    apiBaseUrl: process.env.API_BASE_URL || 'http://localhost:3000/api/v1',
  });
})();

const config = getTestConfig();
const API = config.apiBaseUrl;

const DEFAULT_URLS = [
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',   // Rick Astley – Never Gonna Give You Up
  'https://www.youtube.com/watch?v=9bZkp7q19f0',   // PSY – Gangnam Style
  'https://www.youtube.com/watch?v=kJQP7kiw5Fk',   // Luis Fonsi – Despacito
];

// ── CLI argument parsing ────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  let runs = 1;
  const urls = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--runs' && args[i + 1]) {
      runs = Math.max(1, parseInt(args[++i], 10) || 1);
    } else if (!args[i].startsWith('--')) {
      urls.push(args[i]);
    }
  }

  // If --runs N but fewer URLs, fill from DEFAULT_URLS round-robin
  if (urls.length === 0 && runs === 1) {
    urls.push(DEFAULT_URLS[0]);
  }
  while (urls.length < runs) {
    urls.push(DEFAULT_URLS[urls.length % DEFAULT_URLS.length]);
  }

  return { runs: Math.max(runs, urls.length), urls: urls.slice(0, Math.max(runs, urls.length)) };
}

const PARSED = parseArgs(process.argv);

const POLL_INTERVAL_MS = 5_000;
const MAX_WAIT_MS = 45 * 60 * 1000; // 45 min max per run
const OUTPUT_DIR = path.join(__dirname, '..', '..', 'output');
const BASELINE_FILE = path.join(OUTPUT_DIR, 'baseline_metrics.json');

// ── HTTP helpers ────────────────────────────────────────────────────────────

function request(method, urlStr, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const payload = body ? JSON.stringify(body) : undefined;
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

    const req = lib.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          try {
            resolve({ status: res.statusCode, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode, data: raw });
          }
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * request() with automatic retry on ECONNREFUSED / ECONNRESET.
 * Useful when the backend briefly restarts mid-pipeline.
 */
async function requestWithRetry(method, urlStr, body, token, retries = 3, delayMs = 3000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await request(method, urlStr, body, token);
    } catch (err) {
      const isTransient =
        err &&
        (err.code === 'ECONNREFUSED' ||
          err.code === 'ECONNRESET' ||
          err.code === 'ETIMEDOUT' ||
          err.code === 'EPIPE');
      if (isTransient && attempt < retries) {
        console.log(`  ⚠ Connection lost (${err.code}), retry ${attempt}/${retries} in ${delayMs / 1000}s...`);
        await sleep(delayMs);
        continue;
      }
      throw err;
    }
  }
}

// ── Single pipeline run ─────────────────────────────────────────────────────

async function runPipeline(youtubeUrl, runIndex, totalRuns, token) {
  const label = totalRuns > 1 ? ` [${runIndex}/${totalRuns}]` : '';

  const metrics = {
    youtubeUrl,
    startedAt: new Date().toISOString(),
    stages: {},
    totalDurationMs: 0,
    finalStatus: 'unknown',
    errors: [],
  };

  try {
    // Create project
    console.log(`${label} Creating project (url: ${youtubeUrl})...`);
    const project = await request(
      'POST',
      `${API}/projects`,
      { title: `Smoke Baseline ${new Date().toISOString()}`, youtubeUrl, visualStyle: 'cinematic' },
      token,
    );
    if (!project.data?.id) {
      console.error(`${label}  ? Project creation failed:`, JSON.stringify(project.data));
      metrics.finalStatus = 'failed';
      metrics.errors.push(`Project creation failed: ${JSON.stringify(project.data)}`);
      return metrics;
    }
    const projectId = project.data.id;
    console.log(`${label}  ? Project ${projectId}`);

    // Start pipeline
    console.log(`${label} Starting pipeline...`);
    const start = await request('POST', `${API}/jobs/pipeline/${projectId}/start`, null, token);
    if (start.status >= 400) {
      console.error(`${label}  ? Pipeline start failed:`, JSON.stringify(start.data));
      metrics.finalStatus = 'failed';
      metrics.errors.push(`Pipeline start failed: ${JSON.stringify(start.data)}`);
      return metrics;
    }
    console.log(`${label}  ? Pipeline started`);

    // Poll until done
    console.log(`${label} Polling pipeline status...\n`);
    const pipelineStart = Date.now();
    let lastStage = '';
    let stageStartTs = Date.now();

    while (Date.now() - pipelineStart < MAX_WAIT_MS) {
      const poll = await requestWithRetry('GET', `${API}/jobs/pipeline/${projectId}`, null, token, 5, 5000);
      const pipelineStatus = poll.data?.pipelineStatus || poll.data?.status || 'unknown';
      // Derive current stage from currentJob or the active job in the jobs array
      const activeJob = poll.data?.currentJob || (poll.data?.jobs || []).find((j) => j.status === 'PROCESSING');
      const currentStage = activeJob?.type || poll.data?.currentStage || poll.data?.currentStep || '';
      const progress = poll.data?.overallProgress ?? poll.data?.progress ?? '?';
      const isDegraded = !!poll.data?.degraded;

      if (currentStage && currentStage !== lastStage) {
        const now = Date.now();
        if (lastStage) {
          metrics.stages[lastStage] = {
            durationMs: now - stageStartTs,
            durationSec: Math.round((now - stageStartTs) / 1000),
          };
        }
        lastStage = currentStage;
        stageStartTs = now;
        console.log(`${label}  ? Stage: ${currentStage} (progress: ${progress}%)`);
      }

      // "degraded" means pipeline completed but with quality warnings (e.g. Korean subtitles)
      if (['completed', 'done', 'success', 'degraded'].includes(pipelineStatus)) {
        const totalMs = Date.now() - pipelineStart;
        if (lastStage) {
          metrics.stages[lastStage] = {
            durationMs: Date.now() - stageStartTs,
            durationSec: Math.round((Date.now() - stageStartTs) / 1000),
          };
        }
        metrics.totalDurationMs = totalMs;
        metrics.finalStatus = 'completed';
        metrics.degraded = isDegraded;
        if (isDegraded) {
          metrics.degradedReasons = poll.data?.degradedReasons || [];
        }
        const degradedTag = isDegraded ? ' (degraded)' : '';
        console.log(`${label}\n  ? Pipeline completed${degradedTag} in ${Math.round(totalMs / 1000)}s`);
        break;
      }

      if (['failed', 'error', 'dead_letter'].includes(pipelineStatus)) {
        const totalMs = Date.now() - pipelineStart;
        metrics.totalDurationMs = totalMs;
        metrics.finalStatus = 'failed';
        metrics.errors.push(poll.data?.error || poll.data?.message || 'Unknown failure');
        console.error(`${label}\n  ? Pipeline failed after ${Math.round(totalMs / 1000)}s`);
        console.error(`${label}    Error: ${metrics.errors[0]}`);
        break;
      }

      await sleep(POLL_INTERVAL_MS);
    }

    if (metrics.finalStatus === 'unknown') {
      metrics.finalStatus = 'timeout';
      metrics.totalDurationMs = MAX_WAIT_MS;
      console.error(`${label}\n  ? Pipeline timed out after ${MAX_WAIT_MS / 1000}s`);
    }
  } catch (error) {
    metrics.finalStatus = 'failed';
    metrics.totalDurationMs = 0;
    metrics.errors.push(error instanceof Error ? error.message : String(error));
    console.error(`${label}  ? Run crashed with unhandled error: ${metrics.errors[0]}`);
  }

  metrics.finishedAt = new Date().toISOString();
  return metrics;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { runs, urls } = PARSED;

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  SMOKE BASELINE — Real Pipeline (USE_MOCK_PROCESSORS=false)  ║');
  if (runs > 1) {
    console.log(`║  Runs: ${String(runs).padEnd(51)}║`);
  }
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // 1. Health check
  console.log('[1] Health check...');
  const health = await request('GET', `${API}/health`);
  if (health.status !== 200) {
    console.error('  ✗ Health check failed. Is the backend running with USE_MOCK_PROCESSORS=false?');
    process.exit(1);
  }
  console.log('  ✓ Backend healthy\n');

  // 2. Auth
  console.log('[2] Obtaining dev token...');
  const auth = await request('POST', `${API}/auth/login/dev`, {
    userId: '00000000-0000-4000-8000-000000000001',
  });
  if (!auth.data?.accessToken) {
    console.error('  ✗ Failed to obtain token:', JSON.stringify(auth.data));
    process.exit(1);
  }
  const token = auth.data.accessToken;
  console.log('  ✓ Token acquired\n');

  // 3. Run pipelines sequentially
  const allMetrics = [];
  const globalStart = Date.now();

  for (let i = 0; i < urls.length; i++) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  RUN ${i + 1}/${urls.length} — ${urls[i]}`);
    console.log(`${'═'.repeat(60)}\n`);

    const metrics = await runPipeline(urls[i], i + 1, urls.length, token);
    allMetrics.push(metrics);

    // Brief pause between runs to let BullMQ settle
    if (i < urls.length - 1) {
      console.log('\n  ⏳ Cooling down 10s before next run...\n');
      await sleep(10_000);
    }
  }

  const globalMs = Date.now() - globalStart;

  // 4. Aggregate report
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  AGGREGATE RESULTS');
  console.log(`${'═'.repeat(60)}\n`);

  const completed = allMetrics.filter((m) => m.finalStatus === 'completed').length;
  const failed = allMetrics.filter((m) => m.finalStatus === 'failed').length;
  const timedOut = allMetrics.filter((m) => m.finalStatus === 'timeout').length;

  console.log('┌─────────────────────────────────────────────────┐');
  console.log(`│  Total Runs   : ${String(urls.length).padEnd(32)}│`);
  console.log(`│  Completed    : ${String(completed).padEnd(32)}│`);
  console.log(`│  Failed       : ${String(failed).padEnd(32)}│`);
  console.log(`│  Timed Out    : ${String(timedOut).padEnd(32)}│`);
  console.log(`│  Total Time   : ${String(Math.round(globalMs / 1000) + 's').padEnd(32)}│`);
  console.log('├─────────────────────────────────────────────────┤');

  for (let i = 0; i < allMetrics.length; i++) {
    const m = allMetrics[i];
    const dur = Math.round(m.totalDurationMs / 1000);
    const status = m.finalStatus === 'completed' ? '✓' : '✗';
    const shortUrl = m.youtubeUrl.replace('https://www.youtube.com/watch?v=', '');
    const degradedTag = m.degraded ? ' ⚠deg' : '';
    console.log(`│  ${status} Run ${i + 1} (${shortUrl.substring(0, 11).padEnd(11)}): ${String(dur + 's').padEnd(8)} ${(m.finalStatus + degradedTag).padEnd(12)}│`);

    for (const [stage, data] of Object.entries(m.stages)) {
      console.log(`│    ${stage.padEnd(14)}: ${String(data.durationSec + 's').padEnd(31)}│`);
    }
    if (m.errors.length) {
      for (const err of m.errors) {
        console.log(`│    ERR: ${String(err).substring(0, 38).padEnd(38)}│`);
      }
    }
  }
  console.log('└─────────────────────────────────────────────────┘');

  // 5. Persist baseline
  try {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    let history = [];
    if (fs.existsSync(BASELINE_FILE)) {
      try {
        const existing = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf-8'));
        history = Array.isArray(existing) ? existing : [existing];
      } catch {
        history = [];
      }
    }
    // Push each run as a separate entry
    for (const m of allMetrics) history.push(m);
    if (history.length > 50) history = history.slice(-50);
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(history, null, 2));
    console.log(`\n  Baseline saved to: ${BASELINE_FILE}`);
  } catch (writeErr) {
    console.warn(`  ⚠ Could not persist baseline: ${writeErr.message}`);
  }

  const exitCode = failed + timedOut === 0 ? 0 : 1;
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

