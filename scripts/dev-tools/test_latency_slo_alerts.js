/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { getApiBaseUrl, getPostgresContainerName } = require('./test_config');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const LOG_DIR = path.join(ROOT_DIR, 'storage', 'tmp-tests');
const STDOUT_LOG = path.join(LOG_DIR, 'backend-latency-slo.out.log');
const STDERR_LOG = path.join(LOG_DIR, 'backend-latency-slo.err.log');
const API_BASE_URL = getApiBaseUrl();
const HEALTH_URL = `${API_BASE_URL}/health`;
const POSTGRES_CONTAINER = getPostgresContainerName();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function uuidv4() {
  const bytes = crypto.randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const useShell =
      typeof options.shell === 'boolean'
        ? options.shell
        : process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);

    const child = spawn(command, args, {
      cwd: ROOT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: useShell,
      ...options,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(`${command} ${args.join(' ')} failed with code ${code}`);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

function resolveNpmCommand(args) {
  if (process.platform === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', `npm ${args.join(' ')}`],
    };
  }
  return { command: 'npm', args };
}

function resolveBackendEntry() {
  const candidates = [path.join(ROOT_DIR, 'dist', 'main.js'), path.join(ROOT_DIR, 'dist', 'src', 'main.js')];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function ensureBackendBuild() {
  const forceRebuild = (process.env.TESTS_FORCE_REBUILD || '').toLowerCase() === 'true';
  const entry = resolveBackendEntry();
  if (entry && !forceRebuild) {
    console.log(`step=build_skip entry=${path.relative(ROOT_DIR, entry)}`);
    return;
  }

  console.log('step=build');
  const npmBuild = resolveNpmCommand(['run', 'build']);
  await runCommand(npmBuild.command, npmBuild.args);
}

function startBackend() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  if (fs.existsSync(STDOUT_LOG)) fs.unlinkSync(STDOUT_LOG);
  if (fs.existsSync(STDERR_LOG)) fs.unlinkSync(STDERR_LOG);

  const stdoutStream = fs.createWriteStream(STDOUT_LOG, { flags: 'a' });
  const stderrStream = fs.createWriteStream(STDERR_LOG, { flags: 'a' });

  const backendEntry = resolveBackendEntry();
  if (!backendEntry) {
    throw new Error('backend_entry_missing_after_build');
  }

  const child = spawn(process.execPath, [backendEntry], {
    cwd: ROOT_DIR,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    env: {
      ...process.env,
      ALLOW_DEV_AUTH_BYPASS: process.env.ALLOW_DEV_AUTH_BYPASS || 'true',
      USE_MOCK_PROCESSORS: process.env.USE_MOCK_PROCESSORS || 'true',
    },
  });

  child.stdout?.pipe(stdoutStream);
  child.stderr?.pipe(stderrStream);

  return { child, stdoutStream, stderrStream };
}

async function killProcessTree(pid) {
  if (!pid) {
    return;
  }

  if (process.platform === 'win32') {
    await runCommand('taskkill', ['/pid', String(pid), '/T', '/F']).catch(() => {});
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // ignore
    }
  }
}

async function apiRequestRaw(url, init = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });

    const raw = await response.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = { raw };
    }

    return { status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
}

async function apiRequest(url, init = {}, timeoutMs = 10000) {
  const result = await apiRequestRaw(url, init, timeoutMs);
  if (result.status >= 400) {
    throw new Error(`HTTP ${result.status} on ${url}: ${JSON.stringify(result.data)}`);
  }
  return result.data;
}

async function waitForHealth(attempts = 80, sleepMs = 2000) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const health = await apiRequestRaw(HEALTH_URL, {}, 3000);
      if (health.status === 200) {
        return true;
      }
    } catch {
      // retry
    }
    await sleep(sleepMs);
  }
  return false;
}

function buildAuthHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

