/* eslint-disable no-console */
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..', '..');

const CHECKS = [
  { name: 'repo_hygiene', script: 'scripts/dev-tools/test_repo_hygiene.js' },
  { name: 'artifact_hygiene', script: 'scripts/dev-tools/test_artifact_hygiene.js' },
];

function runNodeScript(relativePath) {
  const absolutePath = path.resolve(ROOT_DIR, relativePath);
  return spawnSync(process.execPath, [absolutePath], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
  });
}

function main() {
  console.log('[pre-commit] Running fast repository guards...');

  for (const check of CHECKS) {
    console.log(`[pre-commit] check=${check.name}`);
    const result = runNodeScript(check.script);
    if (result.status !== 0) {
      console.error(`[pre-commit] status=FAIL check=${check.name}`);
      process.exit(result.status || 1);
    }
  }

  console.log('[pre-commit] status=PASS');
}

main();
