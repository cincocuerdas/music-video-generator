/* eslint-disable no-console */
const { spawn } = require('child_process');
const path = require('path');
const { Queue, Worker, QueueEvents } = require('bullmq');
const { getRedisConnectionOptions } = require('./test_config');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const REDIS_QUEUE_PREFIX = `bullmq-retry-test-${Date.now()}`;
const REDIS_CONTAINER = (process.env.RESILIENCE_REDIS_CONTAINER || 'musicvideo-redis').trim();
const connection = getRedisConnectionOptions();

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

async function ensureRedisUp() {
  console.log('step=redis_up');
  await runCommand('docker', ['compose', 'up', '-d', 'redis']);
  await sleep(2000);
  console.log(`redis_container=${REDIS_CONTAINER}`);
}

async function runTransientRecoveryCase() {
  const queueName = `${REDIS_QUEUE_PREFIX}-transient`;
  const queue = new Queue(queueName, { connection });
  const queueEvents = new QueueEvents(queueName, { connection });
  let transientAttempts = 0;

  const worker = new Worker(
    queueName,
    async (job) => {
      if (job.name !== 'transient') {
        return { ignored: true };
      }
      transientAttempts += 1;
      if (transientAttempts === 1) {
        throw new Error('transient_injected_failure');
      }
      return { recovered: true, attempts: transientAttempts };
    },
    { connection, concurrency: 1 },
  );

  try {
    await queueEvents.waitUntilReady();
    await worker.waitUntilReady();

    const transientJob = await queue.add(
      'transient',
      { kind: 'transient' },
      {
        attempts: 2,
        backoff: { type: 'fixed', delay: 100 },
        removeOnComplete: false,
        removeOnFail: false,
      },
    );

    const result = await transientJob.waitUntilFinished(queueEvents, 30_000);
    const stored = await queue.getJob(transientJob.id);
    const attemptsMade = stored?.attemptsMade ?? -1;

    console.log(
      `transient_case attempts=${transientAttempts} attemptsMade=${attemptsMade} result=${JSON.stringify(result)}`,
    );

    if (transientAttempts !== 2) {
      throw new Error(`transient_case_expected_2_attempts_got_${transientAttempts}`);
    }
    if (attemptsMade < 1) {
      throw new Error(`transient_case_expected_attemptsMade>=1_got_${attemptsMade}`);
    }
  } finally {
    await worker.close().catch(() => {});
    await queueEvents.close().catch(() => {});
    await queue.obliterate({ force: true }).catch(() => {});
    await queue.close().catch(() => {});
  }
}

async function runPermanentFailureCase() {
  const queueName = `${REDIS_QUEUE_PREFIX}-permanent`;
  const queue = new Queue(queueName, { connection });
  const queueEvents = new QueueEvents(queueName, { connection });
  let permanentAttempts = 0;

  const worker = new Worker(
    queueName,
    async (job) => {
      if (job.name !== 'permanent') {
        return { ignored: true };
      }
      permanentAttempts += 1;
      throw new Error('permanent_failure');
    },
    { connection, concurrency: 1 },
  );

  try {
    await queueEvents.waitUntilReady();
    await worker.waitUntilReady();

    const permanentJob = await queue.add(
      'permanent',
      { kind: 'permanent' },
      {
        attempts: 2,
        backoff: { type: 'fixed', delay: 100 },
        removeOnComplete: false,
        removeOnFail: false,
      },
    );

    let failedAsExpected = false;
    try {
      await permanentJob.waitUntilFinished(queueEvents, 30_000);
    } catch {
      failedAsExpected = true;
    }

    const stored = await queue.getJob(permanentJob.id);
    const attemptsMade = stored?.attemptsMade ?? -1;
    const failedReason = stored?.failedReason || '';

    console.log(
      `permanent_case attempts=${permanentAttempts} attemptsMade=${attemptsMade} failedReason=${failedReason}`,
    );

    if (!failedAsExpected) {
      throw new Error('permanent_case_expected_failure_but_completed');
    }
    if (permanentAttempts !== 2) {
      throw new Error(`permanent_case_expected_2_attempts_got_${permanentAttempts}`);
    }
    if (attemptsMade < 2) {
      throw new Error(`permanent_case_expected_attemptsMade>=2_got_${attemptsMade}`);
    }
  } finally {
    await worker.close().catch(() => {});
    await queueEvents.close().catch(() => {});
    await queue.obliterate({ force: true }).catch(() => {});
    await queue.close().catch(() => {});
  }
}

async function main() {
  try {
    await ensureRedisUp();
    await runTransientRecoveryCase();
    await runPermanentFailureCase();
    console.log('bullmq_retries_test_status=PASS');
  } catch (error) {
    console.error('bullmq_retries_test_status=FAIL');
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
  }
}

main();
