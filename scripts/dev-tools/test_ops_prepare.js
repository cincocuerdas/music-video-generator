/* eslint-disable no-console */
const { spawn } = require('child_process');
const IORedis = require('ioredis');
const { getRedisConnectionOptions } = require('./test_config');

const TARGET_PORTS = (process.env.TEST_OPS_CLEAN_PORTS || '3000')
  .split(',')
  .map((item) => Number(item.trim()))
  .filter((item) => Number.isFinite(item) && item > 0);

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const useShell =
      typeof options.shell === 'boolean'
        ? options.shell
        : process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
    const child = spawn(command, args, {
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

function parsePidsFromNetstat(stdout, port) {
  const pids = new Set();
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const cols = line.split(/\s+/);
    if (cols.length < 5) {
      continue;
    }
    const localAddress = cols[1] || '';
    const state = cols[3] || '';
    const pid = Number(cols[4]);
    if (!localAddress.endsWith(`:${port}`)) {
      continue;
    }
    if (state !== 'LISTENING') {
      continue;
    }
    if (Number.isFinite(pid) && pid > 0) {
      pids.add(pid);
    }
  }
  return Array.from(pids);
}

function parsePidsFromLsof(stdout) {
  return Array.from(
    new Set(
      stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => Number(line))
        .filter((value) => Number.isFinite(value) && value > 0),
    ),
  );
}

async function listPidsOnPort(port) {
  if (process.platform === 'win32') {
    const { stdout } = await runCommand('netstat', ['-ano', '-p', 'tcp']).catch(() => ({ stdout: '' }));
    return parsePidsFromNetstat(stdout, port);
  }

  const { stdout } = await runCommand('lsof', ['-t', `-i:${port}`, '-sTCP:LISTEN']).catch(() => ({
    stdout: '',
  }));
  return parsePidsFromLsof(stdout);
}

async function killPidTree(pid) {
  if (!pid) {
    return;
  }
  if (process.platform === 'win32') {
    await runCommand('taskkill', ['/pid', String(pid), '/T', '/F']).catch(() => {});
    return;
  }
  await runCommand('kill', ['-TERM', String(pid)]).catch(() => {});
}

async function cleanupPort(port) {
  const pids = await listPidsOnPort(port);
  if (pids.length === 0) {
    console.log(`cleanup_port=${port} pids=none`);
    return;
  }
  for (const pid of pids) {
    await killPidTree(pid);
  }
  console.log(`cleanup_port=${port} killed=${pids.join(',')}`);
}

async function clearRedisPattern(pattern) {
  const redisConnection = getRedisConnectionOptions();
  const client = redisConnection.url
    ? new IORedis(redisConnection.url, { maxRetriesPerRequest: null })
    : new IORedis({ ...redisConnection, maxRetriesPerRequest: null });

  try {
    let cursor = '0';
    let deleted = 0;
    do {
      const [nextCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = nextCursor;
      if (keys.length > 0) {
        deleted += await client.del(...keys);
      }
    } while (cursor !== '0');
    console.log(`cleanup_redis_pattern=${pattern} deleted=${deleted}`);
  } catch (error) {
    console.log(`cleanup_redis_pattern=${pattern} skipped=${error?.message || String(error)}`);
  } finally {
    await client.quit().catch(async () => {
      await client.disconnect();
    });
  }
}

async function main() {
  for (const port of TARGET_PORTS) {
    await cleanupPort(port);
  }
  await clearRedisPattern('throttler:*');
  console.log('test_ops_prepare_status=PASS');
}

main().catch((error) => {
  console.error(`test_ops_prepare_status=FAIL message=${error?.message || String(error)}`);
  process.exitCode = 1;
});
