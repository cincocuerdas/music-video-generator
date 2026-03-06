const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ baseURL: 'http://localhost:5173' });
  const page = await context.newPage();
  const pageErrors = [];
  const failedRequests = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('requestfailed', (req) => failedRequests.push({ url: req.url(), failure: req.failure()?.errorText || 'unknown' }));

  await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
  await page.getByText('P11 keyword-fix validation').click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  const body = await page.locator('body').innerText();
  const video = page.locator('video');
  const hasVideo = await video.count();
  let videoInfo = null;
  if (hasVideo > 0) {
    videoInfo = await video.evaluate((el) => ({
      currentSrc: el.currentSrc,
      readyState: el.readyState,
      networkState: el.networkState,
      duration: el.duration,
      error: el.error ? { code: el.error.code, message: el.error.message } : null,
    }));
  }

  const benignMediaAborts = failedRequests.filter(
    (entry) =>
      entry.failure === 'net::ERR_ABORTED' &&
      entry.url.endsWith('.mp4') &&
      videoInfo &&
      !videoInfo.error &&
      Number.isFinite(videoInfo.duration) &&
      videoInfo.duration > 0 &&
      videoInfo.readyState >= 1,
  );
  const realFailures = failedRequests.filter(
    (entry) => !benignMediaAborts.includes(entry),
  );

  await page.screenshot({ path: 'output/ui-auth-project-detail-smoke.png', fullPage: true });

  console.log(JSON.stringify({
    url: page.url(),
    bodySnippet: body.slice(0, 1500),
    videoInfo,
    pageErrors,
    benignMediaAborts,
    failedRequests: realFailures,
  }, null, 2));

  await browser.close();
})();
