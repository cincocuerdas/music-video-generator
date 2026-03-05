/* eslint-disable no-console */
const path = require('path');
const { spawn } = require('child_process');
const { getApiBaseUrl, enablePgvectorExtension, getPostgresContainerName } = require('./test_config');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const API_BASE_URL = getApiBaseUrl();
const POSTGRES_CONTAINER = getPostgresContainerName();

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

function backendRuntimeCommand(args, envOverrides = {}) {
  return runCommand(process.execPath, [path.join(ROOT_DIR, 'scripts', 'dev-tools', 'backend_runtime.js'), ...args], {
    env: {
      ...process.env,
      ALLOW_DEV_AUTH_BYPASS: process.env.ALLOW_DEV_AUTH_BYPASS || 'true',
      ...envOverrides,
    },
  });
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

function assertEnvelopeSuccess(body, context) {
  assert(body && typeof body === 'object', `${context}_body_not_object`);
  assert(body.ok === true, `${context}_ok_not_true`);
  assert(body.data && typeof body.data === 'object', `${context}_data_missing`);
  assert(body.meta && typeof body.meta === 'object', `${context}_meta_missing`);
  assert(typeof body.meta.path === 'string', `${context}_meta_path_missing`);
}

function assertLegacySuccess(body, context) {
  assert(body && typeof body === 'object', `${context}_body_not_object`);
  assert(
    !(body.ok === true && body.data && body.meta),
    `${context}_unexpected_envelope_success_shape`,
  );
  assert(typeof body.status === 'string', `${context}_legacy_status_missing`);
  assert(typeof body.timestamp === 'string', `${context}_legacy_timestamp_missing`);
}

function assertEnvelopeError(body, expectedStatus, context) {
  assert(body && typeof body === 'object', `${context}_body_not_object`);
  assert(body.ok === false, `${context}_ok_not_false`);
  assert(body.error && typeof body.error === 'object', `${context}_error_missing`);
  assert(body.error.statusCode === expectedStatus, `${context}_status_mismatch`);
  assert(typeof body.error.message === 'string', `${context}_message_missing`);
  assert(body.meta && typeof body.meta === 'object', `${context}_meta_missing`);
  assert(typeof body.meta.path === 'string', `${context}_meta_path_missing`);
}

function assertLegacyError(body, expectedStatus, context) {
  assert(body && typeof body === 'object', `${context}_body_not_object`);
  assert(typeof body.statusCode === 'number', `${context}_statusCode_missing`);
  assert(body.statusCode === expectedStatus, `${context}_status_mismatch`);
  assert(typeof body.message === 'string' || Array.isArray(body.message), `${context}_message_missing`);
  assert(!(body.ok === false && body.error && body.meta), `${context}_unexpected_envelope_error_shape`);
}

async function validateMode(modeName, envelopeEnabled) {
  console.log(`step=backend_up mode=${modeName}`);
  await backendRuntimeCommand(['up', '--force'], {
    API_RESPONSE_ENVELOPE_ENABLED: envelopeEnabled,
  });

  try {
    const health = await apiRequestRaw(`${API_BASE_URL}/health`, {}, 8000);
    assert(health.status === 200, `${modeName}_health_status_${health.status}`);
    if (envelopeEnabled === 'true') {
      assertEnvelopeSuccess(health.data, `${modeName}_health`);
      assert(
        health.data.data?.status === 'ok' || health.data.data?.status === 'degraded',
        `${modeName}_health_data_status_invalid`,
      );
    } else {
      assertLegacySuccess(health.data, `${modeName}_health`);
      assert(
        health.data.status === 'ok' || health.data.status === 'degraded',
        `${modeName}_health_status_invalid`,
      );
    }

    const unauthorized = await apiRequestRaw(
      `${API_BASE_URL}/auth/me`,
      {
        method: 'GET',
        headers: {
          Authorization: 'Bearer invalid-token',
        },
      },
      8000,
    );
    assert(unauthorized.status === 401, `${modeName}_auth_status_${unauthorized.status}`);
    if (envelopeEnabled === 'true') {
      assertEnvelopeError(unauthorized.data, 401, `${modeName}_auth`);
    } else {
      assertLegacyError(unauthorized.data, 401, `${modeName}_auth`);
    }

    const notFound = await apiRequestRaw(`${API_BASE_URL}/envelope-contract-not-found`, {}, 8000);
    assert(notFound.status === 404, `${modeName}_not_found_status_${notFound.status}`);
    if (envelopeEnabled === 'true') {
      assertEnvelopeError(notFound.data, 404, `${modeName}_not_found`);
    } else {
      assertLegacyError(notFound.data, 404, `${modeName}_not_found`);
    }

    console.log(`mode=${modeName} status=PASS`);
  } finally {
    console.log(`step=backend_down mode=${modeName}`);
    await backendRuntimeCommand(['down']).catch(() => {});
  }
}

async function main() {
  try {
    console.log('step=deps_up');
    await runCommand('docker', ['compose', 'up', '-d', 'postgres', 'redis']);

    console.log('step=enable_pgvector');
    await enablePgvectorExtension({ postgresContainer: POSTGRES_CONTAINER });

    console.log('step=db_push');
    const npmDbPush = resolveNpmCommand(['run', 'db:push']);
    await runCommand(npmDbPush.command, npmDbPush.args);

    await validateMode('legacy', 'false');
    await validateMode('envelope', 'true');

    console.log('envelope_contract_test_status=PASS');
  } catch (error) {
    console.error('envelope_contract_test_status=FAIL');
    console.error(error?.message || error);
    process.exitCode = 1;
  } finally {
    await backendRuntimeCommand(['down']).catch(() => {});
  }
}

main();
