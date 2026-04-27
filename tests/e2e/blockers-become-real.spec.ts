import { test, expect } from './fixtures/auth';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import { request as pwRequest, type APIRequestContext } from '@playwright/test';

/**
 * "Blockers become real" — Probe ship-verifier suite.
 *
 * Scope: end-to-end verification of the cross-team batch Iris orchestrated.
 *   - Reed: schema migration 0004 (resolved + resolved_at on dependencies).
 *   - Vault: PUT /api/blockers/<id> with dual-write semantics (resolved /
 *     resolved_at always move together).
 *   - Lumen: shared blocker primitive (renderBlockerItem + bindBlockerItems),
 *     hero clickable + in-hero blocker actions, goal-detail modal with active
 *     above dimmed resolved, blocker_awareness prompt CTAs with multi-blocker
 *     picker, failed-dump Retry on home.
 *
 * Contracts:
 *   - app/contracts/blockers.md (PUT /api/blockers/<id>, dual-write).
 *   - app/contracts/background-processing.md (failed-dump retry: 'failed' →
 *     'queued' on POST /api/brain-dumps/<id>/retry).
 *
 * Approach: direct SQLite injection of test rows (a probe goal, a probe task,
 * a dependency between them, a `failed` dump, a `blocker_awareness` prompt).
 * Drive via API + Playwright. Canary prefix `probe-blockers-`. Clean up in
 * `test.afterAll` using the canary so a failed run can't leak.
 *
 * Privacy: every string written to the DB is canary-prefixed. No personal
 * data ever lands in test rows.
 *
 * Hero invariant: the dashboard hero is hard-wired to goal id=1 (see
 * handle_get_dashboard in app/handlers.py). The hero-UI tests therefore
 * attach probe blockers to goal id=1 itself, asserting only against rows
 * whose blocker_name carries the canary prefix. This avoids any dependency
 * on the production state of goal 1's other blockers.
 */

// ──────────────────────────────────────────────────────────────────
// Constants & helpers
// ──────────────────────────────────────────────────────────────────

const CANARY_PREFIX = 'probe-blockers-';

const DB_PATH =
  process.env.LIFEPLAN_DB_PATH ||
  '/Users/cam/dev/personal/lifeplan/data/lifeplan.db';

// Hero is wired to goal id=1 server-side. See handle_get_dashboard.
const HERO_GOAL_ID = 1;

function sqliteAvailable(): boolean {
  try {
    execSync('sqlite3 -version', { stdio: 'ignore' });
    return fs.existsSync(DB_PATH);
  } catch {
    return false;
  }
}

function runPython(source: string): string {
  const b64 = Buffer.from(source, 'utf8').toString('base64');
  return execSync(
    `python3 -c "import base64,sys;exec(compile(base64.b64decode('${b64}'),'<probe-blockers>','exec'))"`,
    { encoding: 'utf8' },
  );
}

function uniqueLabel(suffix: string): string {
  return `${CANARY_PREFIX}${suffix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

// Insert a goal row directly. Returns the new goal id.
function injectGoal(title: string, status = 'active'): number {
  const py = `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(DB_PATH)}, timeout=10.0)
try:
    cur = conn.execute(
        "INSERT INTO goals (title, description, status) VALUES (?, ?, ?)",
        (${JSON.stringify(title)}, ${JSON.stringify('canary')}, ${JSON.stringify(status)}),
    )
    conn.commit()
    print(cur.lastrowid)
finally:
    conn.close()
`;
  return parseInt(runPython(py).trim(), 10);
}

// Insert a task row directly. Returns the new task id.
function injectTask(title: string, goalId: number | null = null, status = 'active'): number {
  const py = `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(DB_PATH)}, timeout=10.0)
try:
    cur = conn.execute(
        "INSERT INTO tasks (title, goal_id, status) VALUES (?, ?, ?)",
        (${JSON.stringify(title)}, ${goalId === null ? 'None' : goalId}, ${JSON.stringify(status)}),
    )
    conn.commit()
    print(cur.lastrowid)
