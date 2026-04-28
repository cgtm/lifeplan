import { test, expect } from './fixtures/auth';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import { request as pwRequest, type APIRequestContext } from '@playwright/test';

/**
 * Regression sweep for the brain-dump detail modal (Iris's design,
 * `docs/ux-design/2026-04-27-brain-dump-detail.md`). Subsumes the old
 * `#reviewOverlay` review modal entirely.
 *
 * Two surfaces under test:
 *   1. API surface — `POST /api/brain-dumps/<id>/approve-item` extended
 *      with new `action='retry'` and `action='unreject'` actions, plus
 *      tightened `approve`/`edit_approve` to require `status='suggested'`.
 *      Per `app/contracts/auto-create-item.md` (extended 2026-04-27).
 *   2. UI surface — `#dumpDetailOverlay` drawer driven by clicking dump
 *      rows in the dumps view and home recents strip.
 *
 * Approach: the same direct-injection pattern shipped in
 * `auto-create-item-truthfulness.spec.ts` and `apply-to-fanout.spec.ts`.
 * No LLM dependency — crafted `processed_items` JSON exercises every
 * lifecycle state deterministically.
 *
 * Privacy: every injected row uses canary strings (`probe-dumpmodal-…`).
 * Cleanup nukes everything keyed off that prefix in afterAll.
 */

const DB_PATH =
  process.env.LIFEPLAN_DB_PATH ||
  '/Users/cam/dev/personal/lifeplan/data/lifeplan.db';
const APP_DIR = '/Users/cam/dev/personal/lifeplan';
const CANARY_PREFIX = 'probe-dumpmodal-';

function runPython(source: string): string {
  const b64 = Buffer.from(source, 'utf8').toString('base64');
  return execSync(
    `python3 -c "import base64,sys;exec(compile(base64.b64decode('${b64}'),'<probe-dumpmodal>','exec'))"`,
    { encoding: 'utf8' },
  );
}

function sqliteAvailable(): boolean {
  try {
    execSync('sqlite3 -version', { stdio: 'ignore' });
    return fs.existsSync(DB_PATH);
  } catch {
    return false;
  }
}

function sqliteExec(sql: string): string {
  return execSync(
    `sqlite3 -bail ${JSON.stringify(DB_PATH)} ${JSON.stringify(sql)}`,
    { encoding: 'utf8' },
  );
}

/**
 * Insert a brain_dumps row with crafted processed_items JSON.
 * `processing_status` defaults to 'needs_review' so handle_approve_item
 * sees a triage-ready dump. Override via opts.
 */
function injectDump(
  label: string,
  items: unknown[],
  opts: {
    processing_status?: string;
    processed?: number;
  } = {},
): number {
  const status = opts.processing_status || 'needs_review';
  const processed = opts.processed ?? 0;
  const content = `${CANARY_PREFIX}${label}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const blob = {
    version: 1,
    processed_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    extraction_method: 'probe-dumpmodal-injected',
    items,
  };
  const py = `
import sqlite3, json
conn = sqlite3.connect(${JSON.stringify(DB_PATH)}, timeout=10.0)
try:
    cur = conn.execute(
        "INSERT INTO brain_dumps (content, processing_status, processed_items, processed) "
        "VALUES (?, ?, ?, ?)",
        (
            ${JSON.stringify(content)},
            ${JSON.stringify(status)},
            ${JSON.stringify(JSON.stringify(blob))},
            ${processed},
        ),
    )
    conn.commit()
    print(cur.lastrowid)
finally:
    conn.close()
`;
  return parseInt(runPython(py).trim(), 10);
}

/**
 * Read a single column from brain_dumps via direct DB. Used to confirm
 * server-side state after the API and UI flows mutate.
 */
function readDumpField(dumpId: number, column: string): string {
  return sqliteExec(
    `SELECT ${column} FROM brain_dumps WHERE id=${dumpId};`,
  ).trim();
}

/**
 * Poke a value in the brain_dumps row (used to flip processing_status
 * mid-test for the polling-based re-render check, since we can't actually
 * boot the worker on a synthetic dump).
 */
function updateDumpField(dumpId: number, column: string, value: string): void {
  const py = `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(DB_PATH)}, timeout=10.0)
