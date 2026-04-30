import { test, expect } from './fixtures/auth';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import { request as pwRequest, type APIRequestContext } from '@playwright/test';

/**
 * Probe regression — Unlink Auto-Created Items (Iris 2026-04-30, Reed
 * 2026-04-23, Vault + Lumen ship 2026-04-30).
 *
 * Surfaces under test:
 *   1. POST /api/brain-dumps/<id>/unlink-preview   (read-only verdict)
 *   2. POST /api/brain-dumps/<id>/approve-item     (action='unlink')
 *   3. UI surface — `#dumpDetailOverlay` × affordance + confirm dialog
 *
 * Contract sources:
 *   - app/contracts/auto-create-item.md            (action='unlink', preview API)
 *   - docs/architecture/unlink-safety-heuristic.md (per-entity rules)
 *   - docs/ux-design/2026-04-30-unlink-auto-created.md (dialog templates)
 *
 * Approach: direct sqlite3 injection of brain_dumps + entity rows. Same
 * pattern shipped in auto-create-item-truthfulness.spec.ts and
 * dump-detail-modal.spec.ts. No LLM dependency — deterministic heuristic
 * inputs only.
 *
 * Privacy: every test row is canary-prefixed (`probe-unlink-`). afterAll
 * sweeps everything keyed off that prefix.
 */

const DB_PATH =
  process.env.LIFEPLAN_DB_PATH ||
  '/Users/cam/dev/personal/lifeplan/data/lifeplan.db';
const CANARY_PREFIX = 'probe-unlink-';