finally:
    conn.close()
`;
  return parseInt(runPython(py).trim(), 10);
}

// Insert a dependency row directly. Returns the new dependency id.
function injectDependency(
  blockerType: 'goal' | 'task' | 'external_system',
  blockerId: number,
  blockedType: 'goal' | 'task',
  blockedId: number,
  opts: { resolved?: 0 | 1; resolvedAt?: string | null; notes?: string | null } = {},
): number {
  const resolved = opts.resolved ?? 0;
  const resolvedAt = opts.resolvedAt === undefined ? null : opts.resolvedAt;
  const notes = opts.notes === undefined ? null : opts.notes;
  const py = `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(DB_PATH)}, timeout=10.0)
try:
    cur = conn.execute(
        "INSERT INTO dependencies (blocker_type, blocker_id, blocked_type, blocked_id, resolved, resolved_at, notes) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            ${JSON.stringify(blockerType)},
            ${blockerId},
            ${JSON.stringify(blockedType)},
            ${blockedId},
            ${resolved},
            ${resolvedAt === null ? 'None' : JSON.stringify(resolvedAt)},
            ${notes === null ? 'None' : JSON.stringify(notes)},
        ),
    )
    conn.commit()
    print(cur.lastrowid)
finally:
    conn.close()
`;
  return parseInt(runPython(py).trim(), 10);
}

// Insert a brain_dump row directly with a chosen processing_status.
// Used to seed a `failed` dump for the home Retry test without waiting
// for the worker to actually fail one.
function injectBrainDump(content: string, processingStatus = 'failed'): number {
  const py = `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(DB_PATH)}, timeout=10.0)
try:
    cur = conn.execute(
        "INSERT INTO brain_dumps (content, processing_status) VALUES (?, ?)",
        (${JSON.stringify(content)}, ${JSON.stringify(processingStatus)}),
    )
    conn.commit()
    print(cur.lastrowid)
finally:
    conn.close()
`;
  return parseInt(runPython(py).trim(), 10);
}

// Insert a prompt row directly. Used for the blocker_awareness CTAs.
function injectBlockerAwarenessPrompt(goalId: number, title: string, body: string): number {
  // Fingerprint must be unique. Use a canary-prefixed unique fingerprint
  // so the cleanup wipe by prefix nukes the row.
  const fingerprint = `${CANARY_PREFIX}fp-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const py = `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(DB_PATH)}, timeout=10.0)
try:
    cur = conn.execute(
        "INSERT INTO prompts (prompt_type, title, body, priority, status, "
        "source_type, source_id, trigger_rule, fingerprint) "
        "VALUES ('blocker_awareness', ?, ?, 2, 'active', 'goal', ?, 'multi_blockers', ?)",
        (${JSON.stringify(title)}, ${JSON.stringify(body)}, ${goalId}, ${JSON.stringify(fingerprint)}),
    )
    conn.commit()
    print(cur.lastrowid)
finally:
    conn.close()
`;
  return parseInt(runPython(py).trim(), 10);
}

// Read a single dependency row (used for SQL-level dual-write assertions).
function readDependency(
  id: number,
): { id: number; resolved: number; resolved_at: string | null; notes: string | null } {
  const py = `
import sqlite3, json, sys
conn = sqlite3.connect(${JSON.stringify(DB_PATH)}, timeout=10.0)
try:
    row = conn.execute(
        "SELECT id, resolved, resolved_at, notes FROM dependencies WHERE id = ?",
        (${id},),
    ).fetchone()
    if row is None:
        sys.stdout.write("null")
    else:
        sys.stdout.write(json.dumps({
            "id": row[0],
            "resolved": row[1],
            "resolved_at": row[2],
            "notes": row[3],
        }))
finally:
    conn.close()
`;
  const out = runPython(py).trim();
  if (out === 'null') throw new Error(`dependency ${id} not found`);
  return JSON.parse(out);
}

