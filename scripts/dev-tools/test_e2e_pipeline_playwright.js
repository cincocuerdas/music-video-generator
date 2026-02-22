/* eslint-disable no-console */
const { setTimeout: sleep } = require('timers/promises');

const API_BASE_URL = (process.env.API_BASE_URL || 'http://127.0.0.1:3000/api/v1').replace(/\/$/, '');
const FRONTEND_BASE_URL = (process.env.FRONTEND_BASE_URL || 'http://127.0.0.1:5173').replace(
  /\/$/,
  '',
);
const PIPELINE_TIMEOUT_MS = Number(process.env.E2E_PIPELINE_TIMEOUT_MS || 240_000);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function parseTimestampToSeconds(text) {
  const normalized = (text || '').trim();
  const match = normalized.match(/^(\d+):(\d{2})$/);
  if (!match) {
    return null;
  }
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return null;
  }
  return minutes * 60 + seconds;
}

async function apiRequest(path, init = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
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
    if (response.status >= 400) {
      throw new Error(`HTTP ${response.status} ${path}: ${JSON.stringify(data)}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForPipelineCompletion(projectId, authHeader) {
  const deadline = Date.now() + PIPELINE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await apiRequest(`/projects/${projectId}/status`, {
      method: 'GET',
      headers: authHeader,
    });
    if (status?.status === 'FAILED') {
      throw new Error(`pipeline_failed project=${projectId}`);
    }
    if (status?.status === 'COMPLETED') {
      return status;
    }
    await sleep(3_000);
  }
  throw new Error(`pipeline_timeout project=${projectId}`);
}

async function requirePlaywright() {
  try {
    return await import('playwright');
  } catch {
    throw new Error(
      'Playwright not installed. Run: npm i -D playwright && npx playwright install chromium',
    );
  }
}

async function main() {
  const { chromium } = await requirePlaywright();

  const health = await apiRequest('/health', { method: 'GET' });
  assert(health?.status === 'ok', 'backend_health_not_ok');

  const login = await apiRequest('/auth/login/dev', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  const accessToken = login?.accessToken;
  assert(accessToken, 'missing_access_token');
  const authHeader = { Authorization: `Bearer ${accessToken}` };

  const project = await apiRequest('/projects', {
    method: 'POST',
    headers: authHeader,
    body: JSON.stringify({
      title: `E2E Pipeline ${Date.now()}`,
      youtubeUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      lyrics: 'Luces en la calle, sombras en mi voz, sigo caminando hasta encontrar mi sol',
      visualStyle: 'cinematic',
      aspectRatio: '16:9',
    }),
  });
  assert(project?.id, 'missing_project_id');
  const projectId = project.id;
  console.log(`seed_project=${projectId}`);

  const feedbackBefore = await apiRequest(`/projects/${projectId}/feedback`, {
    method: 'GET',
    headers: authHeader,
  });
  const baselineFeedbackCount = Number(feedbackBefore?.total || 0);

  await apiRequest(`/projects/${projectId}/generate`, {
    method: 'POST',
    headers: authHeader,
    body: JSON.stringify({
      youtubeUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      visualStyle: 'cinematic',
    }),
  });

  const pipelineStatus = await waitForPipelineCompletion(projectId, authHeader);
  assert(pipelineStatus?.pipelineStatus !== 'failed', 'pipeline_completed_with_failed_status');
  console.log(`pipeline_status=${pipelineStatus?.pipelineStatus || 'unknown'}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript((token) => {
    window.localStorage.setItem('auth_token', token);
  }, accessToken);

  await page.goto(`${FRONTEND_BASE_URL}/project/${projectId}`, {
    waitUntil: 'networkidle',
    timeout: 120_000,
  });

  await page.getByText(/Generated Scenes/i).waitFor({ timeout: 60_000 });
  const sceneCards = page.locator('#scenes-scroll [role="button"]');
  const sceneCount = await sceneCards.count();
  assert(sceneCount >= 2, `expected_at_least_2_scene_cards_got_${sceneCount}`);

  const targetCard = sceneCards.nth(1);
  const timestampText = ((await targetCard.locator('span').first().innerText()) || '').trim();
  const expectedSeconds = parseTimestampToSeconds(timestampText);
  assert(expectedSeconds !== null, `invalid_scene_timestamp_text:${timestampText}`);

  await targetCard.click();
  await page.waitForTimeout(1_200);

  const currentTime = await page.evaluate(() => {
    const video = document.querySelector('video');
    return video ? Number(video.currentTime || 0) : -1;
  });
  assert(currentTime >= 0, 'video_element_not_found');
  const seekDelta = Math.abs(currentTime - Number(expectedSeconds));
  assert(
    seekDelta <= 2.5,
    `scene_seek_mismatch expected=${expectedSeconds} current=${currentTime.toFixed(2)} delta=${seekDelta.toFixed(2)}`,
  );
  console.log(`case_scene_sync=PASS expected=${expectedSeconds} current=${currentTime.toFixed(2)}`);

  await page.getByRole('button', { name: /NEEDS WORK/i }).click();
  const feedbackMessage = `e2e feedback ${Date.now()}`;
  await page.locator('textarea[placeholder*="What went wrong"]').fill(feedbackMessage);
  await page.getByRole('button', { name: /Submit Feedback/i }).click();
  await page.getByRole('button', { name: /Submitted!/i }).waitFor({ timeout: 20_000 });

  await sleep(1_000);
  const feedbackAfter = await apiRequest(`/projects/${projectId}/feedback`, {
    method: 'GET',
    headers: authHeader,
  });
  const updatedTotal = Number(feedbackAfter?.total || 0);
  assert(
    updatedTotal === baselineFeedbackCount + 1,
    `feedback_total_mismatch before=${baselineFeedbackCount} after=${updatedTotal}`,
  );
  assert(
    Array.isArray(feedbackAfter?.feedbacks) &&
      feedbackAfter.feedbacks.some((item) => item && item.prompt === feedbackMessage),
    'feedback_payload_not_persisted',
  );
  console.log('case_feedback_persisted=PASS');

  await browser.close();
  console.log('e2e_pipeline_playwright_test_status=PASS');
}

main().catch((error) => {
  console.error('e2e_pipeline_playwright_test_status=FAIL');
  console.error(error?.message || error);
  process.exitCode = 1;
});
