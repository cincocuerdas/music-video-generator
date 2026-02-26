/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getApiBaseUrl, getPostgresContainerName, enablePgvectorExtension } = require('./test_config');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const LOG_DIR = path.join(ROOT_DIR, 'storage', 'tmp-tests');
const STDOUT_LOG = path.join(LOG_DIR, 'backend-pipeline-status.out.log');
const STDERR_LOG = path.join(LOG_DIR, 'backend-pipeline-status.err.log');
const API_BASE_URL = getApiBaseUrl();
const HEALTH_URL = `${API_BASE_URL}/health`;
const POSTGRES_CONTAINER = getPostgresContainerName();
const TEST_PIPELINE_STATUS_YOUTUBE_URL =
  process.env.TEST_PIPELINE_STATUS_YOUTUBE_URL || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const TEST_PIPELINE_STATUS_COMFYUI_URL =
  process.env.TEST_PIPELINE_STATUS_COMFYUI_URL ||
  process.env.COMFYUI_URL ||
  'http://127.0.0.1:8188';
const TEST_PIPELINE_STATUS_GEMINI_KEY =
  process.env.TEST_PIPELINE_STATUS_GEMINI_KEY ||
  process.env.GEMINI_API_KEY ||
  'test-gemini-key';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const useShell =
      typeof options.shell === 'boolean'
        ? options.shell
        : process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);

    const child = spawn(command, args, {
      cwd: ROOT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: useShell,
      ...options,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(`${command} ${args.join(' ')} failed with code ${code}`);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

function resolveNpmCommand(args) {
  if (process.platform === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', `npm ${args.join(' ')}`],
    };
  }
  return { command: 'npm', args };
}

function resolveBackendEntry() {
  const candidates = [path.join(ROOT_DIR, 'dist', 'main.js'), path.join(ROOT_DIR, 'dist', 'src', 'main.js')];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function ensureBackendBuild() {
  const forceRebuild = (process.env.TESTS_FORCE_REBUILD || '').toLowerCase() === 'true';
  const entry = resolveBackendEntry();
  if (entry && !forceRebuild) {
    console.log(`step=build_skip entry=${path.relative(ROOT_DIR, entry)}`);
    return;
  }

  console.log('step=build');
  const npmBuild = resolveNpmCommand(['run', 'build']);
  await runCommand(npmBuild.command, npmBuild.args);
}

function startBackend() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  if (fs.existsSync(STDOUT_LOG)) fs.unlinkSync(STDOUT_LOG);
  if (fs.existsSync(STDERR_LOG)) fs.unlinkSync(STDERR_LOG);

  const stdoutStream = fs.createWriteStream(STDOUT_LOG, { flags: 'a' });
  const stderrStream = fs.createWriteStream(STDERR_LOG, { flags: 'a' });

  const backendEntry = resolveBackendEntry();
  if (!backendEntry) {
    throw new Error('backend_entry_missing_after_build');
  }

  const child = spawn(process.execPath, [backendEntry], {
    cwd: ROOT_DIR,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    env: {
      ...process.env,
      ALLOW_DEV_AUTH_BYPASS: process.env.ALLOW_DEV_AUTH_BYPASS || 'true',
      USE_MOCK_PROCESSORS: process.env.USE_MOCK_PROCESSORS || 'true',
      IMAGE_PROVIDER: process.env.TEST_PIPELINE_STATUS_IMAGE_PROVIDER || 'comfyui',
      LLM_PROVIDER: process.env.TEST_PIPELINE_STATUS_LLM_PROVIDER || 'gemini',
      COMFYUI_URL: TEST_PIPELINE_STATUS_COMFYUI_URL,
      GEMINI_API_KEY: TEST_PIPELINE_STATUS_GEMINI_KEY,
    },
  });

  child.stdout?.pipe(stdoutStream);
  child.stderr?.pipe(stderrStream);

  return { child, stdoutStream, stderrStream };
}

async function killProcessTree(pid) {
  if (!pid) {
    return;
  }

  if (process.platform === 'win32') {
    await runCommand('taskkill', ['/pid', String(pid), '/T', '/F']).catch(() => {});
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // ignore
    }
  }
}

async function apiRequestRaw(url, init = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });

    const raw = await response.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = { raw };
    }

    return { status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
}

async function apiRequest(url, init = {}, timeoutMs = 10000) {
  const result = await apiRequestRaw(url, init, timeoutMs);
  if (result.status >= 400) {
    throw new Error(`HTTP ${result.status} on ${url}: ${JSON.stringify(result.data)}`);
  }
  return result.data;
}

