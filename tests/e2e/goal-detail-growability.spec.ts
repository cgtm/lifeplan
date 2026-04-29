import { test, expect } from './fixtures/auth';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import { request as pwRequest, type APIRequestContext } from '@playwright/test';

/**
 * "Goal-detail growability" — Probe ship-verifier suite for Iris's
 * 2026-04-29 dispatch.
 *
 * Scope:
 *   - Vault: POST /api/blockers (full validation matrix), GET /api/external-systems.
 *   - Lumen: + Task inline form, + Blocker unified-search picker, modal-stays-open
 *     invariant on every Add action, empty-state CTA pre-expand.
 *
 * Contracts:
 *   - app/contracts/blockers.md (POST section).
 *   - docs/ux-design/2026-04-29-goal-detail-growability.md.
 *
 * Approach: API tests use a fresh APIRequestContext per test; UI tests
 * inject canary goals/tasks/external_systems via direct sqlite, then drive
 * Playwright. Canary prefix `probe-grow-`. afterAll cleanup wipes by prefix.
 *
 * Privacy: every DB-written string is canary-prefixed. No real data leaks
 * into test rows.
 */

const CANARY_PREFIX = 'probe-grow-';

const DB_PATH =
  process.env.LIFEPLAN_DB_PATH ||
  '/Users/cam/dev/personal/lifeplan/data/lifeplan.db';

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
    `python3 -c "import base64,sys;exec(compile(base64.b64decode('${b64}'),'<probe-grow>','exec'))"`,
    { encoding: 'utf8' },
  );
}

function uniqueLabel(suffix: string): string {
  return `${CANARY_PREFIX}${suffix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

function injectGoal(title: string, status = 'active'): number {
  const py = `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(DB_PATH)}, timeout=10.0)
try:
    cur = conn.execute(
        "INSERT INTO goals (title, description, status) VALUES (?, ?, ?)",
        (${JSON.stringify(title)}, 'canary', ${JSON.stringify(status)}),
    )
    conn.commit()
    print(cur.lastrowid)
finally:
    conn.close()
`;
  return parseInt(runPython(py).trim(), 10);
}

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

function injectExternalSystem(name: string): number {
  const py = `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(DB_PATH)}, timeout=10.0)
try:
    cur = conn.execute(
        "INSERT INTO external_systems (name, description) VALUES (?, ?)",
        (${JSON.stringify(name)}, 'canary'),
    )
    conn.commit()
    print(cur.lastrowid)
finally:
    conn.close()
`;
  return parseInt(runPython(py).trim(), 10);
}

function readDependency(
  id: number,
): { id: number; blocker_type: string; blocker_id: number; blocked_id: number; resolved: number; notes: string | null } | null {
  const py = `
import sqlite3, json, sys
conn = sqlite3.connect(${JSON.stringify(DB_PATH)}, timeout=10.0)
try:
    row = conn.execute(
        "SELECT id, blocker_type, blocker_id, blocked_id, resolved, notes FROM dependencies WHERE id = ?",
        (${id},),
    ).fetchone()
    if row is None:
        sys.stdout.write("null")
    else:
        sys.stdout.write(json.dumps({
            "id": row[0], "blocker_type": row[1], "blocker_id": row[2],
            "blocked_id": row[3], "resolved": row[4], "notes": row[5],
        }))
finally:
    conn.close()
`;
  const out = runPython(py).trim();
  if (out === 'null') return null;
  return JSON.parse(out);
}

function cleanupByCanary(): void {
  const py = `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(DB_PATH)}, timeout=10.0)
