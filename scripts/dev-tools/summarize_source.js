const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function usage() {
  console.log([
    'Usage: node scripts/dev-tools/summarize_source.js <url-or-path> [--mode extract|summary] [--model <provider/model>] [--out <file>]',
    '',
    'Defaults:',
    '  --mode extract   Safe mode for URLs. No LLM key required.',
    '  --model auto     Only used in --mode summary.',
    '',
    'Examples:',
    '  npm run summarize:source -- https://example.com',
    '  npm run summarize:source -- README.md --mode summary --model google/gemini-2.5-flash',
  ].join('\n'));
}

function parseArgs(argv) {
  const parsed = { input: null, mode: 'extract', model: 'auto', out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!parsed.input && !arg.startsWith('--')) {
      parsed.input = arg;
      continue;
    }
    if (arg === '--mode') {
      parsed.mode = argv[i + 1] || parsed.mode;
      i += 1;
      continue;
    }
    if (arg === '--model') {
      parsed.model = argv[i + 1] || parsed.model;
      i += 1;
      continue;
    }
    if (arg === '--out') {
      parsed.out = argv[i + 1] || parsed.out;
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function sanitizeForFileName(value) {
  return value.replace(/^https?:\/\//i, '').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/_+/g, '_').slice(0, 80);
}

function resolveOutputPath(input, explicitOut) {
  if (explicitOut) return path.resolve(explicitOut);
  const dir = path.resolve('output', 'summaries');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, `${sanitizeForFileName(input)}_${stamp}.json`);
}

function resolveCommandAndArgs(parsed) {
  const cli = path.resolve('node_modules', '@steipete', 'summarize', 'dist', 'cli.js');
  if (!fs.existsSync(cli)) {
    throw new Error('summarize CLI not found. Run npm install first.');
  }

  const inputPath = path.resolve(parsed.input);
  const inputIsLocalFile = fs.existsSync(inputPath);
  if (parsed.mode === 'extract' && inputIsLocalFile) {
    throw new Error('extract mode only supports URLs. For local files, use --mode summary.');
  }

  const args = [cli, parsed.input, '--json', '--stream', 'off'];
  if (parsed.mode === 'extract') {
    args.push('--extract');
  } else {
    args.push('--model', parsed.model);
  }

  return { command: process.execPath, args };
}

async function run() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help || !parsed.input) {
    usage();
    process.exit(parsed.help ? 0 : 1);
  }
  if (!['extract', 'summary'].includes(parsed.mode)) {
    throw new Error(`Unsupported mode: ${parsed.mode}`);
  }

  const outputPath = resolveOutputPath(parsed.input, parsed.out);
  const { command, args } = resolveCommandAndArgs(parsed);
  const stdout = [];
  const stderr = [];
  const child = spawn(command, args, { cwd: process.cwd(), shell: false, env: process.env });
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));

  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });

  const stdoutText = Buffer.concat(stdout).toString('utf8').trim();
  const stderrText = Buffer.concat(stderr).toString('utf8').trim();
  if (exitCode !== 0) {
    throw new Error(`summarize exited with code ${exitCode}${stderrText ? `\n${stderrText}` : ''}`);
  }

  let payload;
  try {
    payload = JSON.parse(stdoutText);
  } catch (error) {
    throw new Error(`Failed to parse summarize JSON output: ${error.message}\n${stdoutText.slice(0, 1000)}`);
  }

  const envelope = {
    tool: '@steipete/summarize',
    mode: parsed.mode,
    input: parsed.input,
    model: parsed.mode === 'summary' ? parsed.model : null,
    generatedAt: new Date().toISOString(),
    stderr: stderrText || null,
    payload,
  };

  fs.writeFileSync(outputPath, JSON.stringify(envelope, null, 2), 'utf8');
  console.log('summarize_source_status=PASS');
  console.log(`mode=${parsed.mode}`);
  console.log(`output=${outputPath}`);
  if (payload?.summary) console.log('summary_present=true');
  if (payload?.extract?.content || payload?.content || payload?.extracted) console.log('content_present=true');
}

run().catch((error) => {
  console.error('summarize_source_status=FAIL');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
