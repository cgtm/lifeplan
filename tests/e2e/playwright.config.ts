import { defineConfig, devices } from '@playwright/test';

/**
 * Lifeplan end-to-end verification config.
 *
 * Targeting:
 *   LIFEPLAN_TEST_BASE_URL  — overrides baseURL (default: http://localhost:3131/).
 *   LIFEPLAN_TEST_PASSWORD  — login password used by the auth fixture.
 *   LIFEPLAN_RESTART_CMD    — optional shell command run before the suite to reset
 *                             the in-process rate limiter (e.g. "lp restart"). When
 *                             unset, the rate-limit test still passes but consumes
 *                             real slots; use against a fresh server.
 *
 * Browsers:
 *   Chromium and WebKit. WebKit is the load-bearing one — Cam's primary device is iOS.
 *   Firefox is intentionally skipped: Cam doesn't use it; Lifeplan doesn't promise it.
 */

const baseURL = process.env.LIFEPLAN_TEST_BASE_URL || 'http://localhost:3131/';
const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './',
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false, // auth state and rate limits are global; serialise to keep tests honest
  workers: 1,
  retries: isCI ? 2 : 1,
  reporter: isCI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 30_000,
  expect: { timeout: 5_000 },

  use: {
    baseURL,
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    ignoreHTTPSErrors: true,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],
});