try:
    pref = ${JSON.stringify(CANARY_PREFIX)} + '%'
    # dependencies whose endpoints touch a canary goal/task/external_system, or whose notes carry canary
    conn.execute(
        "DELETE FROM dependencies WHERE id IN ("
        "  SELECT d.id FROM dependencies d "
        "  LEFT JOIN goals g_blk ON d.blocker_type='goal' AND d.blocker_id=g_blk.id "
        "  LEFT JOIN tasks t_blk ON d.blocker_type='task' AND d.blocker_id=t_blk.id "
        "  LEFT JOIN external_systems x_blk ON d.blocker_type='external_system' AND d.blocker_id=x_blk.id "
        "  LEFT JOIN goals g_bd  ON d.blocked_type='goal'  AND d.blocked_id=g_bd.id "
        "  LEFT JOIN tasks t_bd  ON d.blocked_type='task'  AND d.blocked_id=t_bd.id "
        "  WHERE (g_blk.title LIKE ?) OR (t_blk.title LIKE ?) OR (x_blk.name LIKE ?) "
        "     OR (g_bd.title  LIKE ?) OR (t_bd.title  LIKE ?) "
        "     OR (d.notes LIKE ?)"
        ")",
        (pref, pref, pref, pref, pref, pref),
    )
    conn.execute("DELETE FROM tasks WHERE title LIKE ?", (pref,))
    conn.execute("DELETE FROM goals WHERE title LIKE ?", (pref,))
    conn.execute("DELETE FROM external_systems WHERE name LIKE ?", (pref,))
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
  cleanupByCanary();
});

test.afterAll(() => {
  cleanupByCanary();
});

// ──────────────────────────────────────────────────────────────────
// API: GET /api/external-systems
// ──────────────────────────────────────────────────────────────────

test.describe('contract: GET /api/external-systems', () => {
  test('API 7: returns the seeded list as an array of {id, name, ...}', async ({
    baseURL,
    password,
  }) => {
    const api = await newAuthedApi(baseURL!, password);
    try {
      // Inject a canary external_system so we can find it without depending
      // on a specific seed.
      const xName = uniqueLabel('xs-list');
      const xId = injectExternalSystem(xName);

      const r = await api.get('api/external-systems');
      expect(r.status()).toBe(200);
      const body = await r.json();
      expect(Array.isArray(body)).toBe(true);
      const found = body.find((row: any) => row.id === xId);
      expect(found, 'canary external_system appears in list').toBeTruthy();
      expect(found.name).toBe(xName);
    } finally {
      await api.dispose();
    }
  });
});

// ──────────────────────────────────────────────────────────────────
// API: POST /api/blockers — happy path × 3 types
// ──────────────────────────────────────────────────────────────────

test.describe('contract: POST /api/blockers happy paths', () => {
  test('API 1a: blocker_type=goal → 201, full enriched row', async ({ baseURL, password }) => {
    const api = await newAuthedApi(baseURL!, password);
    try {
      const target = injectGoal(uniqueLabel('post-goal-target'));
      const blkGoal = injectGoal(uniqueLabel('post-goal-blocker'));

      const r = await api.post('api/blockers', {
        headers: { 'Content-Type': 'application/json' },
        data: {
          goal_id: target,
          blocker_type: 'goal',
          blocker_goal_id: blkGoal,
          notes: `${CANARY_PREFIX}post-goal-notes`,
        },
      });
      expect(r.status()).toBe(201);
      const body = await r.json();
      expect(body.id).toBeTruthy();
      expect(body.blocker_type).toBe('goal');
      expect(body.blocker_id).toBe(blkGoal);
      expect(body.blocked_type).toBe('goal');
      expect(body.blocked_id).toBe(target);
      expect(body.blocker_name).toBeTruthy();
      expect(body.blocked_name).toBeTruthy();
      expect(body.resolved).toBe(0);
      expect(body.resolved_at).toBeNull();
      expect(body.created_at).toBeTruthy();
      expect(body.notes).toBe(`${CANARY_PREFIX}post-goal-notes`);

      // Persisted at SQL level.
      const row = readDependency(body.id);
      expect(row).toBeTruthy();
      expect(row!.blocker_type).toBe('goal');
      expect(row!.blocker_id).toBe(blkGoal);
    } finally {
      await api.dispose();
    }
  });

  test('API 1b: blocker_type=task → 201, full enriched row', async ({ baseURL, password }) => {
    const api = await newAuthedApi(baseURL!, password);
    try {
      const target = injectGoal(uniqueLabel('post-task-target'));
      const blkTask = injectTask(uniqueLabel('post-task-blocker'));

      const r = await api.post('api/blockers', {
        headers: { 'Content-Type': 'application/json' },
        data: {
          goal_id: target,
          blocker_type: 'task',
          blocker_task_id: blkTask,
        },
      });
      expect(r.status()).toBe(201);
      const body = await r.json();
      expect(body.blocker_type).toBe('task');
      expect(body.blocker_id).toBe(blkTask);
      expect(body.blocked_id).toBe(target);
      expect(body.notes).toBeNull();
    } finally {
      await api.dispose();
    }
  });

  test('API 1c: blocker_type=external_system → 201, full enriched row', async ({ baseURL, password }) => {
    const api = await newAuthedApi(baseURL!, password);
    try {
      const target = injectGoal(uniqueLabel('post-xs-target'));
      const blkXs = injectExternalSystem(uniqueLabel('post-xs-blocker'));

      const r = await api.post('api/blockers', {
        headers: { 'Content-Type': 'application/json' },
        data: {
          goal_id: target,
          blocker_type: 'external_system',
          blocker_external_system_id: blkXs,
        },
      });
      expect(r.status()).toBe(201);
      const body = await r.json();
      expect(body.blocker_type).toBe('external_system');
      expect(body.blocker_id).toBe(blkXs);
      expect(body.blocked_id).toBe(target);
      expect(body.blocker_name).toBeTruthy();
    } finally {
      await api.dispose();
    }
  });
});