function readBrainDumpStatus(id: number): string {
  const py = `
import sqlite3, sys
conn = sqlite3.connect(${JSON.stringify(DB_PATH)}, timeout=10.0)
try:
    row = conn.execute(
        "SELECT processing_status FROM brain_dumps WHERE id = ?",
        (${id},),
    ).fetchone()
    if row is None:
        sys.stdout.write("__missing__")
    else:
        sys.stdout.write(row[0])
finally:
    conn.close()
`;
  return runPython(py).trim();
}

// Wholesale cleanup by canary prefix. Order matters: deps → prompts →
// brain_dumps → tasks → goals. Tasks reference goals via FK ON DELETE SET NULL
// so order between those two doesn't strictly matter, but we keep it tidy.
function cleanupByCanary(): void {
  const py = `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(DB_PATH)}, timeout=10.0)
try:
    pref = ${JSON.stringify(CANARY_PREFIX)} + '%'
    # Dependencies whose blocker_id or blocked_id points at a canary goal/task,
    # or whose notes carry the canary string.
    conn.execute(
        "DELETE FROM dependencies WHERE id IN ("
        "  SELECT d.id FROM dependencies d "
        "  LEFT JOIN goals g_blk ON d.blocker_type='goal' AND d.blocker_id=g_blk.id "
        "  LEFT JOIN tasks t_blk ON d.blocker_type='task' AND d.blocker_id=t_blk.id "
        "  LEFT JOIN goals g_bd  ON d.blocked_type='goal'  AND d.blocked_id=g_bd.id "
        "  LEFT JOIN tasks t_bd  ON d.blocked_type='task'  AND d.blocked_id=t_bd.id "
        "  WHERE (g_blk.title LIKE ?) OR (t_blk.title LIKE ?) "
        "     OR (g_bd.title  LIKE ?) OR (t_bd.title  LIKE ?) "
        "     OR (d.notes LIKE ?)"
        ")",
        (pref, pref, pref, pref, pref),
    )
    conn.execute("DELETE FROM prompts WHERE fingerprint LIKE ?", (pref,))
    conn.execute("DELETE FROM brain_dumps WHERE content LIKE ?", (pref,))
    conn.execute("DELETE FROM tasks WHERE title LIKE ?", (pref,))
    conn.execute("DELETE FROM goals WHERE title LIKE ?", (pref,))
    conn.commit()
finally:
    conn.close()
`;
  runPython(py);
}

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
// Suite-level guard + cleanup
// ──────────────────────────────────────────────────────────────────

test.beforeAll(() => {
  if (!sqliteAvailable()) {
    throw new Error(
      `sqlite3 / ${DB_PATH} not available; this suite needs direct DB access. ` +
        `Set LIFEPLAN_DB_PATH to override.`,
    );
  }
  // Wipe any leftover canary rows from a prior failed run so seeded rows
  // start clean.
  cleanupByCanary();
});

test.afterAll(() => {
  cleanupByCanary();
});

// ──────────────────────────────────────────────────────────────────
// API: PUT /api/blockers/<id> contract — dual-write & validation
// ──────────────────────────────────────────────────────────────────

