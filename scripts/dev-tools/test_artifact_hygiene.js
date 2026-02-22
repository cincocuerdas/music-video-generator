/* eslint-disable no-console */
const { execSync } = require('child_process');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..', '..');

const FORBIDDEN_TRACKED_PREFIXES = [
  'public/outputs/',
  'scripts/temp/',
  'output/',
  'storage/',
  'logs/',
];

const ALLOWLIST = new Set([
  'storage/.gitkeep',
  'logs/.gitkeep',
  'output/.gitkeep',
  'public/outputs/.gitkeep',
  'scripts/temp/.gitkeep',
]);

function normalizeGitPath(filePath) {
  return filePath.replace(/\\/g, '/').trim();
}

function main() {
  try {
    const stdout = execSync('git ls-files', {
      cwd: ROOT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });

    const trackedFiles = stdout
      .split('\n')
      .map((line) => normalizeGitPath(line))
      .filter(Boolean);

    const offenders = trackedFiles.filter((file) => {
      if (ALLOWLIST.has(file)) {
        return false;
      }
      return FORBIDDEN_TRACKED_PREFIXES.some((prefix) => file.startsWith(prefix));
    });

    console.log(`tracked_files_scanned=${trackedFiles.length}`);
    console.log(`forbidden_prefixes=${FORBIDDEN_TRACKED_PREFIXES.join(',')}`);

    if (offenders.length > 0) {
      console.error(`tracked_artifact_offenders=${offenders.join(',')}`);
      console.error('artifact_hygiene_test_status=FAIL');
      process.exit(1);
      return;
    }

    console.log('artifact_hygiene_test_status=PASS');
  } catch (error) {
    console.error('artifact_hygiene_test_status=FAIL');
    console.error(`error=${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();
