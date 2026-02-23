/* eslint-disable no-console */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { randomUUID, createHmac, timingSafeEqual } = require('crypto');
const { spawn } = require('child_process');
const { getApiBaseUrl, getPostgresContainerName, enablePgvectorExtension } = require('./test_config');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const LOG_DIR = path.join(ROOT_DIR, 'storage', 'tmp-tests');
const STDOUT_LOG = path.join(LOG_DIR, 'backend-health-alert-webhook.out.log');
const STDERR_LOG = path.join(LOG_DIR, 'backend-health-alert-webhook.err.log');
const API_BASE_URL = getApiBaseUrl();
const HEALTH_URL = `${API_BASE_URL}/health`;
const POSTGRES_CONTAINER = getPostgresContainerName();

const WEBHOOK_PATH = '/hook';
const WEBHOOK_SECRET = process.env.HEALTH_WEBHOOK_TEST_SECRET || 'test-health-webhook-secret';
const METRIC_HOURS = 1;
const WEBHOOK_MAX_SKEW_SEC = Number(process.env.HEALTH_WEBHOOK_TEST_MAX_SKEW_SEC || '300');

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

function startBackend(webhookUrl) {
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
      HEALTH_DEGRADED_ALERT_MIN_COMPLETED_WINDOW: '1',
      HEALTH_DEGRADED_ALERT_WARN_PCT: '0.01',
      HEALTH_DEGRADED_ALERT_CRITICAL_PCT: '0.01',
      HEALTH_DEGRADED_ALERT_COOLDOWN_MS: '600000',
      HEALTH_ALERT_WEBHOOK_TIMEOUT_MS: '3000',
      HEALTH_ALERT_WEBHOOK_SECRET: WEBHOOK_SECRET,
      HEALTH_ALERT_WEBHOOK_URL: webhookUrl,
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

async function createProject(token, title) {
  const project = await apiRequest(`${API_BASE_URL}/projects`, {
    method: 'POST',
    headers: buildAuthHeaders(token),
    body: JSON.stringify({
      title,
      visualStyle: 'cinematic',
      lyrics: 'health webhook alert test',
      aspectRatio: '16:9',
    }),
  });
  assert(project?.id, 'missing_project_id');
  return project.id;
}

async function insertDegradedCompletedJob(projectId) {
  const jobId = randomUUID();
  const sql = `
    INSERT INTO "Job" ("id","projectId","type","status","progress","outputData","createdAt","updatedAt")
    VALUES ('${jobId}'::uuid,'${projectId}'::uuid,'FINALIZE','COMPLETED',100,'{"status":"degraded","degraded":true}'::jsonb,NOW() - INTERVAL '3 minutes',NOW() - INTERVAL '2 minutes');
  `;
  await runCommand('docker', [
    'exec',
    POSTGRES_CONTAINER,
    'psql',
    '-U',
    'postgres',
    '-d',
    'musicvideo',
    '-c',
    sql,
  ]);
}

async function clearDegradedForProject(projectId) {
  const sql = `
    UPDATE "Job"
    SET "outputData"='{"status":"success"}'::jsonb, "updatedAt"=NOW()
    WHERE "projectId"='${projectId}'::uuid
      AND "status"='COMPLETED'
      AND "type"='FINALIZE';
  `;
  await runCommand('docker', [
    'exec',
    POSTGRES_CONTAINER,
    'psql',
    '-U',
    'postgres',
    '-d',
    'musicvideo',
    '-c',
    sql,
  ]);
}

async function clearRecentDegradedJobs() {
  const sql = `
    UPDATE "Job"
    SET "outputData"='{"status":"success"}'::jsonb, "updatedAt"=NOW()
    WHERE "status"='COMPLETED'
      AND "updatedAt" >= NOW() - INTERVAL '2 hours'
      AND (
        LOWER(COALESCE("outputData"->>'status',''))='degraded'
        OR LOWER(COALESCE("outputData"->>'degraded','false')) IN ('true','1','t','yes')
      );
  `;
  await runCommand('docker', [
    'exec',
    POSTGRES_CONTAINER,
    'psql',
    '-U',
    'postgres',
    '-d',
    'musicvideo',
    '-c',
    sql,
  ]);
}

function verifyInboundWebhook(raw, headers, replayStore) {
  const timestampHeader = getHeaderValue(headers, 'x-mvg-webhook-timestamp').trim();
  const signatureHeader = getHeaderValue(headers, 'x-mvg-webhook-signature').trim();
  if (!timestampHeader) {
    return { ok: false, reason: 'missing_timestamp_header', statusCode: 401 };
  }
  if (!signatureHeader.startsWith('sha256=')) {
    return { ok: false, reason: 'missing_or_invalid_signature_header', statusCode: 401 };
  }
  const timestampSec = Number(timestampHeader);
  if (!Number.isFinite(timestampSec) || timestampSec <= 0) {
    return { ok: false, reason: 'invalid_timestamp_header', statusCode: 401 };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - Math.floor(timestampSec)) > WEBHOOK_MAX_SKEW_SEC) {
    return { ok: false, reason: 'timestamp_out_of_range', statusCode: 401 };
  }

  const providedHex = signatureHeader.slice('sha256='.length).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(providedHex)) {
    return { ok: false, reason: 'invalid_signature_encoding', statusCode: 401 };
  }
  const expectedHex = createHmac('sha256', WEBHOOK_SECRET)
    .update(`${timestampHeader}.${raw}`)
    .digest('hex');
  const provided = Buffer.from(providedHex, 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'signature_mismatch', statusCode: 401 };
  }

  const replayKey = `${timestampHeader}.${providedHex}`;
  if (replayStore.has(replayKey)) {
    return { ok: false, reason: 'replay_detected', statusCode: 409 };
  }
  replayStore.set(replayKey, Date.now() + WEBHOOK_MAX_SKEW_SEC * 1000);
  return { ok: true, reason: null, statusCode: 200 };
}