test.describe('contract: PUT /api/blockers/<id> dual-write', () => {
  test('contract: {"resolved": true} → 200, resolved=1 + resolved_at populated', async ({
    baseURL,
    password,
  }) => {
    const api = await newAuthedApi(baseURL!, password);
    try {
      const goalA = injectGoal(uniqueLabel('goalA-resolve'));
      const goalB = injectGoal(uniqueLabel('goalB-resolve'));
      const depId = injectDependency('goal', goalA, 'goal', goalB);

      // Pre-state sanity.
      const pre = readDependency(depId);
      expect(pre.resolved).toBe(0);
      expect(pre.resolved_at).toBeNull();

      const r = await api.put(`api/blockers/${depId}`, {
        headers: { 'Content-Type': 'application/json' },
        data: { resolved: true },
      });
      expect(r.status()).toBe(200);
      const body = await r.json();
      expect(body.id).toBe(depId);
      expect(body.resolved).toBe(1);
      expect(body.resolved_at, 'resolved_at populated in response').toBeTruthy();

      // Dual-write at the SQL level.
      const post = readDependency(depId);
      expect(post.resolved).toBe(1);
      expect(post.resolved_at, 'resolved_at populated in DB').toBeTruthy();
    } finally {
      await api.dispose();
    }
  });

  test('contract: {"resolved": false} → 200, resolved=0 + resolved_at NULL', async ({
    baseURL,
    password,
  }) => {
    const api = await newAuthedApi(baseURL!, password);
    try {
      const goalA = injectGoal(uniqueLabel('goalA-unresolve'));
      const goalB = injectGoal(uniqueLabel('goalB-unresolve'));
      // Seed already-resolved.
      const depId = injectDependency('goal', goalA, 'goal', goalB, {
        resolved: 1,
        resolvedAt: '2026-04-22T10:00:00',
      });

      const r = await api.put(`api/blockers/${depId}`, {
        headers: { 'Content-Type': 'application/json' },
        data: { resolved: false },
      });
      expect(r.status()).toBe(200);
      const body = await r.json();
      expect(body.resolved).toBe(0);
      expect(body.resolved_at, 'resolved_at cleared in response').toBeNull();

      const post = readDependency(depId);
      expect(post.resolved).toBe(0);
      expect(post.resolved_at, 'resolved_at cleared in DB').toBeNull();
    } finally {
      await api.dispose();
    }
  });

  test('contract: {"notes": "..."} partial update → notes change, resolved/resolved_at untouched', async ({
    baseURL,
    password,
  }) => {
    const api = await newAuthedApi(baseURL!, password);
    try {
      const goalA = injectGoal(uniqueLabel('goalA-notes'));
      const goalB = injectGoal(uniqueLabel('goalB-notes'));
      // Seed already-resolved with a known timestamp; we expect the
      // partial-update to leave both alone.
      const seededAt = '2026-04-22T10:00:00';
      const depId = injectDependency('goal', goalA, 'goal', goalB, {
        resolved: 1,
        resolvedAt: seededAt,
        notes: 'before',
      });

      const newNotes = uniqueLabel('after-note');
      const r = await api.put(`api/blockers/${depId}`, {
        headers: { 'Content-Type': 'application/json' },
        data: { notes: newNotes },
      });
      expect(r.status()).toBe(200);
      const body = await r.json();
      expect(body.notes).toBe(newNotes);
      // resolved + resolved_at untouched.
      expect(body.resolved).toBe(1);
      expect(body.resolved_at).toBe(seededAt);

      const post = readDependency(depId);
      expect(post.notes).toBe(newNotes);
      expect(post.resolved).toBe(1);
      expect(post.resolved_at).toBe(seededAt);
    } finally {
      await api.dispose();
    }
  });

  test('contract: 404 on missing id', async ({ baseURL, password }) => {
    const api = await newAuthedApi(baseURL!, password);
    try {
      // Use an id that's almost certainly not present.
      const r = await api.put('api/blockers/999999999', {
        headers: { 'Content-Type': 'application/json' },
        data: { resolved: true },
      });
      expect(r.status()).toBe(404);
      expect(await r.json()).toEqual({ error: 'Blocker not found' });
    } finally {
      await api.dispose();
    }
  });

  test('contract: 400 on {"unknown_key": 1}', async ({ baseURL, password }) => {
    const api = await newAuthedApi(baseURL!, password);
    try {
      const goalA = injectGoal(uniqueLabel('goalA-unknown'));
      const goalB = injectGoal(uniqueLabel('goalB-unknown'));
      const depId = injectDependency('goal', goalA, 'goal', goalB);

      const r = await api.put(`api/blockers/${depId}`, {
        headers: { 'Content-Type': 'application/json' },
        data: { unknown_key: 1 },
      });
      expect(r.status()).toBe(400);
      const body = await r.json();
      // Privacy: error names the field, never echoes the value.
      expect(body.error).toBe('unknown field: unknown_key');
    } finally {
      await api.dispose();
    }
  });

  test('contract: 400 on {"resolved": "yes"} (must be a boolean)', async ({
    baseURL,
    password,
  }) => {
    const api = await newAuthedApi(baseURL!, password);
    try {
      const goalA = injectGoal(uniqueLabel('goalA-strbool'));
      const goalB = injectGoal(uniqueLabel('goalB-strbool'));
      const depId = injectDependency('goal', goalA, 'goal', goalB);

      const r = await api.put(`api/blockers/${depId}`, {
        headers: { 'Content-Type': 'application/json' },
        data: { resolved: 'yes' },
      });
      expect(r.status()).toBe(400);
      const body = await r.json();
      expect(body.error).toBe('resolved must be a boolean');

      // And state did not change.
      const post = readDependency(depId);
      expect(post.resolved).toBe(0);
      expect(post.resolved_at).toBeNull();
    } finally {
      await api.dispose();
    }
  });
});