async function createProject(token, title) {
  const project = await apiRequest(`${API_BASE_URL}/projects`, {
    method: 'POST',
    headers: buildAuthHeaders(token),
    body: JSON.stringify({
      title,
      visualStyle: 'cinematic',
      lyrics: 'latency slo seed',
      aspectRatio: '16:9',
    }),
  });
  assert(project?.id, 'missing_project_id');
  return project.id;
}

async function seedHighLatencyJobs(projectId) {
  const statements = [];
  for (let i = 0; i < 3; i += 1) {
    const jobId = uuidv4();
    const createdAtMinutesAgo = 30 + i * 2;
    statements.push(
      `INSERT INTO "Job" ("id","projectId","type","status","progress","createdAt","updatedAt") VALUES ('${jobId}'::uuid,'${projectId}'::uuid,'GENERATE_IMAGES','COMPLETED',100,NOW() - INTERVAL '${createdAtMinutesAgo} minutes',NOW() - INTERVAL '${i} minutes');`,
    );
  }

  const sql = statements.join(' ');
  await runCommand('docker', [
    'exec',
    POSTGRES_CONTAINER,
    'psql',
    '-U',
    'postgres',
    '-d',
    'musicvideo',
    '-c',
    sql,
  ]);
}

async function main() {
  let backend;
  try {
    console.log('step=deps_up');
    await runCommand('docker', ['compose', 'up', '-d', 'postgres', 'redis']);

    console.log('step=enable_pgvector');
    await runCommand('docker', [
      'exec',
      POSTGRES_CONTAINER,
      'psql',
      '-U',
      'postgres',
      '-d',
      'musicvideo',
      '-c',
      'CREATE EXTENSION IF NOT EXISTS vector;',
    ]);

    console.log('step=db_push');
    const npmDbPush = resolveNpmCommand(['run', 'db:push']);
    await runCommand(npmDbPush.command, npmDbPush.args);

    await ensureBackendBuild();

    console.log('step=backend_start');
    backend = startBackend();
    console.log(`backend_pid=${backend.child.pid}`);

    const healthy = await waitForHealth();
    assert(healthy, 'health_timeout');
    console.log('health=ok');

    const login = await apiRequest(`${API_BASE_URL}/auth/login/dev`, {
      method: 'POST',
      body: '{}',
    });
    const token = login?.accessToken;
    assert(token, 'missing_access_token');

    const projectId = await createProject(token, `Latency SLO ${Date.now()}`);
    console.log(`seed_project=${projectId}`);

    await seedHighLatencyJobs(projectId);
    console.log('step=seed_high_latency_jobs_done');

    const ops = await apiRequest(`${API_BASE_URL}/health/ops`, { method: 'GET' });
    assert(ops?.latencyAlerts && typeof ops.latencyAlerts === 'object', 'latency_alerts_missing');
    assert(
      Array.isArray(ops.latencyAlerts.alerts),
      'latency_alerts_array_missing',
    );

    const generateImagesAlert = ops.latencyAlerts.alerts.find(
      (alert) =>
        alert &&
        alert.type === 'GENERATE_IMAGES' &&
        (alert.severity === 'critical' || alert.severity === 'warning'),
    );
    assert(generateImagesAlert, 'generate_images_latency_alert_missing');
    assert(
      generateImagesAlert.severity === 'critical',
      `generate_images_alert_expected_critical_got_${generateImagesAlert.severity}`,
    );

    assert(ops.status === 'degraded', `ops_status_expected_degraded_got_${ops.status}`);

    console.log(
      `case_latency_slo_alert=PASS severity=${generateImagesAlert.severity} p95=${generateImagesAlert.p95DurationMs24h}`,
    );
    console.log('latency_slo_alerts_test_status=PASS');
  } catch (error) {
    console.error('latency_slo_alerts_test_status=FAIL');
    console.error(error?.message || error);
    process.exitCode = 1;
  } finally {
    if (backend?.child?.pid) {
      await killProcessTree(backend.child.pid);
    }
    backend?.stdoutStream?.end();
    backend?.stderrStream?.end();
  }
}

main();