// ──────────────────────────────────────────────────────────────────
// API: POST /api/blockers — semantic failures
// ──────────────────────────────────────────────────────────────────

test.describe('contract: POST /api/blockers failure matrix', () => {
  test('API 2: self-block → 422 with {error: "a goal cannot block itself"}', async ({
    baseURL,
    password,
  }) => {
    const api = await newAuthedApi(baseURL!, password);
    try {
      const target = injectGoal(uniqueLabel('selfblock'));
      const r = await api.post('api/blockers', {
        headers: { 'Content-Type': 'application/json' },
        data: {
          goal_id: target,
          blocker_type: 'goal',
          blocker_goal_id: target,
        },
      });
      expect(r.status()).toBe(422);
      const body = await r.json();
      expect(body).toEqual({ error: 'a goal cannot block itself' });
    } finally {
      await api.dispose();
    }
  });

  test('API 3: duplicate edge → 201 then 409 with {error, id}', async ({ baseURL, password }) => {
    const api = await newAuthedApi(baseURL!, password);
    try {
      const target = injectGoal(uniqueLabel('dup-target'));
      const blk = injectGoal(uniqueLabel('dup-blocker'));

      const r1 = await api.post('api/blockers', {
        headers: { 'Content-Type': 'application/json' },
        data: { goal_id: target, blocker_type: 'goal', blocker_goal_id: blk },
      });
      expect(r1.status()).toBe(201);
      const firstId = (await r1.json()).id;

      const r2 = await api.post('api/blockers', {
        headers: { 'Content-Type': 'application/json' },
        data: { goal_id: target, blocker_type: 'goal', blocker_goal_id: blk },
      });
      expect(r2.status()).toBe(409);
      const body2 = await r2.json();
      expect(body2.error).toBe('blocker already exists');
      expect(body2.id).toBe(firstId);
    } finally {
      await api.dispose();
    }
  });

  test('API 4: bad goal_id → 404 "goal not found"', async ({ baseURL, password }) => {
    const api = await newAuthedApi(baseURL!, password);
    try {
      const blk = injectGoal(uniqueLabel('bad-goal-blocker'));
      const r = await api.post('api/blockers', {
        headers: { 'Content-Type': 'application/json' },
        data: { goal_id: 999_999_999, blocker_type: 'goal', blocker_goal_id: blk },
      });
      expect(r.status()).toBe(404);
      expect((await r.json()).error).toBe('goal not found');
    } finally {
      await api.dispose();
    }
  });

  test('API 5: bad blocker_<type>_id → 404 "<type> not found" for each type', async ({
    baseURL,
    password,
  }) => {
    const api = await newAuthedApi(baseURL!, password);
    try {
      const target = injectGoal(uniqueLabel('bad-blocker-target'));

      // goal
      const rGoal = await api.post('api/blockers', {
        headers: { 'Content-Type': 'application/json' },
        data: { goal_id: target, blocker_type: 'goal', blocker_goal_id: 999_999_999 },
      });
      expect(rGoal.status()).toBe(404);
      expect((await rGoal.json()).error).toBe('goal not found');

      // task
      const rTask = await api.post('api/blockers', {
        headers: { 'Content-Type': 'application/json' },
        data: { goal_id: target, blocker_type: 'task', blocker_task_id: 999_999_999 },
      });
      expect(rTask.status()).toBe(404);
      expect((await rTask.json()).error).toBe('task not found');

      // external_system
      const rXs = await api.post('api/blockers', {
        headers: { 'Content-Type': 'application/json' },
        data: {
          goal_id: target,
          blocker_type: 'external_system',
          blocker_external_system_id: 999_999_999,
        },
      });
      expect(rXs.status()).toBe(404);
      expect((await rXs.json()).error).toBe('external_system not found');
    } finally {
      await api.dispose();
    }
  });

  test('API 6: missing fields → 400 with field-named error', async ({ baseURL, password }) => {
    const api = await newAuthedApi(baseURL!, password);
    try {
      // missing goal_id
      const r1 = await api.post('api/blockers', {
        headers: { 'Content-Type': 'application/json' },
        data: { blocker_type: 'goal', blocker_goal_id: 1 },
      });
      expect(r1.status()).toBe(400);
      expect((await r1.json()).error).toBe('goal_id is required');

      // missing blocker_type
      const target = injectGoal(uniqueLabel('miss-type'));
      const r2 = await api.post('api/blockers', {
        headers: { 'Content-Type': 'application/json' },
        data: { goal_id: target },
      });
      expect(r2.status()).toBe(400);
      expect((await r2.json()).error).toBe('blocker_type is required');

      // missing matching blocker_<type>_id
      const r3 = await api.post('api/blockers', {
        headers: { 'Content-Type': 'application/json' },
        data: { goal_id: target, blocker_type: 'task' },
      });
      expect(r3.status()).toBe(400);
      expect((await r3.json()).error).toBe(
        "blocker_task_id is required for blocker_type='task'",
      );
    } finally {
      await api.dispose();
    }
  });
});

