import { test, expect } from './fixtures/auth';
import type { APIResponse } from '@playwright/test';

/**
 * Cookie-session auth — end-to-end verification.
 *
 * Each `test(...)` block maps to one clause in app/contracts/cookie-auth.md.
 * The clause reference is in the title prefix so a failure tells you exactly
 * which contract clause regressed.
 */

const COOKIE_NAME = 'lifeplan_session';

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

function parseSetCookie(headerValue: string): Record<string, string | true> {
  // Playwright concatenates multiple Set-Cookie headers with newlines.
  // We only ever expect one lifeplan_session cookie per response, so take
  // whichever line names it.
  const lines = headerValue.split('\n');
  const ours = lines.find((l) => l.toLowerCase().startsWith(`${COOKIE_NAME.toLowerCase()}=`));
  if (!ours) return {};
  const out: Record<string, string | true> = {};
  ours.split(';').forEach((part, idx) => {
    const trimmed = part.trim();
    if (!trimmed) return;
    if (idx === 0) {
      const eq = trimmed.indexOf('=');
      out['__name'] = trimmed.slice(0, eq);
      out['__value'] = trimmed.slice(eq + 1);
      return;
    }
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      out[trimmed] = true;
    } else {
      out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
  });
  return out;
}

function getSetCookieRaw(res: APIResponse): string {
  const headers = res.headersArray();
  const cookieHeaders = headers.filter((h) => h.name.toLowerCase() === 'set-cookie');
  return cookieHeaders.map((h) => h.value).join('\n');
}

// ──────────────────────────────────────────────────────────────────
// Contract: GET /login (public)
// ──────────────────────────────────────────────────────────────────

