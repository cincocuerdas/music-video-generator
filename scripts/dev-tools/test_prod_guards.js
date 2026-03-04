/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getProdGuardBaseEnv } = require('./test_config');

const ROOT_DIR = path.resolve(__dirname, '..', '..');

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runScenarioOnce(name, envOverrides, expectedMessage) {
  return new Promise((resolve, reject) => {
    const backendEntry = resolveBackendEntry();
    if (!backendEntry) {
      reject(new Error('backend_entry_missing_after_build'));
      return;
    }

    const baseEnv = {
      ...process.env,
      ...getProdGuardBaseEnv(),
      ...envOverrides,
    };

    const child = spawn(process.execPath, [backendEntry], {
      cwd: ROOT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      env: baseEnv,
    });

    let output = '';
    let timedOut = false;

    child.stdout?.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      output += chunk.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 15_000);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const compactOutput = output.replace(/\s+/g, ' ').trim();

      if (timedOut) {
        reject(new Error(`${name}: process timed out waiting for guard failure`));
        return;
      }
      if (code === 0) {
        reject(new Error(`${name}: expected non-zero exit code but got 0`));
        return;
      }
      if (!compactOutput.includes(expectedMessage)) {
        reject(
          new Error(
            `${name}: expected error message not found.\nExpected: ${expectedMessage}\nOutput: ${compactOutput.slice(-1000)}`,
          ),
        );
        return;
      }

      console.log(`scenario=${name} status=PASS`);
      resolve();
    });
  });
}

async function runScenario(name, envOverrides, expectedMessage) {
  const maxAttempts = 2;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await runScenarioOnce(name, envOverrides, expectedMessage);
      return;
    } catch (error) {
      lastError = error;
      const message = error?.message || '';
      const isTransientModuleResolutionError =
        /Cannot find module/i.test(message) || /MODULE_NOT_FOUND/i.test(message);

      if (!isTransientModuleResolutionError || attempt === maxAttempts) {
        throw error;
      }

      console.warn(
        `scenario=${name} transient module resolution failure detected, retrying (${attempt}/${maxAttempts})...`,
      );
      await sleep(300);
    }
  }

  throw lastError;
}

async function main() {
  console.log('step=build_check');
  await ensureBackendBuild();

  const scenarios = [
    {
      name: 'weak_jwt_secret',
      env: { JWT_SECRET: 'dev_local_secret_123' },
      expected: 'Unsafe production configuration: JWT_SECRET uses empty/placeholder values.',
    },
    {
      name: 'missing_database_url',
      env: { DATABASE_URL: '' },
      expected: 'Missing DATABASE_URL in production.',
    },
    {
      name: 'short_refresh_secret',
      env: {
        JWT_SECRET: 'this_is_a_strong_jwt_secret_for_prod_guard_tests_12345',
        JWT_REFRESH_SECRET: 'short_refresh_secret_123',
      },
      expected:
        'Unsafe production configuration: JWT_REFRESH_SECRET must be at least 32 characters.',
    },
    {
      name: 'short_refresh_pepper',
      env: {
        JWT_SECRET: 'this_is_a_strong_jwt_secret_for_prod_guard_tests_12345',
        JWT_REFRESH_SECRET: 'this_is_a_strong_refresh_secret_for_prod_guard_tests_12345',
        JWT_REFRESH_TOKEN_PEPPER: 'short_pepper_123',
      },
      expected:
        'Unsafe production configuration: JWT_REFRESH_TOKEN_PEPPER must be at least 32 characters.',
    },
    {
      name: 'dev_auth_bypass_enabled',
      env: { ALLOW_DEV_AUTH_BYPASS: 'true' },
      expected:
        'Unsafe production configuration: ALLOW_DEV_AUTH_BYPASS must be false in production.',
    },
    {
      name: 'missing_redis_config',
      env: { REDIS_URL: '', REDIS_HOST: '' },
      expected: 'Missing Redis configuration. Set REDIS_URL or REDIS_HOST/REDIS_PORT.',
    },
    {
      name: 'weak_database_credentials',
      env: { DATABASE_URL: 'postgresql://postgres:postgres@db.internal:5432/musicvideo' },
      expected:
        'Unsafe production configuration: DATABASE_URL uses weak/default database credentials.',
    },
    {
      name: 'loopback_database_url',
      env: { DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/musicvideo' },
      expected:
        'Unsafe production configuration: DATABASE_URL cannot use localhost/loopback host in production.',
    },
    {
      name: 'loopback_redis_url',
      env: { REDIS_URL: 'redis://localhost:6379' },
      expected:
        'Unsafe production configuration: REDIS_URL cannot use localhost/loopback host in production.',
    },
    {
      name: 'redis_url_missing_password',
      env: { REDIS_URL: 'redis://redis.internal:6379' },
      expected:
        'Unsafe production configuration: REDIS_URL must include a strong password.',
    },
    {
      name: 'missing_gemini_key',
      env: { LLM_PROVIDER: 'gemini', GEMINI_API_KEY: '' },
      expected:
        'Unsafe production configuration: GEMINI_API_KEY is missing/placeholder while LLM_PROVIDER=gemini.',
    },
    {
      name: 'missing_replicate_token',
      env: { IMAGE_PROVIDER: 'replicate', REPLICATE_API_TOKEN: '' },
      expected:
        'Unsafe production configuration: REPLICATE_API_TOKEN is missing/placeholder while IMAGE_PROVIDER=replicate.',
    },
    {
      name: 'missing_comfyui_url',
      env: { IMAGE_PROVIDER: 'comfyui', COMFYUI_URL: '' },
      expected:
        'Unsafe production configuration: COMFYUI_URL is missing/placeholder while IMAGE_PROVIDER=comfyui.',
    },
    {
      name: 'unsafe_cors_origin',
      env: { CORS_ORIGIN: '*' },
      expected:
        'Unsafe production configuration: CORS_ORIGIN cannot be empty or "*" in production.',
    },
    {
      name: 'loopback_cors_origin',
      env: { CORS_ORIGIN: 'http://localhost:5173' },
      expected:
        'Unsafe production configuration: CORS_ORIGIN cannot target localhost/loopback hosts in production.',
    },
  ];

  for (const scenario of scenarios) {
    await runScenario(scenario.name, scenario.env, scenario.expected);
  }

  console.log('prod_guards_test_status=PASS');
}

main().catch((error) => {
  console.error('prod_guards_test_status=FAIL');
  console.error(error?.message || error);
  process.exit(1);
});
