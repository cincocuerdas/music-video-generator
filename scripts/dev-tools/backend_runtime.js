/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const RUNTIME_DIR = path.join(ROOT_DIR, 'storage', 'runtime');
const PID_FILE = path.join(RUNTIME_DIR, 'backend-runtime.json');
const LOG_DIR = path.join(ROOT_DIR, 'storage', 'logs');
const STDOUT_LOG = path.join(LOG_DIR, 'backend-runtime.out.log');
const STDERR_LOG = path.join(LOG_DIR, 'backend-runtime.err.log');

function getAppPort() {
  const raw = process.env.PORT || process.env.APP_PORT || '3000';
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 3000;
}

function getHealthUrl() {
  return `http://127.0.0.1:${getAppPort()}/api/v1/health`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const args = new Set(argv.slice(2));
  return {
    command: argv[2] || 'status',
    force: args.has('--force'),
  };
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

function ensureDirs() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function withNodeMemoryGuard(env) {
  const baseOptions = (env.NODE_OPTIONS || '').trim();
  const guard = '--max-old-space-size=4096';
  if (baseOptions.includes('--max-old-space-size=')) {
    return env;
  }
  const nextOptions = baseOptions ? `${baseOptions} ${guard}` : guard;
  return { ...env, NODE_OPTIONS: nextOptions };
}

function isProcessRunning(pid) {
  if (!pid || typeof pid !== 'number') {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function readPidRecord() {
  try {
    const raw = fs.readFileSync(PID_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writePidRecord(record) {
  ensureDirs();
  fs.writeFileSync(PID_FILE, JSON.stringify(record, null, 2), 'utf8');
}

function removePidRecord() {
  if (fs.existsSync(PID_FILE)) {
    fs.unlinkSync(PID_FILE);
  }
}

async function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      resolve(false);
    });
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForPortState(port, desiredOpen, attempts = 30, sleepMs = 200) {
  for (let i = 0; i < attempts; i += 1) {
    const open = await isPortOpen(port);
    if (open === desiredOpen) {
      return true;
    }
    await sleep(sleepMs);
  }
  return false;
}

async function apiRequestRaw(url, timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
    });
    const raw = await response.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = { raw };
    }
    return { status: response.status, data };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHealth(attempts = 60, sleepMs = 1000) {
  const url = getHealthUrl();
  for (let i = 0; i < attempts; i += 1) {
    const response = await apiRequestRaw(url);
    if (response?.status === 200) {
      return response.data;
    }
    await sleep(sleepMs);
  }
  return null;
}

async function ensureBackendBuild() {
  const forceRebuild = (process.env.TESTS_FORCE_REBUILD || '').trim().toLowerCase() === 'true';
  const entry = resolveBackendEntry();
  if (entry && !forceRebuild) {
    return entry;
  }
  const npmBuild = resolveNpmCommand(['run', 'build']);
  console.log('build=running');
  await runCommand(npmBuild.command, npmBuild.args);
  const builtEntry = resolveBackendEntry();
  if (!builtEntry) {
    throw new Error('backend_entry_missing_after_build');
  }
  return builtEntry;
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

async function findPidUsingPortWindows(port) {
  const { stdout } = await runCommand('netstat', ['-ano', '-p', 'tcp']).catch(() => ({ stdout: '' }));
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const match = lines.find((line) => {
    const cols = line.split(/\s+/);
    if (cols.length < 5) {
      return false;
    }
    const local = cols[1] || '';
    return local.endsWith(`:${port}`) && cols[3] === 'LISTENING';
  });
  if (!match) {
    return null;
  }
  const cols = match.split(/\s+/);
  const pid = Number(cols[4]);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

async function ensurePortAvailable(port, force) {
  const open = await isPortOpen(port);
  if (!open) {
    return;
  }

  if (!force) {
    throw new Error(`port_${port}_already_in_use (use --force to reclaim)`);
  }

  if (process.platform === 'win32') {
    const pid = await findPidUsingPortWindows(port);
    if (pid) {
      await killProcessTree(pid);
      await waitForPortState(port, false, 25, 200);
      return;
    }
  }

  throw new Error(`port_${port}_in_use_unable_to_reclaim`);
}

async function commandUp(force) {
  ensureDirs();

  const existing = readPidRecord();
  if (existing?.pid && isProcessRunning(existing.pid)) {
    console.log(
      `status=already_running pid=${existing.pid} port=${existing.port || getAppPort()} startedAt=${existing.startedAt || 'unknown'}`,
    );
    return;
  }
  if (existing) {
    removePidRecord();
  }

  const port = getAppPort();
  await ensurePortAvailable(port, force);
  await waitForPortState(port, false, 10, 100);
  const entry = await ensureBackendBuild();

  const stdoutFd = fs.openSync(STDOUT_LOG, 'a');
  const stderrFd = fs.openSync(STDERR_LOG, 'a');

  const runtimeEnv = withNodeMemoryGuard({
    ...process.env,
    ALLOW_DEV_AUTH_BYPASS: process.env.ALLOW_DEV_AUTH_BYPASS || 'true',
  });

  const child = spawn(process.execPath, [entry], {
    cwd: ROOT_DIR,
    // Keep backend alive after the wrapper exits on Windows and Unix.
    detached: true,
    stdio: ['ignore', stdoutFd, stderrFd],
    shell: false,
    env: runtimeEnv,
  });
  child.unref();
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);

  const healthy = await waitForHealth();
  if (!healthy) {
    await killProcessTree(child.pid);
    throw new Error('backend_health_timeout_after_start');
  }

  writePidRecord({
    pid: child.pid,
    port,
    startedAt: new Date().toISOString(),
    entry: path.relative(ROOT_DIR, entry),
    healthUrl: getHealthUrl(),
  });

  console.log(`status=started pid=${child.pid} port=${port} health=${getHealthUrl()}`);
}

async function commandDown() {
  const record = readPidRecord();
  if (!record?.pid) {
    console.log('status=already_stopped');
    return;
  }

  await killProcessTree(record.pid);
  await waitForPortState(record.port || getAppPort(), false, 30, 200);
  removePidRecord();
  console.log(`status=stopped pid=${record.pid}`);
}

async function commandStatus() {
  const record = readPidRecord();
  if (!record?.pid) {
    console.log('status=stopped');
    return;
  }

  const running = isProcessRunning(record.pid);
  if (!running) {
    removePidRecord();
    console.log('status=stopped stale_pid_removed=true');
    return;
  }

  const health = await apiRequestRaw(record.healthUrl || getHealthUrl());
  console.log(
    `status=running pid=${record.pid} port=${record.port || getAppPort()} healthStatus=${health?.status || 'down'}`,
  );
}

async function main() {
  try {
    const { command, force } = parseArgs(process.argv);
    if (command === 'up') {
      await commandUp(force);
      return;
    }
    if (command === 'down') {
      await commandDown();
      return;
    }
    if (command === 'status') {
      await commandStatus();
      return;
    }
    console.error(`unknown_command=${command}`);
    console.error('usage: node scripts/dev-tools/backend_runtime.js <up|down|status> [--force]');
    process.exitCode = 1;
  } catch (error) {
    console.error(`backend_runtime_status=FAIL message=${error?.message || String(error)}`);
    process.exitCode = 1;
  }
}

main();
