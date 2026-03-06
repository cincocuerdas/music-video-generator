const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ baseURL: 'http://localhost:5173' });
  const page = await context.newPage();
  const failedRequests = [];
  page.on('requestfailed', (req) => failedRequests.push({ url: req.url(), failure: req.failure()?.errorText || 'unknown' }));

  await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
  await page.getByText('P11 keyword-fix validation').click();
  await page.waitForLoadState('networkidle');
  const video = page.locator('video');
  await video.waitFor({ state: 'attached', timeout: 10000 });
  await page.waitForTimeout(5000);

  const info = await video.evaluate((el) => ({
    currentSrc: el.currentSrc,
    readyState: el.readyState,
    networkState: el.networkState,
    duration: el.duration,
    paused: el.paused,
    error: el.error ? { code: el.error.code, message: el.error.message } : null,
  }));

  const benignMediaAborts = failedRequests.filter(
    (entry) =>
      entry.failure === 'net::ERR_ABORTED' &&
      entry.url.endsWith('.mp4') &&
      !info.error &&
      Number.isFinite(info.duration) &&
      info.duration > 0 &&
      info.readyState >= 1,
  );
  const realFailures = failedRequests.filter(
    (entry) => !benignMediaAborts.includes(entry),
  );

  console.log(JSON.stringify({ info, benignMediaAborts, failedRequests: realFailures }, null, 2));
  await browser.close();
})();
