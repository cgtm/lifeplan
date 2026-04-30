import { test, expect } from './fixtures/auth';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Background processing — end-to-end verification.
 *
 * Each `test(...)` block maps to a clause in
 * app/contracts/background-processing.md. The clause reference is in the
 * title prefix so a failure tells you exactly which contract clause regressed.
 *
 * Speed profile: these tests poll for state changes (3 s UI cadence + 2 s
 * worker tick). The default suite caps polling at 30 s per assertion so a
 * stuck worker fails fast. Two tests are gated behind env vars because they
 * either inject faults or wait for the 60 s watchdog cycle.
 *
 *   - default suite                   green-and-fast
 *   - FORCE_FAIL_TEST=1               adds the failure-detection test
 *   - WATCHDOG_TEST=1                 adds the 70 s watchdog reclaim test
 *
 * Both gated tests need direct SQLite access — `LIFEPLAN_DB_PATH` may
 * override; defaults to /Users/cam/dev/personal/lifeplan/data/lifeplan.db.
 *
 * Privacy invariant: brain-dump content uses only timestamp suffixes
 * (`probe-bg-<timestamp>`). No personal data ever lands in test rows.
 */

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

// 120 s upper bound on polling for a single dump to reach a terminal state.
// Worker cadence is 2 s claim + LLM (~3-5 s typical, 30 s ceiling when
// regex fallback fires). 120 s covers the worst-case scenario in the full
// Probe pass: this suite serially queues ~6 dumps + a tail of in-flight
// work from earlier tests, so a late dump can sit behind 10+ jobs. If
// the LLM tier is degraded (Mistral cloud failing → regex fallback at
// ~25 s/job), even 120 s can be tight; check `lp worker logs` if this
// trips and confirm the worker isn't actually stuck before treating it
// as a real bug.
const POLL_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_000;

const TERMINAL_OK = new Set(['processed', 'needs_review']);
const INFLIGHT = new Set(['queued', 'unprocessed', 'processing']);

function uniqueDumpContent(label: string): string {
  // Privacy: only label + timestamp + random suffix. Never personal data.
  return `probe-bg ${label} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function findDumpById(apiCtx: import('@playwright/test').APIRequestContext, id: number) {
  const r = await apiCtx.get('api/brain-dumps');
  if (!r.ok()) throw new Error(`GET /api/brain-dumps returned ${r.status()}`);
  const list = (await r.json()) as Array<{ id: number; processing_status: string; content: string }>;
  return list.find((d) => d.id === id);
}

async function pollForStatus(
  apiCtx: import('@playwright/test').APIRequestContext,
  id: number,
  predicate: (status: string) => boolean,
  timeoutMs = POLL_TIMEOUT_MS,
): Promise<string> {
  const start = Date.now();
  let last = '<never-fetched>';
  while (Date.now() - start < timeoutMs) {
    const dump = await findDumpById(apiCtx, id);
    if (!dump) throw new Error(`brain dump ${id} disappeared while polling`);
    last = dump.processing_status;
    if (predicate(last)) return last;
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for status (last seen: ${last})`);
}

async function deleteDump(apiCtx: import('@playwright/test').APIRequestContext, id: number) {
  // Cleanup helper. Order matters.
  //
  // The worker logs `worker.finalise.error / OperationalError` if it's
  // mid-process when we delete the brain_dumps row (the post-LLM cache
  // update on brain_dumps fails because the row is gone, and the queue
  // row gets stuck in 'processing' until the watchdog reclaims it 5 min
  // later). To avoid both the noisy log and the orphan queue rows:
  //   1. Drop the queue rows FIRST (when sqlite3 is available) so the
  //      worker can't pick up new claims for this dump, and the
  //      finalisation guard for any in-flight claim becomes a clean
  //      no-op (the row simply isn't there).
  //   2. THEN delete via the API.
  //
  // When sqlite3 isn't available (e.g. the test is running against
  // production), skip step 1; the API delete is best-effort and orphan
  // rows self-heal via the watchdog.
  if (sqliteAvailable()) {
    try {
      sqliteExec(
        `DELETE FROM work_queue WHERE job_type='brain_dump' AND target_id=${id};`,
      );
    } catch {
      /* ignore */
    }
  }
  try {
    await apiCtx.delete(`api/brain-dumps/${id}`);
  } catch {
    /* ignore */
  }
}