async function waitForHealth(attempts = 80, sleepMs = 2000) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const health = await apiRequestRaw(HEALTH_URL, {}, 3000);
      if (health.status === 200) {
        return true;
      }
    } catch {
      // retry
    }
    await sleep(sleepMs);
  }
  return false;
}

function buildAuthHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

async function setProjectStatus(projectId, status) {
  await runCommand('docker', [
    'exec',
    POSTGRES_CONTAINER,
    'psql',
    '-U',
    'postgres',
    '-d',
    'musicvideo',
    '-c',
    `UPDATE "Project" SET "status"='${status}' WHERE "id"='${projectId}'::uuid;`,
  ]);
}

async function setProjectAudioUrl(projectId, audioUrl) {
  await runCommand('docker', [
    'exec',
    POSTGRES_CONTAINER,
    'psql',
    '-U',
    'postgres',
    '-d',
    'musicvideo',
    '-c',
    `UPDATE "Project" SET "audioUrl"='${audioUrl}' WHERE "id"='${projectId}'::uuid;`,
  ]);
}

async function createProject(token, title) {
  const project = await apiRequest(`${API_BASE_URL}/projects`, {
    method: 'POST',
    headers: buildAuthHeaders(token),
    body: JSON.stringify({
      title,
      visualStyle: 'cinematic',
      lyrics: 'test',
      aspectRatio: '16:9',
    }),
  });

  assert(project?.id, 'missing_project_id');
  return project.id;
}

async function createProjectWithPayload(token, payload) {
  const project = await apiRequest(`${API_BASE_URL}/projects`, {
    method: 'POST',
    headers: buildAuthHeaders(token),
    body: JSON.stringify(payload),
  });

  assert(project?.id, 'missing_project_id');
  return project.id;
}

async function startPipeline(token, projectId) {
  return apiRequest(`${API_BASE_URL}/jobs/pipeline/${projectId}/start`, {
    method: 'POST',
    headers: buildAuthHeaders(token),
  });
}

function assertJobOrder(jobs, expectedOrder, label) {
  const types = (jobs || []).map((job) => job.type);
  const actual = types.join(',');
  const expected = expectedOrder.join(',');
  assert(actual === expected, `${label}_pipeline_order_mismatch actual=${actual} expected=${expected}`);
}

async function createJob(token, projectId, type) {
  const job = await apiRequest(`${API_BASE_URL}/jobs`, {
    method: 'POST',
    headers: buildAuthHeaders(token),
    body: JSON.stringify({ projectId, type }),
  });
  assert(job?.id, `missing_job_id_${type}`);
  return job.id;
}

async function patchJob(token, jobId, data) {
  return apiRequest(`${API_BASE_URL}/jobs/${jobId}`, {
    method: 'PATCH',
    headers: buildAuthHeaders(token),
    body: JSON.stringify(data),
  });
}

async function assertPipelineProjection(token, projectId, expected) {
  const authHeaders = buildAuthHeaders(token);

  const projectStatus = await apiRequest(`${API_BASE_URL}/projects/${projectId}/status`, {
    method: 'GET',
    headers: authHeaders,
  });
  const videoStatus = await apiRequest(`${API_BASE_URL}/projects/${projectId}/video`, {
    method: 'GET',
    headers: authHeaders,
  });
  const pipelineStatus = await apiRequest(`${API_BASE_URL}/jobs/pipeline/${projectId}`, {
    method: 'GET',
    headers: authHeaders,
  });

  assert(
    projectStatus.pipelineStatus === expected.pipelineStatus,
    `project_status_pipelineStatus_mismatch:${projectStatus.pipelineStatus}`,
  );
  assert(
    pipelineStatus.pipelineStatus === expected.pipelineStatus,
    `jobs_pipelineStatus_mismatch:${pipelineStatus.pipelineStatus}`,
  );
  assert(
    videoStatus.pipelineStatus === expected.pipelineStatus,
    `video_pipelineStatus_mismatch:${videoStatus.pipelineStatus}`,
  );
  assert(
    Boolean(projectStatus.degraded) === Boolean(expected.degraded),
    `project_degraded_mismatch:${projectStatus.degraded}`,
  );
  assert(
    Boolean(pipelineStatus.degraded) === Boolean(expected.degraded),
    `jobs_degraded_mismatch:${pipelineStatus.degraded}`,
  );
  assert(
    Boolean(videoStatus.degraded) === Boolean(expected.degraded),
    `video_degraded_mismatch:${videoStatus.degraded}`,
  );

  if (expected.reasonCodeIncludes) {
    const combinedCodes = [
      ...(projectStatus.degradedReasonCodes || []),
      ...(pipelineStatus.degradedReasonCodes || []),
      ...(videoStatus.degradedReasonCodes || []),
    ].join(' | ');
    assert(
      combinedCodes.includes(expected.reasonCodeIncludes),
      `missing_expected_reason_code:${expected.reasonCodeIncludes}`,
    );
  }

  if (expected.reasonIncludes) {
    const combinedReasons = [
      ...(projectStatus.degradedReasons || []),
      ...(pipelineStatus.degradedReasons || []),
      ...(videoStatus.degradedReasons || []),
    ].join(' | ');
    assert(
      combinedReasons.includes(expected.reasonIncludes),
      `missing_expected_reason:${expected.reasonIncludes}`,
    );
  }
}