try:
    conn.execute(
        ${JSON.stringify(`UPDATE brain_dumps SET ${column} = ? WHERE id = ?`)},
        (${JSON.stringify(value)}, ${dumpId}),
    )
    conn.commit()
finally:
    conn.close()
`;
  runPython(py);
}

async function newAuthedApi(
  baseURL: string,
  password: string,
): Promise<APIRequestContext> {
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

function cleanupAll(): void {
  if (!sqliteAvailable()) return;
  const py = `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(DB_PATH)}, timeout=10.0)
try:
    ids = [r[0] for r in conn.execute(
        "SELECT id FROM brain_dumps WHERE content LIKE ?",
        (${JSON.stringify(CANARY_PREFIX + '%')},),
    ).fetchall()]
    for did in ids:
        conn.execute("DELETE FROM work_queue WHERE job_type='brain_dump' AND target_id=?", (did,))
        conn.execute("DELETE FROM brain_dumps WHERE id=?", (did,))
    # Test rows from approve actions (tag fall-through, person_mention)
    # are canary-named.
    conn.execute("DELETE FROM tags WHERE name LIKE ?",   (${JSON.stringify(CANARY_PREFIX + '%')},))
    conn.execute("DELETE FROM people WHERE name LIKE ?", (${JSON.stringify(CANARY_PREFIX + '%')},))
    conn.execute("DELETE FROM tasks WHERE title LIKE ?", (${JSON.stringify(CANARY_PREFIX + '%')},))
    conn.execute("DELETE FROM goals WHERE title LIKE ?", (${JSON.stringify(CANARY_PREFIX + '%')},))
    conn.execute("DELETE FROM knowledge_items WHERE title LIKE ?", (${JSON.stringify(CANARY_PREFIX + '%')},))
    conn.commit()
finally:
    conn.close()