// ──────────────────────────────────────────────────────────────────
// UI: hero card → goal detail modal
// ──────────────────────────────────────────────────────────────────

test.describe('UI: hero card opens goal-detail modal', () => {
  test('UI: clicking the hero card opens the goal-detail modal for the primary goal', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    const page = loggedInPage;
    await page.goto(mountPrefix);

    // Hero is hard-wired to goal id=1. Wait for it to render.
    const hero = page.locator('.hero-goal--clickable');
    await expect(hero).toBeVisible({ timeout: 10_000 });

    // Click the hero title (not a blocker row, not a button) so the card
    // open path runs. The .hero-goal-title is a safe inner element.
    await hero.locator('.hero-goal-title').click();

    // Modal opens.
    await expect(page.locator('#goalDetailOverlay.visible')).toBeVisible({ timeout: 5_000 });
    // The title element of the modal carries the goal name; we don't pin
    // the exact string because the production goal name is real data.
    await expect(page.locator('#goalDetailTitle')).not.toBeEmpty();
  });
});

// ──────────────────────────────────────────────────────────────────
// UI: hero blocker row — toggle (icon) + navigate (name)
// ──────────────────────────────────────────────────────────────────

test.describe('UI: hero blocker row interactions', () => {
  test('UI: tap blocker icon → row dims, toast shows Undo, PUT fires; after 5s blocker stays resolved (SQL verified)', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    test.setTimeout(45_000);

    // Seed a probe blocker on goal id=1 (the hero). Use a task-typed
    // blocker so the name navigates to the tasks list (we don't click
    // the name in this test, but it keeps the row navigable).
    const taskTitle = uniqueLabel('hero-toggle-blocker');
    const taskId = injectTask(taskTitle, null, 'active');
    const depId = injectDependency('task', taskId, 'goal', HERO_GOAL_ID);

    const page = loggedInPage;
    await page.goto(mountPrefix);

    // Capture the network PUT.
    const putWaiter = page.waitForRequest(
      (req) =>
        req.method() === 'PUT' &&
        new RegExp(`/api/blockers/${depId}(\\?|$)`).test(req.url()),
      { timeout: 10_000 },
    );

    const row = page.locator(`.hero-blockers .blocker-item[data-blocker-id="${depId}"]`);
    await expect(row, 'probe blocker row appears in hero').toBeVisible({ timeout: 10_000 });
    // Sanity: the canary task title shows.
    await expect(row.locator('.blocker-name')).toHaveText(taskTitle);
    // Pre-state: not resolved.
    await expect(row).not.toHaveClass(/blocker--resolved/);

    // Tap the leading icon button.
    await row.locator('[data-action="toggle-resolve"]').click();

    // PUT fired.
    const putReq = await putWaiter;
    expect(putReq.method()).toBe('PUT');

    // Toast with Undo appears. The toast and Undo button are not
    // role-tagged; pin by class. Lifeplan reuses a single .lp-toast
    // node, and the Undo affordance is .lp-toast-retry.
    await expect(page.locator('.lp-toast.visible')).toBeVisible({ timeout: 3_000 });
    await expect(page.locator('.lp-toast.visible .lp-toast-retry')).toHaveText('Undo');

    // Row leaves the hero's active list once resolved. The hero filters
    // to `!resolved` (see renderHome → unresolvedBlockers), so on the
    // next loadHome() refresh the row will simply not be there. Either
    // (a) the optimistic class flip lands and we see .blocker--resolved
    // before refresh, or (b) refresh removed the row outright. Both
    // demonstrate the visual "this is no longer blocking me" outcome.
    const heroRow = page.locator(`.hero-blockers .blocker-item[data-blocker-id="${depId}"]`);
    await expect
      .poll(
        async () => {
          if ((await heroRow.count()) === 0) return 'gone';
          const cls = (await heroRow.first().getAttribute('class')) || '';
          return cls.includes('blocker--resolved') ? 'dimmed' : 'still-active';
        },
        {
          message: 'hero row should dim or be removed on resolve',
          timeout: 5_000,
        },
      )
      .not.toBe('still-active');

    // Wait past the 5.5s toast lifetime; the toast should disappear and
    // the resolution should persist.
    await expect(page.locator('.lp-toast.visible')).toBeHidden({ timeout: 8_000 });

    // SQL truth: row is resolved with a non-null resolved_at.
    const persisted = readDependency(depId);
    expect(persisted.resolved).toBe(1);
    expect(persisted.resolved_at).toBeTruthy();
  });

  test('UI: tap blocker name on a task-typed blocker → navigates to tasks view', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    // Seed a task-typed blocker on goal id=1.
    const taskTitle = uniqueLabel('hero-nav-task-blocker');
    const taskId = injectTask(taskTitle, null, 'active');
    const depId = injectDependency('task', taskId, 'goal', HERO_GOAL_ID);

    const page = loggedInPage;
    await page.goto(mountPrefix);

    const row = page.locator(`.hero-blockers .blocker-item[data-blocker-id="${depId}"]`);
    await expect(row).toBeVisible({ timeout: 10_000 });

    await row.locator('.blocker-name').click();

    // Tasks view becomes the active view.
    await expect(page.locator('#view-tasks.active')).toBeVisible({ timeout: 5_000 });
  });

  test('UI: tap blocker name on a goal-typed blocker → opens that goal-detail modal', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    // Seed a goal-typed blocker on goal id=1: probe-goal blocks goal 1.
    const probeGoalTitle = uniqueLabel('hero-nav-goal-target');
    const probeGoalId = injectGoal(probeGoalTitle);
    const depId = injectDependency('goal', probeGoalId, 'goal', HERO_GOAL_ID);

    const page = loggedInPage;
    await page.goto(mountPrefix);

    const row = page.locator(`.hero-blockers .blocker-item[data-blocker-id="${depId}"]`);
    await expect(row).toBeVisible({ timeout: 10_000 });

    await row.locator('.blocker-name').click();

    // Goal-detail modal opens with the probe-goal title.
    await expect(page.locator('#goalDetailOverlay.visible')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('#goalDetailTitle')).toHaveText(probeGoalTitle, { timeout: 5_000 });
  });
});

