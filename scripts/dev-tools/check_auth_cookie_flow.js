const { chromium } = require('playwright');

const DEV_USER_ID = '00000000-0000-4000-8000-000000000001';
const FRONTEND = process.env.FRONTEND_BASE_URL || 'http://localhost:5173';
const API = process.env.API_BASE_URL || 'http://localhost:3000/api/v1';
const COOKIE_NAME = 'mvg_refresh_token';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ baseURL: FRONTEND });
  const page = await context.newPage();

  await page.goto(FRONTEND, { waitUntil: 'networkidle' });

  const readStorage = async () =>
    page.evaluate(() => ({
      localStorage: { ...localStorage },
      sessionStorage: { ...sessionStorage },
    }));

  const initialStorage = await readStorage();

  const login = await page.evaluate(async ({ api, userId }) => {
    const response = await fetch(`${api}/auth/login/dev`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    const body = await response.json();
    return { status: response.status, body };
  }, { api: API, userId: DEV_USER_ID });

  const cookiesAfterLogin = await context.cookies();
  const storageAfterLogin = await readStorage();

  const refresh = await page.evaluate(async ({ api }) => {
    const response = await fetch(`${api}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = await response.json();
    return { status: response.status, body };
  }, { api: API });

  const cookiesAfterRefresh = await context.cookies();

  await page.reload({ waitUntil: 'networkidle' });
  const storageAfterReload = await readStorage();

  const accessToken = refresh.body?.data?.accessToken || refresh.body?.accessToken || login.body?.data?.accessToken || login.body?.accessToken;

  const meWithAccess = await page.evaluate(async ({ api, accessToken }) => {
    const response = await fetch(`${api}/auth/me`, {
      credentials: 'include',
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    });
    const body = await response.json();
    return { status: response.status, body };
  }, { api: API, accessToken });

  const logout = await page.evaluate(async ({ api }) => {
    const response = await fetch(`${api}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = await response.json();
    return { status: response.status, body };
  }, { api: API });

  const cookiesAfterLogout = await context.cookies();

  const refreshAfterLogout = await page.evaluate(async ({ api }) => {
    const response = await fetch(`${api}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = await response.json();
    return { status: response.status, body };
  }, { api: API });

  const findCookie = (cookies) => {
    const cookie = cookies.find((entry) => entry.name === COOKIE_NAME);
    if (!cookie) return null;
    return {
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
    };
  };

  console.log(JSON.stringify({
    initialStorage,
    login,
    refreshCookieAfterLogin: findCookie(cookiesAfterLogin),
    storageAfterLogin,
    refresh,
    refreshCookieAfterRefresh: findCookie(cookiesAfterRefresh),
    storageAfterReload,
    meWithAccess,
    logout,
    refreshCookieAfterLogout: findCookie(cookiesAfterLogout),
    refreshAfterLogout,
  }, null, 2));

  await browser.close();
})();