async function assertDegradedOpsShape() {
  const degradedOps = await apiRequest(`${API_BASE_URL}/health/ops/degraded?hours=24`, {
    method: 'GET',
  });

  assert(
    degradedOps?.status === 'ok' || degradedOps?.status === 'degraded',
    `degraded_ops_status_mismatch:${degradedOps?.status}`,
  );
  assert(Array.isArray(degradedOps?.byType), 'degraded_ops_byType_not_array');
  assert(typeof degradedOps?.windowHours === 'number', 'degraded_ops_windowHours_not_number');
  assert(degradedOps?.totals && typeof degradedOps.totals === 'object', 'degraded_ops_totals_missing');
  assert(degradedOps?.alerts && typeof degradedOps.alerts === 'object', 'degraded_ops_alerts_missing');

  const realtimeOps = await apiRequest(`${API_BASE_URL}/health/ops/realtime`, {
    method: 'GET',
  });
  assert(realtimeOps?.status === 'ok', `realtime_ops_status_mismatch:${realtimeOps?.status}`);
  assert(
    realtimeOps?.realtimeEvents && typeof realtimeOps.realtimeEvents === 'object',
    'realtime_ops_metrics_missing',
  );

  const qualityOps = await apiRequest(`${API_BASE_URL}/health/ops/pipeline-quality?hours=24`, {
    method: 'GET',
  });
  assert(qualityOps?.status === 'ok', `pipeline_quality_status_mismatch:${qualityOps?.status}`);
  assert(Array.isArray(qualityOps?.byType), 'pipeline_quality_byType_not_array');
  assert(Array.isArray(qualityOps?.byReasonCode), 'pipeline_quality_byReasonCode_not_array');
}