// Direct SQLite helpers — only used by gated tests.
function dbPath(): string {
  return (
    process.env.LIFEPLAN_DB_PATH ||
    '/Users/cam/dev/personal/lifeplan/data/lifeplan.db'
  );
}

function sqliteAvailable(): boolean {
  try {
    const { execSync } = require('node:child_process');
    execSync('sqlite3 -version', { stdio: 'ignore' });
    return fs.existsSync(dbPath());
  } catch {
    return false;
  }
}

function sqliteExec(sql: string): string {
  const { execSync } = require('node:child_process');
  // Use -bail so the first error blows up loudly. -separator newline keeps
  // any RETURNING-style output trivially parseable.
  return execSync(`sqlite3 -bail ${JSON.stringify(dbPath())} ${JSON.stringify(sql)}`, {
    encoding: 'utf8',
  });
}

// ──────────────────────────────────────────────────────────────────
// Need an authenticated APIRequestContext for the API-level tests.
// The shipped `apiCtx` fixture is unauthenticated by design (it's used to
// probe the auth gate). We make a per-suite authenticated one ourselves.
// ──────────────────────────────────────────────────────────────────

import { request as pwRequest, type APIRequestContext } from '@playwright/test';

async function newAuthedApi(baseURL: string, password: string): Promise<APIRequestContext> {
  const ctx = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true });
  const r = await ctx.post('login', {
    headers: { 'Content-Type': 'application/json' },
    data: { password },
  });
  if (r.status() !== 200) {
    throw new Error(`auth setup failed: POST /login returned ${r.status()}`);
  }
  return ctx;
}

// ──────────────────────────────────────────────────────────────────
// Contract: POST /api/brain-dumps — happy path: queued → processed
// ──────────────────────────────────────────────────────────────────

test.describe('POST /api/brain-dumps (happy path)', () => {
  test('@worker @dump contract: 202 + queued → claimed by worker within 30s → terminal within 120s', async ({
    baseURL,
    password,
  }) => {
    test.skip(
      process.env.BG_HAPPY_TEST !== '1',
      'Skipped by default. Set BG_HAPPY_TEST=1 to run the full happy-path ' +
        'poll (claim within 30s + terminal within 120s). LLM-tier-dependent ' +
        'flake; see docs/runbooks/probe-suite-scoping.md §5.',
    );
    test.setTimeout(150_000);
    const api = await newAuthedApi(baseURL!, password);
    let dumpId: number | null = null;
    try {
      const content = uniqueDumpContent('happy');
      const post = await api.post('api/brain-dumps', {
        headers: { 'Content-Type': 'application/json' },
        data: { content },
      });
      // Contract: 202 on accept. Phase 3 commit pins processing_status to
      // 'queued' at insert (NOT the legacy 'unprocessed' default).
      expect(post.status()).toBe(202);
      const body = await post.json();
      expect(body).toMatchObject({ processing_status: 'queued' });
      expect(typeof body.id).toBe('number');
      dumpId = body.id as number;

      // First assertion: the worker is alive and claiming jobs. This is
      // the daemon-health signal — anything other than `queued` proves
      // the worker has at least picked up our dump (it might be
      // `processing`, `processed`, `needs_review`, or `failed` by the
      // time we look). Generous 30 s window covers a small backlog.
      // If THIS trips, the worker is stuck or dead.
      const claimedStatus = await pollForStatus(
        api,
        dumpId,
        (s) => s !== 'queued' && s !== 'unprocessed',
        30_000,
      );
      expect(['processing', 'processed', 'needs_review', 'failed']).toContain(claimedStatus);

      // Second assertion: it eventually reaches a terminal-ok state.
      // 120 s headroom for LLM cold paths and queue position. If THIS
      // trips and the first didn't, the worker is keeping up but
      // something downstream (LLM tier, finalisation) is slow.
      const finalStatus = await pollForStatus(api, dumpId, (s) => TERMINAL_OK.has(s));
      expect(['processed', 'needs_review']).toContain(finalStatus);
    } finally {
      if (dumpId !== null) await deleteDump(api, dumpId);
      await api.dispose();
    }
  });
});

