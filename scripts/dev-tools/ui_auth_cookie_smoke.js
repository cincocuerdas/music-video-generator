const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ baseURL: 'http://localhost:5173' });
  const page = await context.newPage();
  const consoleMessages = [];
  const pageErrors = [];
  const failedRequests = [];

  page.on('console', (msg) => {
    consoleMessages.push({ type: msg.type(), text: msg.text() });
  });
  page.on('pageerror', (err) => {
    pageErrors.push(String(err));
  });
  page.on('requestfailed', (req) => {
    failedRequests.push({ url: req.url(), method: req.method(), failure: req.failure()?.errorText || 'unknown' });
  });

  await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  const title = await page.title();
  const text = await page.locator('body').innerText();
  const h1s = await page.locator('h1').allInnerTexts().catch(() => []);
  const buttons = await page.locator('button').evaluateAll((els) =>
    els.map((el) => ({ text: (el.textContent || '').trim(), disabled: el.hasAttribute('disabled') }))
  );
  const storage = await page.evaluate(() => ({
    localStorage: { ...localStorage },
    sessionStorage: { ...sessionStorage },
  }));
  const cookies = await context.cookies();

  await page.screenshot({ path: 'output/ui-auth-cookie-smoke.png', fullPage: true });

  console.log(JSON.stringify({
    title,
    url: page.url(),
    h1s,
    buttons,
    bodySnippet: text.slice(0, 1200),
    storage,
    cookies: cookies.map((c) => ({ name: c.name, domain: c.domain, path: c.path, httpOnly: c.httpOnly, sameSite: c.sameSite, secure: c.secure })),
    consoleMessages,
    pageErrors,
    failedRequests,
  }, null, 2));

  await browser.close();
})();