`;
  try {
    runPython(py);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[probe-dumpmodal] cleanup failed:', e);
  }
}

test.describe('brain-dump detail modal — API + UI regression', () => {
  test.skip(
    !sqliteAvailable(),
    'sqlite3 CLI / local DB not available — direct-injection spec skipped',
  );

  test.afterAll(() => {
    cleanupAll();
  });

  // ════════════════════════════════════════════════════════════════════
  // API surface — handle_approve_item action matrix
  // (cases 1-7 from Probe's brief)
  // ════════════════════════════════════════════════════════════════════

  // 1. retry on a failed item -> 200 + status flips to approved (success path).
  test('API 1: action=retry on a failed item -> 200, item flips to approved', async ({
    baseURL,
    password,
  }) => {
    const taskTitle = `${CANARY_PREFIX}retry-success-task`;
    const dumpId = injectDump('retry-success', [
      {
        type: 'task',
        confidence: 0.95,
        status: 'failed', // already failed; retry should re-run the create
        created_id: null,
        data: { title: taskTitle, description: `${CANARY_PREFIX}desc` },
      },
    ]);

    const api = await newAuthedApi(baseURL!, password);
    try {
      const r = await api.post(`api/brain-dumps/${dumpId}/approve-item`, {
        headers: { 'Content-Type': 'application/json' },
        data: { item_index: 0, action: 'retry' },
      });
      expect(r.status()).toBe(200);
      const body = await r.json();
      const item = body.processed_items.items[0];
      // Per contract: success on retry == approved (user-initiated create).
      expect(item.status).toBe('approved');
      expect(item.created_id).not.toBeNull();
      // The task row really exists.
      const found = sqliteExec(
        `SELECT title FROM tasks WHERE id=${item.created_id};`,
      ).trim();
      expect(found).toBe(taskTitle);
    } finally {
      await api.dispose();
    }
  });

  // 2. retry on suggested/approved/rejected -> 409 with documented body.
  test('API 2: action=retry on non-failed item -> 409 "only failed items can be retried"', async ({
    baseURL,
    password,
  }) => {
    const dumpId = injectDump('retry-precondition', [
      {
        type: 'task',
        confidence: 0.6,
        status: 'suggested',
        created_id: null,
        data: { title: `${CANARY_PREFIX}sugg` },
      },
      {
        type: 'task',
        confidence: 0.95,
        status: 'approved',
        created_id: 1, // any int; we don't read it
        data: { title: `${CANARY_PREFIX}appr` },
      },
      {
        type: 'task',
        confidence: 0.6,
        status: 'rejected',
        created_id: null,
        data: { title: `${CANARY_PREFIX}rej` },
      },
    ]);

    const api = await newAuthedApi(baseURL!, password);
    try {
      for (const idx of [0, 1, 2]) {
        const r = await api.post(`api/brain-dumps/${dumpId}/approve-item`, {
          headers: { 'Content-Type': 'application/json' },
          data: { item_index: idx, action: 'retry' },
        });
        expect(r.status()).toBe(409);
        const body = await r.json();
        expect(body).toEqual({ error: 'only failed items can be retried' });
      }
    } finally {
      await api.dispose();
    }
  });

  // 3. unreject on rejected -> 200, status flips to suggested.
  test('API 3: action=unreject on a rejected item -> 200, status=suggested', async ({
    baseURL,
    password,
  }) => {
    const dumpId = injectDump(
      'unreject-success',
      [
        {
          type: 'task',
          confidence: 0.6,
          status: 'rejected',
          created_id: null,
          data: { title: `${CANARY_PREFIX}toUnreject` },
          error: 'stale-error-text', // verify cleared
        },
      ],
      { processing_status: 'processed', processed: 1 },
    );

    const api = await newAuthedApi(baseURL!, password);
    try {
      const r = await api.post(`api/brain-dumps/${dumpId}/approve-item`, {
        headers: { 'Content-Type': 'application/json' },
        data: { item_index: 0, action: 'unreject' },
      });
      expect(r.status()).toBe(200);
      const body = await r.json();
      const item = body.processed_items.items[0];
      expect(item.status).toBe('suggested');
      // Prior error text cleared.
      expect(item.error).toBeNull();
    } finally {
      await api.dispose();
    }
  });

  // 4. unreject on non-rejected -> 409.
  test('API 4: action=unreject on non-rejected item -> 409', async ({
    baseURL,
    password,
  }) => {
    const dumpId = injectDump('unreject-precondition', [
      {
        type: 'task',
        confidence: 0.6,
        status: 'suggested',
        created_id: null,
        data: { title: `${CANARY_PREFIX}sugg` },
      },
    ]);

    const api = await newAuthedApi(baseURL!, password);
    try {
      const r = await api.post(`api/brain-dumps/${dumpId}/approve-item`, {
        headers: { 'Content-Type': 'application/json' },
        data: { item_index: 0, action: 'unreject' },
      });
      expect(r.status()).toBe(409);
      const body = await r.json();
      expect(body).toEqual({
        error: 'only rejected items can be un-rejected',
      });
    } finally {
      await api.dispose();
    }
  });

  // 5. approve on already-approved -> 409 (Vault's tightening; was a silent
  //    re-clobber pre-patch).
  test('API 5: action=approve on already-approved item -> 409 (no clobber)', async ({
    baseURL,
    password,
  }) => {
    const dumpId = injectDump('approve-precondition', [
      {
        type: 'task',
        confidence: 0.95,
        status: 'approved',
        created_id: 999,
        data: { title: `${CANARY_PREFIX}original` },
      },
    ]);

    const api = await newAuthedApi(baseURL!, password);
    try {
      const r = await api.post(`api/brain-dumps/${dumpId}/approve-item`, {
        headers: { 'Content-Type': 'application/json' },
        data: { item_index: 0, action: 'approve' },
      });
      expect(r.status()).toBe(409);
      const body = await r.json();
      expect(body).toEqual({
        error: 'only suggested items can be approved',
      });
      // created_id NOT clobbered (the load-bearing protection from the patch).
      const stored = sqliteExec(
        `SELECT json_extract(processed_items, '$.items[0].created_id') ` +
          `FROM brain_dumps WHERE id=${dumpId};`,
      ).trim();
      expect(stored).toBe('999');
    } finally {
      await api.dispose();
    }
  });

  // 6. unknown action -> 400 with documented body.
  test('API 6: unknown action -> 400 "unknown action: \'bogus\'"', async ({
    baseURL,
    password,
  }) => {
    const dumpId = injectDump('bogus-action', [
      {
        type: 'task',
        confidence: 0.6,
        status: 'suggested',
        created_id: null,
        data: { title: `${CANARY_PREFIX}t` },
      },
    ]);

    const api = await newAuthedApi(baseURL!, password);
    try {
      const r = await api.post(`api/brain-dumps/${dumpId}/approve-item`, {
        headers: { 'Content-Type': 'application/json' },
        data: { item_index: 0, action: 'bogus' },
      });
      expect(r.status()).toBe(400);
      const body = await r.json();
      // Python repr of the action string is single-quoted.
      expect(body).toEqual({ error: "unknown action: 'bogus'" });
    } finally {
      await api.dispose();
    }
  });

  // 7. unreject from a `processed` dump containing one rejected item ->
  //    dump rolls back to needs_review (and `processed` flag flips to 0).
  test('API 7: unreject in a processed dump -> rolls back to needs_review, processed=0', async ({
    baseURL,
    password,
  }) => {
    const dumpId = injectDump(
      'unreject-rollback',
      [
        {
          type: 'task',
          confidence: 0.95,
          status: 'auto_created',
          created_id: 1,
          data: { title: `${CANARY_PREFIX}already-created` },
        },
        {
          type: 'task',
          confidence: 0.6,
          status: 'rejected',
          created_id: null,
          data: { title: `${CANARY_PREFIX}was-rejected` },
        },
      ],
      { processing_status: 'processed', processed: 1 },
    );

    // Pre-condition sanity: dump really starts at processed/1.
    expect(readDumpField(dumpId, 'processing_status')).toBe('processed');
    expect(readDumpField(dumpId, 'processed')).toBe('1');

    const api = await newAuthedApi(baseURL!, password);
    try {
      const r = await api.post(`api/brain-dumps/${dumpId}/approve-item`, {
        headers: { 'Content-Type': 'application/json' },
        data: { item_index: 1, action: 'unreject' },
      });
      expect(r.status()).toBe(200);
      const body = await r.json();
      expect(body.processing_status).toBe('needs_review');
      expect(body.processed).toBe(0);
      // Direct-DB confirmation — the response and the row agree.
      expect(readDumpField(dumpId, 'processing_status')).toBe('needs_review');
      expect(readDumpField(dumpId, 'processed')).toBe('0');
    } finally {
      await api.dispose();
    }
  });

  // ════════════════════════════════════════════════════════════════════
  // UI surface — #dumpDetailOverlay
  // (cases 8-15 from Probe's brief)
  // ════════════════════════════════════════════════════════════════════

  // 8. Click a dump row in the dumps list -> drawer opens with content+items.
  test('UI 8: click dump row in dumps list -> drawer opens with content + items', async ({
    loggedInPage,
  }) => {
    const dumpId = injectDump(
      'open-from-dumps-list',
      [
        {
          type: 'task',
          confidence: 0.6,
          status: 'suggested',
          created_id: null,
          source_text: 'a snippet from the dump',
          data: { title: `${CANARY_PREFIX}item-title-A` },
        },
      ],
      { processing_status: 'needs_review' },
    );

    await loggedInPage.goto('');
    await loggedInPage.locator('[data-view="dump"]').first().click();
    await expect(loggedInPage.locator('#view-dump')).toBeVisible();
    const row = loggedInPage.locator(
      `#view-dump .dump-item-clickable[data-dump-id="${dumpId}"]`,
    );
    await row.waitFor({ state: 'visible', timeout: 10_000 });
    await row.click();

    const drawer = loggedInPage.locator('#dumpDetailOverlay');
    await expect(drawer).toBeVisible();
    // Content of the dump renders inside the drawer.
    await expect(drawer.locator('#dumpDetailContent')).toContainText(
      CANARY_PREFIX,
    );
    // Pending-review group renders the suggested item.
    await expect(drawer.locator('.dump-detail-section-title')).toContainText(
      'Pending review',
    );
    await expect(
      drawer.locator(`.dump-detail-item[data-item-index="0"]`),
    ).toContainText(`${CANARY_PREFIX}item-title-A`);
  });

  // 9. Click a dump row in the home recents strip -> same drawer opens.
  test('UI 9: click dump row in home recents strip -> drawer opens', async ({
    loggedInPage,
  }) => {
    const dumpId = injectDump(
      'open-from-home',
      [
        {
          type: 'task',
          confidence: 0.6,
          status: 'suggested',
          created_id: null,
          data: { title: `${CANARY_PREFIX}home-item` },
        },
      ],
      { processing_status: 'needs_review' },
    );

    await loggedInPage.goto('');
    // Home shows the most-recent dumps; ours was just inserted so it
    // should land in the strip. (`recent_dumps` in /api/home limits to a
    // sensible recent set; the freshly-inserted row tops the order.)
    const row = loggedInPage.locator(
      `#homeRecentDumps .dump-item-clickable[data-dump-id="${dumpId}"]`,
    );
    await row.waitFor({ state: 'visible', timeout: 10_000 });
    await row.click();

    const drawer = loggedInPage.locator('#dumpDetailOverlay');
    await expect(drawer).toBeVisible();
    await expect(drawer.locator('#dumpDetailContent')).toContainText(
      CANARY_PREFIX,
    );
  });

  // 10. Click an auto_created goal item -> goal modal opens *over* the
  //     drawer; closing the goal modal returns to the drawer.
  //
  // KNOWN DIVERGENCE FROM IRIS'S SPEC (flagged for Iris's device pass):
  //   - Iris specified "z-index +1" so the new detail modal opens *over*
  //     the drawer. Reality: both #goalDetailOverlay and #dumpDetailOverlay
  //     have z-index:100; DOM order in index.html puts dumpDetailOverlay
  //     after goalDetailOverlay, so the drawer sits ON TOP of the goal
  //     modal. Pointer events on `#goalDetailClose` are intercepted by
  //     the drawer; the user can't close the goal modal with X.
  //   - Escape closes BOTH overlays simultaneously (the keydown handler
  //     at app.js:4171 always closes #dumpDetailOverlay), so there is no
  //     "close goal modal, return to drawer" path for the user today.
  // Probed via UI 10a (open-stack works) + UI 10b.fixme (close-X is
  // currently blocked). Lumen owns the z-stack/Escape-priority fix.
  test('UI 10a: click auto_created goal item -> goal modal opens; drawer stays in DOM', async ({
    loggedInPage,
    baseURL,
    password,
  }) => {
    // Create a real goal via the API so its detail modal can resolve.
    const api = await newAuthedApi(baseURL!, password);
    let goalId: number;
    try {
      const r = await api.post('api/goals', {
        headers: { 'Content-Type': 'application/json' },
        data: { title: `${CANARY_PREFIX}stack-goal`, description: '' },
      });
      expect(r.status()).toBeLessThan(300);
      const goal = await r.json();
      goalId = goal.id;
    } finally {
      await api.dispose();
    }

    const dumpId = injectDump(
      'lateral-nav-goal',
      [
        {
          type: 'goal_link',
          confidence: 0.95,
          status: 'auto_created',
          created_id: goalId!,
          data: { goal_id: goalId!, goal_title: `${CANARY_PREFIX}stack-goal` },
        },
      ],
      { processing_status: 'processed', processed: 1 },
    );

    await loggedInPage.goto('');
    await loggedInPage.locator('[data-view="dump"]').first().click();
    await expect(loggedInPage.locator('#view-dump')).toBeVisible();
    const row = loggedInPage.locator(
      `#view-dump .dump-item-clickable[data-dump-id="${dumpId}"]`,
    );
    await row.waitFor({ state: 'visible', timeout: 10_000 });
    await row.click();
    const drawer = loggedInPage.locator('#dumpDetailOverlay');
    await expect(drawer).toBeVisible();

    // Click the auto_created goal_link row inside the drawer.
    const goalRow = drawer.locator(
      `.dump-detail-item[data-item-type="goal_link"][data-launch="1"]`,
    );
    await expect(goalRow).toBeVisible();
    await goalRow.click();

    const goalModal = loggedInPage.locator('#goalDetailOverlay');
    await expect(goalModal).toBeVisible();
    // Drawer stays in the DOM (we just don't currently get the visual
    // stacking Iris specified — see the test note above).
    await expect(drawer).toBeVisible();
  });

  // 10b. The lateral-navigation close-back-to-drawer path Iris specified.
  //      Currently broken at the z-stack level (drawer covers goalDetailClose).
  //      Marked .fixme so the failure mode is captured in the test plan and
  //      gets a green tick the moment Lumen fixes the z-index/Escape priority.
  test(
    'UI 10b: close goal modal returns user to dump drawer (z-stack + Escape priority)',
    async ({ loggedInPage, baseURL, password }) => {
      const api = await newAuthedApi(baseURL!, password);
      let goalId: number;
      try {
        const r = await api.post('api/goals', {
          headers: { 'Content-Type': 'application/json' },
          data: { title: `${CANARY_PREFIX}10b-goal`, description: '' },
        });
        expect(r.status()).toBeLessThan(300);
        goalId = (await r.json()).id;
      } finally {
        await api.dispose();
      }
      const dumpId = injectDump(
        '10b-lateral',
        [
          {
            type: 'goal_link',
            confidence: 0.95,
            status: 'auto_created',
            created_id: goalId!,
            data: { goal_id: goalId!, goal_title: `${CANARY_PREFIX}10b-goal` },
          },
        ],
        { processing_status: 'processed', processed: 1 },
      );
      await loggedInPage.goto('');
      await loggedInPage.locator('[data-view="dump"]').first().click();
      await loggedInPage
        .locator(`#view-dump .dump-item-clickable[data-dump-id="${dumpId}"]`)
        .click();
      const drawer = loggedInPage.locator('#dumpDetailOverlay');
      await expect(drawer).toBeVisible();
      await drawer
        .locator(`.dump-detail-item[data-item-type="goal_link"][data-launch="1"]`)
        .click();
      const goalModal = loggedInPage.locator('#goalDetailOverlay');
      await expect(goalModal).toBeVisible();
      // Once Lumen lifts goalDetailOverlay above the drawer, this click
      // should resolve normally. Today the drawer subtree intercepts.
      await loggedInPage.locator('#goalDetailClose').click();
      await expect(goalModal).toBeHidden();
      await expect(drawer).toBeVisible();
    },
  );

  // 11. Approve a suggested item from the drawer -> optimistic flip,
  //     server confirms approved, row moves out of pending.
  test('UI 11: approve suggested item from drawer -> status flips to approved', async ({
    loggedInPage,
  }) => {
    const dumpId = injectDump(
      'ui-approve',
      [
        {
          type: 'task',
          confidence: 0.6,
          status: 'suggested',
          created_id: null,
          data: { title: `${CANARY_PREFIX}ui-approve-task` },
        },
      ],
      { processing_status: 'needs_review' },
    );

    await loggedInPage.goto('');
    await loggedInPage.locator('[data-view="dump"]').first().click();
    await expect(loggedInPage.locator('#view-dump')).toBeVisible();
    const row = loggedInPage.locator(
      `#view-dump .dump-item-clickable[data-dump-id="${dumpId}"]`,
    );
    await row.waitFor({ state: 'visible', timeout: 10_000 });
    await row.click();
    const drawer = loggedInPage.locator('#dumpDetailOverlay');
    await expect(drawer).toBeVisible();

    // Approve button on the pending row.
    await drawer
      .locator(
        `.dump-detail-item[data-item-index="0"] button[data-action="approve"]`,
      )
      .click();

    // Wait for the row to leave the Pending-review group and join Created.
    // Easiest assertion: the resulting task row exists in DB and the
    // pending-review section is gone (single item dump).
    await expect
      .poll(
        () =>
          sqliteExec(
            `SELECT json_extract(processed_items, '$.items[0].status') ` +
              `FROM brain_dumps WHERE id=${dumpId};`,
          ).trim(),
        { timeout: 5000 },
      )
      .toBe('approved');
    // UI: a Created group section now exists.
    await expect(drawer.locator('.dump-detail-section-title')).toContainText(
      /Created/,
    );
  });

  // 12. Tap-to-edit content -> textarea + Cancel + Save & re-process.
  //     Save with changes -> PUT then POST /process; status flips to queued.
  //     (Iris's spec also called for a separate "Save (no re-process)" button
  //      and a no-op when content was unchanged. Reality ships only the
  //      "Save & re-process" + "Cancel" buttons. Flagged in the report.)
  test('UI 12: edit content + Save & re-process -> status flips to queued', async ({
    loggedInPage,
  }) => {
    const dumpId = injectDump(
      'ui-edit',
      [
        {
          type: 'task',
          confidence: 0.6,
          status: 'suggested',
          created_id: null,
          data: { title: `${CANARY_PREFIX}edit-precursor` },
        },
      ],
      { processing_status: 'needs_review' },
    );

    await loggedInPage.goto('');
    await loggedInPage.locator('[data-view="dump"]').first().click();
    await expect(loggedInPage.locator('#view-dump')).toBeVisible();
    const row = loggedInPage.locator(
      `#view-dump .dump-item-clickable[data-dump-id="${dumpId}"]`,
    );
    await row.waitFor({ state: 'visible', timeout: 10_000 });
    await row.click();
    const drawer = loggedInPage.locator('#dumpDetailOverlay');
    await expect(drawer).toBeVisible();

    await drawer.locator('#dumpDetailEditBtn').click();
    const textarea = drawer.locator('#dumpDetailEditTextarea');
    await expect(textarea).toBeVisible();
    // Cancel returns to read mode.
    await drawer.locator('#dumpDetailEditCancel').click();
    await expect(textarea).toHaveCount(0);

    // Edit, then Save & re-process.
    await drawer.locator('#dumpDetailEditBtn').click();
    const newContent = `${CANARY_PREFIX}edited-content-${Date.now()}`;
    await drawer.locator('#dumpDetailEditTextarea').fill(newContent);
    await drawer.locator('#dumpDetailEditSaveReprocess').click();

    // The dump's processing_status should land at 'queued' (POST /process
    // re-queues). The poll re-renders the drawer; we just confirm the row
    // in DB to avoid timing flake on the optimistic UI.
    await expect
      .poll(() => readDumpField(dumpId, 'processing_status'), { timeout: 5000 })
      .toBe('queued');
    // And the content was actually updated (PUT happened).
    expect(readDumpField(dumpId, 'content')).toBe(newContent);
  });

  // 13. Failed-state dump -> red Failed badge inside drawer + Retry button
  //     in the header. Click Retry -> POST /retry -> dump flips to queued.
  test('UI 13: failed dump shows red badge + Retry button -> retry flips to queued', async ({
    loggedInPage,
  }) => {
    const dumpId = injectDump(
      'ui-failed-retry',
      [],
      { processing_status: 'failed' },
    );

    await loggedInPage.goto('');
    await loggedInPage.locator('[data-view="dump"]').first().click();
    await expect(loggedInPage.locator('#view-dump')).toBeVisible();
    const row = loggedInPage.locator(
      `#view-dump .dump-item-clickable[data-dump-id="${dumpId}"]`,
    );
    await row.waitFor({ state: 'visible', timeout: 10_000 });
    await row.click();
    const drawer = loggedInPage.locator('#dumpDetailOverlay');
    await expect(drawer).toBeVisible();

    // Failed badge present in header meta.
    await expect(
      drawer.locator('.dump-badge[data-dump-status="failed"]'),
    ).toBeVisible();
    // Top-level Retry button present.
    const retryBtn = drawer.locator('#dumpDetailHeaderActions button', {
      hasText: 'Retry',
    });
    await expect(retryBtn).toBeVisible();
    await retryBtn.click();

    await expect
      .poll(() => readDumpField(dumpId, 'processing_status'), { timeout: 5000 })
      .toBe('queued');
  });

  // 14. processing_status poll updates the open drawer in-place (the 3s
  //     poll re-renders without re-opening). Simulate by flipping the row
  //     directly mid-test.
  //
  // KNOWN DIVERGENCE FROM IRIS'S SPEC (flagged for Iris's device pass):
  //   Iris specified "the existing 3s poll updates the modal in place;
  //   state transitions render through the modal without requiring a
  //   re-open." Reality: `_pollOnce` (app.js:1118) calls loadDumps() but
  //   does NOT call `_refreshDumpDetail()`. The dumps list re-renders
  //   on each poll tick; the open drawer is never touched. The user has
  //   to close and reopen the drawer to see worker progress.
  //   Fix is one line in `_pollOnce` (call `_refreshDumpDetail()` after
  //   loadDumps/renderHome). Lumen owns the patch.
  test(
    'UI 14: drawer re-renders in place when processing_status changes via poll',
    async ({ loggedInPage }) => {
    const dumpId = injectDump(
      'ui-poll-reflow',
      [],
      { processing_status: 'queued' },
    );

    await loggedInPage.goto('');
    await loggedInPage.locator('[data-view="dump"]').first().click();
    await expect(loggedInPage.locator('#view-dump')).toBeVisible();
    const row = loggedInPage.locator(
      `#view-dump .dump-item-clickable[data-dump-id="${dumpId}"]`,
    );
    await row.waitFor({ state: 'visible', timeout: 10_000 });
    await row.click();
    const drawer = loggedInPage.locator('#dumpDetailOverlay');
    await expect(drawer).toBeVisible();
    // Initial state: queued -> Pending badge inside drawer header.
    await expect(
      drawer.locator(
        '.dump-badge[data-dump-status="queued"], .dump-badge[data-dump-status="unprocessed"]',
      ),
    ).toBeVisible();

    // Mutate the DB out-of-band — simulate the worker finishing a pass.
    // Inject a real auto_created item so the rendered drawer transitions
    // from the inflight placeholder to the Created group.
    const newProcessed = JSON.stringify({
      version: 1,
      processed_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
      extraction_method: 'probe-dumpmodal-poll',
      items: [
        {
          type: 'task',
          confidence: 0.95,
          status: 'auto_created',
          created_id: 1,
          data: { title: `${CANARY_PREFIX}poll-arrived` },
        },
      ],
    });
    updateDumpField(dumpId, 'processing_status', 'processed');
    updateDumpField(dumpId, 'processed_items', newProcessed);

    // Drawer should re-render via the 3s brain-dump poll. Assert the new
    // state appears within ~10s (≈3 poll cycles + slack for WebKit). The
    // drawer must NOT have closed — same #dumpDetailOverlay element stays
    // visible and now shows the Created group.
    await expect(drawer).toBeVisible();
    await expect(
      drawer.locator('.dump-detail-section-title', { hasText: /Created/ }),
    ).toBeVisible({ timeout: 10_000 });
    },
  );

  // 15. The old review modal is fully gone from app/.
  //     `grep -r "reviewOverlay" app/` -> zero hits.
  test('UI 15: reviewOverlay is fully gone from app/', async () => {
    let hits = '';
    try {
      hits = execSync(
        'grep -r "reviewOverlay" /Users/cam/dev/personal/lifeplan/app/',
        { encoding: 'utf8' },
      );
    } catch (e: any) {
      // grep exits non-zero with empty stdout when there are no matches.
      if (e.status === 1) {
        hits = '';
      } else {
        throw e;
      }
    }
    expect(hits).toBe('');
  });
});