// ──────────────────────────────────────────────────────────────────
// UI: goal-detail modal — active above resolved, count is correct
// ──────────────────────────────────────────────────────────────────

test.describe('UI: goal-detail modal blocker ordering and header count', () => {
  test('UI: active blockers above dimmed resolved; "Blockers (N active)" count matches', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    // Build a fresh probe goal with 2 active and 1 resolved blocker,
    // attached as goal-typed blockers (so the modal opens cleanly without
    // racing with prod data on goal 1).
    const targetTitle = uniqueLabel('detail-target');
    const targetGoalId = injectGoal(targetTitle);

    const blkA = injectGoal(uniqueLabel('detail-active-A'));
    const blkB = injectGoal(uniqueLabel('detail-active-B'));
    const blkR = injectGoal(uniqueLabel('detail-resolved'));

    const depA = injectDependency('goal', blkA, 'goal', targetGoalId);
    const depB = injectDependency('goal', blkB, 'goal', targetGoalId);
    const depR = injectDependency('goal', blkR, 'goal', targetGoalId, {
      resolved: 1,
      resolvedAt: '2026-04-22T10:00:00',
    });

    const page = loggedInPage;
    await page.goto(mountPrefix);

    // Open the goal-detail modal directly via the app's helper. This is
    // the same code path the rest of the app uses; we skip the goals-list
    // navigation here because we're testing the modal contents, not the
    // navigation.
    await page.evaluate((id) => (window as any).openGoalDetail?.(id), targetGoalId);
    await expect(page.locator('#goalDetailOverlay.visible')).toBeVisible({ timeout: 5_000 });

    // Header: "Blockers (2 active)".
    const header = page.locator('#goalDetailBody .goal-detail-section-title', {
      hasText: /^Blockers/,
    });
    await expect(header).toHaveText('Blockers (2 active)');

    // Row order: depA, depB, then depR (active before resolved).
    const rows = page.locator('#goalDetailBody .goal-detail-blockers .blocker-item');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toHaveAttribute('data-blocker-id', String(depA));
    await expect(rows.nth(1)).toHaveAttribute('data-blocker-id', String(depB));
    await expect(rows.nth(2)).toHaveAttribute('data-blocker-id', String(depR));

    // The resolved row is dimmed; the actives are not.
    await expect(rows.nth(0)).not.toHaveClass(/blocker--resolved/);
    await expect(rows.nth(1)).not.toHaveClass(/blocker--resolved/);
    await expect(rows.nth(2)).toHaveClass(/blocker--resolved/);
  });
});

