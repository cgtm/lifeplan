import { test as base, expect, request, type APIRequestContext } from '@playwright/test';

/**
 * Auth fixture.
 *
 * Provides:
 *   - `password`: resolved test password (from LIFEPLAN_TEST_PASSWORD).
 *   - `mountPrefix`: the path prefix the browser sees. "/" locally, "/lifeplan/" in prod.
 *     Computed from baseURL's pathname so the same suite runs against either env.
 *   - `loginPath`: mountPrefix + "login" — the expected redirect target.
 *   - `loggedInPage`: a fresh authenticated page (one network login per test that uses it).
 *   - `apiCtx`: a bare APIRequestContext (no cookies) for cookie-flag and HTTP-shape assertions.
 *
 * Tests that explicitly verify the login or logout flow do NOT use loggedInPage; they
 * drive the browser themselves so the navigation is observed end-to-end.
 */

export type Fixtures = {
  password: string;
  mountPrefix: string;
  loginPath: string;
  loggedInPage: import('@playwright/test').Page;
  apiCtx: APIRequestContext;
};

function resolveMountPrefix(baseURL: string | undefined): string {
  if (!baseURL) return '/';
  try {
    const u = new URL(baseURL);
    let p = u.pathname || '/';
    if (!p.endsWith('/')) p += '/';
    return p;
  } catch {
    return '/';
  }
}

export const test = base.extend<Fixtures>({
  password: async ({}, use) => {
    const pw = process.env.LIFEPLAN_TEST_PASSWORD;
    if (!pw) {
      throw new Error(
        'LIFEPLAN_TEST_PASSWORD is not set. Probe needs the local dev password to run the suite. ' +
          'Ask Atlas to confirm the current password (the one in .env was rotated).',
      );
    }
    await use(pw);
  },

  mountPrefix: async ({ baseURL }, use) => {
    await use(resolveMountPrefix(baseURL));
  },

  loginPath: async ({ mountPrefix }, use) => {
    await use(mountPrefix + 'login');
  },

  apiCtx: async ({ baseURL }, use) => {
    const ctx = await request.newContext({ baseURL, ignoreHTTPSErrors: true });
    await use(ctx);
    await ctx.dispose();
  },

  loggedInPage: async ({ browser, baseURL, password }, use) => {
    const context = await browser.newContext({ baseURL });
    // Log in via the API so this fixture doesn't depend on the login HTML
    // staying selector-stable. Cookies attach to the browser context, then
    // the next page.goto() carries them.
    const r = await context.request.post('login', {
      headers: { 'Content-Type': 'application/json' },
      data: { password },
    });
    expect(r.status(), 'fixture login should succeed').toBe(200);
    const page = await context.newPage();
    await use(page);
    await context.close();
  },
});

export { expect };
