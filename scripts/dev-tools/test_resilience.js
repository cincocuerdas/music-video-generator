/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  getApiBaseUrl,
  getPostgresContainerName,
  getRedisContainerName,
  enablePgvectorExtension,
} = require('./test_config');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const LOG_DIR = path.join(ROOT_DIR, 'storage', 'tmp-tests');
const STDOUT_LOG = path.join(LOG_DIR, 'backend-redis-resilience.out.log');
const STDERR_LOG = path.join(LOG_DIR, 'backend-redis-resilience.err.log');
const API_BASE_URL = getApiBaseUrl();
const HEALTH_URL = `${API_BASE_URL}/health`;
const RESILIENCE_REDIS_CONTAINER = getRedisContainerName();
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

async function apiRequest(url, init = {}, timeoutMs = 8000) {
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

    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} on ${url}: ${JSON.stringify(data)}`);
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHealth(attempts = 80, sleepMs = 2000) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await apiRequest(HEALTH_URL, {}, 3000);
      return true;
    } catch {
      await sleep(sleepMs);
    }
  }
  return false;
}

function createProjectPayload(title, lyrics) {
  return {
    title,
    lyrics,
    visualStyle: 'cinematic',
    aspectRatio: '16:9',
  };
}

async function createProjectAndStartPipeline(token, title, lyrics) {
  const headers = { Authorization: `Bearer ${token}` };
  const project = await apiRequest(`${API_BASE_URL}/projects`, {
    method: 'POST',
    headers,
    body: JSON.stringify(createProjectPayload(title, lyrics)),
  });

  if (!project?.id) {
    throw new Error(`project id missing for "${title}"`);
  }

  await apiRequest(`${API_BASE_URL}/jobs/pipeline/${project.id}/start`, {
    method: 'POST',
    headers,
  });

  return project.id;
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
      // Ignore if already dead
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
      ALLOW_DEV_AUTH_BYPASS: process.env.ALLOW_DEV_AUTH_BYPASS || 'true',
      USE_MOCK_PROCESSORS: process.env.USE_MOCK_PROCESSORS || 'true',
    },
  });

  child.stdout?.pipe(stdoutStream);
  child.stderr?.pipe(stderrStream);

  return { child, stdoutStream, stderrStream };
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

    const login = await apiRequest(`${API_BASE_URL}/auth/login/dev`, {
      method: 'POST',
      body: '{}',
    });
    const token = login?.accessToken;
    if (!token) {
      throw new Error('no_token');
    }

    const baselineProject = await createProjectAndStartPipeline(
      token,
      'Resilience Baseline',
      'a\nb',
    );
    console.log(`baseline_project=${baselineProject}`);

    console.log('step=redis_down');
    await runCommand('docker', ['stop', RESILIENCE_REDIS_CONTAINER]);
    await sleep(8000);

    await apiRequest(HEALTH_URL, {}, 3000);
    console.log('health_during_redis_down=ok');

    console.log('step=redis_up');
    await runCommand('docker', ['start', RESILIENCE_REDIS_CONTAINER]);
    await sleep(10000);

    const recoveryProject = await createProjectAndStartPipeline(
      token,
      'Resilience Recovery',
      'c\nd',
    );
    console.log(`recovery_project=${recoveryProject}`);

    await sleep(2000);
    const combinedLogs = `${fs.existsSync(STDOUT_LOG) ? fs.readFileSync(STDOUT_LOG, 'utf8') : ''}\n${
      fs.existsSync(STDERR_LOG) ? fs.readFileSync(STDERR_LOG, 'utf8') : ''
    }`;

    const hasReconnecting = combinedLogs.includes('Redis reconnecting');
    const hasReady = combinedLogs.includes('Redis ready');
    console.log(`log_has_reconnecting=${hasReconnecting}`);
    console.log(`log_has_ready=${hasReady}`);

    if (!hasReconnecting || !hasReady) {
      throw new Error('redis_reconnect_logs_missing');
    }

    console.log('resilience_test_status=PASS');
  } catch (error) {
    console.error('resilience_test_status=FAIL');
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