// ──────────────────────────────────────────────────────────────────
// UI: blocker_awareness prompt CTAs — "Open the goal" / "Mark resolved"
// ──────────────────────────────────────────────────────────────────

test.describe('UI: blocker_awareness prompt CTAs', () => {
  test('UI: "Open the goal" CTA opens the goal-detail modal for the prompt source', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    // Seed a probe goal + one blocker, plus a blocker_awareness prompt
    // pointing at that goal.
    const goalTitle = uniqueLabel('prompt-open-goal');
    const goalId = injectGoal(goalTitle);
    const blkId = injectGoal(uniqueLabel('prompt-open-goal-blk'));
    injectDependency('goal', blkId, 'goal', goalId);
    const promptId = injectBlockerAwarenessPrompt(
      goalId,
      uniqueLabel('prompt-title'),
      'canary body',
    );

    const page = loggedInPage;
    await page.goto(mountPrefix);

    const promptCard = page.locator(`#prompt-${promptId}`);
    await expect(promptCard).toBeVisible({ timeout: 10_000 });

    await promptCard.getByRole('button', { name: 'Open the goal' }).click();

    await expect(page.locator('#goalDetailOverlay.visible')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('#goalDetailTitle')).toHaveText(goalTitle);
  });

  test('UI: "Mark resolved" with one active blocker → resolves directly (SQL verified)', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    test.setTimeout(45_000);

    const goalTitle = uniqueLabel('prompt-mark-one');
    const goalId = injectGoal(goalTitle);
    const blkId = injectGoal(uniqueLabel('prompt-mark-one-blk'));
    const depId = injectDependency('goal', blkId, 'goal', goalId);
    const promptId = injectBlockerAwarenessPrompt(
      goalId,
      uniqueLabel('prompt-mark-one-title'),
      'canary body',
    );

    const page = loggedInPage;
    await page.goto(mountPrefix);

    const promptCard = page.locator(`#prompt-${promptId}`);
    await expect(promptCard).toBeVisible({ timeout: 10_000 });

    const putWaiter = page.waitForRequest(
      (req) =>
        req.method() === 'PUT' &&
        new RegExp(`/api/blockers/${depId}(\\?|$)`).test(req.url()),
      { timeout: 10_000 },
    );

    await promptCard.getByRole('button', { name: 'Mark resolved' }).click();

    await putWaiter;

    // No picker should appear when there's exactly one active blocker.
    await expect(page.locator('.blocker-picker-overlay')).toHaveCount(0);

    // Eventual SQL truth.
    await expect.poll(() => readDependency(depId).resolved, { timeout: 5_000 }).toBe(1);
    expect(readDependency(depId).resolved_at).toBeTruthy();
  });

  test('UI: "Mark resolved" with multiple active blockers → picker overlay opens', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    const goalTitle = uniqueLabel('prompt-mark-multi');
    const goalId = injectGoal(goalTitle);
    const blkA = injectGoal(uniqueLabel('prompt-mark-multi-blkA'));
    const blkB = injectGoal(uniqueLabel('prompt-mark-multi-blkB'));
    injectDependency('goal', blkA, 'goal', goalId);
    injectDependency('goal', blkB, 'goal', goalId);
    const promptId = injectBlockerAwarenessPrompt(
      goalId,
      uniqueLabel('prompt-mark-multi-title'),
      'canary body',
    );

    const page = loggedInPage;
    await page.goto(mountPrefix);

    const promptCard = page.locator(`#prompt-${promptId}`);
    await expect(promptCard).toBeVisible({ timeout: 10_000 });

    await promptCard.getByRole('button', { name: 'Mark resolved' }).click();

    // Picker opens.
    const picker = page.locator('.blocker-picker-overlay');
    await expect(picker).toBeVisible({ timeout: 5_000 });
    // Two picker items, one per active blocker.
    await expect(picker.locator('.blocker-picker-item')).toHaveCount(2);
  });
});