// ──────────────────────────────────────────────────────────────────
// UI: goal-detail growability — + Task + + Blocker + modal-stays-open
// ──────────────────────────────────────────────────────────────────

test.describe('UI: goal-detail growability', () => {
  test('UI 8: goal detail shows + Task chip and + Blocker chip in section headers', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    const goalId = injectGoal(uniqueLabel('chips'));
    // One existing task so the tasks section renders normally (chip not pre-expanded).
    injectTask(uniqueLabel('chip-existing-task'), goalId, 'active');

    const page = loggedInPage;
    await page.goto(mountPrefix);
    await page.evaluate((id) => (window as any).openGoalDetail?.(id), goalId);
    await expect(page.locator('#goalDetailOverlay.visible')).toBeVisible({ timeout: 5_000 });

    await expect(page.locator('#growTaskChip')).toBeVisible();
    await expect(page.locator('#growTaskChip')).toHaveText(/\+\s*Task/);
    await expect(page.locator('#growBlockerChip')).toBeVisible();
    await expect(page.locator('#growBlockerChip')).toHaveText(/\+\s*Blocker/);

    // Modal stays open.
    await expect(page.locator('#goalDetailOverlay.visible')).toBeVisible();
  });

  test('UI 9: + Task chip → form expands, submit prepends row + focus-flash, modal stays open', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    const goalId = injectGoal(uniqueLabel('addtask'));
    injectTask(uniqueLabel('addtask-existing'), goalId, 'active');

    const page = loggedInPage;
    await page.goto(mountPrefix);
    await page.evaluate((id) => (window as any).openGoalDetail?.(id), goalId);
    await expect(page.locator('#goalDetailOverlay.visible')).toBeVisible({ timeout: 5_000 });

    // Form starts hidden because the section already has a task.
    const form = page.locator('#growTaskForm');
    await expect(form).toHaveClass(/hidden/);

    await page.locator('#growTaskChip').click();
    await expect(form).not.toHaveClass(/hidden/);
    // Title input focused after expand.
    await expect(page.locator('#growTaskTitle')).toBeFocused();

    const newTitle = uniqueLabel('addtask-new');
    await page.locator('#growTaskTitle').fill(newTitle);
    // Submit via button (Enter on a non-form input has its own quirks).
    await page.locator('#growTaskSubmit').click();

    // New row appears at the top of the active tasks list.
    const firstRow = page.locator('#goalDetailTasks .task-row').first();
    await expect(firstRow).toContainText(newTitle, { timeout: 5_000 });
    await expect(firstRow).toHaveClass(/highlight-flash/);

    // Form cleared and visible (soft-reset for stream-add).
    await expect(page.locator('#growTaskTitle')).toHaveValue('');
    await expect(form).not.toHaveClass(/hidden/);

    // Modal-stays-open invariant.
    await expect(page.locator('#goalDetailOverlay.visible')).toBeVisible();
  });

  test('UI 10: zero-task goal pre-expands the inline task form (empty-state-as-action)', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    const goalId = injectGoal(uniqueLabel('emptyform'));

    const page = loggedInPage;
    await page.goto(mountPrefix);
    await page.evaluate((id) => (window as any).openGoalDetail?.(id), goalId);
    await expect(page.locator('#goalDetailOverlay.visible')).toBeVisible({ timeout: 5_000 });

    // Form is visible without tapping the chip.
    await expect(page.locator('#growTaskForm')).not.toHaveClass(/hidden/);
    // Title input gets autofocus on empty state.
    await expect(page.locator('#growTaskTitle')).toBeFocused({ timeout: 2_000 });
  });

  test('UI 11: + Blocker chip → picker opens; type-ahead returns results across all 3 types with badges', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    const goalId = injectGoal(uniqueLabel('picker-target'));
    const queryToken = `picker${Date.now()}${Math.floor(Math.random() * 100000)}`;
    // Three findable items, one per type, each containing the unique token.
    const goalName = `${CANARY_PREFIX}${queryToken}-goal`;
    const taskName = `${CANARY_PREFIX}${queryToken}-task`;
    const xsName = `${CANARY_PREFIX}${queryToken}-xs`;
    injectGoal(goalName);
    injectTask(taskName);
    injectExternalSystem(xsName);

    const page = loggedInPage;
    await page.goto(mountPrefix);
    await page.evaluate((id) => (window as any).openGoalDetail?.(id), goalId);
    await expect(page.locator('#goalDetailOverlay.visible')).toBeVisible({ timeout: 5_000 });

    await page.locator('#growBlockerChip').click();
    const overlay = page.locator('.grow-picker-overlay');
    await expect(overlay).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('#growPickerSearch')).toBeFocused({ timeout: 2_000 });

    await page.locator('#growPickerSearch').fill(queryToken);

    // Wait for the three canary results to render.
    const results = overlay.locator('.grow-picker-result');
    await expect(results).toHaveCount(3, { timeout: 5_000 });

    // Each type appears with the right type badge.
    const types = await results.evaluateAll((els) =>
      els.map((el) => (el as HTMLElement).getAttribute('data-type')),
    );
    expect(new Set(types)).toEqual(new Set(['goal', 'task', 'external_system']));

    // Type badges visible.
    await expect(overlay.locator('.grow-picker-result-badge.type-goal')).toBeVisible();
    await expect(overlay.locator('.grow-picker-result-badge.type-task')).toBeVisible();
    await expect(overlay.locator('.grow-picker-result-badge.type-external_system')).toBeVisible();

    // Modal-stays-open.
    await expect(page.locator('#goalDetailOverlay.visible')).toBeVisible();
  });

  test('UI 12: current goal is greyed out / disabled in picker results', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    const targetTitle = uniqueLabel('self-disabled');
    const goalId = injectGoal(targetTitle);

    const page = loggedInPage;
    await page.goto(mountPrefix);
    await page.evaluate((id) => (window as any).openGoalDetail?.(id), goalId);
    await expect(page.locator('#goalDetailOverlay.visible')).toBeVisible({ timeout: 5_000 });

    await page.locator('#growBlockerChip').click();
    await expect(page.locator('.grow-picker-overlay')).toBeVisible({ timeout: 5_000 });

    // Type exact target title to find self in results.
    await page.locator('#growPickerSearch').fill(targetTitle);
    const selfRow = page.locator(
      `.grow-picker-overlay .grow-picker-result[data-type="goal"][data-id="${goalId}"]`,
    );
    await expect(selfRow).toBeVisible({ timeout: 5_000 });
    // Disabled.
    await expect(selfRow).toHaveAttribute('disabled', '');
    await expect(selfRow).toHaveAttribute('aria-disabled', 'true');
  });

  test('UI 13: pick a task → notes textarea reveals → Save → blocker appears, picker closes, modal stays open', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    const goalId = injectGoal(uniqueLabel('pick-task-target'));
    const taskTitle = uniqueLabel('pick-task-blocker');
    const taskId = injectTask(taskTitle);

    const page = loggedInPage;
    await page.goto(mountPrefix);
    await page.evaluate((id) => (window as any).openGoalDetail?.(id), goalId);
    await expect(page.locator('#goalDetailOverlay.visible')).toBeVisible({ timeout: 5_000 });

    await page.locator('#growBlockerChip').click();
    const overlay = page.locator('.grow-picker-overlay');
    await expect(overlay).toBeVisible({ timeout: 5_000 });

    await page.locator('#growPickerSearch').fill(taskTitle);
    const row = overlay.locator(
      `.grow-picker-result[data-type="task"][data-id="${taskId}"]`,
    );
    await expect(row).toBeVisible({ timeout: 5_000 });

    // Notes section hidden before pick.
    await expect(page.locator('#growPickerNotes')).toHaveClass(/hidden/);
    await expect(page.locator('#growPickerSave')).toBeDisabled();

    await row.click();

    // Notes textarea reveals after pick.
    await expect(page.locator('#growPickerNotes')).not.toHaveClass(/hidden/);
    await expect(page.locator('#growPickerSave')).toBeEnabled();

    const noteText = `${CANARY_PREFIX}note-pick-task`;
    await page.locator('#growPickerNotesInput').fill(noteText);

    // Capture POST.
    const postWaiter = page.waitForRequest(
      (req) => req.method() === 'POST' && /\/api\/blockers(\?|$)/.test(req.url()),
      { timeout: 10_000 },
    );

    await page.locator('#growPickerSave').click();
    await postWaiter;

    // Picker closes (allow for the 200ms removal animation).
    await expect(page.locator('.grow-picker-overlay')).toHaveCount(0, { timeout: 10_000 });

    // New blocker row appears in the goal-detail blockers list.
    const newRow = page.locator('#goalDetailBody .goal-detail-blockers .blocker-item').first();
    await expect(newRow).toBeVisible({ timeout: 5_000 });
    await expect(newRow.locator('.blocker-name')).toContainText(taskTitle);

    // Modal-stays-open invariant.
    await expect(page.locator('#goalDetailOverlay.visible')).toBeVisible();
  });

  test('UI 14: same triple twice → 409 → picker closes → toast + flash existing row', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    const goalId = injectGoal(uniqueLabel('dup-target'));
    const blkTitle = uniqueLabel('dup-blocker');
    const blkGoalId = injectGoal(blkTitle);

    const page = loggedInPage;
    await page.goto(mountPrefix);
    await page.evaluate((id) => (window as any).openGoalDetail?.(id), goalId);
    await expect(page.locator('#goalDetailOverlay.visible')).toBeVisible({ timeout: 5_000 });

    // First add — succeeds.
    await page.locator('#growBlockerChip').click();
    await expect(page.locator('.grow-picker-overlay')).toBeVisible({ timeout: 5_000 });
    await page.locator('#growPickerSearch').fill(blkTitle);
    const firstHit = page.locator(
      `.grow-picker-overlay .grow-picker-result[data-type="goal"][data-id="${blkGoalId}"]`,
    );
    await expect(firstHit).toBeVisible({ timeout: 5_000 });
    await firstHit.click();
    await page.locator('#growPickerSave').click();
    await expect(page.locator('.grow-picker-overlay')).toHaveCount(0, { timeout: 10_000 });

    // The first blocker row is now present.
    const firstRow = page.locator('#goalDetailBody .goal-detail-blockers .blocker-item').first();
    await expect(firstRow).toBeVisible({ timeout: 5_000 });
    const firstId = await firstRow.getAttribute('data-blocker-id');
    expect(firstId).toBeTruthy();

    // Second add — same triple → 409.
    await page.locator('#growBlockerChip').click();
    await expect(page.locator('.grow-picker-overlay')).toBeVisible({ timeout: 5_000 });
    await page.locator('#growPickerSearch').fill(blkTitle);
    const secondHit = page.locator(
      `.grow-picker-overlay .grow-picker-result[data-type="goal"][data-id="${blkGoalId}"]`,
    );
    await expect(secondHit).toBeVisible({ timeout: 5_000 });
    await secondHit.click();

    const respWaiter = page.waitForResponse(
      (resp) =>
        resp.request().method() === 'POST' &&
        /\/api\/blockers(\?|$)/.test(resp.url()),
      { timeout: 10_000 },
    );
    await page.locator('#growPickerSave').click();
    const resp = await respWaiter;
    expect(resp.status()).toBe(409);

    // Picker closes.
    await expect(page.locator('.grow-picker-overlay')).toHaveCount(0, { timeout: 10_000 });

    // Toast surfaces.
    await expect(page.locator('.lp-toast.visible')).toBeVisible({ timeout: 3_000 });

    // Existing row flashes.
    const existing = page.locator(
      `#goalDetailBody .blocker-item[data-blocker-id="${firstId}"]`,
    );
    await expect(existing).toHaveClass(/highlight-flash/, { timeout: 3_000 });

    // Modal-stays-open invariant.
    await expect(page.locator('#goalDetailOverlay.visible')).toBeVisible();
  });

  test('UI 15: external_system search with no match → "Coming soon" signpost shown', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    const goalId = injectGoal(uniqueLabel('nomatch-target'));

    const page = loggedInPage;
    await page.goto(mountPrefix);
    await page.evaluate((id) => (window as any).openGoalDetail?.(id), goalId);
    await expect(page.locator('#goalDetailOverlay.visible')).toBeVisible({ timeout: 5_000 });

    await page.locator('#growBlockerChip').click();
    const overlay = page.locator('.grow-picker-overlay');
    await expect(overlay).toBeVisible({ timeout: 5_000 });

    // A query string highly unlikely to match anything in DB.
    await page
      .locator('#growPickerSearch')
      .fill(`zzz-no-such-thing-${Date.now()}-${Math.random().toString(36).slice(2)}`);

    const empty = overlay.locator('.grow-picker-empty');
    await expect(empty).toBeVisible({ timeout: 5_000 });
    const signpost = overlay.locator('.grow-picker-signpost');
    await expect(signpost).toBeVisible();
    await expect(signpost).toContainText(/Add as new external system/);
    await expect(signpost).toContainText(/Coming soon/i);
    // Greyed/disabled signpost — aria-disabled set.
    await expect(signpost).toHaveAttribute('aria-disabled', 'true');

    // Modal-stays-open invariant.
    await expect(page.locator('#goalDetailOverlay.visible')).toBeVisible();
  });

  test('UI 16: modal-stays-open invariant — every Add action keeps #goalDetailOverlay visible', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    // Composite check: open modal, add a task, add a blocker, assert
    // #goalDetailOverlay.visible after each step.
    const goalId = injectGoal(uniqueLabel('invariant-target'));
    const blkGoalId = injectGoal(uniqueLabel('invariant-blocker'));

    const page = loggedInPage;
    await page.goto(mountPrefix);
    await page.evaluate((id) => (window as any).openGoalDetail?.(id), goalId);
    await expect(page.locator('#goalDetailOverlay.visible')).toBeVisible({ timeout: 5_000 });

    // Step 1: add a task. Empty-state form is pre-expanded.
    await page.locator('#growTaskTitle').fill(uniqueLabel('invariant-task'));
    await page.locator('#growTaskSubmit').click();
    await expect(page.locator('#goalDetailTasks .task-row').first()).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.locator('#goalDetailOverlay.visible')).toBeVisible();

    // Step 2: add a blocker via picker.
    await page.locator('#growBlockerChip').click();
    await expect(page.locator('.grow-picker-overlay')).toBeVisible({ timeout: 5_000 });
    // Modal still visible underneath.
    await expect(page.locator('#goalDetailOverlay.visible')).toBeVisible();

    await page.locator('#growPickerSearch').fill('invariant-blocker');
    const hit = page.locator(
      `.grow-picker-overlay .grow-picker-result[data-type="goal"][data-id="${blkGoalId}"]`,
    );
    await expect(hit).toBeVisible({ timeout: 5_000 });
    await hit.click();
    await page.locator('#growPickerSave').click();

    await expect(page.locator('.grow-picker-overlay')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator('#goalDetailBody .goal-detail-blockers .blocker-item').first()).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.locator('#goalDetailOverlay.visible')).toBeVisible();

    // Step 3: cancel from picker step 1 → modal still open.
    await page.locator('#growBlockerChip').click();
    await expect(page.locator('.grow-picker-overlay')).toBeVisible({ timeout: 5_000 });
    await page.locator('.grow-picker-overlay .grow-picker-cancel').click();
    await expect(page.locator('.grow-picker-overlay')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator('#goalDetailOverlay.visible')).toBeVisible();
  });
});