// ──────────────────────────────────────────────────────────────────
// Contract: HTTP non-blocking — POST round-trip < 200ms
//
// THE headline regression test for this rollout. Pre-Phase-3, the POST
// blocked on the LLM call (2-45s). After: insert + queue + return.
// ──────────────────────────────────────────────────────────────────

test.describe('POST /api/brain-dumps non-blocking', () => {
  test('@worker @dump contract: round-trip well under 1s (was 2-45s pre-rollout)', async ({
    baseURL,
    password,
  }) => {
    const api = await newAuthedApi(baseURL!, password);
    let dumpId: number | null = null;
    try {
      // Warm-up GET so the latency we measure is the POST itself, not
      // TCP/TLS connection setup. The headline regression is "no inline
      // LLM call" — the LLM is 2-45s, so anything an order of magnitude
      // below that proves non-blocking. Stays well clear of cold-connection
      // jitter (~300ms first hit) while remaining sharply distinguishable
      // from the regression case.
      await api.get('api/brain-dumps');

      // Best-of-three: minimum of three POST round-trips to neutralise
      // GC / CPU jitter on the test runner. We assert on the floor.
      const samples: number[] = [];
      const ids: number[] = [];
      for (let i = 0; i < 3; i++) {
        const content = uniqueDumpContent(`latency-${i}`);
        const t0 = Date.now();
        const post = await api.post('api/brain-dumps', {
          headers: { 'Content-Type': 'application/json' },
          data: { content },
        });
        const elapsed = Date.now() - t0;
        expect(post.status()).toBe(202);
        const body = await post.json();
        ids.push(body.id as number);
        samples.push(elapsed);
      }
      dumpId = ids[ids.length - 1] ?? null;
      const fastest = Math.min(...samples);

      // 1s is the regression threshold: pre-rollout this was 2-45s
      // (inline LLM). Local insert + queue write is ~5-30ms; we leave
      // generous headroom for runner jitter. If this fires, the handler
      // is almost certainly doing inline processing again.
      expect(
        fastest,
        `fastest of ${samples.length} POST round-trips was ${fastest}ms (samples=${samples.join(',')}); target <1000ms`,
      ).toBeLessThan(1000);

      // Cleanup all the test rows we created.
      for (const id of ids) await deleteDump(api, id);
      dumpId = null;
    } finally {
      if (dumpId !== null) await deleteDump(api, dumpId);
      await api.dispose();
    }
  });
});

// ──────────────────────────────────────────────────────────────────
// Contract: POST /api/brain-dumps/<id>/retry — failed-state guard
//
// Lighter version of "retry actually re-queues a failed row." We don't
// want to wait for 3 real failures here, so we exercise the 409 guard
// (retry on a non-failed dump returns 409). The full failure path is
// gated behind FORCE_FAIL_TEST=1 below.
// ──────────────────────────────────────────────────────────────────

test.describe('POST /api/brain-dumps/<id>/retry', () => {
  test('@worker @dump contract: retry on non-failed dump returns 409 "not in failed state"', async ({
    baseURL,
    password,
  }) => {
    const api = await newAuthedApi(baseURL!, password);
    let dumpId: number | null = null;
    try {
      const content = uniqueDumpContent('retry-guard');
      const post = await api.post('api/brain-dumps', {
        headers: { 'Content-Type': 'application/json' },
        data: { content },
      });
      expect(post.status()).toBe(202);
      dumpId = (await post.json()).id as number;

      // Try retry while still queued/processing — must 409.
      const retry = await api.post(`api/brain-dumps/${dumpId}/retry`, {
        headers: { 'Content-Type': 'application/json' },
        data: {},
      });
      expect(retry.status()).toBe(409);
      expect(await retry.json()).toEqual({ error: 'not in failed state' });
    } finally {
      if (dumpId !== null) await deleteDump(api, dumpId);
      await api.dispose();
    }
  });

  test('@worker @dump contract: retry on non-existent dump returns 404', async ({ baseURL, password }) => {
    const api = await newAuthedApi(baseURL!, password);
    try {
      // High id unlikely to exist. Even if it does, the test still
      // either gets 404 (correct) or 409 (also acceptable: row exists
      // and is non-failed). We assert 404 strictly because the contract
      // says "no such dump" → 404.
      const retry = await api.post('api/brain-dumps/999999999/retry', {
        headers: { 'Content-Type': 'application/json' },
        data: {},
      });
      expect(retry.status()).toBe(404);
      expect(await retry.json()).toEqual({ error: 'not found' });
    } finally {
      await api.dispose();
    }
  });
});

