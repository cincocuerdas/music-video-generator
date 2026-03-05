/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getApiBaseUrl, getPostgresContainerName, enablePgvectorExtension, unwrapEnvelope } = require('./test_config');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const LOG_DIR = path.join(ROOT_DIR, 'storage', 'tmp-tests');
const STDOUT_LOG = path.join(LOG_DIR, 'backend-feedback-optimization.out.log');
const STDERR_LOG = path.join(LOG_DIR, 'backend-feedback-optimization.err.log');
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

async function apiRequest(url, init = {}, timeoutMs = 10000) {
  const result = await apiRequestRaw(url, init, timeoutMs);
  if (result.status >= 400) {
    throw new Error(`HTTP ${result.status} on ${url}: ${JSON.stringify(result.data)}`);
  }
  return unwrapEnvelope(result.data);
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
      ALLOW_DEV_AUTH_BYPASS: process.env.ALLOW_DEV_AUTH_BYPASS || 'true',
      USE_MOCK_PROCESSORS: process.env.USE_MOCK_PROCESSORS || 'true',
      GEMINI_API_KEY: process.env.TEST_FEEDBACK_OPTIMIZATION_GEMINI_KEY || '',
    },
  });

  child.stdout?.pipe(stdoutStream);
  child.stderr?.pipe(stderrStream);

  return { child, stdoutStream, stderrStream };
}

function buildAuthHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
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
    assert(healthy, 'health_timeout');
    console.log('health=ok');

    const login = await apiRequest(`${API_BASE_URL}/auth/login/dev`, {
      method: 'POST',
      body: '{}',
    });
    const token = login?.accessToken;
    assert(!!token, 'missing_access_token');

    const project = await apiRequest(
      `${API_BASE_URL}/projects`,
      {
        method: 'POST',
        headers: buildAuthHeaders(token),
        body: JSON.stringify({
          title: 'Feedback Optimization Regression',
          visualStyle: 'cinematic',
          lyrics: 'test lyrics',
        }),
      },
      20000,
    );
    const projectId = project?.id;
    assert(!!projectId, 'missing_project_id');
    console.log(`seed_project=${projectId}`);

    const likedPrompts = [
      'cinematic masterpiece, volumetric lighting, detailed portrait frame 01',
      'cinematic detailed composition with dramatic lighting frame 02',
      'professional cinematic scene with atmospheric volumetric light frame 03',
      'stunning cinematic closeup with dramatic lighting and detail frame 04',
      'cinematic professional color grading, volumetric beams frame 05',
      'cinematic lighting, detailed texture, dramatic atmosphere frame 06',
    ];

    const dislikedPrompts = [
      'amateur blurry low quality composition frame 11',
      'distorted anatomy with artifacts and bad exposure frame 12',
      'oversaturated underexposed noisy render frame 13',
      'amateur distorted framing with blurry artifacts frame 14',
    ];

    for (const prompt of likedPrompts) {
      await apiRequest(`${API_BASE_URL}/projects/${projectId}/feedback`, {
        method: 'POST',
        headers: buildAuthHeaders(token),
        body: JSON.stringify({ score: 1, prompt }),
      });
    }

    for (const prompt of dislikedPrompts) {
      await apiRequest(`${API_BASE_URL}/projects/${projectId}/feedback`, {
        method: 'POST',
        headers: buildAuthHeaders(token),
        body: JSON.stringify({ score: -1, prompt }),
      });
    }

    const stats = await apiRequest(
      `${API_BASE_URL}/projects/feedback/stats?style=cinematic`,
      {
        method: 'GET',
        headers: buildAuthHeaders(token),
      },
    );

    assert(stats.totalLikes >= likedPrompts.length, `unexpected totalLikes=${stats.totalLikes}`);
    assert(
      stats.totalDislikes >= dislikedPrompts.length,
      `unexpected totalDislikes=${stats.totalDislikes}`,
    );
    assert(
      Array.isArray(stats.topSuccessfulKeywords),
      'topSuccessfulKeywords should be an array',
    );

    const optimization = await apiRequest(
      `${API_BASE_URL}/projects/${projectId}/prompt-optimization`,
      {
        method: 'GET',
        headers: buildAuthHeaders(token),
      },
    );

    assert(typeof optimization.confidence === 'number', 'confidence should be a number');
    assert(optimization.confidence > 0, 'confidence should be > 0 with seeded feedback');
    assert(
      typeof optimization.qualityBoost === 'string' && optimization.qualityBoost.length > 0,
      'qualityBoost should not be empty',
    );
    assert(
      typeof optimization.negativeBoost === 'string' && optimization.negativeBoost.length > 0,
      'negativeBoost should not be empty',
    );

    console.log(
      `optimization_result qualityBoost="${optimization.qualityBoost}" negativeBoost="${optimization.negativeBoost}" confidence=${optimization.confidence}`,
    );
    console.log('feedback_optimization_test_status=PASS');
  } catch (error) {
    console.error('feedback_optimization_test_status=FAIL');
    console.error(error?.message || error);
    process.exitCode = 1;
  } finally {
    if (backend?.child?.pid) {
      await killProcessTree(backend.child.pid);
    }
    if (backend?.stdoutStream) backend.stdoutStream.end();
    if (backend?.stderrStream) backend.stderrStream.end();
  }
}

main();
