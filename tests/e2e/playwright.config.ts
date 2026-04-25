import * as path from 'node:path';
import * as dotenv from 'dotenv';
import { defineConfig, devices } from '@playwright/test';

/**
 * Lifeplan end-to-end verification config.
 *
 * Secrets / config flow:
 *   `tests/e2e/.env` (gitignored) is loaded automatically below. Run
 *   `./setup.sh` (or `npm run setup`) once on a fresh checkout to write it.
 *   Inline env vars on the command line still override .env, so ad-hoc runs
 *   against production work with `LIFEPLAN_TEST_BASE_URL=… npm test`.
 *
 * Recognised vars:
 *   LIFEPLAN_TEST_BASE_URL  — overrides baseURL (default: http://localhost:3131/).
 *   LIFEPLAN_TEST_PASSWORD  — login password used by the auth fixture.
 *   RATE_LIMIT_TEST         — set to "1" to run the rate-limit test. Off by
 *                             default because it burns the in-process limiter.
 *   LIFEPLAN_RESTART_CMD    — only consulted when RATE_LIMIT_TEST=1; shell
 *                             command run in beforeAll to reset the limiter
 *                             (e.g. "/Users/.../lp restart").
 *
 * Browsers:
 *   Chromium and WebKit. WebKit is the load-bearing one — Cam's primary device is iOS.
 *   Firefox is intentionally skipped: Cam doesn't use it; Lifeplan doesn't promise it.
 */

// Load tests/e2e/.env if present. `override: false` means an inline
// `FOO=bar npm test` still wins over what's in the file — that's the
// ad-hoc production-run escape hatch.
dotenv.config({ path: path.join(__dirname, '.env'), override: false });

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