function runPython(source: string): string {
  const b64 = Buffer.from(source, 'utf8').toString('base64');
  return execSync(
    `python3 -c "import base64,sys;exec(compile(base64.b64decode('${b64}'),'<probe-unlink>','exec'))"`,
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
 * Insert a brain_dumps row with crafted processed_items JSON. Returns id.
 */
function injectDump(
  label: string,
  items: unknown[],
  opts: { processing_status?: string; processed?: number } = {},
): number {
  const status = opts.processing_status || 'processed';
  const processed = opts.processed ?? 1;
  const content = `${CANARY_PREFIX}${label}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const blob = {
    version: 1,
    processed_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    extraction_method: 'probe-unlink-injected',
    items,
  };
  const py = `
import sqlite3
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
 * Insert a tasks row stamped to look auto-created (created_at == updated_at,
 * status='active'). Returns the new id.
 */
function injectTask(title: string): number {
  const py = `
import sqlite3
from datetime import datetime, timezone
ts = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')
conn = sqlite3.connect(${JSON.stringify(DB_PATH)}, timeout=10.0)
try:
    cur = conn.execute(
        "INSERT INTO tasks (title, description, status, created_at, updated_at) "
        "VALUES (?, ?, 'active', ?, ?)",
        (${JSON.stringify(title)}, '', ts, ts),
    )
    conn.commit()
    print(cur.lastrowid)
finally:
    conn.close()
`;
  return parseInt(runPython(py).trim(), 10);
}

/**
 * Force a task's updated_at to be later than its created_at — simulates
 * "the user edited this task since auto-creation," which is Reed's
 * `edited` reason for the detach path.
 */
function bumpTaskUpdatedAt(taskId: number): void {
  const py = `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(DB_PATH)}, timeout=10.0)
try:
    conn.execute(
        "UPDATE tasks SET updated_at = datetime(updated_at, '+1 day') WHERE id = ?",
        (${taskId},),
    )
    conn.commit()
finally:
    conn.close()
`;
  runPython(py);
}

/**
 * Create a goal row (used for goal_link external_reference test).
 */
function injectGoal(title: string): number {
  const py = `
import sqlite3
from datetime import datetime, timezone
ts = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')
conn = sqlite3.connect(${JSON.stringify(DB_PATH)}, timeout=10.0)
try:
    cur = conn.execute(
        "INSERT INTO goals (title, description, status, created_at, updated_at) "
        "VALUES (?, '', 'active', ?, ?)",
        (${JSON.stringify(title)}, ts, ts),
    )
    conn.commit()
    print(cur.lastrowid)
finally:
    conn.close()
`;
  return parseInt(runPython(py).trim(), 10);
}

/**
 * Insert a tag + brain_dump_tags link. Returns the new tag id.
 */
function injectTagWithDumpLink(tagName: string, dumpId: number): number {
  // tags table has only id + name; no created_at column.
  const py = `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(DB_PATH)}, timeout=10.0)
try:
    cur = conn.execute(
        "INSERT INTO tags (name) VALUES (?)",
        (${JSON.stringify(tagName)},),
    )
    tag_id = cur.lastrowid
    conn.execute(
        "INSERT INTO brain_dump_tags (brain_dump_id, tag_id) VALUES (?, ?)",
        (${dumpId}, tag_id),
    )
    conn.commit()
    print(tag_id)
finally:
    conn.close()
`;
  return parseInt(runPython(py).trim(), 10);
}

/**
 * Add a brain_dump_tags row linking another dump to the same tag —
 * simulates "tag is shared across multiple dumps" (detach path).
 */
function linkTagToDump(tagId: number, dumpId: number): void {
  const py = `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(DB_PATH)}, timeout=10.0)
try:
    conn.execute(
        "INSERT OR IGNORE INTO brain_dump_tags (brain_dump_id, tag_id) VALUES (?, ?)",
        (${dumpId}, ${tagId}),
    )
    conn.commit()
finally:
    conn.close()
`;
  runPython(py);
}

/** Existence probes for the post-action assertions. */
function rowExists(table: string, id: number): boolean {
  const out = sqliteExec(
    `SELECT 1 FROM ${table} WHERE id=${id};`,
  ).trim();
  return out === '1';
}

function brainDumpTagsCount(dumpId: number, tagId: number): number {
  const out = sqliteExec(
    `SELECT COUNT(*) FROM brain_dump_tags WHERE brain_dump_id=${dumpId} AND tag_id=${tagId};`,
  ).trim();
  return parseInt(out, 10);
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

/** afterAll cleanup — every row keyed off the canary prefix. */
function cleanupAll(): void {
  if (!sqliteAvailable()) return;
  const py = `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(DB_PATH)}, timeout=10.0)
try:
    # Brain dumps + their work_queue rows + brain_dump_tags links
    ids = [r[0] for r in conn.execute(
        "SELECT id FROM brain_dumps WHERE content LIKE ?",
        (${JSON.stringify(CANARY_PREFIX + '%')},),
    ).fetchall()]
    for did in ids:
        conn.execute("DELETE FROM work_queue WHERE job_type='brain_dump' AND target_id=?", (did,))
        conn.execute("DELETE FROM brain_dump_tags WHERE brain_dump_id=?", (did,))
        conn.execute("DELETE FROM brain_dumps WHERE id=?", (did,))
    # Tasks / goals / tags / people / knowledge canaries
    conn.execute("DELETE FROM task_tags WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE ?)", (${JSON.stringify(CANARY_PREFIX + '%')},))
    conn.execute("DELETE FROM tasks WHERE title LIKE ?", (${JSON.stringify(CANARY_PREFIX + '%')},))
    conn.execute("DELETE FROM goal_tags WHERE goal_id IN (SELECT id FROM goals WHERE title LIKE ?)", (${JSON.stringify(CANARY_PREFIX + '%')},))
    conn.execute("DELETE FROM goal_people WHERE goal_id IN (SELECT id FROM goals WHERE title LIKE ?)", (${JSON.stringify(CANARY_PREFIX + '%')},))
    conn.execute("DELETE FROM goals WHERE title LIKE ?", (${JSON.stringify(CANARY_PREFIX + '%')},))
    conn.execute("DELETE FROM knowledge_tags WHERE knowledge_id IN (SELECT id FROM knowledge_items WHERE title LIKE ?)", (${JSON.stringify(CANARY_PREFIX + '%')},))
    conn.execute("DELETE FROM knowledge_items WHERE title LIKE ?", (${JSON.stringify(CANARY_PREFIX + '%')},))
    conn.execute("DELETE FROM person_tags WHERE person_id IN (SELECT id FROM people WHERE name LIKE ?)", (${JSON.stringify(CANARY_PREFIX + '%')},))
    conn.execute("DELETE FROM people WHERE name LIKE ?", (${JSON.stringify(CANARY_PREFIX + '%')},))
    conn.execute("DELETE FROM brain_dump_tags WHERE tag_id IN (SELECT id FROM tags WHERE name LIKE ?)", (${JSON.stringify(CANARY_PREFIX + '%')},))
    conn.execute("DELETE FROM task_tags WHERE tag_id IN (SELECT id FROM tags WHERE name LIKE ?)", (${JSON.stringify(CANARY_PREFIX + '%')},))
    conn.execute("DELETE FROM goal_tags WHERE tag_id IN (SELECT id FROM tags WHERE name LIKE ?)", (${JSON.stringify(CANARY_PREFIX + '%')},))
    conn.execute("DELETE FROM knowledge_tags WHERE tag_id IN (SELECT id FROM tags WHERE name LIKE ?)", (${JSON.stringify(CANARY_PREFIX + '%')},))
    conn.execute("DELETE FROM person_tags WHERE tag_id IN (SELECT id FROM tags WHERE name LIKE ?)", (${JSON.stringify(CANARY_PREFIX + '%')},))
    conn.execute("DELETE FROM tags WHERE name LIKE ?", (${JSON.stringify(CANARY_PREFIX + '%')},))
    conn.commit()
finally:
    conn.close()
`;
  try {
    runPython(py);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[probe-unlink] cleanup failed:', e);
  }
}

test.describe('unlink auto-created items — API + UI regression', () => {
  test.skip(
    !sqliteAvailable(),
    'sqlite3 CLI / local DB not available — direct-injection spec skipped',
  );

  test.afterAll(() => {
    cleanupAll();
  });

  // ════════════════════════════════════════════════════════════════════
  // API surface — preview endpoint and unlink action
  // ════════════════════════════════════════════════════════════════════

  // 1. Preview on a clean auto_created task -> path: 'delete', empty reasons.
  test('@dump @worker unlink API 1: preview on clean auto_created task -> path=delete, no reasons', async ({
    baseURL,
    password,
  }) => {
    const taskTitle = `${CANARY_PREFIX}clean-task-${Date.now()}`;
    const taskId = injectTask(taskTitle);
    const dumpId = injectDump('preview-clean-task', [
      {
        type: 'task',
        confidence: 0.95,
        status: 'auto_created',
        created_id: taskId,
        data: { title: taskTitle },
      },
    ]);

    const api = await newAuthedApi(baseURL!, password);
    try {
      const r = await api.post(`api/brain-dumps/${dumpId}/unlink-preview`, {
        headers: { 'Content-Type': 'application/json' },
        data: { item_index: 0 },
      });
      expect(r.status()).toBe(200);
      const body = await r.json();
      expect(body.path).toBe('delete');
      expect(body.reasons).toEqual([]);
      expect(body.entity_label).toBe(`the task #${taskId}`);
    } finally {
      await api.dispose();
    }
  });

  // 2. Preview on a task that has been edited since auto-creation
  //    -> path: 'detach', reasons includes 'edited'.
  test('@dump @worker unlink API 2: preview on edited task -> path=detach, reasons include edited', async ({
    baseURL,
    password,
  }) => {
    const taskTitle = `${CANARY_PREFIX}edited-task-${Date.now()}`;
    const taskId = injectTask(taskTitle);
    bumpTaskUpdatedAt(taskId); // updated_at != created_at -> 'edited'
    const dumpId = injectDump('preview-edited-task', [
      {
        type: 'task',
        confidence: 0.95,
        status: 'auto_created',
        created_id: taskId,
        data: { title: taskTitle },
      },
    ]);

    const api = await newAuthedApi(baseURL!, password);
    try {
      const r = await api.post(`api/brain-dumps/${dumpId}/unlink-preview`, {
        headers: { 'Content-Type': 'application/json' },
        data: { item_index: 0 },
      });
      expect(r.status()).toBe(200);
      const body = await r.json();
      expect(body.path).toBe('detach');
      expect(body.reasons).toContain('edited');
    } finally {
      await api.dispose();
    }
  });

  // 3. Preview on a goal_link item (external_reference short-circuit per
  //    Reed §4 / contract): always detach with reason 'external_reference'.
  test('@dump @worker unlink API 3: preview on goal_link -> path=detach, reasons=[external_reference]', async ({
    baseURL,
    password,
  }) => {
    const goalTitle = `${CANARY_PREFIX}goal-for-link-${Date.now()}`;
    const goalId = injectGoal(goalTitle);
    const dumpId = injectDump('preview-goal-link', [
      {
        type: 'goal_link',
        confidence: 0.95,
        status: 'auto_created',
        created_id: goalId,
        data: { goal_id: goalId, goal_title: goalTitle },
      },
    ]);

    const api = await newAuthedApi(baseURL!, password);
    try {
      const r = await api.post(`api/brain-dumps/${dumpId}/unlink-preview`, {
        headers: { 'Content-Type': 'application/json' },
        data: { item_index: 0 },
      });
      expect(r.status()).toBe(200);
      const body = await r.json();
      expect(body.path).toBe('detach');
      expect(body.reasons).toEqual(['external_reference']);
    } finally {
      await api.dispose();
    }
  });

  // 4. Preview on a task whose entity has been deleted out from under
  //    the dump -> path: 'already_gone'.
  test('@dump @worker unlink API 4: preview when entity already deleted -> path=already_gone', async ({
    baseURL,
    password,
  }) => {
    const taskTitle = `${CANARY_PREFIX}stale-task-${Date.now()}`;
    const taskId = injectTask(taskTitle);
    const dumpId = injectDump('preview-stale', [
      {
        type: 'task',
        confidence: 0.95,
        status: 'auto_created',
        created_id: taskId,
        data: { title: taskTitle },
      },
    ]);
    // Wipe the task out of band (simulates "Cam deleted it elsewhere").
    sqliteExec(`DELETE FROM tasks WHERE id=${taskId};`);

    const api = await newAuthedApi(baseURL!, password);
    try {
      const r = await api.post(`api/brain-dumps/${dumpId}/unlink-preview`, {
        headers: { 'Content-Type': 'application/json' },
        data: { item_index: 0 },
      });
      expect(r.status()).toBe(200);
      const body = await r.json();
      expect(body.path).toBe('already_gone');
    } finally {
      await api.dispose();
    }
  });

  // 5. Preview on a `suggested` item -> 409 (precondition: only
  //    auto_created or approved items can be unlinked).
  test('@dump @worker unlink API 5: preview on suggested item -> 409', async ({
    baseURL,
    password,
  }) => {
    const dumpId = injectDump(
      'preview-precondition-suggested',
      [
        {
          type: 'task',
          confidence: 0.6,
          status: 'suggested',
          created_id: null,
          data: { title: `${CANARY_PREFIX}sugg-${Date.now()}` },
        },
      ],
      { processing_status: 'needs_review', processed: 0 },
    );

    const api = await newAuthedApi(baseURL!, password);
    try {
      const r = await api.post(`api/brain-dumps/${dumpId}/unlink-preview`, {
        headers: { 'Content-Type': 'application/json' },
        data: { item_index: 0 },
      });
      expect(r.status()).toBe(409);
      const body = await r.json();
      expect(body).toEqual({
        error: 'only auto-created or approved items can be unlinked',
      });
    } finally {
      await api.dispose();
    }
  });

  // 6. action='unlink' with confirmed_path matching the verdict -> 200.
  //    Entity is gone, item flips to rejected with unlinked_path/reasons.
  test('@smoke @dump @worker unlink API 6: action=unlink confirmed_path=delete -> entity gone, item rejected with audit fields', async ({
    baseURL,
    password,
  }) => {
    const taskTitle = `${CANARY_PREFIX}delete-success-${Date.now()}`;
    const taskId = injectTask(taskTitle);
    const dumpId = injectDump('action-delete', [
      {
        type: 'task',
        confidence: 0.95,
        status: 'auto_created',
        created_id: taskId,
        data: { title: taskTitle },
      },
    ]);

    const api = await newAuthedApi(baseURL!, password);
    try {
      const r = await api.post(`api/brain-dumps/${dumpId}/approve-item`, {
        headers: { 'Content-Type': 'application/json' },
        data: {
          item_index: 0,
          action: 'unlink',
          confirmed_path: 'delete',
        },
      });
      expect(r.status()).toBe(200);
      const body = await r.json();
      const item = body.processed_items.items[0];
      expect(item.status).toBe('rejected');
      expect(item.created_id).toBeNull();
      expect(item.unlinked_path).toBe('delete');
      expect(Array.isArray(item.unlinked_reasons)).toBe(true);
      expect(item.unlinked_reasons).toEqual([]);
      // Entity row is gone.
      expect(rowExists('tasks', taskId)).toBe(false);
    } finally {
      await api.dispose();
    }
  });

  // 7. action='unlink' with mismatched confirmed_path (force drift):
  //    server says 'detach' (because the task was edited) but client
  //    sends 'delete'. -> 409 with new_path + reasons in body.
  test('@dump @worker unlink API 7: drift between confirmed_path and recomputed verdict -> 409', async ({
    baseURL,
    password,
  }) => {
    const taskTitle = `${CANARY_PREFIX}drift-task-${Date.now()}`;
    const taskId = injectTask(taskTitle);
    bumpTaskUpdatedAt(taskId); // server will recompute -> detach
    const dumpId = injectDump('action-drift', [
      {
        type: 'task',
        confidence: 0.95,
        status: 'auto_created',
        created_id: taskId,
        data: { title: taskTitle },
      },
    ]);

    const api = await newAuthedApi(baseURL!, password);
    try {
      const r = await api.post(`api/brain-dumps/${dumpId}/approve-item`, {
        headers: { 'Content-Type': 'application/json' },
        data: {
          item_index: 0,
          action: 'unlink',
          confirmed_path: 'delete', // wrong — server will say detach
        },
      });
      expect(r.status()).toBe(409);
      const body = await r.json();
      expect(body.error).toBe('state changed');
      expect(body.new_path).toBe('detach');
      expect(Array.isArray(body.reasons)).toBe(true);
      expect(body.reasons).toContain('edited');
      // Entity is NOT gone — drift means we rolled back.
      expect(rowExists('tasks', taskId)).toBe(true);
      // Item state was NOT mutated.
      const stored = sqliteExec(
        `SELECT json_extract(processed_items, '$.items[0].status') ` +
          `FROM brain_dumps WHERE id=${dumpId};`,
      ).trim();
      expect(stored).toBe('auto_created');
    } finally {
      await api.dispose();
    }
  });

  // 8. Tag unlink — clean case: tag created by this dump only, no per-item
  //    junctions to entities outside this dump's fanout. -> path=delete.
  test('@dump @worker @tags unlink API 8: tag created only by this dump -> path=delete, tag gone after action', async ({
    baseURL,
    password,
  }) => {
    const tagName = `${CANARY_PREFIX}solo-tag-${Date.now()}`;
    // Inject the dump first so the tag's brain_dump_tags row can point at it.
    const dumpId = injectDump('tag-solo', [
      {
        type: 'tag',
        confidence: 0.95,
        status: 'auto_created',
        created_id: 0, // patched below
        data: { tag_name: tagName, is_new: true },
      },
    ]);
    const tagId = injectTagWithDumpLink(tagName, dumpId);
    // Patch the item's created_id now that the tag exists.
    sqliteExec(
      `UPDATE brain_dumps SET processed_items = json_set(processed_items, '$.items[0].created_id', ${tagId}) WHERE id=${dumpId};`,
    );

    const api = await newAuthedApi(baseURL!, password);
    try {
      // Preview confirms the verdict.
      const preview = await api.post(`api/brain-dumps/${dumpId}/unlink-preview`, {
        headers: { 'Content-Type': 'application/json' },
        data: { item_index: 0 },
      });
      expect(preview.status()).toBe(200);
      const previewBody = await preview.json();
      expect(previewBody.path).toBe('delete');

      // Action: confirm with delete -> tag row is removed.
      const r = await api.post(`api/brain-dumps/${dumpId}/approve-item`, {
        headers: { 'Content-Type': 'application/json' },
        data: { item_index: 0, action: 'unlink', confirmed_path: 'delete' },
      });
      expect(r.status()).toBe(200);
      expect(rowExists('tags', tagId)).toBe(false);
    } finally {
      await api.dispose();
    }
  });

  // 9. Tag unlink — cross-dump junction: tag is referenced by a second
  //    brain_dump_tags row from a different dump. -> path=detach, only
  //    THIS dump's brain_dump_tags row is removed; tag and the other
  //    dump's link survive.
  test('@dump @worker @tags unlink API 9: tag with cross-dump junction -> detach, only this dump\'s link removed', async ({
    baseURL,
    password,
  }) => {
    const tagName = `${CANARY_PREFIX}shared-tag-${Date.now()}`;
    const dumpA = injectDump('tag-cross-A', [
      {
        type: 'tag',
        confidence: 0.95,
        status: 'auto_created',
        created_id: 0,
        data: { tag_name: tagName, is_new: true },
      },
    ]);
    const dumpB = injectDump('tag-cross-B', []);
    const tagId = injectTagWithDumpLink(tagName, dumpA);
    linkTagToDump(tagId, dumpB);
    sqliteExec(
      `UPDATE brain_dumps SET processed_items = json_set(processed_items, '$.items[0].created_id', ${tagId}) WHERE id=${dumpA};`,
    );

    const api = await newAuthedApi(baseURL!, password);
    try {
      const preview = await api.post(`api/brain-dumps/${dumpA}/unlink-preview`, {
        headers: { 'Content-Type': 'application/json' },
        data: { item_index: 0 },
      });
      expect(preview.status()).toBe(200);
      const previewBody = await preview.json();
      expect(previewBody.path).toBe('detach');
      expect(previewBody.reasons).toContain('other_dumps');

      const r = await api.post(`api/brain-dumps/${dumpA}/approve-item`, {
        headers: { 'Content-Type': 'application/json' },
        data: { item_index: 0, action: 'unlink', confirmed_path: 'detach' },
      });
      expect(r.status()).toBe(200);
      // Tag row survives.
      expect(rowExists('tags', tagId)).toBe(true);
      // dumpA's link is gone; dumpB's link survives.
      expect(brainDumpTagsCount(dumpA, tagId)).toBe(0);
      expect(brainDumpTagsCount(dumpB, tagId)).toBe(1);
      // Item flips to rejected with unlinked_path=detach.
      const item = (await r.json()).processed_items.items[0];
      expect(item.status).toBe('rejected');
      expect(item.unlinked_path).toBe('detach');
    } finally {
      await api.dispose();
    }
  });

  // ════════════════════════════════════════════════════════════════════
  // UI surface — × affordance + confirm dialog
  // ════════════════════════════════════════════════════════════════════

  // 10. Open dump detail with an auto_created task -> × visible. Click ->
  //     dialog renders with the right template (delete heuristic). Confirm
  //     -> row flips to Rejected group. (Toast/optimistic-flip is captured
  //     by the row group transition.)
  test('@dump UI 10: × on auto_created task row -> dialog -> confirm -> row enters Rejected group', async ({
    loggedInPage,
  }) => {
    const taskTitle = `${CANARY_PREFIX}ui-delete-task-${Date.now()}`;
    const taskId = injectTask(taskTitle);
    const dumpId = injectDump('ui-delete', [
      {
        type: 'task',
        confidence: 0.95,
        status: 'auto_created',
        created_id: taskId,
        data: { title: taskTitle },
      },
    ]);

    await loggedInPage.goto('');
    await loggedInPage.locator('[data-view="dump"]').first().click();
    await expect(loggedInPage.locator('#view-dump')).toBeVisible();
    const dumpRow = loggedInPage.locator(
      `#view-dump .dump-item-clickable[data-dump-id="${dumpId}"]`,
    );
    await dumpRow.waitFor({ state: 'visible', timeout: 10_000 });
    await dumpRow.click();

    const drawer = loggedInPage.locator('#dumpDetailOverlay');
    await expect(drawer).toBeVisible();

    // The × button exists on the auto_created row. We don't assert hover
    // visibility (hover-revealed on desktop, always-visible on mobile;
    // the CSS pixel state isn't load-bearing — the click resolves either
    // way because the element is in the DOM).
    const unlinkBtn = drawer.locator(
      `.dump-detail-item[data-item-index="0"] .dump-detail-item-unlink`,
    );
    await expect(unlinkBtn).toHaveCount(1);
    await unlinkBtn.click();

    // The confirm dialog renders with the delete template (server returned
    // path=delete because the task is clean).
    const dialog = loggedInPage.locator('.unlink-dialog-overlay .unlink-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.unlink-dialog-title')).toContainText(
      /Delete/i,
    );

    // Confirm.
    await dialog.locator('.unlink-dialog-confirm').click();

    // Dialog closes, row flips into Rejected group, tasks row gone.
    await expect(loggedInPage.locator('.unlink-dialog-overlay')).toHaveCount(0, {
      timeout: 5_000,
    });
    await expect
      .poll(() => rowExists('tasks', taskId), { timeout: 5_000 })
      .toBe(false);
    // Server-side: item flipped to rejected with unlinked_path=delete.
    await expect
      .poll(
        () =>
          sqliteExec(
            `SELECT json_extract(processed_items, '$.items[0].status') ` +
              `FROM brain_dumps WHERE id=${dumpId};`,
          ).trim(),
        { timeout: 5_000 },
      )
      .toBe('rejected');
    expect(
      sqliteExec(
        `SELECT json_extract(processed_items, '$.items[0].unlinked_path') ` +
          `FROM brain_dumps WHERE id=${dumpId};`,
      ).trim(),
    ).toBe('delete');
  });

  // 11. Regression check: ↶ Un-reject on a recently-unlinked row flips it
  //     back to suggested (existing behaviour the unlink change must not
  //     break). We inject a row already in `rejected` state with the
  //     unlink audit fields, exactly as the unlink action would leave it.
  test('@dump UI 11: ↶ Un-reject on a recently-unlinked row -> flips back to suggested', async ({
    loggedInPage,
  }) => {
    const dumpId = injectDump(
      'ui-unreject-after-unlink',
      [
        {
          type: 'task',
          confidence: 0.95,
          status: 'rejected',
          created_id: null,
          unlinked_path: 'delete',
          unlinked_reasons: [],
          data: { title: `${CANARY_PREFIX}ui-unreject-${Date.now()}` },
        },
      ],
      { processing_status: 'processed', processed: 1 },
    );

    await loggedInPage.goto('');
    await loggedInPage.locator('[data-view="dump"]').first().click();
    await expect(loggedInPage.locator('#view-dump')).toBeVisible();
    const dumpRow = loggedInPage.locator(
      `#view-dump .dump-item-clickable[data-dump-id="${dumpId}"]`,
    );
    await dumpRow.waitFor({ state: 'visible', timeout: 10_000 });
    await dumpRow.click();

    const drawer = loggedInPage.locator('#dumpDetailOverlay');
    await expect(drawer).toBeVisible();

    // Click ↶ Un-reject.
    await drawer
      .locator(
        `.dump-detail-item[data-item-index="0"] button[data-action="unreject"]`,
      )
      .click();

    // Server-side flip to suggested.
    await expect
      .poll(
        () =>
          sqliteExec(
            `SELECT json_extract(processed_items, '$.items[0].status') ` +
              `FROM brain_dumps WHERE id=${dumpId};`,
          ).trim(),
        { timeout: 5_000 },
      )
      .toBe('suggested');
  });

  // 12. Click × is independent of launchpad click — clicking the × on an
  //     auto_created row must NOT also fire the row's launch handler
  //     (which would open the entity detail underneath the dialog).
  test('@dump UI 12: × click does not also trigger row launchpad', async ({
    loggedInPage,
  }) => {
    // Use a goal_link so a launch would open #goalDetailOverlay. The
    // dump-detail-modal spec already proved the launch fires on row body
    // click; here we assert it does NOT fire when × is the click target.
    const goalTitle = `${CANARY_PREFIX}ui-no-launch-goal-${Date.now()}`;
    const goalId = injectGoal(goalTitle);
    const dumpId = injectDump(
      'ui-no-launch',
      [
        {
          type: 'goal_link',
          confidence: 0.95,
          status: 'auto_created',
          created_id: goalId,
          data: { goal_id: goalId, goal_title: goalTitle },
        },
      ],
      { processing_status: 'processed', processed: 1 },
    );

    await loggedInPage.goto('');
    await loggedInPage.locator('[data-view="dump"]').first().click();
    await expect(loggedInPage.locator('#view-dump')).toBeVisible();
    const dumpRow = loggedInPage.locator(
      `#view-dump .dump-item-clickable[data-dump-id="${dumpId}"]`,
    );
    await dumpRow.waitFor({ state: 'visible', timeout: 10_000 });
    await dumpRow.click();

    const drawer = loggedInPage.locator('#dumpDetailOverlay');
    await expect(drawer).toBeVisible();

    // Click × on the row.
    const unlinkBtn = drawer.locator(
      `.dump-detail-item[data-item-index="0"] .dump-detail-item-unlink`,
    );
    await expect(unlinkBtn).toHaveCount(1);
    await unlinkBtn.click();

    // The unlink dialog opens.
    const dialog = loggedInPage.locator('.unlink-dialog-overlay .unlink-dialog');
    await expect(dialog).toBeVisible();

    // The goal detail overlay should NOT have opened (event.stopPropagation
    // on the × must prevent the row's launch handler from firing).
    const goalModal = loggedInPage.locator('#goalDetailOverlay');
    await expect(goalModal).toBeHidden();

    // Tidy up — cancel out of the dialog so afterAll cleanup isn't fighting
    // a half-completed unlink (the dump itself is canary-prefixed and will
    // still be wiped, but cancelling is the friendlier shape).
    await dialog.locator('.unlink-dialog-cancel').click();
    await expect(loggedInPage.locator('.unlink-dialog-overlay')).toHaveCount(0, {
      timeout: 5_000,
    });
  });
});