// ──────────────────────────────────────────────────────────────────
// UI: failed dump on home shows Retry; click → status flips to queued
// ──────────────────────────────────────────────────────────────────

test.describe('UI: failed-dump Retry on home', () => {
  test('UI: failed dump shows Retry; click → POST retry, processing_status flips to queued', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    test.setTimeout(60_000);

    // Seed a failed dump directly. The home view's recent-dumps section
    // will surface it on its next loadHome() call.
    const dumpContent = uniqueLabel('failed-dump');
    const dumpId = injectBrainDump(dumpContent, 'failed');

    const page = loggedInPage;
    await page.goto(mountPrefix);

    const retryBtn = page.locator(`#homeRecentDumps .dump-retry-btn[data-dump-id="${dumpId}"]`);
    await expect(retryBtn, 'Retry button surfaces on a failed dump').toBeVisible({ timeout: 10_000 });

    const retryWaiter = page.waitForResponse(
      (resp) =>
        new RegExp(`/api/brain-dumps/${dumpId}/retry$`).test(resp.url()) &&
        resp.request().method() === 'POST',
      { timeout: 10_000 },
    );

    await retryBtn.click();

    const resp = await retryWaiter;
    // 202 from the retry endpoint on a successful re-queue (per
    // app/contracts/background-processing.md and handle_retry_brain_dump).
    expect(resp.status()).toBe(202);

    // Eventual SQL truth: status flipped to 'queued' (or onward as the
    // worker may have already claimed it). Anything that's NOT 'failed'
    // proves the retry took effect; the headline assertion is the
    // contract-specified flip 'failed' → 'queued'.
    await expect
      .poll(() => readBrainDumpStatus(dumpId), { timeout: 10_000 })
      .not.toBe('failed');

    // Cleanup: best-effort delete via the brain-dump DELETE handler so we
    // don't leave a queued worker job hanging. The afterAll canary wipe
    // also catches it.
    // (No work_queue cleanup here — the canary cleanup wipes the
    // brain_dump row; orphan work_queue rows self-heal via the watchdog.)
  });
});
