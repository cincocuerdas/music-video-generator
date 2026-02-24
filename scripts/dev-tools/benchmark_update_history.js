/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const TMP_DIR = path.join(ROOT_DIR, 'storage', 'tmp-tests');
const HISTORY_FILE_DEFAULT = path.join(
  ROOT_DIR,
  'docs',
  'benchmarks',
  'history',
  'image-generation-concurrency-history.ndjson',
);
const HISTORY_MD_DEFAULT = path.join(
  ROOT_DIR,
  'docs',
  'benchmarks',
  'history',
  'image-generation-concurrency-history.md',
);

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function findLatestBenchmarkJson() {
  if (!fs.existsSync(TMP_DIR)) {
    return null;
  }

  const files = fs
    .readdirSync(TMP_DIR)
    .filter((name) => /^image_generation_concurrency_.*\.json$/i.test(name))
    .map((name) => ({
      name,
      fullPath: path.join(TMP_DIR, name),
      mtimeMs: fs.statSync(path.join(TMP_DIR, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return files[0]?.fullPath || null;
}

function readHistoryEntries(historyPath) {
  if (!fs.existsSync(historyPath)) {
    return [];
  }

  return fs
    .readFileSync(historyPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function writeHistoryEntries(historyPath, entries) {
  const output = entries.map((entry) => JSON.stringify(entry)).join('\n');
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.writeFileSync(historyPath, `${output}${output ? '\n' : ''}`, 'utf8');
}

function renderHistoryMarkdown(entries, historyPath, markdownPath) {
  const sorted = [...entries].sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));
  const rows = sorted.slice(0, 30);
  const lines = [];
  lines.push('# Image Generation Concurrency History');
  lines.push('');
  lines.push(`Source: \`${path.relative(ROOT_DIR, historyPath)}\``);
  lines.push('');
  lines.push('| Timestamp (UTC) | Provider | Scenes | Runs | Recommended Concurrency | p50 (ms) | p95 (ms) | SLO Status |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---|');
  rows.forEach((entry) => {
    lines.push(
      `| ${entry.generatedAt || '-'} | ${entry.provider || '-'} | ${entry.sceneCount ?? '-'} | ${entry.runsPerConcurrency ?? '-'} | ${entry.recommendation?.concurrency ?? '-'} | ${Number(entry.recommendation?.p50Ms || 0).toFixed(1)} | ${Number(entry.recommendation?.p95Ms || 0).toFixed(1)} | ${entry.sloStatus || 'unknown'} |`,
    );
  });
  lines.push('');

  fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
  fs.writeFileSync(markdownPath, `${lines.join('\n')}\n`, 'utf8');
}

function buildHistoryEntry(payload) {
  const recommendation = payload.recommendation || {};
  return {
    generatedAt: payload.generatedAt,
    provider: payload.provider,
    sceneCount: payload.sceneCount,
    runsPerConcurrency: payload.runsPerConcurrency,
    warmupRuns: payload.warmupRuns,
    recommendation: {
      concurrency: recommendation.concurrency,
      p50Ms: recommendation.p50Ms,
      p95Ms: recommendation.p95Ms,
    },
    summary: payload.summary || [],
    sloStatus: 'pending',
  };
}

function main() {
  const benchmarkJsonPath = process.env.BENCHMARK_JSON_PATH || findLatestBenchmarkJson();
  if (!benchmarkJsonPath) {
    throw new Error('No benchmark JSON found. Run bench:image-generation-concurrency first.');
  }

  const historyPath = process.env.BENCH_HISTORY_FILE || HISTORY_FILE_DEFAULT;
  const historyMdPath = process.env.BENCH_HISTORY_MARKDOWN_FILE || HISTORY_MD_DEFAULT;
  const maxEntries = toNumber(process.env.BENCH_HISTORY_MAX_ENTRIES, 500);

  const payload = JSON.parse(fs.readFileSync(benchmarkJsonPath, 'utf8'));
  const newEntry = buildHistoryEntry(payload);

  const currentEntries = readHistoryEntries(historyPath);
  const deduped = currentEntries.filter((entry) => entry.generatedAt !== newEntry.generatedAt);
  deduped.push(newEntry);

  deduped.sort((a, b) => String(a.generatedAt).localeCompare(String(b.generatedAt)));
  const trimmed = deduped.slice(Math.max(0, deduped.length - maxEntries));

  writeHistoryEntries(historyPath, trimmed);
  renderHistoryMarkdown(trimmed, historyPath, historyMdPath);

  console.log(`benchmark_history_source=${benchmarkJsonPath}`);
  console.log(`benchmark_history_file=${historyPath}`);
  console.log(`benchmark_history_markdown=${historyMdPath}`);
  console.log(`benchmark_history_entries=${trimmed.length}`);
  console.log('benchmark_history_status=PASS');
}

try {
  main();
} catch (error) {
  console.error(`benchmark_history_status=FAIL error=${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