function startWebhookCaptureServer(capturedEvents) {
  const replayStore = new Map();

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== WEBHOOK_PATH) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      for (const [key, expiresAt] of replayStore.entries()) {
        if (expiresAt <= Date.now()) {
          replayStore.delete(key);
        }
      }

      const verification = verifyInboundWebhook(body, req.headers, replayStore);
      try {
        const payload = body ? JSON.parse(body) : {};
        capturedEvents.push({
          payload,
          headers: req.headers,
          raw: body,
          verification,
        });
      } catch {
        capturedEvents.push({
          payload: { parseError: true },
          headers: req.headers,
          raw: body,
          verification,
        });
      }
      res.writeHead(verification.statusCode, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: verification.ok,
          reason: verification.reason,
        }),
      );
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function countEvents(capturedEvents, eventName) {
  return capturedEvents.filter(
    (event) => event?.payload?.event === eventName && event?.verification?.ok === true,
  ).length;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function assertIsoTimestamp(value, label) {
  assert(typeof value === 'string' && value.length >= 10, `${label}_missing`);
  const parsed = Date.parse(value);
  assert(Number.isFinite(parsed), `${label}_invalid_iso`);
}

function assertAlertPayloadContract(payload) {
  assert(payload && typeof payload === 'object', 'alert_payload_missing');
  assert(payload.event === 'pipeline_degraded_alert', 'alert_event_mismatch');
  assert(typeof payload.environment === 'string' && payload.environment, 'alert_environment_missing');
  assertIsoTimestamp(payload.timestamp, 'alert_timestamp');
  assert(isFiniteNumber(payload.windowHours) && payload.windowHours > 0, 'alert_windowHours_invalid');
  assert(payload.status === 'degraded', 'alert_status_mismatch');

  assert(payload.totals && typeof payload.totals === 'object', 'alert_totals_missing');
  assert(
    isFiniteNumber(payload.totals.degradedRateWindowPct),
    'alert_totals_degradedRateWindowPct_invalid',
  );

  assert(payload.alerts && typeof payload.alerts === 'object', 'alert_alerts_missing');
  assert(isFiniteNumber(payload.alerts.criticalCount), 'alert_criticalCount_invalid');
  assert(isFiniteNumber(payload.alerts.warningCount), 'alert_warningCount_invalid');
  assert(Array.isArray(payload.alerts.critical), 'alert_critical_array_missing');
  assert(Array.isArray(payload.alerts.warnings), 'alert_warnings_array_missing');
  assert(payload.alerts.critical.length >= 1, 'alert_critical_array_empty');

  const criticalEntry = payload.alerts.critical[0];
  assert(criticalEntry && typeof criticalEntry === 'object', 'alert_critical_entry_invalid');
  assert(criticalEntry.severity === 'critical', 'alert_critical_entry_severity_mismatch');
  assert(typeof criticalEntry.type === 'string' && criticalEntry.type, 'alert_critical_entry_type_missing');
  assert(
    isFiniteNumber(criticalEntry.degradedRateWindowPct),
    'alert_critical_entry_degradedRateWindowPct_invalid',
  );
  assert(isFiniteNumber(criticalEntry.degradedWindow), 'alert_critical_entry_degradedWindow_invalid');
  assert(isFiniteNumber(criticalEntry.completedWindow), 'alert_critical_entry_completedWindow_invalid');

  assert(typeof payload.signature === 'string' && payload.signature.length > 0, 'alert_signature_missing');
  assert(isFiniteNumber(payload.cooldownMs) && payload.cooldownMs > 0, 'alert_cooldownMs_invalid');
}

function assertRecoveryPayloadContract(payload, expectedSignature) {
  assert(payload && typeof payload === 'object', 'recovery_payload_missing');
  assert(payload.event === 'pipeline_degraded_recovered', 'recovery_event_mismatch');
  assert(typeof payload.environment === 'string' && payload.environment, 'recovery_environment_missing');
  assertIsoTimestamp(payload.timestamp, 'recovery_timestamp');
  assert(
    isFiniteNumber(payload.windowHours) && payload.windowHours > 0,
    'recovery_windowHours_invalid',
  );
  assert(
    typeof payload.previousCriticalSignature === 'string' && payload.previousCriticalSignature.length > 0,
    'recovery_previousCriticalSignature_missing',
  );
  assert(payload.totals && typeof payload.totals === 'object', 'recovery_totals_missing');
  assert(
    isFiniteNumber(payload.totals.degradedRateWindowPct),
    'recovery_totals_degradedRateWindowPct_invalid',
  );

  if (expectedSignature) {
    assert(
      payload.previousCriticalSignature === expectedSignature,
      'recovery_previousCriticalSignature_mismatch',
    );
  }
}

function getHeaderValue(headers, key) {
  const value = headers?.[key.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0] || '';
  }
  return typeof value === 'string' ? value : '';
}

