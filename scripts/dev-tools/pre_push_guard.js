/* eslint-disable no-console */
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const JEST_JS = path.join(ROOT_DIR, 'node_modules', 'jest', 'bin', 'jest.js');

const CHECKS = [
  {
    name: 'secret_hygiene',
    command: process.execPath,
    args: ['scripts/dev-tools/test_secret_hygiene.js'],
  },
  {
    name: 'python_runner_contract',
    command: process.execPath,
    args: [JEST_JS, 'python-runner.integration.spec.ts', '--runInBand'],
  },
  {
    name: 'redis_client',
    command: process.execPath,
    args: [JEST_JS, 'redis-client.service.spec.ts', '--runInBand'],
  },
  {
    name: 'prod_guards',
    command: process.execPath,
    args: ['scripts/dev-tools/test_prod_guards.js'],
  },
];

function runCheck(check) {
  return spawnSync(check.command, check.args, {
    cwd: ROOT_DIR,
    stdio: 'inherit',
  });
}

function main() {
  console.log('[pre-push] Running critical backend guards...');

  for (const check of CHECKS) {
    console.log(`[pre-push] check=${check.name}`);
    const result = runCheck(check);
    if (result.error) {
      console.error(`[pre-push] status=FAIL check=${check.name} error=${result.error.message}`);
      process.exit(1);
    }
    if (result.status !== 0) {
      console.error(`[pre-push] status=FAIL check=${check.name}`);
      process.exit(result.status || 1);
    }
  }

  console.log('[pre-push] status=PASS');
}

main();
