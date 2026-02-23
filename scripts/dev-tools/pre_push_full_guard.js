/* eslint-disable no-console */
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
function main() {
  console.log('[pre-push:full] Running full backend quality gate (test:ops)...');
  const npmExecPath = process.env.npm_execpath;

  const result = npmExecPath
    ? spawnSync(process.execPath, [npmExecPath, 'run', 'test:ops'], {
        cwd: ROOT_DIR,
        stdio: 'inherit',
      })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'test:ops'], {
        cwd: ROOT_DIR,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      });

  if (result.error) {
    console.error(`[pre-push:full] status=FAIL error=${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error('[pre-push:full] status=FAIL');
    process.exit(result.status || 1);
  }

  console.log('[pre-push:full] status=PASS');
}

main();