function assertWebhookEnvelopeSignatureContract(envelope, expectedEvent) {
  assert(envelope && typeof envelope === 'object', 'webhook_envelope_missing');
  assert(envelope.payload && typeof envelope.payload === 'object', 'webhook_envelope_payload_missing');
  assert(envelope.payload.event === expectedEvent, `webhook_event_mismatch_${expectedEvent}`);
  assert(typeof envelope.raw === 'string' && envelope.raw.length > 0, 'webhook_raw_missing');
  assert(envelope.verification?.ok === true, `webhook_receiver_verification_failed_${expectedEvent}`);

  const timestampHeader = getHeaderValue(envelope.headers, 'x-mvg-webhook-timestamp');
  const normalizedTimestamp = timestampHeader.trim();
  const timestampNumeric = Number(normalizedTimestamp);
  assert(
    Number.isFinite(timestampNumeric) && timestampNumeric > 0,
    'webhook_timestamp_header_invalid',
  );

  const signatureHeader = getHeaderValue(envelope.headers, 'x-mvg-webhook-signature');
  assert(signatureHeader.startsWith('sha256='), 'webhook_signature_header_missing');

  const expectedSignature = createHmac('sha256', WEBHOOK_SECRET)
    .update(`${normalizedTimestamp}.${envelope.raw}`)
    .digest('hex');
  assert(
    signatureHeader === `sha256=${expectedSignature}`,
    'webhook_signature_header_mismatch',
  );
}

async function postWebhookRaw(webhookUrl, rawBody, headers) {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: rawBody,
  });
  const rawResponse = await response.text();
  return {
    status: response.status,
    raw: rawResponse,
  };
}

