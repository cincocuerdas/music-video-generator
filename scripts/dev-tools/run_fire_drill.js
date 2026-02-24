/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getPostgresContainerName, enablePgvectorExtension } = require('./test_config');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const TMP_DIR = path.join(ROOT_DIR, 'storage', 'tmp-tests');
const REPORT_MD_PATH = path.join(ROOT_DIR, 'docs', 'benchmarks', 'fire-drill-latest.md');
const REPORT_JSON_PATH = path.join(TMP_DIR, `fire_drill_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveNpmCommand() {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return { command: process.execPath, baseArgs: [npmExecPath] };
  }
  if (process.platform === 'win32') {
    return { command: 'npm.cmd', baseArgs: [] };
  }
  return { command: 'npm', baseArgs: [] };
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: options.shell || false,
      env: {
        ...process.env,
        ...(options.env || {}),
      },
    });

    let stdout = '';
    let stderr = '';
    const startedAt = Date.now();

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const timeout = options.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL');
        }, options.timeoutMs)
      : null;

    child.on('error', reject);
    child.on('close', (code) => {
      if (timeout) clearTimeout(timeout);
      const durationMs = Date.now() - startedAt;
      if (code === 0) {
        resolve({ code, stdout, stderr, durationMs });
        return;
      }
      const error = new Error(`${command} ${args.join(' ')} failed with code ${code}`);
      error.stdout = stdout;
      error.stderr = stderr;
      error.durationMs = durationMs;
      reject(error);
    });
  });
}

async function runNpmScript(scriptName, timeoutMs) {
  const npm = resolveNpmCommand();
  return runCommand(npm.command, [...npm.baseArgs, 'run', scriptName], {
    timeoutMs,
    shell: process.platform === 'win32' && npm.command.endsWith('.cmd'),
  });
}

function buildMarkdown(results, generatedAt) {
  const lines = [];
  lines.push('# Backend Fire Drill Report');
  lines.push('');
  lines.push(`- Generated at (UTC): ${generatedAt}`);
  lines.push('');
  lines.push('| Scenario | Status | Duration (ms) | Recovery (ms) | Notes |');
  lines.push('|---|---|---:|---:|---|');
  results.forEach((result) => {
    lines.push(
      `| ${result.name} | ${result.status} | ${result.durationMs} | ${result.recoveryMs ?? '-'} | ${result.notes || '-'} |`,
    );
  });
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function runPostgresRecoveryScenario() {
  const postgresContainer = getPostgresContainerName();
  await runCommand('docker', ['compose', 'up', '-d', 'postgres', 'redis']);
  await runCommand('docker', ['stop', postgresContainer]);
  await sleep(3000);

  const recoveryStartedAt = Date.now();
  await runCommand('docker', ['start', postgresContainer]);
  await enablePgvectorExtension({
    postgresContainer,
    retries: 45,
    delayMs: 1000,
  });
  const recoveryMs = Date.now() - recoveryStartedAt;

  const check = await runNpmScript('test:pipeline-status', 10 * 60 * 1000);
  return {
    durationMs: check.durationMs,
    recoveryMs,
    notes: 'postgres restart + pgvector ready + pipeline-status pass',
  };
}

async function runScenario(name, runner) {
  const startedAt = Date.now();
  try {
    const outcome = await runner();
    return {
      name,
      status: 'PASS',
      durationMs: Date.now() - startedAt,
      recoveryMs: outcome?.recoveryMs,
      notes: outcome?.notes || '',
    };
  } catch (error) {
    const details = [];
    if (error?.message) details.push(error.message);
    if (typeof error?.stderr === 'string' && error.stderr.trim()) {
      details.push(error.stderr.trim().slice(-600));
    }
    return {
      name,
      status: 'FAIL',
      durationMs: Date.now() - startedAt,
      recoveryMs: null,
      notes: details.join(' | ').slice(0, 1000),
    };
  }
}

async function main() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(REPORT_MD_PATH), { recursive: true });

  const scenarios = [
    {
      name: 'redis_recovery',
      runner: async () => {
        const result = await runNpmScript('test:resilience', 15 * 60 * 1000);
        return {
          recoveryMs: result.durationMs,
          notes: 'validated through test:resilience',
        };
      },
    },
    {
      name: 'postgres_restart_recovery',
      runner: runPostgresRecoveryScenario,
    },
    {
      name: 'external_dependency_degraded_mode',
      runner: async () => {
        const result = await runNpmScript('test:external-chaos', 15 * 60 * 1000);
        return {
          recoveryMs: result.durationMs,
          notes: 'validated degraded fallback under dependency outage',
        };
      },
    },
  ];

  const results = [];
  for (const scenario of scenarios) {
    console.log(`fire_drill_scenario_start=${scenario.name}`);
    // eslint-disable-next-line no-await-in-loop
    const result = await runScenario(scenario.name, scenario.runner);
    results.push(result);
    console.log(`fire_drill_scenario_end=${scenario.name} status=${result.status} duration_ms=${result.durationMs}`);
  }

  const generatedAt = new Date().toISOString();
  const report = {
    generatedAt,
    results,
    overallStatus: results.every((result) => result.status === 'PASS') ? 'PASS' : 'FAIL',
  };

  fs.writeFileSync(REPORT_JSON_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(REPORT_MD_PATH, buildMarkdown(results, generatedAt), 'utf8');

  console.log(`fire_drill_report_json=${REPORT_JSON_PATH}`);
  console.log(`fire_drill_report_markdown=${REPORT_MD_PATH}`);
  console.log(`fire_drill_status=${report.overallStatus}`);

  if (report.overallStatus !== 'PASS') {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`fire_drill_status=FAIL error=${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
