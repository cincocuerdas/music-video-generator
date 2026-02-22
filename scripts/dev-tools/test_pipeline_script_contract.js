/* eslint-disable no-console */
const path = require('path');
const { spawn } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const PYTHON_BIN = process.env.PYTHON_BIN || 'python';

function runPython(scriptRelativePath, args = []) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(ROOT_DIR, scriptRelativePath);
    const child = spawn(PYTHON_BIN, [scriptPath, ...args], {
      cwd: ROOT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => reject(error));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function parseResultJson(stderr, stdout) {
  const combined = `${stderr}\n${stdout}`;
  const lines = combined.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const marker = lines.reverse().find((line) => line.startsWith('RESULT_JSON:'));
  if (!marker) {
    return null;
  }

  try {
    return JSON.parse(marker.slice('RESULT_JSON:'.length));
  } catch {
    return null;
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function validateScript(scriptPath) {
  const result = await runPython(scriptPath, []);
  const payload = parseResultJson(result.stderr, result.stdout);

  assert(result.code === 0, `${scriptPath} exited with code ${result.code}`);
  assert(payload, `${scriptPath} did not emit RESULT_JSON payload`);
  assert(payload.status === 'failed', `${scriptPath} status should be failed`);
  assert(payload.success === false, `${scriptPath} success should be false`);
  assert(typeof payload.degraded === 'boolean', `${scriptPath} degraded should be boolean`);
  assert(Array.isArray(payload.degradedReasons), `${scriptPath} degradedReasons should be array`);

  console.log(`${scriptPath}: status=${payload.status} success=${payload.success} exit=${result.code}`);
}

async function main() {
  try {
    await validateScript('scripts/youtube_download.py');
    await validateScript('scripts/transcribe_audio.py');
    console.log('pipeline_script_contract_test_status=PASS');
  } catch (error) {
    console.error('pipeline_script_contract_test_status=FAIL');
    console.error(error?.message || error);
    process.exitCode = 1;
  }
}

main();
