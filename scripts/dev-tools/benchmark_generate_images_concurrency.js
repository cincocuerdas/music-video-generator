/* eslint-disable no-console */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const PYTHON_COMMAND = process.env.PYTHON_CMD || (process.platform === 'win32' ? 'python' : 'python3');

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  const weight = rank - low;
  return sorted[low] * (1 - weight) + sorted[high] * weight;
}

function parseConcurrencyList(raw) {
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => Number(item))
    .filter((num) => Number.isInteger(num) && num > 0)
    .filter((num, index, arr) => arr.indexOf(num) === index)
    .sort((a, b) => a - b);
}

function parseResultPayload(stdout, stderr) {
  const stderrLines = stderr.split(/\r?\n/).filter(Boolean);
  const resultLines = stderrLines.filter((line) => line.startsWith('RESULT_JSON:'));
  if (resultLines.length > 0) {
    const payload = resultLines[resultLines.length - 1].slice('RESULT_JSON:'.length);
    return JSON.parse(payload);
  }

  const stdoutLines = stdout.split(/\r?\n/).filter(Boolean);
  for (let i = stdoutLines.length - 1; i >= 0; i -= 1) {
    const line = stdoutLines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line);
    } catch (_error) {
      // keep scanning
    }
  }
  return null;
}

function buildScenes(sceneCount) {
  return Array.from({ length: sceneCount }, (_, index) => ({
    sceneIndex: index,
    verseText: `Benchmark verse ${index + 1}`,
    visualPrompt: `cinematic documentary portrait, realistic human anatomy, natural hands, depth of field, scene ${index + 1}`,
    duration: 4,
    verseType: 'NARRATIVE',
  }));
}

async function ensureBenchmarkUser() {
  return prisma.user.upsert({
    where: { email: 'benchmark.local@musicvideo.dev' },
    update: { name: 'Benchmark User' },
    create: { email: 'benchmark.local@musicvideo.dev', name: 'Benchmark User' },
  });
}

async function createBenchmarkProject(userId, sceneCount, iterationLabel) {
  const analysisResult = {
    scenes: buildScenes(sceneCount),
    generatedImages: [],
  };

  return prisma.project.create({
    data: {
      userId,
      title: `benchmark-${iterationLabel}`,
      status: 'DRAFT',
      lyrics: `Benchmark payload for ${iterationLabel}`,
      visualStyle: 'cinematic',
      aspectRatio: '16:9',
      analysisResult,
    },
  });
}

function runGenerateImages(projectId, concurrency, provider) {
  const env = {
    ...process.env,
    IMAGE_PROVIDER: provider,
    IMAGE_GENERATION_CONCURRENCY: String(concurrency),
    PYTHONUNBUFFERED: '1',
  };

  const args = ['scripts/generate_images.py', projectId, `bench-job-${Date.now()}`, '{}'];
  const startedAt = process.hrtime.bigint();
  const result = spawnSync(PYTHON_COMMAND, args, {
    cwd: ROOT_DIR,
    env,
    encoding: 'utf8',
    maxBuffer: 25 * 1024 * 1024,
  });
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

  return {
    elapsedMs,
    statusCode: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? result.error.message : null,
  };
}

