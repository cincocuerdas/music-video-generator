/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { createHmac } = require('crypto');
const { spawn } = require('child_process');
const { getApiBaseUrl, getPostgresContainerName } = require('./test_config');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const LOG_DIR = path.join(ROOT_DIR, 'storage', 'tmp-tests');
const STDOUT_LOG = path.join(LOG_DIR, 'backend-health-webhook-receiver.out.log');
const STDERR_LOG = path.join(LOG_DIR, 'backend-health-webhook-receiver.err.log');
const API_BASE_URL = getApiBaseUrl();
const HEALTH_URL = `${API_BASE_URL}/health`;
const RECEIVER_URL = `${API_BASE_URL}/webhooks/health-alert`;
const POSTGRES_CONTAINER = getPostgresContainerName();

const RECEIVER_SECRET =
  process.env.HEALTH_WEBHOOK_RECEIVER_TEST_SECRET || 'receiver-test-health-webhook-secret';
const MAX_SKEW_SEC = Number(process.env.HEALTH_WEBHOOK_RECEIVER_TEST_MAX_SKEW_SEC || '300');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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
      HEALTH_WEBHOOK_RECEIVER_SECRET: RECEIVER_SECRET,
      HEALTH_WEBHOOK_RECEIVER_MAX_SKEW_SEC: String(MAX_SKEW_SEC),
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

async function waitForHealth(attempts = 60, sleepMs = 2000) {
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

function buildSignedWebhookBody(payload, timestampSec) {
  const rawBody = JSON.stringify(payload);
  const signature = createHmac('sha256', RECEIVER_SECRET)
    .update(`${timestampSec}.${rawBody}`)
    .digest('hex');
  return {
    rawBody,
    timestampSec,
    signature: `sha256=${signature}`,
  };
}

async function postWebhook(payload, timestampSec, signatureOverride) {
  const signed = buildSignedWebhookBody(payload, timestampSec);
  const signature = signatureOverride || signed.signature;
  return apiRequestRaw(
    RECEIVER_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-MVG-Webhook-Timestamp': String(timestampSec),
        'X-MVG-Webhook-Signature': signature,
      },
      body: signed.rawBody,
    },
    5000,
  );
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

    const nowSec = Math.floor(Date.now() / 1000);
    const payload = {
      event: 'pipeline_degraded_alert',
      environment: 'test',
      timestamp: new Date().toISOString(),
      windowHours: 1,
      status: 'degraded',
    };

    const valid = await postWebhook(payload, nowSec);
    assert(valid.status === 201, `expected_valid_webhook_201_got_${valid.status}`);
    assert(valid.data?.ok === true, 'expected_valid_response_ok_true');
    console.log('case_valid_signature=PASS');

    const replay = await postWebhook(payload, nowSec);
    assert(replay.status === 409, `expected_replay_409_got_${replay.status}`);
    console.log('case_replay=PASS');

    const invalidSignature = await postWebhook(
      payload,
      nowSec + 1,
      'sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    assert(
      invalidSignature.status === 401,
      `expected_invalid_signature_401_got_${invalidSignature.status}`,
    );
    console.log('case_invalid_signature=PASS');

    const stale = await postWebhook(payload, nowSec - (MAX_SKEW_SEC + 5));
    assert(stale.status === 401, `expected_stale_timestamp_401_got_${stale.status}`);
    console.log('case_stale_timestamp=PASS');

    console.log('health_webhook_receiver_test_status=PASS');
  } catch (error) {
    console.error('health_webhook_receiver_test_status=FAIL');
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