test.describe('GET /login (public)', () => {
  test('contract: 200 + HTML form, unauthenticated', async ({ apiCtx }) => {
    const res = await apiCtx.get('login');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/text\/html/);
    const body = await res.text();
    // User-observable: the form is present and the password field is named.
    expect(body).toMatch(/<form[^>]*id=["']loginForm["']/);
    expect(body).toMatch(/name=["']password["']/);
  });
});

// ──────────────────────────────────────────────────────────────────
// Contract: POST /login (public, rate-limited)
// ──────────────────────────────────────────────────────────────────

test.describe('POST /login (public)', () => {
  test('contract: correct password → 200, sets session cookie with right flags', async ({
    apiCtx,
    mountPrefix,
    password,
  }) => {
    const res = await apiCtx.post('login', {
      headers: { 'Content-Type': 'application/json' },
      data: { password },
    });
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const setCookieRaw = getSetCookieRaw(res);
    expect(setCookieRaw, 'Set-Cookie must be present').not.toBe('');
    const cookie = parseSetCookie(setCookieRaw);

    expect(cookie['__name']).toBe(COOKIE_NAME);
    expect(typeof cookie['__value']).toBe('string');
    expect((cookie['__value'] as string).length).toBeGreaterThan(0);

    // Flags per contract.
    expect(cookie['HttpOnly']).toBe(true);
    expect(cookie['SameSite']).toBe('Lax');
    expect(cookie['Path']).toBe(mountPrefix);
    expect(cookie['Max-Age']).toBe(String(30 * 24 * 60 * 60));

    // Locally we're on http; Secure must NOT be set (else the browser would drop the cookie).
    if (mountPrefix === '/') {
      expect(cookie['Secure']).toBeUndefined();
    }
  });

  test('contract: wrong password → 401 {ok:false}, no cookie', async ({ apiCtx }) => {
    const res = await apiCtx.post('login', {
      headers: { 'Content-Type': 'application/json' },
      data: { password: 'definitely-not-the-password-' + Date.now() },
    });
    expect(res.status()).toBe(401);
    expect(await res.json()).toEqual({ ok: false });
    const setCookieRaw = getSetCookieRaw(res);
    // No session cookie should be issued on failure.
    expect(setCookieRaw.toLowerCase()).not.toContain(`${COOKIE_NAME.toLowerCase()}=`);
  });

  test('UI: wrong password shows "Wrong password" in the form', async ({ page, loginPath }) => {
    await page.goto(loginPath);
    await page.locator('#password').fill('this-is-wrong-' + Date.now());
    await page.locator('#submitBtn').click();
    await expect(page.locator('#error')).toHaveText('Wrong password');
    // Defensive: the input is cleared on failure so the user can retype.
    await expect(page.locator('#password')).toHaveValue('');
  });

  test('contract: Content-Type gate — POST /login with form-urlencoded → 415 (NOT 401)', async ({
    apiCtx,
  }) => {
    const res = await apiCtx.post('login', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: 'password=anything',
    });
    // Per cookie-auth.md "DISCREPANCY" clause: 415 fires before password check.
    expect(res.status()).toBe(415);
    expect(await res.json()).toEqual({ error: 'unsupported media type' });
  });
});

// ──────────────────────────────────────────────────────────────────
// Contract: rate limiting on /login
//
// Skipped by default: this test fires 6 wrong-password attempts, which
// burns the in-process limiter slots and means the next default `npm test`
// run would need a server restart to clear. Probe runs default-runs often,
// rate-limit verification rarely. Gate it behind RATE_LIMIT_TEST=1 — the
// test then expects LIFEPLAN_RESTART_CMD too so it can reset the limiter
// in beforeAll.
//
// Cadence: run on demand when /login or auth.py rate-limit code changes,
// not on every Probe pass. See docs/runbooks/probe-go-no-go.md.
// ──────────────────────────────────────────────────────────────────

test.describe('POST /login rate limit', () => {
  test.beforeAll(async () => {
    if (process.env.RATE_LIMIT_TEST !== '1') return;
    const restart = process.env.LIFEPLAN_RESTART_CMD;
    if (!restart) return;
    // Best-effort restart. We import lazily so test discovery doesn't pull node:child_process.
    const { execSync } = await import('node:child_process');
    execSync(restart, { stdio: 'inherit' });
    // Wait until the server is responsive again.
    const baseURL = process.env.LIFEPLAN_TEST_BASE_URL || 'http://localhost:3131/';
    const start = Date.now();
    // poll for up to 10 s
    while (Date.now() - start < 10_000) {
      try {
        const r = await fetch(new URL('login', baseURL));
        if (r.ok) break;
      } catch {
        /* not yet */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  });

  test('contract: 5 failures return 401, 6th returns 429', async ({ apiCtx, page, loginPath }) => {
    test.skip(
      process.env.RATE_LIMIT_TEST !== '1',
      'Skipped by default. Set RATE_LIMIT_TEST=1 (and LIFEPLAN_RESTART_CMD) to run; this test burns the in-process limiter slots.',
    );
    test.skip(
      !process.env.LIFEPLAN_RESTART_CMD,
      'RATE_LIMIT_TEST=1 also requires LIFEPLAN_RESTART_CMD (e.g. "/path/to/lp restart") so the limiter starts fresh.',
    );

    const wrongPw = 'rl-probe-' + Date.now();
    for (let i = 1; i <= 5; i++) {
      const r = await apiCtx.post('login', {
        headers: { 'Content-Type': 'application/json' },
        data: { password: wrongPw + ':' + i },
      });
      expect(r.status(), `attempt #${i} should still be 401`).toBe(401);
    }
    const sixth = await apiCtx.post('login', {
      headers: { 'Content-Type': 'application/json' },
      data: { password: wrongPw + ':6' },
    });
    expect(sixth.status()).toBe(429);
    expect(await sixth.json()).toEqual({ error: 'too many attempts' });

    // UI surfaces the rate-limit message.
    await page.goto(loginPath);
    await page.locator('#password').fill('one-more-' + Date.now());
    await page.locator('#submitBtn').click();
    await expect(page.locator('#error')).toHaveText('Too many attempts. Try again in a few minutes.');
  });
});

// ──────────────────────────────────────────────────────────────────
// Contract: authenticated GET /
// ──────────────────────────────────────────────────────────────────

test.describe('GET / (auth-required)', () => {
  test('contract: authenticated → 200 with app HTML', async ({ loggedInPage, mountPrefix }) => {
    const res = await loggedInPage.goto(mountPrefix);
    expect(res?.status()).toBe(200);
    const body = await loggedInPage.content();
    // The app HTML is index.html — it has a <title> containing "lifeplan"
    // (case-insensitive — branding casing is Lumen's call, not Probe's contract)
    // and it contains the nav scaffold.
    expect(body).toMatch(/<title>[^<]*lifeplan/i);
    expect(body).toMatch(/id=["']navMoreBtn["']/);
  });

  test('contract: unauthenticated HTML GET → 302 to <mount>login (NO root-absolute path leak)', async ({
    request,
    mountPrefix,
    loginPath,
  }) => {
    // Use a fresh request context that won't auto-follow the redirect.
    const r = await request.fetch(mountPrefix, {
      method: 'GET',
      headers: { Accept: 'text/html' },
      maxRedirects: 0,
    });
    expect(r.status()).toBe(302);
    const location = r.headers()['location'];
    // CRITICAL: the regression test for the three /login bugs.
    // Must equal the mount-aware path exactly. No bare "/login" leak.
    expect(location).toBe(loginPath);
  });
});

// ──────────────────────────────────────────────────────────────────
// Contract: API requests → 401 JSON, NOT 302
// ──────────────────────────────────────────────────────────────────

test.describe('API auth gate', () => {
  test('contract: unauthenticated /api/dashboard → 401 JSON, not 302', async ({ apiCtx }) => {
    const r = await apiCtx.fetch('api/dashboard', {
      method: 'GET',
      // No Accept: text/html — this is an API client.
      headers: { Accept: 'application/json' },
      maxRedirects: 0,
    });
    expect(r.status(), 'API path must return 401, not redirect').toBe(401);
    expect(r.headers()['content-type']).toMatch(/application\/json/);
    expect(await r.json()).toEqual({ error: 'unauthorized' });
  });
});

// ──────────────────────────────────────────────────────────────────
// Contract: POST /logout
// ──────────────────────────────────────────────────────────────────

test.describe('POST /logout (auth-required)', () => {
  test('contract: 200 {ok:true} + clear-cookie; subsequent protected request → 401', async ({
    browser,
    baseURL,
    password,
    mountPrefix,
  }) => {
    const ctx = await browser.newContext({ baseURL });
    // Log in.
    const login = await ctx.request.post('login', {
      headers: { 'Content-Type': 'application/json' },
      data: { password },
    });
    expect(login.status()).toBe(200);

    // Log out.
    const logout = await ctx.request.post('logout', {
      headers: { 'Content-Type': 'application/json' },
      data: {},
    });
    expect(logout.status()).toBe(200);
    expect(await logout.json()).toEqual({ ok: true });

    const setCookieRaw = getSetCookieRaw(logout);
    expect(setCookieRaw, 'Logout must emit a Set-Cookie that clears the session').not.toBe('');
    const cookie = parseSetCookie(setCookieRaw);
    expect(cookie['__name']).toBe(COOKIE_NAME);
    expect(cookie['__value']).toBe('');
    expect(cookie['Max-Age']).toBe('0');
    expect(cookie['Path']).toBe(mountPrefix);

    // After logout, a protected API call must 401.
    const after = await ctx.request.fetch('api/dashboard', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      maxRedirects: 0,
    });
    expect(after.status()).toBe(401);

    await ctx.close();
  });
});

// ──────────────────────────────────────────────────────────────────
// Contract: Logout button click — REGRESSION test for the three /login bugs
// ──────────────────────────────────────────────────────────────────

test.describe('Logout via UI', () => {
  test('regression: desktop logout chip lands on <mount>login (NOT apex)', async ({
    browser,
    baseURL,
    password,
    mountPrefix,
    loginPath,
  }) => {
    const ctx = await browser.newContext({
      baseURL,
      viewport: { width: 1280, height: 800 }, // desktop — chip is visible
    });
    const page = await ctx.newPage();

    // Log in via API, then load app.
    await ctx.request.post('login', {
      headers: { 'Content-Type': 'application/json' },
      data: { password },
    });
    await page.goto(mountPrefix);

    // Click the desktop logout chip and observe the navigation target.
    const navAfterClick = page.waitForURL((url) => url.pathname === loginPath);
    await page.locator('#navLogoutDesktopBtn').click();
    await navAfterClick;

    // Final URL pathname must be the mount-aware login path. This is the
    // regression test for "Lumen had to fix this three times."
    expect(new URL(page.url()).pathname).toBe(loginPath);

    await ctx.close();
  });

  test('mobile (<640px): desktop chip hidden, More-menu Log out works', async ({
    browser,
    baseURL,
    password,
    mountPrefix,
    loginPath,
  }) => {
    const ctx = await browser.newContext({
      baseURL,
      viewport: { width: 390, height: 844 }, // iPhone-ish
    });
    const page = await ctx.newPage();
    await ctx.request.post('login', {
      headers: { 'Content-Type': 'application/json' },
      data: { password },
    });
    await page.goto(mountPrefix);

    // Desktop chip is hidden at this breakpoint.
    await expect(page.locator('#navLogoutDesktopBtn')).toBeHidden();

    // Open the More menu, click Log out.
    await page.locator('#navMoreBtn').click();
    await expect(page.locator('#navLogoutBtn')).toBeVisible();

    const navAfterClick = page.waitForURL((url) => url.pathname === loginPath);
    await page.locator('#navLogoutBtn').click();
    await navAfterClick;

    expect(new URL(page.url()).pathname).toBe(loginPath);
    await ctx.close();
  });
});

// ──────────────────────────────────────────────────────────────────
// Contract: tampered cookie
// ──────────────────────────────────────────────────────────────────

test.describe('Tampered cookie', () => {
  test('edited cookie value → reload redirects to login', async ({
    browser,
    baseURL,
    password,
    mountPrefix,
    loginPath,
  }) => {
    const ctx = await browser.newContext({ baseURL });
    await ctx.request.post('login', {
      headers: { 'Content-Type': 'application/json' },
      data: { password },
    });

    // Tamper with the session cookie in the browser context.
    const cookies = await ctx.cookies();
    const session = cookies.find((c) => c.name === COOKIE_NAME);
    expect(session, 'session cookie should be present after login').toBeTruthy();
    const tampered = (session!.value.replace(/.$/, '') + '0').replace(/0$/, '1'); // flip last char
    await ctx.clearCookies();
    await ctx.addCookies([{ ...session!, value: tampered }]);

    const page = await ctx.newPage();
    const res = await page.goto(mountPrefix);
    // The browser auto-follows the 302; the final URL is the login page.
    expect(new URL(page.url()).pathname).toBe(loginPath);
    expect(res?.status()).toBe(200); // 200 of the *login* page after the redirect

    await ctx.close();
  });
});

// ──────────────────────────────────────────────────────────────────
// Contract: public assets
// ──────────────────────────────────────────────────────────────────

test.describe('Public assets', () => {
  for (const path of ['manifest.json', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png']) {
    test(`contract: GET ${path} → 200 unauthenticated`, async ({ apiCtx }) => {
      const r = await apiCtx.get(path);
      expect(r.status(), `${path} must be reachable pre-auth`).toBe(200);
    });
  }
});