async function main() {
  let backend;

  try {
    console.log('step=deps_up');
    await runCommand('docker', ['compose', 'up', '-d', 'postgres', 'redis']);

    console.log('step=enable_pgvector');
    await enablePgvectorExtension({ postgresContainer: POSTGRES_CONTAINER });

    console.log('step=db_push');
    const npmDbPush = resolveNpmCommand(['run', 'db:push']);
    await runCommand(npmDbPush.command, npmDbPush.args);

    await ensureBackendBuild();

    console.log('step=backend_start');
    backend = startBackend();
    console.log(`backend_pid=${backend.child.pid}`);

    const healthy = await waitForHealth();
    assert(healthy, 'health_timeout');
    console.log('health=ok');

    const login = await apiRequest(`${API_BASE_URL}/auth/login/dev`, {
      method: 'POST',
      body: '{}',
    });
    const token = login?.accessToken;
    assert(token, 'missing_access_token');

    await assertDegradedOpsShape();

    // Source routing: lyrics-only should skip download/transcription
    const lyricsOnlyProjectId = await createProjectWithPayload(token, {
      title: `Route Lyrics ${Date.now()}`,
      lyrics: 'manual lyrics route',
      visualStyle: 'cinematic',
      aspectRatio: '16:9',
    });
    const lyricsJobs = await startPipeline(token, lyricsOnlyProjectId);
    assertJobOrder(
      lyricsJobs,
      ['ANALYZE_LYRICS', 'GENERATE_IMAGES', 'RENDER_VIDEO', 'FINALIZE'],
      'lyrics_only',
    );
    console.log(`case_routing_lyrics=PASS project=${lyricsOnlyProjectId}`);

    // Source routing: audio-only should skip youtube_download but keep transcription
    const audioOnlyProjectId = await createProjectWithPayload(token, {
      title: `Route Audio ${Date.now()}`,
      visualStyle: 'cinematic',
      aspectRatio: '16:9',
    });
    await setProjectAudioUrl(audioOnlyProjectId, '/output/audio/mock-track.wav');
    const audioJobs = await startPipeline(token, audioOnlyProjectId);
    assertJobOrder(
      audioJobs,
      ['TRANSCRIPTION', 'ANALYZE_LYRICS', 'GENERATE_IMAGES', 'RENDER_VIDEO', 'FINALIZE'],
      'audio_only',
    );
    console.log(`case_routing_audio=PASS project=${audioOnlyProjectId}`);

    // Source routing: youtube should keep full pipeline
    const youtubeProjectId = await createProjectWithPayload(token, {
      title: `Route Youtube ${Date.now()}`,
      youtubeUrl: TEST_PIPELINE_STATUS_YOUTUBE_URL,
      visualStyle: 'cinematic',
      aspectRatio: '16:9',
    });
    const youtubeJobs = await startPipeline(token, youtubeProjectId);
    assertJobOrder(
      youtubeJobs,
      ['YOUTUBE_DOWNLOAD', 'TRANSCRIPTION', 'ANALYZE_LYRICS', 'GENERATE_IMAGES', 'RENDER_VIDEO', 'FINALIZE'],
      'youtube_source',
    );
    console.log(`case_routing_youtube=PASS project=${youtubeProjectId}`);

    // Case 1: degraded
    const degradedProjectId = await createProject(token, `Pipeline Degraded ${Date.now()}`);
    const degradedJobA = await createJob(token, degradedProjectId, 'YOUTUBE_DOWNLOAD');
    const degradedJobB = await createJob(token, degradedProjectId, 'RENDER_VIDEO');
    await patchJob(token, degradedJobA, {
      status: 'COMPLETED',
      progress: 100,
      outputData: { status: 'success' },
    });
    await patchJob(token, degradedJobB, {
      status: 'COMPLETED',
      progress: 100,
      outputData: {
        status: 'degraded',
        degraded: true,
        degradedReasons: ['ffmpeg-fallback'],
        message: 'fallback output used',
      },
    });
    await setProjectStatus(degradedProjectId, 'COMPLETED');
    await assertPipelineProjection(token, degradedProjectId, {
      pipelineStatus: 'degraded',
      degraded: true,
      reasonIncludes: 'RENDER_VIDEO: ffmpeg-fallback',
      reasonCodeIncludes: 'render_video.ffmpeg_fallback',
    });
    console.log(`case_degraded=PASS project=${degradedProjectId}`);

    // Case 2: success
    const successProjectId = await createProject(token, `Pipeline Success ${Date.now()}`);
    const successJobA = await createJob(token, successProjectId, 'YOUTUBE_DOWNLOAD');
    const successJobB = await createJob(token, successProjectId, 'RENDER_VIDEO');
    await patchJob(token, successJobA, {
      status: 'COMPLETED',
      progress: 100,
      outputData: { status: 'success' },
    });
    await patchJob(token, successJobB, {
      status: 'COMPLETED',
      progress: 100,
      outputData: { status: 'success' },
    });
    await setProjectStatus(successProjectId, 'COMPLETED');
    await assertPipelineProjection(token, successProjectId, {
      pipelineStatus: 'success',
      degraded: false,
    });
    console.log(`case_success=PASS project=${successProjectId}`);

    // Case 3: failed
    const failedProjectId = await createProject(token, `Pipeline Failed ${Date.now()}`);
    const failedJob = await createJob(token, failedProjectId, 'TRANSCRIPTION');
    await patchJob(token, failedJob, {
      status: 'FAILED',
      progress: 0,
      errorMessage: 'forced failure',
      outputData: { status: 'failed', error: 'forced failure' },
    });
    await setProjectStatus(failedProjectId, 'FAILED');
    await assertPipelineProjection(token, failedProjectId, {
      pipelineStatus: 'failed',
      degraded: false,
    });
    console.log(`case_failed=PASS project=${failedProjectId}`);

    console.log('pipeline_status_test_status=PASS');
  } catch (error) {
    console.error('pipeline_status_test_status=FAIL');
    console.error(error?.message || error);
    process.exitCode = 1;
  } finally {
    if (backend?.child?.pid) {
      await killProcessTree(backend.child.pid);
    }
    backend?.stdoutStream?.end();
    backend?.stderrStream?.end();
  }
}

main();