async function main() {
  let backend;
  let webhookServer;
  let webhookUrl = '';
  const capturedEvents = [];
  let firstAlertSignature = null;

  try {
    console.log('step=deps_up');
    await runCommand('docker', ['compose', 'up', '-d', 'postgres', 'redis']);

    console.log('step=enable_pgvector');
    await enablePgvectorExtension({ postgresContainer: POSTGRES_CONTAINER });

    console.log('step=db_push');
    const npmDbPush = resolveNpmCommand(['run', 'db:push']);
    await runCommand(npmDbPush.command, npmDbPush.args);

    await ensureBackendBuild();

    console.log('step=webhook_server_start');
    webhookServer = await startWebhookCaptureServer(capturedEvents);
    const address = webhookServer.address();
    const webhookPort =
      address && typeof address === 'object' && typeof address.port === 'number'
        ? address.port
        : null;
    if (!webhookPort) {
      throw new Error('webhook_server_missing_port');
    }
    webhookUrl = `http://127.0.0.1:${webhookPort}${WEBHOOK_PATH}`;
    console.log(`webhook_server=up url=${webhookUrl}`);

    console.log('step=backend_start');
    backend = startBackend(webhookUrl);
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

    const projectId = await createProject(token, `Health Webhook Test ${Date.now()}`);
    console.log(`seed_project=${projectId}`);

    await clearRecentDegradedJobs();
    await apiRequest(`${API_BASE_URL}/health/ops/degraded?hours=${METRIC_HOURS}`, {
      method: 'GET',
    });

    await insertDegradedCompletedJob(projectId);
    console.log('step=seed_degraded_job_done');

    // First degraded snapshot should emit alert.
    const degradedSnapshot1 = await apiRequest(
      `${API_BASE_URL}/health/ops/degraded?hours=${METRIC_HOURS}`,
      {
      method: 'GET',
      },
    );
    assert(
      degradedSnapshot1?.status === 'degraded',
      `expected_degraded_snapshot_status_got_${degradedSnapshot1?.status}`,
    );

    await sleep(700);
    const degradedAlertsAfterFirstCall = countEvents(capturedEvents, 'pipeline_degraded_alert');
    assert(
      degradedAlertsAfterFirstCall === 1,
      `expected_one_degraded_alert_after_first_call_got_${degradedAlertsAfterFirstCall}`,
    );
    const firstAlertEnvelope = capturedEvents.find(
      (event) => event?.payload?.event === 'pipeline_degraded_alert',
    );
    assertWebhookEnvelopeSignatureContract(firstAlertEnvelope, 'pipeline_degraded_alert');
    const firstAlertPayload = firstAlertEnvelope.payload;
    assertAlertPayloadContract(firstAlertPayload);
    firstAlertSignature = firstAlertPayload.signature;
    console.log(`case_first_alert=PASS count=${degradedAlertsAfterFirstCall}`);

    // Replaying the same signed request must be rejected by receiver anti-replay.
    const replayResponse = await postWebhookRaw(webhookUrl, firstAlertEnvelope.raw, {
      'x-mvg-webhook-timestamp': getHeaderValue(
        firstAlertEnvelope.headers,
        'x-mvg-webhook-timestamp',
      ),
      'x-mvg-webhook-signature': getHeaderValue(
        firstAlertEnvelope.headers,
        'x-mvg-webhook-signature',
      ),
    });
    assert(
      replayResponse.status === 409,
      `expected_replay_rejection_status_409_got_${replayResponse.status}`,
    );
    console.log('case_replay_protection=PASS status=409');

    // Second call inside cooldown should NOT emit duplicated alert.
    await apiRequest(`${API_BASE_URL}/health/ops/degraded?hours=${METRIC_HOURS}`, {
      method: 'GET',
    });
    await sleep(700);
    const degradedAlertsAfterSecondCall = countEvents(capturedEvents, 'pipeline_degraded_alert');
    assert(
      degradedAlertsAfterSecondCall === 1,
      `expected_cooldown_to_prevent_duplicate_alert_got_${degradedAlertsAfterSecondCall}`,
    );
    console.log(`case_cooldown=PASS count=${degradedAlertsAfterSecondCall}`);

    // Recover the degraded condition and ensure recovery event is sent.
    await clearDegradedForProject(projectId);
    await clearRecentDegradedJobs();
    await apiRequest(`${API_BASE_URL}/health/ops/degraded?hours=${METRIC_HOURS}`, {
      method: 'GET',
    });
    await sleep(700);

    const recoveryEvents = countEvents(capturedEvents, 'pipeline_degraded_recovered');
    assert(recoveryEvents === 1, `expected_one_recovery_event_got_${recoveryEvents}`);
    const recoveryEnvelope = capturedEvents.find(
      (event) => event?.payload?.event === 'pipeline_degraded_recovered',
    );
    assertWebhookEnvelopeSignatureContract(recoveryEnvelope, 'pipeline_degraded_recovered');
    const recoveryPayload = recoveryEnvelope.payload;
    assertRecoveryPayloadContract(recoveryPayload, firstAlertSignature);
    console.log(`case_recovery=PASS count=${recoveryEvents}`);

    console.log('health_alert_webhook_test_status=PASS');
  } catch (error) {
    console.error('health_alert_webhook_test_status=FAIL');
    console.error(error?.message || error);
    process.exitCode = 1;
  } finally {
    if (webhookServer) {
      await new Promise((resolve) => webhookServer.close(resolve));
    }
    if (backend?.child?.pid) {
      await killProcessTree(backend.child.pid);
    }
    backend?.stdoutStream?.end();
    backend?.stderrStream?.end();
  }
}

main();
