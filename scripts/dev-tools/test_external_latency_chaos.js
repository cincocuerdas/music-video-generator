/* eslint-disable no-console */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { getApiBaseUrl, getPostgresContainerName, enablePgvectorExtension } = require('./test_config');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const LOG_DIR = path.join(ROOT_DIR, 'storage', 'tmp-tests');
const STDOUT_LOG = path.join(LOG_DIR, 'backend-external-latency-chaos.out.log');
const STDERR_LOG = path.join(LOG_DIR, 'backend-external-latency-chaos.err.log');
const API_BASE_URL = getApiBaseUrl();
const HEALTH_URL = `${API_BASE_URL}/health`;
const POSTGRES_CONTAINER = getPostgresContainerName();
const PYTHON_BIN = process.env.PYTHON_BIN || 'python';
const CHAOS_PORT = Number(process.env.EXTERNAL_LATENCY_CHAOS_PORT || '8899');
const CHAOS_BASE_URL = `http://127.0.0.1:${CHAOS_PORT}`;

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

async function createProject(token, title, lyrics) {
  const project = await apiRequest(`${API_BASE_URL}/projects`, {
    method: 'POST',
    headers: buildAuthHeaders(token),
    body: JSON.stringify({
      title,
      visualStyle: 'cinematic',
      lyrics,
      aspectRatio: '16:9',
    }),
  });
  assert(project?.id, 'missing_project_id');
  return project.id;
}

function parseResultJson(stdout, stderr) {
  const combined = `${stderr || ''}\n${stdout || ''}`;
  const lines = combined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const marker = [...lines].reverse().find((line) => line.startsWith('RESULT_JSON:'));
  if (!marker) {
    return null;
  }
  try {
    return JSON.parse(marker.slice('RESULT_JSON:'.length));
  } catch {
    return null;
  }
}

async function runPython(scriptRelativePath, args = [], envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(ROOT_DIR, scriptRelativePath);
    const child = spawn(PYTHON_BIN, [scriptPath, ...args], {
      cwd: ROOT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      env: {
        ...process.env,
        ...envOverrides,
      },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr, result: parseResultJson(stdout, stderr) });
    });
  });
}

function startLatencyChaosServer() {
  const server = http.createServer((req, res) => {
    const url = req.url || '';

    if (url.startsWith('/v1beta/models')) {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            models: [
              {
                name: 'models/gemini-1.5-flash',
                supportedGenerationMethods: ['generateContent'],
              },
            ],
          }),
        );
      }, 2500);
      return;
    }

    if (url.includes(':generateContent')) {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: '{"sentiment":"nostalgic","mood":"slow-server"}' }],
                },
              },
            ],
          }),
        );
      }, 2500);
      return;
    }

    if (url.startsWith('/prompt')) {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ prompt_id: 'slow-chaos-prompt' }));
      }, 15000);
      return;
    }

    if (url.startsWith('/queue')) {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ queue_running: [], queue_pending: [['slow']] }));
      }, 15000);
      return;
    }

    if (url.startsWith('/history/')) {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      }, 15000);
      return;
    }

    setTimeout(() => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    }, 100);
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(CHAOS_PORT, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  let backend;
  let chaosServer;
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

    console.log('step=latency_chaos_server_start');
    chaosServer = await startLatencyChaosServer();
    console.log(`latency_chaos_server=up port=${CHAOS_PORT}`);

    const login = await apiRequest(`${API_BASE_URL}/auth/login/dev`, {
      method: 'POST',
      body: '{}',
    });
    const token = login?.accessToken;
    assert(token, 'missing_access_token');

    const projectId = await createProject(
      token,
      `External Latency Chaos ${Date.now()}`,
      'Sigo caminando bajo luces lentas',
    );
    console.log(`seed_project=${projectId}`);

    const analyze = await runPython('scripts/analyze_lyrics.py', [projectId], {
      GEMINI_API_KEY: 'chaos_key',
      GEMINI_API_BASE_URL: CHAOS_BASE_URL,
      GEMINI_MODELS_TIMEOUT_SEC: '1',
      GEMINI_REQUEST_TIMEOUT_SEC: '1',
      GEMINI_REQUEST_RETRIES: '0',
    });

    assert(analyze.code === 0, `analyze_exit_code_${analyze.code}`);
    assert(analyze.result, 'analyze_missing_result_json');
    assert(analyze.result.success === true, 'analyze_should_return_success_true');
    assert(
      analyze.result.status === 'degraded',
      `analyze_status_expected_degraded_got_${analyze.result.status}`,
    );
    console.log(`case_gemini_timeout=PASS status=${analyze.result.status}`);

    const generate = await runPython('scripts/generate_images.py', [projectId, 'latency-chaos-job', '{}'], {
      IMAGE_PROVIDER: 'comfyui',
      COMFYUI_URL: CHAOS_BASE_URL,
      COMFYUI_DISABLE_HAND_LORA: 'true',
      COMFYUI_DISABLE_FACE_DETAILER: 'true',
      IMAGE_GENERATION_CONCURRENCY: '1',
    });

    assert(generate.code === 0, `generate_exit_code_${generate.code}`);
    assert(generate.result, 'generate_missing_result_json');
    assert(generate.result.success === true, 'generate_should_return_success_true');
    assert(
      generate.result.status === 'degraded',
      `generate_status_expected_degraded_got_${generate.result.status}`,
    );
    assert(generate.result.degraded === true, 'generate_degraded_flag_expected_true');
    assert(
      Array.isArray(generate.result.images) && generate.result.images.some((img) => img?.isFallback === true),
      'generate_expected_fallback_image',
    );
    console.log(`case_comfyui_timeout=PASS status=${generate.result.status}`);

    console.log('external_latency_chaos_test_status=PASS');
  } catch (error) {
    console.error('external_latency_chaos_test_status=FAIL');
    console.error(error?.message || error);
    process.exitCode = 1;
  } finally {
    if (chaosServer) {
      await new Promise((resolve) => chaosServer.close(resolve));
    }
    if (backend?.child?.pid) {
      await killProcessTree(backend.child.pid);
    }
    backend?.stdoutStream?.end();
    backend?.stderrStream?.end();
  }
}

main();
