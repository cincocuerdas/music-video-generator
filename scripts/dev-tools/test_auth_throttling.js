/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getApiBaseUrl, getPostgresContainerName, enablePgvectorExtension, unwrapEnvelope } = require('./test_config');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const LOG_DIR = path.join(ROOT_DIR, 'storage', 'tmp-tests');
const STDOUT_LOG = path.join(LOG_DIR, 'backend-auth-throttling.out.log');
const STDERR_LOG = path.join(LOG_DIR, 'backend-auth-throttling.err.log');
const API_BASE_URL = getApiBaseUrl();
const HEALTH_URL = `${API_BASE_URL}/health`;
const POSTGRES_CONTAINER = getPostgresContainerName();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function apiRequestRawWithRetry(
  url,
  init = {},
  {
    timeoutMs = 12000,
    retries = 2,
    retryDelayMs = 250,
  } = {},
) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await apiRequestRaw(url, init, timeoutMs);
    } catch (error) {
      lastError = error;
      const isAbort = error?.name === 'AbortError' || /aborted/i.test(error?.message || '');
      const isLast = attempt >= retries;
      if (!isAbort || isLast) {
        throw error;
      }
      await sleep(retryDelayMs * (attempt + 1));
    }
  }
  throw lastError;
}

async function waitForHealth(attempts = 80, sleepMs = 2000) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const health = await apiRequestRaw(HEALTH_URL, {}, 3000);
      if (health.status === 200) {
        return true;
      }
    } catch {
      // keep retrying
    }
    await sleep(sleepMs);
  }
  return false;
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
      NODE_ENV: process.env.NODE_ENV || 'development',
      ALLOW_DEV_AUTH_BYPASS: process.env.ALLOW_DEV_AUTH_BYPASS || 'true',
      THROTTLE_TTL_MS: process.env.THROTTLE_TTL_MS || '60000',
      THROTTLE_AUTH_DEV_TOKEN_LIMIT:
        process.env.THROTTLE_AUTH_DEV_TOKEN_LIMIT || '8',
      THROTTLE_AUTH_LOGIN_DEV_LIMIT:
        process.env.THROTTLE_AUTH_LOGIN_DEV_LIMIT || '8',
      THROTTLE_AUTH_REFRESH_LIMIT:
        process.env.THROTTLE_AUTH_REFRESH_LIMIT || '12',
      THROTTLE_AUTH_LOGOUT_LIMIT:
        process.env.THROTTLE_AUTH_LOGOUT_LIMIT || '12',
      THROTTLE_AUTH_ME_LIMIT:
        process.env.THROTTLE_AUTH_ME_LIMIT || '12',
    },
  });

  child.stdout?.pipe(stdoutStream);
  child.stderr?.pipe(stderrStream);

  return { child, stdoutStream, stderrStream };
}

async function runThrottleScenario({
  name,
  limit,
  totalRequests,
  requestFn,
  allowStatuses = [200, 201, 401],
}) {
  const statuses = [];
  for (let i = 0; i < totalRequests; i += 1) {
    const response = await requestFn(i);
    statuses.push(response.status);
  }

  const throttledCount = statuses.filter((status) => status === 429).length;
  const disallowedStatuses = statuses.filter(
    (status) => status !== 429 && !allowStatuses.includes(status),
  );

  console.log(
    `${name}: total=${totalRequests} limit=${limit} throttled=${throttledCount} statuses=${statuses.join(',')}`,
  );

  if (throttledCount === 0) {
    throw new Error(`${name}: expected at least one 429 but received none`);
  }
  if (disallowedStatuses.length > 0) {
    throw new Error(`${name}: unexpected statuses ${disallowedStatuses.join(',')}`);
  }
}