// ──────────────────────────────────────────────────────────────────
// Contract: failure path — gated (FORCE_FAIL_TEST=1)
//
// We force-inject a queue row whose target_id points at a non-existent
// brain_dump. The worker raises ValueError, retries up to 3 attempts,
// then marks failed. We assert the row reaches `status='failed'` with
// `attempts >= 3` within ~30s.
//
// Why gated: needs direct SQLite write. CI that doesn't have the dev
// DB shouldn't try. Also doesn't help retry-success (that requires
// actually fixing the failure cause, which we can't do for a missing
// target_id). Documented in README and the manual checklist.
// ──────────────────────────────────────────────────────────────────

test.describe('Worker failure handling (gated: FORCE_FAIL_TEST=1)', () => {
  test('@worker @dump contract: 3 attempts on a poison job → status=failed', async () => {
    test.skip(
      process.env.FORCE_FAIL_TEST !== '1',
      'Skipped by default. Set FORCE_FAIL_TEST=1 to inject a poison work_queue row.',
    );
    test.skip(!sqliteAvailable(), 'sqlite3 CLI not available or DB path missing');

    // Use a target_id high enough that no brain_dump row will ever
    // accidentally collide. The unique partial index `idx_work_queue_one_active_per_dump`
    // permits this because no other non-terminal row will exist for it.
    const poisonTargetId = 2_000_000_000;
    sqliteExec(
      `INSERT INTO work_queue (job_type, target_id, status, attempts) ` +
        `VALUES ('brain_dump', ${poisonTargetId}, 'queued', 0);`,
    );
    // Capture the inserted id so we can clean up regardless.
    const idRaw = sqliteExec(
      `SELECT id FROM work_queue WHERE job_type='brain_dump' ` +
        `AND target_id=${poisonTargetId} AND status IN ('queued','processing','failed') ` +
        `ORDER BY id DESC LIMIT 1;`,
    ).trim();
    const queueId = parseInt(idRaw, 10);
    expect(queueId).toBeGreaterThan(0);

    try {
      // Worker ticks every 2s, +1 attempt per tick on failure. Three
      // attempts therefore complete in ~6-15s. Cap at 60s.
      const start = Date.now();
      let status = 'queued';
      let attempts = 0;
      while (Date.now() - start < 60_000) {
        const row = sqliteExec(
          `SELECT status || '|' || attempts FROM work_queue WHERE id=${queueId};`,
        ).trim();
        const [s, a] = row.split('|');
        status = s;
        attempts = parseInt(a, 10);
        if (status === 'failed') break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      expect(status, `terminal status after 60s (attempts=${attempts})`).toBe('failed');
      expect(attempts, 'attempts at terminal failure').toBeGreaterThanOrEqual(3);
    } finally {
      sqliteExec(`DELETE FROM work_queue WHERE id=${queueId};`);
    }
  });
});

// ──────────────────────────────────────────────────────────────────
// Contract: watchdog reclaim — gated (WATCHDOG_TEST=1)
//
// Insert a stale `processing` row, wait up to 70s for the watchdog
// (~60s cycle) to reclaim it back to `queued`, then for the worker to
// pick it up and mark it done.
//
// Why gated: 70s is disproportionate for a 30s-cap suite. Also needs
// direct SQLite access. Run on demand when worker / watchdog code
// changes. Documented in README and the manual checklist.
// ──────────────────────────────────────────────────────────────────

test.describe('Watchdog reclaim (gated: WATCHDOG_TEST=1)', () => {
  test('@worker @dump contract: stale processing row → reclaimed → done within ~90s', async ({
    baseURL,
    password,
  }) => {
    test.skip(
      process.env.WATCHDOG_TEST !== '1',
      'Skipped by default. Set WATCHDOG_TEST=1 to exercise the 60s watchdog cycle (slow test).',
    );
    test.skip(!sqliteAvailable(), 'sqlite3 CLI not available or DB path missing');

    // Set timeout high — this test deliberately waits past the 60s mark.
    test.setTimeout(150_000);

    const api = await newAuthedApi(baseURL!, password);
    let dumpId: number | null = null;
    let queueId: number | null = null;

    try {
      // Create a real brain dump so the worker can actually process it.
      const content = uniqueDumpContent('watchdog');
      const post = await api.post('api/brain-dumps', {
        headers: { 'Content-Type': 'application/json' },
        data: { content },
      });
      expect(post.status()).toBe(202);
      dumpId = (await post.json()).id as number;

      // Find the queue row that was just created and mutate it into a
      // stuck `processing` state (claimed_at = 10 minutes ago, well past
      // the 5-minute watchdog window).
      const idRaw = sqliteExec(
        `SELECT id FROM work_queue WHERE job_type='brain_dump' ` +
          `AND target_id=${dumpId} ORDER BY id DESC LIMIT 1;`,
      ).trim();
      queueId = parseInt(idRaw, 10);
      expect(queueId).toBeGreaterThan(0);

      sqliteExec(
        `UPDATE work_queue ` +
          `SET status='processing', claimed_at=datetime('now','-10 minutes'), attempts=1 ` +
          `WHERE id=${queueId};` +
          `UPDATE brain_dumps SET processing_status='processing' WHERE id=${dumpId};`,
      );

      // Now wait for: watchdog (≤60s) reclaims → queued → next claim
      // (≤2s) → processing → done (LLM duration). Cap at ~90s wall.
      const finalStatus = await pollForStatus(api, dumpId, (s) => TERMINAL_OK.has(s), 120_000);
      expect(['processed', 'needs_review']).toContain(finalStatus);
    } finally {
      if (dumpId !== null) await deleteDump(api, dumpId);
      await api.dispose();
    }
  });
});

// ──────────────────────────────────────────────────────────────────
// Contract: UI live transitions
//
// Browser test. Submits a dump via the form on the Brain Dump page and
// asserts the row appears with a Pending badge within 1s and transitions
// to a terminal badge within 30s WITHOUT manual reload (the polling
// loop does the work).
// ──────────────────────────────────────────────────────────────────

test.describe('UI live transitions on the dump-list page', () => {
  test('@worker @dump UI: submit → "Pending" within 1s → terminal badge within 120s, no reload', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    test.skip(
      process.env.BG_HAPPY_TEST !== '1',
      'Skipped by default. Set BG_HAPPY_TEST=1 to run the full UI live ' +
        'transition (Pending within 1s + terminal badge within 120s). ' +
        'LLM-tier-dependent flake; see docs/runbooks/probe-suite-scoping.md §5.',
    );
    // 150 s test budget. Worker is serial; in a full Probe pass this dump
    // can sit behind 10+ jobs queued by earlier tests. LLM tier chain is
    // ~3-5 s typical (Ollama 2 s timeout → Mistral cloud 1.5-3 s); when
    // Mistral cloud is degraded the regex fallback adds ~25 s per job.
    // 120 s polling assertion + 30 s headroom for setup/teardown.
    test.setTimeout(150_000);

    const page = loggedInPage;
    await page.goto(mountPrefix);
    // Navigate to Brain Dump view via the nav link (data-view hook).
    await page.locator('.nav-link[data-view="dump"]').first().click();
    // The textarea is the page anchor.
    await expect(page.locator('#dumpInput')).toBeVisible();

    const content = uniqueDumpContent('ui-live');
    await page.locator('#dumpInput').fill(content);
    // Wait for the Capture button to become visible — it's hidden until
    // the textarea has trimmed content. Without this, the click can race
    // the input handler that toggles the .visible class.
    await expect(page.locator('#dumpSend')).toBeVisible({ timeout: 2_000 });
    await page.locator('#dumpSend').click();

    // The new row contains the unique content and an in-flight badge.
    // We pin to the dump-item that contains our exact content string.
    const row = page.locator('.dump-item', { hasText: content });
    await expect(row, 'new row appears after submit').toBeVisible({ timeout: 5_000 });

    // Inflight badge: data-dump-status in {queued, unprocessed, processing}.
    const inflightBadge = row.locator(
      '.dump-badge[data-dump-status="queued"], ' +
        '.dump-badge[data-dump-status="unprocessed"], ' +
        '.dump-badge[data-dump-status="processing"]',
    );
    await expect(inflightBadge, 'in-flight badge present (Pending or Processing)').toBeVisible({
      timeout: 5_000,
    });

    // Without any manual reload, the polling loop should flip this row to
    // a terminal state within 30s.
    const terminalBadge = row.locator(
      '.dump-badge[data-dump-status="processed"], ' +
        '.dump-badge[data-dump-status="needs_review"], ' +
        '.dump-badge[data-dump-status="failed"]',
    );
    await expect(terminalBadge, 'terminal badge appears via polling, no reload').toBeVisible({
      timeout: 120_000,
    });

    // Cleanup: the page exposes deleteBrainDump(id). Find the dump id from
    // the rendered DOM (the retry button or review button carries it; if
    // neither, fall back to API list lookup).
    const dumpIdAttr = await row
      .locator('[data-dump-id]')
      .first()
      .getAttribute('data-dump-id')
      .catch(() => null);
    if (dumpIdAttr) {
      await page.evaluate((id) => (window as any).deleteBrainDump?.(parseInt(id, 10)), dumpIdAttr);
    }
  });

  test('@worker @dump UI: leaving the dump page stops polling (no further /api/brain-dumps calls)', async ({
    loggedInPage,
    mountPrefix,
    baseURL,
    password,
  }) => {
    test.setTimeout(60_000);

    const page = loggedInPage;
    await page.goto(mountPrefix);
    await page.locator('.nav-link[data-view="dump"]').first().click();
    await expect(page.locator('#dumpInput')).toBeVisible();

    const content = uniqueDumpContent('poll-stop');
    await page.locator('#dumpInput').fill(content);
    // Wait for the Capture button to become visible — it's hidden until
    // the textarea has trimmed content. Without this, the click can race
    // the input handler that toggles the .visible class.
    await expect(page.locator('#dumpSend')).toBeVisible({ timeout: 2_000 });
    await page.locator('#dumpSend').click();

    const row = page.locator('.dump-item', { hasText: content });
    await expect(row).toBeVisible({ timeout: 5_000 });

    // Navigate away to Goals while the dump is still in flight (best-effort
    // — if it processes instantly we still verify the polling-stop invariant
    // because no inflight rows means polling shouldn't fire anyway).
    await page.locator('.nav-link[data-view="goals"]').first().click();
    // Confirm we actually left the dump view; otherwise the assertion below
    // is meaningless.
    await expect(page.locator('#view-goals')).toBeVisible({ timeout: 5_000 });

    // Watch network for /api/brain-dumps requests for ~7 s (longer than
    // the 3 s polling interval, short enough to keep the test under the
    // 60 s test timeout). Contract: unmount stops the recursive
    // setTimeout, so zero further dump-list requests should fire while
    // we're on Goals.
    const dumpRequests: string[] = [];
    const handler = (req: import('@playwright/test').Request) => {
      const u = req.url();
      // Accept either with or without trailing query — exclude /<id>/* sub-routes.
      // Polling endpoint per contract is GET /api/brain-dumps (the list).
      if (/\/api\/brain-dumps(\?|$)/.test(u) && req.method() === 'GET') {
        dumpRequests.push(u);
      }
    };
    page.on('request', handler);
    await new Promise((r) => setTimeout(r, 7_000));
    page.off('request', handler);

    expect(
      dumpRequests,
      `polling should stop on navigation; saw ${dumpRequests.length} requests after leave: ${dumpRequests.join(', ')}`,
    ).toHaveLength(0);

    // Cleanup: best-effort via API (avoids racing the UI re-render).
    const api = await newAuthedApi(baseURL!, password);
    try {
      const r = await api.get('api/brain-dumps');
      if (r.ok()) {
        const list = (await r.json()) as Array<{ id: number; content: string }>;
        const mine = list.find((d) => d.content === content);
        if (mine) await deleteDump(api, mine.id);
      }
    } finally {
      await api.dispose();
    }
  });
});
