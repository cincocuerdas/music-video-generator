/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..', '..');

const FORBIDDEN_ROOT_FILES = new Set([
  'check_db.ts',
  'check_db.js',
  'check_db_detailed.js',
  'test_regex.js',
  'test_regex_final.js',
  '0.39.0',
  '1.50.0',
  '3GlzOsVIqdc.es.clean.txt',
  'body.png',
  'crank.png',
]);

function main() {
  try {
    const rootEntries = fs.readdirSync(ROOT_DIR, { withFileTypes: true });
    const rootFiles = rootEntries.filter((entry) => entry.isFile()).map((entry) => entry.name);

    const offenders = rootFiles.filter((file) => FORBIDDEN_ROOT_FILES.has(file));
    const numericStrays = rootFiles.filter((file) => /^\d+(\.\d+)+$/.test(file));

    console.log(`root_files_scanned=${rootFiles.length}`);
    console.log(`forbidden_candidates=${FORBIDDEN_ROOT_FILES.size}`);

    if (offenders.length > 0) {
      console.error(`offenders=${offenders.join(',')}`);
      console.error('repo_hygiene_test_status=FAIL');
      process.exit(1);
      return;
    }

    if (numericStrays.length > 0) {
      console.error(`numeric_stray_files=${numericStrays.join(',')}`);
      console.error('repo_hygiene_test_status=FAIL');
      process.exit(1);
      return;
    }

    console.log('repo_hygiene_test_status=PASS');
  } catch (error) {
    console.error('repo_hygiene_test_status=FAIL');
    console.error(`error=${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();