async function main() {
  let backend;
  try {
    console.log('step=deps_up');
    await runCommand('docker', ['compose', 'up', '-d', 'postgres', 'redis']);

    console.log('step=enable_pgvector');
    await enablePgvectorExtension({ postgresContainer: POSTGRES_CONTAINER });

    console.log('step=db_push');
    const npmDbPush = resolveNpmCommand(['run', 'db:push']);
    await runCommand(npmDbPush.command, npmDbPush.args);

    await ensureBackendBuild();

    console.log('step=backend_start');
    backend = startBackend();
    console.log(`backend_pid=${backend.child.pid}`);

    const healthy = await waitForHealth();
    if (!healthy) {
      throw new Error('health_timeout');
    }
    console.log('health=ok');

    const devTokenLimit = Number(process.env.THROTTLE_AUTH_DEV_TOKEN_LIMIT || '8');
    const loginLimit = Number(process.env.THROTTLE_AUTH_LOGIN_DEV_LIMIT || '8');
    const refreshLimit = Number(process.env.THROTTLE_AUTH_REFRESH_LIMIT || '12');
    const logoutLimit = Number(process.env.THROTTLE_AUTH_LOGOUT_LIMIT || '12');
    const meLimit = Number(process.env.THROTTLE_AUTH_ME_LIMIT || '12');

    const initialLogin = await apiRequestRawWithRetry(`${API_BASE_URL}/auth/login/dev`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const accessToken = unwrapEnvelope(initialLogin?.data)?.accessToken;
    if (!accessToken) {
      throw new Error('auth_me_missing_access_token');
    }

    await runThrottleScenario({
      name: 'auth.dev-token',
      limit: devTokenLimit,
      totalRequests: devTokenLimit + 4,
      requestFn: async () =>
        apiRequestRawWithRetry(`${API_BASE_URL}/auth/dev-token`, {
          method: 'POST',
          body: JSON.stringify({}),
        }),
      allowStatuses: [201],
    });

    await runThrottleScenario({
      name: 'auth.login/dev',
      limit: loginLimit,
      totalRequests: loginLimit + 4,
      requestFn: async () =>
        apiRequestRawWithRetry(`${API_BASE_URL}/auth/login/dev`, {
          method: 'POST',
          body: JSON.stringify({}),
        }),
      allowStatuses: [201],
    });

    await runThrottleScenario({
      name: 'auth.refresh',
      limit: refreshLimit,
      totalRequests: refreshLimit + 4,
      requestFn: async () =>
        apiRequestRawWithRetry(`${API_BASE_URL}/auth/refresh`, {
          method: 'POST',
          body: JSON.stringify({
            refreshToken: 'x'.repeat(40),
          }),
        }),
      allowStatuses: [401],
    });

    await runThrottleScenario({
      name: 'auth.logout',
      limit: logoutLimit,
      totalRequests: logoutLimit + 4,
      requestFn: async () =>
        apiRequestRawWithRetry(`${API_BASE_URL}/auth/logout`, {
          method: 'POST',
          body: JSON.stringify({}),
        }),
      allowStatuses: [200],
    });

    await runThrottleScenario({
      name: 'auth.me',
      limit: meLimit,
      totalRequests: meLimit + 4,
      requestFn: async () =>
        apiRequestRawWithRetry(`${API_BASE_URL}/auth/me`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }),
      allowStatuses: [200],
    });

    console.log('auth_throttling_test_status=PASS');
  } catch (error) {
    console.error('auth_throttling_test_status=FAIL');
    console.error(`error=${error instanceof Error ? error.message : String(error)}`);
    if (error && typeof error === 'object') {
      const errObj = error;
      if (typeof errObj.stdout === 'string' && errObj.stdout.trim()) {
        console.error(`stdout=${errObj.stdout.trim()}`);
      }
      if (typeof errObj.stderr === 'string' && errObj.stderr.trim()) {
        console.error(`stderr=${errObj.stderr.trim()}`);
      }
    }
    process.exitCode = 1;
  } finally {
    if (backend?.stdoutStream) backend.stdoutStream.end();
    if (backend?.stderrStream) backend.stderrStream.end();
    if (backend?.child?.pid) {
      await killProcessTree(backend.child.pid);
    }
  }
}

main();