function buildMarkdownReport(meta, summaryRows, recommendation) {
  const lines = [];
  lines.push('# Image Generation Concurrency Benchmark');
  lines.push('');
  lines.push(`- Timestamp (UTC): ${meta.generatedAt}`);
  lines.push(`- Provider: \`${meta.provider}\``);
  lines.push(`- Scene count per run: \`${meta.sceneCount}\``);
  lines.push(`- Runs per concurrency: \`${meta.runsPerConcurrency}\``);
  lines.push(`- Warmup runs per concurrency: \`${meta.warmupRuns}\``);
  lines.push(`- Python command: \`${meta.pythonCommand}\``);
  lines.push('');
  lines.push('| Concurrency | Runs | Mean (ms) | p50 (ms) | p95 (ms) | Min (ms) | Max (ms) | Speedup vs 1x (p50) |');
  lines.push('|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of summaryRows) {
    lines.push(
      `| ${row.concurrency} | ${row.runs} | ${row.meanMs.toFixed(1)} | ${row.p50Ms.toFixed(1)} | ${row.p95Ms.toFixed(1)} | ${row.minMs.toFixed(1)} | ${row.maxMs.toFixed(1)} | ${row.speedupVsBaseline.toFixed(2)}x |`,
    );
  }
  lines.push('');
  lines.push(`**Recommendation:** use \`IMAGE_GENERATION_CONCURRENCY=${recommendation.concurrency}\` (best p95=${recommendation.p95Ms.toFixed(1)}ms).`);
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- This benchmark isolates image-stage generation (`generate_images.py`) and is deterministic only for the configured provider.');
  lines.push('- Re-run after infrastructure/model/provider changes and compare p50/p95 drift.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const sceneCount = toNumber(process.env.BENCH_SCENE_COUNT, 12);
  const runsPerConcurrency = toNumber(process.env.BENCH_RUNS_PER_CONCURRENCY, 5);
  const warmupRuns = toNumber(process.env.BENCH_WARMUP_RUNS, 1);
  const provider = process.env.BENCH_IMAGE_PROVIDER || 'mock';
  const concurrencyList = parseConcurrencyList(process.env.BENCH_CONCURRENCY_LIST || '1,2,4,6');

  if (concurrencyList.length === 0) {
    throw new Error('Invalid BENCH_CONCURRENCY_LIST. Example: "1,2,4,6"');
  }

  const benchmarkUser = await ensureBenchmarkUser();
  const allResults = [];

  console.log(`benchmark_config provider=${provider} scenes=${sceneCount} runs=${runsPerConcurrency} warmup=${warmupRuns} list=${concurrencyList.join(',')}`);

  for (const concurrency of concurrencyList) {
    console.log(`benchmark_concurrency_start concurrency=${concurrency}`);

    for (let warmup = 0; warmup < warmupRuns; warmup += 1) {
      const warmupProject = await createBenchmarkProject(benchmarkUser.id, sceneCount, `warmup-c${concurrency}-r${warmup + 1}`);
      try {
        const run = runGenerateImages(warmupProject.id, concurrency, provider);
        if (run.statusCode !== 0) {
          throw new Error(`Warmup failed (status=${run.statusCode}): ${run.error || run.stderr.slice(-300)}`);
        }
      } finally {
        await prisma.project.delete({ where: { id: warmupProject.id } }).catch(() => null);
      }
    }

    for (let runIndex = 0; runIndex < runsPerConcurrency; runIndex += 1) {
      const label = `c${concurrency}-run${runIndex + 1}`;
      const project = await createBenchmarkProject(benchmarkUser.id, sceneCount, label);
      try {
        const run = runGenerateImages(project.id, concurrency, provider);
        const payload = parseResultPayload(run.stdout, run.stderr);

        if (run.statusCode !== 0) {
          throw new Error(`Run ${label} exited with code ${run.statusCode}`);
        }
        if (!payload) {
          throw new Error(`Run ${label} missing RESULT_JSON payload`);
        }
        if (payload.status === 'failed' || payload.success === false) {
          throw new Error(`Run ${label} returned failed payload status=${payload.status}`);
        }

        allResults.push({
          concurrency,
          run: runIndex + 1,
          elapsedMs: run.elapsedMs,
          status: payload.status,
          generatedCount: payload.generatedCount ?? null,
        });
        console.log(`benchmark_run_ok concurrency=${concurrency} run=${runIndex + 1} elapsed_ms=${run.elapsedMs.toFixed(1)} status=${payload.status}`);
      } finally {
        await prisma.project.delete({ where: { id: project.id } }).catch(() => null);
      }
    }
  }

  const baseline = concurrencyList[0];
  const baselineValues = allResults.filter((item) => item.concurrency === baseline).map((item) => item.elapsedMs);
  const baselineP50 = percentile(baselineValues, 50);

  const summaryRows = concurrencyList.map((concurrency) => {
    const values = allResults
      .filter((item) => item.concurrency === concurrency)
      .map((item) => item.elapsedMs)
      .sort((a, b) => a - b);

    const meanMs = values.reduce((sum, value) => sum + value, 0) / values.length;
    const p50Ms = percentile(values, 50);
    const p95Ms = percentile(values, 95);
    const minMs = values[0];
    const maxMs = values[values.length - 1];
    const speedupVsBaseline = baselineP50 > 0 ? baselineP50 / p50Ms : 1;

    return {
      concurrency,
      runs: values.length,
      meanMs,
      p50Ms,
      p95Ms,
      minMs,
      maxMs,
      speedupVsBaseline,
    };
  });

  const recommendation = [...summaryRows].sort((a, b) => a.p95Ms - b.p95Ms)[0];

  const generatedAt = new Date().toISOString();
  const jsonOutput = {
    generatedAt,
    provider,
    sceneCount,
    runsPerConcurrency,
    warmupRuns,
    concurrencyList,
    results: allResults,
    summary: summaryRows,
    recommendation,
  };

  const benchmarkDir = path.join(ROOT_DIR, 'docs', 'benchmarks');
  const tmpDir = path.join(ROOT_DIR, 'storage', 'tmp-tests');
  fs.mkdirSync(benchmarkDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const jsonPath = path.join(tmpDir, `image_generation_concurrency_${generatedAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(jsonOutput, null, 2)}\n`, 'utf8');

  const markdown = buildMarkdownReport(
    {
      generatedAt,
      provider,
      sceneCount,
      runsPerConcurrency,
      warmupRuns,
      pythonCommand: PYTHON_COMMAND,
    },
    summaryRows,
    recommendation,
  );
  const mdPath = path.join(benchmarkDir, 'image-generation-concurrency-baseline.md');
  fs.writeFileSync(mdPath, markdown, 'utf8');

  console.log(`benchmark_report_json=${jsonPath}`);
  console.log(`benchmark_report_markdown=${mdPath}`);
  console.log(
    `benchmark_recommendation concurrency=${recommendation.concurrency} p50_ms=${recommendation.p50Ms.toFixed(1)} p95_ms=${recommendation.p95Ms.toFixed(1)}`,
  );
}

main()
  .catch((error) => {
    console.error(`benchmark_status=FAIL error=${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
