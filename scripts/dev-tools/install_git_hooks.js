/* eslint-disable no-console */
const { execSync } = require('child_process');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..', '..');

function run(command) {
  return execSync(command, {
    cwd: ROOT_DIR,
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
}

function main() {
  try {
    const inRepo = run('git rev-parse --is-inside-work-tree');
    if (inRepo !== 'true') {
      throw new Error('Not inside a git repository');
    }

    run('git config core.hooksPath .githooks');
    const hooksPath = run('git config --get core.hooksPath');
    console.log(`hooks_path=${hooksPath}`);
    console.log('git_hooks_install_status=PASS');
  } catch (error) {
    console.error('git_hooks_install_status=FAIL');
    console.error(`error=${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();
