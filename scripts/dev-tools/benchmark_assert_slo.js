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

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  const weight = rank - low;
  return sorted[low] * (1 - weight) + sorted[high] * weight;
}

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
  if (!fs.existsSync(historyPath)) return [];
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

function renderHistoryMarkdown(entries, historyPath) {
  const markdownPath = path.join(path.dirname(historyPath), 'image-generation-concurrency-history.md');
  const sorted = [...entries].sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));
  const lines = [];
  lines.push('# Image Generation Concurrency History');
  lines.push('');
  lines.push(`Source: \`${path.relative(ROOT_DIR, historyPath)}\``);
  lines.push('');
  lines.push('| Timestamp (UTC) | Provider | Scenes | Runs | Recommended Concurrency | p50 (ms) | p95 (ms) | SLO Status |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---|');
  sorted.slice(0, 30).forEach((entry) => {
    lines.push(
      `| ${entry.generatedAt || '-'} | ${entry.provider || '-'} | ${entry.sceneCount ?? '-'} | ${entry.runsPerConcurrency ?? '-'} | ${entry.recommendation?.concurrency ?? '-'} | ${Number(entry.recommendation?.p50Ms || 0).toFixed(1)} | ${Number(entry.recommendation?.p95Ms || 0).toFixed(1)} | ${entry.sloStatus || 'unknown'} |`,
    );
  });
  lines.push('');
  fs.writeFileSync(markdownPath, `${lines.join('\n')}\n`, 'utf8');
}

function determineSloDefaults(provider) {
  if (provider === 'mock') {
    return { p50: 350, p95: 500 };
  }
  if (provider === 'comfyui') {
    return { p50: 180000, p95: 300000 };
  }
  return { p50: 60000, p95: 120000 };
}

function main() {
  const benchmarkJsonPath = process.env.BENCHMARK_JSON_PATH || findLatestBenchmarkJson();
  if (!benchmarkJsonPath) {
    throw new Error('No benchmark JSON found. Run bench:image-generation-concurrency first.');
  }

  const historyPath = process.env.BENCH_HISTORY_FILE || HISTORY_FILE_DEFAULT;
  const regressionWindow = toNumber(process.env.BENCH_REGRESSION_WINDOW, 20);
  const regressionMultiplier = toNumber(process.env.BENCH_REGRESSION_P95_MULTIPLIER, 1.25);
  const failOnBreach = (process.env.BENCH_FAIL_ON_SLO_BREACH || 'false').toLowerCase() === 'true';

  const payload = JSON.parse(fs.readFileSync(benchmarkJsonPath, 'utf8'));
  const provider = payload.provider || 'unknown';
  const recommendation = payload.recommendation || {};
  const currentP50 = toNumber(recommendation.p50Ms, 0);
  const currentP95 = toNumber(recommendation.p95Ms, 0);

  const defaults = determineSloDefaults(provider);
  const sloP50 = toNumber(process.env.BENCH_SLO_P50_MS, defaults.p50);
  const sloP95 = toNumber(process.env.BENCH_SLO_P95_MS, defaults.p95);

  const historyEntries = readHistoryEntries(historyPath)
    .filter((entry) => entry.provider === provider && entry.generatedAt !== payload.generatedAt)
    .sort((a, b) => String(a.generatedAt).localeCompare(String(b.generatedAt)));
  const historyWindow = historyEntries.slice(Math.max(0, historyEntries.length - regressionWindow));
  const historicalP95 = historyWindow
    .map((entry) => toNumber(entry?.recommendation?.p95Ms, NaN))
    .filter((value) => Number.isFinite(value) && value > 0);
  const historicalMedianP95 = historicalP95.length ? percentile(historicalP95, 50) : 0;

  const breaches = [];
  if (currentP50 > sloP50) {
    breaches.push(`p50 ${currentP50.toFixed(1)}ms > SLO ${sloP50.toFixed(1)}ms`);
  }
  if (currentP95 > sloP95) {
    breaches.push(`p95 ${currentP95.toFixed(1)}ms > SLO ${sloP95.toFixed(1)}ms`);
  }
  if (historicalMedianP95 > 0) {
    const maxAllowedP95 = historicalMedianP95 * regressionMultiplier;
    if (currentP95 > maxAllowedP95) {
      breaches.push(
        `p95 regression ${currentP95.toFixed(1)}ms > median(${historicalMedianP95.toFixed(1)}ms) * ${regressionMultiplier.toFixed(2)} (${maxAllowedP95.toFixed(1)}ms)`,
      );
    }
  }

  const status = breaches.length > 0 ? 'FAIL' : 'PASS';
  const result = {
    generatedAt: payload.generatedAt,
    provider,
    recommendationConcurrency: recommendation.concurrency,
    currentP50,
    currentP95,
    sloP50,
    sloP95,
    historicalMedianP95,
    regressionMultiplier,
    status,
    breaches,
    benchmarkJsonPath,
    historyPath,
  };

  const outputPath = path.join(ROOT_DIR, 'storage', 'tmp-tests', 'benchmark_slo_latest.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  // Update latest matching history entry with SLO evaluation status.
  if (fs.existsSync(historyPath)) {
    const mutableHistory = readHistoryEntries(historyPath);
    let updated = false;
    for (let i = mutableHistory.length - 1; i >= 0; i -= 1) {
      if (mutableHistory[i]?.generatedAt === payload.generatedAt && mutableHistory[i]?.provider === provider) {
        mutableHistory[i].sloStatus = status.toLowerCase();
        mutableHistory[i].sloCheckedAt = new Date().toISOString();
        mutableHistory[i].sloBreaches = breaches;
        updated = true;
        break;
      }
    }
    if (updated) {
      writeHistoryEntries(historyPath, mutableHistory);
      renderHistoryMarkdown(mutableHistory, historyPath);
    }
  }

  console.log(`benchmark_slo_status=${status}`);
  console.log(`benchmark_slo_json=${outputPath}`);
  console.log(
    `benchmark_slo_metrics provider=${provider} concurrency=${recommendation.concurrency} p50_ms=${currentP50.toFixed(1)} p95_ms=${currentP95.toFixed(1)} slo_p50_ms=${sloP50.toFixed(1)} slo_p95_ms=${sloP95.toFixed(1)} history_median_p95_ms=${historicalMedianP95.toFixed(1)}`,
  );
  if (breaches.length) {
    console.error(`benchmark_slo_breaches=${breaches.join(' | ')}`);
    if (failOnBreach) {
      process.exit(1);
    }
  }
}

try {
  main();
} catch (error) {
  console.error(`benchmark_slo_status=FAIL error=${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
