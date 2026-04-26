import { test, expect } from './fixtures/auth';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import { request as pwRequest, type APIRequestContext } from '@playwright/test';

/**
 * Regression test for option (C) — LLM-supplied `apply_to` with junction-
 * table fan-out (Vault, 2026-04-23).
 *
 * Contract under test:
 *   `app/contracts/auto-create-item.md` — "tag" branch, `apply_to` fan-out
 *   section.
 *
 * Central invariant:
 *   When a tag's `apply_to` names sibling items by `{type, source_text}`,
 *   the tag attaches to ONLY those siblings via the appropriate junction
 *   table (`task_tags`, `knowledge_tags`, `goal_tags`, `person_tags`).
 *   Empty or absent `apply_to` keeps today's behaviour: tag exists, is
 *   linked into `brain_dump_tags`, no per-item attachment.
 *
 * Cases covered (proportional to the patch — 6 cases):
 *   1. Happy path: apply_to=[task] -> task_tags row, NOT knowledge_tags.
 *   2. Multi-target: apply_to=[task, knowledge] -> both junctions.
 *   3. Backwards compat: empty apply_to -> only brain_dump_tags, no per-item.
 *   4. Unknown type in apply_to (`goal_link`) -> no junction row, no error,
 *      tag still created and linked to dump.
 *   5. Sibling not yet created (created_id=null) -> skipped silently, no
 *      error, tag still created.
 *   6. Approve-handler reach -> approving a tag with apply_to fans out via
 *      the approve handler's sibling pass-through.
 *
 * Approach: direct sqlite injection of crafted `processed_items` JSON
 * (matches `auto-create-item-truthfulness.spec.ts`), then drive each
 * assertion via POST /api/brain-dumps/<id>/approve-item. All cases use the
 * approve-handler surface — `_attach_tag_to_siblings` is identical code on
 * both worker and approve paths, and the approve path is the only one we
 * can drive deterministically without booting an LLM (case 6 explicitly
 * proves the approve-handler reach).
 *
 * Privacy: every injected row uses canary strings (`probe-fanout-...`).
 * Cleanup nukes everything keyed off that prefix in afterAll.
 */

const DB_PATH =
  process.env.LIFEPLAN_DB_PATH ||
  '/Users/cam/dev/personal/lifeplan/data/lifeplan.db';
const CANARY_PREFIX = 'probe-fanout-';

function runPython(source: string): string {
  const b64 = Buffer.from(source, 'utf8').toString('base64');
  return execSync(
    `python3 -c "import base64,sys;exec(compile(base64.b64decode('${b64}'),'<probe-fanout>','exec'))"`,
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
 *
 * `items` is the array put under processed_items.items[]. Each entry is an
 * item dict shaped like the LLM's output: type, source_text, confidence,
 * status (default "suggested" so handle_approve_item will act on it),
 * created_id (default null), data{}.
 */
function injectDump(label: string, items: unknown[]): number {
  const content = `${CANARY_PREFIX}${label}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const processed = {
    version: 1,
    processed_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    extraction_method: 'probe-fanout-injected',
    items,
  };
  const py = `
import sqlite3, json
conn = sqlite3.connect(${JSON.stringify(DB_PATH)}, timeout=10.0)
try:
    cur = conn.execute(
        "INSERT INTO brain_dumps (content, processing_status, processed_items, processed) "
        "VALUES (?, 'needs_review', ?, 0)",
        (${JSON.stringify(content)}, ${JSON.stringify(JSON.stringify(processed))}),
    )
    conn.commit()
    print(cur.lastrowid)
finally:
    conn.close()
`;
  return parseInt(runPython(py).trim(), 10);
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

/**
 * Approve one item by index, return the updated dump body.
 */
async function approveItem(
  api: APIRequestContext,
  dumpId: number,
  itemIndex: number,
): Promise<any> {
  const r = await api.post(`api/brain-dumps/${dumpId}/approve-item`, {
    headers: { 'Content-Type': 'application/json' },
    data: { item_index: itemIndex, action: 'approve' },
  });
  expect(r.status()).toBe(200);
  return r.json();
}

/**
 * Count rows in a junction table for a given tag_id.
 */
function junctionRowCount(table: string, tagId: number): number {
  const out = sqliteExec(
    `SELECT COUNT(*) FROM ${table} WHERE tag_id=${tagId};`,
  ).trim();
  return parseInt(out, 10);
}

/**
 * Suite-wide cleanup: every brain_dump, work_queue row, person, tag, and
 * dependent junction-table row that keys off our canary prefix.
 *
 * Order: junction tables first (no FK, but harmless), then brain_dumps
 * (CASCADE deletes brain_dump_tags), then people / tags by canary name.
 *
 * We delete junction rows for any tag whose name carries the canary
 * prefix — this catches task_tags / knowledge_tags / goal_tags / person_tags
 * rows our fan-out wrote, even though their foreign rows aren't ours.
 * (Tasks / knowledge_items / goals / people created by approve actions
 * for fan-out targets ARE ours — also canary-named; cleaned below.)
 */
function cleanupAll(): void {
  if (!sqliteAvailable()) return;
  const py = `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(DB_PATH)}, timeout=10.0)
try:
    canary = ${JSON.stringify(CANARY_PREFIX + '%')}
    # 1. Identify our tags up front so we can drop their junction rows.
    tag_ids = [r[0] for r in conn.execute(
        "SELECT id FROM tags WHERE name LIKE ?", (canary,)
    ).fetchall()]
    for tid in tag_ids:
        for tbl in ("task_tags", "knowledge_tags", "goal_tags", "person_tags"):
            conn.execute(f"DELETE FROM {tbl} WHERE tag_id=?", (tid,))
    # 2. Brain dumps + their work_queue rows (CASCADE handles brain_dump_tags).
    dump_ids = [r[0] for r in conn.execute(
        "SELECT id FROM brain_dumps WHERE content LIKE ?", (canary,)
    ).fetchall()]
    for did in dump_ids:
        conn.execute(
            "DELETE FROM work_queue WHERE job_type='brain_dump' AND target_id=?",
            (did,),
        )
        conn.execute("DELETE FROM brain_dumps WHERE id=?", (did,))
    # 3. Tasks, knowledge_items, goals, people created during approve flows
    #    (every test crafts canary-named rows so this is safe).
    conn.execute("DELETE FROM tasks WHERE title LIKE ?", (canary,))
    conn.execute("DELETE FROM knowledge_items WHERE title LIKE ?", (canary,))
    conn.execute("DELETE FROM goals WHERE title LIKE ?", (canary,))
    conn.execute("DELETE FROM people WHERE name LIKE ?", (canary,))
    # 4. Tags themselves.
    conn.execute("DELETE FROM tags WHERE name LIKE ?", (canary,))
    conn.commit()
finally:
    conn.close()
`;
  try {
    runPython(py);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[probe-fanout] cleanup failed:', e);
  }
}

test.describe('tag apply_to fan-out (Vault option C)', () => {
  test.skip(
    !sqliteAvailable(),
    'sqlite3 CLI / local DB not available — direct-injection spec skipped',
  );

  test.afterAll(() => {
    cleanupAll();
  });

  // ────────────────────────────────────────────────────────────────
  // Case 1: Happy path
  //   task + knowledge created, then tag with apply_to=[{task, ...}]
  //   approved -> tag attaches via task_tags, NOT knowledge_tags.
  // ────────────────────────────────────────────────────────────────
  test('case 1 happy path: apply_to=[task] -> only task_tags has the row', async ({
    baseURL,
    password,
  }) => {
    const taskSrc = `${CANARY_PREFIX}task-src-1`;
    const knowSrc = `${CANARY_PREFIX}know-src-1`;
    const tagName = `${CANARY_PREFIX}tag1-${Date.now()}`;
    const dumpId = injectDump('case1-happy', [
      {
        type: 'task',
        source_text: taskSrc,
        confidence: 0.95,
        status: 'suggested',
        created_id: null,
        data: { title: `${CANARY_PREFIX}task1` },
      },
      {
        type: 'knowledge',
        source_text: knowSrc,
        confidence: 0.95,
        status: 'suggested',
        created_id: null,
        data: { title: `${CANARY_PREFIX}know1`, content: 'body' },
      },
      {
        type: 'tag',
        source_text: tagName,
        confidence: 0.95,
        status: 'suggested',
        created_id: null,
        data: {
          tag_name: tagName,
          is_new: true,
          matched_existing_id: null,
          apply_to: [{ type: 'task', source_text: taskSrc }],
        },
      },
    ]);

    const api = await newAuthedApi(baseURL!, password);
    try {
      // Approve task and knowledge first so they have created_id by the
      // time the tag's fan-out reads sibling_items.
      await approveItem(api, dumpId, 0);
      await approveItem(api, dumpId, 1);
      const body = await approveItem(api, dumpId, 2);

      const tagItem = body.processed_items.items[2];
      expect(tagItem.status).toBe('approved');
      expect(tagItem.created_id).not.toBeNull();
      const tagId = tagItem.created_id as number;

      // Junction-table truth: task_tags has 1 row, knowledge_tags has 0.
      expect(junctionRowCount('task_tags', tagId)).toBe(1);
      expect(junctionRowCount('knowledge_tags', tagId)).toBe(0);
      expect(junctionRowCount('goal_tags', tagId)).toBe(0);
      expect(junctionRowCount('person_tags', tagId)).toBe(0);

      // Confirm task_tags row points at the right task.
      const taskItem = body.processed_items.items[0];
      const linked = sqliteExec(
        `SELECT task_id FROM task_tags WHERE tag_id=${tagId};`,
      ).trim();
      expect(linked).toBe(String(taskItem.created_id));

      // Backwards-compat slice: brain_dump_tags link still present.
      const dumpLink = sqliteExec(
        `SELECT COUNT(*) FROM brain_dump_tags ` +
          `WHERE brain_dump_id=${dumpId} AND tag_id=${tagId};`,
      ).trim();
      expect(dumpLink).toBe('1');
    } finally {
      await api.dispose();
    }
  });

  // ────────────────────────────────────────────────────────────────
  // Case 2: Multi-target
  //   apply_to=[task, knowledge] -> both junction tables get a row.
  // ────────────────────────────────────────────────────────────────
  test('case 2 multi-target: apply_to=[task, knowledge] -> rows in both junctions', async ({
    baseURL,
    password,
  }) => {
    const taskSrc = `${CANARY_PREFIX}task-src-2`;
    const knowSrc = `${CANARY_PREFIX}know-src-2`;
    const tagName = `${CANARY_PREFIX}tag2-${Date.now()}`;
    const dumpId = injectDump('case2-multi', [
      {
        type: 'task',
        source_text: taskSrc,
        confidence: 0.95,
        status: 'suggested',
        created_id: null,
        data: { title: `${CANARY_PREFIX}task2` },
      },
      {
        type: 'knowledge',
        source_text: knowSrc,
        confidence: 0.95,
        status: 'suggested',
        created_id: null,
        data: { title: `${CANARY_PREFIX}know2`, content: 'body' },
      },
      {
        type: 'tag',
        source_text: tagName,
        confidence: 0.95,
        status: 'suggested',
        created_id: null,
        data: {
          tag_name: tagName,
          is_new: true,
          matched_existing_id: null,
          apply_to: [
            { type: 'task', source_text: taskSrc },
            { type: 'knowledge', source_text: knowSrc },
          ],
        },
      },
    ]);

    const api = await newAuthedApi(baseURL!, password);
    try {
      await approveItem(api, dumpId, 0);
      await approveItem(api, dumpId, 1);
      const body = await approveItem(api, dumpId, 2);

      const tagItem = body.processed_items.items[2];
      expect(tagItem.status).toBe('approved');
      const tagId = tagItem.created_id as number;

      expect(junctionRowCount('task_tags', tagId)).toBe(1);
      expect(junctionRowCount('knowledge_tags', tagId)).toBe(1);
      expect(junctionRowCount('goal_tags', tagId)).toBe(0);
      expect(junctionRowCount('person_tags', tagId)).toBe(0);
    } finally {
      await api.dispose();
    }
  });

  // ────────────────────────────────────────────────────────────────
  // Case 3: Backwards compat (every historical row is this shape)
  //   tag with empty apply_to -> brain_dump_tags only, no per-item rows.
  // ────────────────────────────────────────────────────────────────
  test('case 3 backwards compat: empty apply_to -> brain_dump_tags only', async ({
    baseURL,
    password,
  }) => {
    const tagName = `${CANARY_PREFIX}tag3-${Date.now()}`;
    const dumpId = injectDump('case3-empty-applyto', [
      {
        type: 'task',
        source_text: `${CANARY_PREFIX}task-src-3`,
        confidence: 0.95,
        status: 'suggested',
        created_id: null,
        data: { title: `${CANARY_PREFIX}task3` },
      },
      {
        type: 'tag',
        source_text: tagName,
        confidence: 0.95,
        status: 'suggested',
        created_id: null,
        data: {
          tag_name: tagName,
          is_new: true,
          matched_existing_id: null,
          apply_to: [],
        },
      },
    ]);

    const api = await newAuthedApi(baseURL!, password);
    try {
      await approveItem(api, dumpId, 0);
      const body = await approveItem(api, dumpId, 1);

      const tagItem = body.processed_items.items[1];
      expect(tagItem.status).toBe('approved');
      const tagId = tagItem.created_id as number;

      // No per-item attachment anywhere.
      expect(junctionRowCount('task_tags', tagId)).toBe(0);
      expect(junctionRowCount('knowledge_tags', tagId)).toBe(0);
      expect(junctionRowCount('goal_tags', tagId)).toBe(0);
      expect(junctionRowCount('person_tags', tagId)).toBe(0);

      // brain_dump_tags link IS present (today's behaviour preserved).
      const dumpLink = sqliteExec(
        `SELECT COUNT(*) FROM brain_dump_tags ` +
          `WHERE brain_dump_id=${dumpId} AND tag_id=${tagId};`,
      ).trim();
      expect(dumpLink).toBe('1');
    } finally {
      await api.dispose();
    }
  });

  // ────────────────────────────────────────────────────────────────
  // Case 4: Unknown type in apply_to (e.g. `goal_link`)
  //   goal_link has no junction table per `_TAG_FANOUT_JUNCTIONS`.
  //   Defence-in-depth in `_attach_tag_to_siblings` skips it; the
  //   sanitiser would have dropped it pre-persistence in the live LLM
  //   path, but persisted JSON might carry it through. Either way:
  //   no error, no junction row, tag still created and dump-linked.
  // ────────────────────────────────────────────────────────────────
  test('case 4 unknown apply_to type: dropped silently, tag still created', async ({
    baseURL,
    password,
  }) => {
    const tagName = `${CANARY_PREFIX}tag4-${Date.now()}`;
    const dumpId = injectDump('case4-unknown-type', [
      {
        type: 'tag',
        source_text: tagName,
        confidence: 0.95,
        status: 'suggested',
        created_id: null,
        data: {
          tag_name: tagName,
          is_new: true,
          matched_existing_id: null,
          apply_to: [
            { type: 'goal_link', source_text: `${CANARY_PREFIX}nope` },
          ],
        },
      },
    ]);

    const api = await newAuthedApi(baseURL!, password);
    try {
      const body = await approveItem(api, dumpId, 0);

      const tagItem = body.processed_items.items[0];
      // Tag itself created OK (no error from the unknown apply_to entry).
      expect(tagItem.status).toBe('approved');
      expect(tagItem.created_id).not.toBeNull();
      const tagId = tagItem.created_id as number;

      // Nothing landed in any junction table.
      expect(junctionRowCount('task_tags', tagId)).toBe(0);
      expect(junctionRowCount('knowledge_tags', tagId)).toBe(0);
      expect(junctionRowCount('goal_tags', tagId)).toBe(0);
      expect(junctionRowCount('person_tags', tagId)).toBe(0);

      // brain_dump_tags link present.
      const dumpLink = sqliteExec(
        `SELECT COUNT(*) FROM brain_dump_tags ` +
          `WHERE brain_dump_id=${dumpId} AND tag_id=${tagId};`,
      ).trim();
      expect(dumpLink).toBe('1');
    } finally {
      await api.dispose();
    }
  });

  // ────────────────────────────────────────────────────────────────
  // Case 5: Sibling not yet created (still `suggested`, no created_id)
  //   Per contract: tag fan-out skips siblings whose created_id is null
  //   (counted as `no_created_id` in the fanout log). The user can attach
  //   manually if they later approve the sibling. No error, tag created.
  // ────────────────────────────────────────────────────────────────
  test('case 5 sibling not yet created: skipped silently, no error', async ({
    baseURL,
    password,
  }) => {
    const taskSrc = `${CANARY_PREFIX}task-src-5`;
    const tagName = `${CANARY_PREFIX}tag5-${Date.now()}`;
    const dumpId = injectDump('case5-pending-sibling', [
      {
        type: 'task',
        source_text: taskSrc,
        confidence: 0.6, // stays `suggested`; we don't approve it
        status: 'suggested',
        created_id: null,
        data: { title: `${CANARY_PREFIX}task5` },
      },
      {
        type: 'tag',
        source_text: tagName,
        confidence: 0.95,
        status: 'suggested',
        created_id: null,
        data: {
          tag_name: tagName,
          is_new: true,
          matched_existing_id: null,
          apply_to: [{ type: 'task', source_text: taskSrc }],
        },
      },
    ]);

    const api = await newAuthedApi(baseURL!, password);
    try {
      // Approve ONLY the tag. The task sibling still has created_id=null.
      const body = await approveItem(api, dumpId, 1);

      const tagItem = body.processed_items.items[1];
      expect(tagItem.status).toBe('approved');
      expect(tagItem.created_id).not.toBeNull();
      const tagId = tagItem.created_id as number;

      // No fan-out row anywhere.
      expect(junctionRowCount('task_tags', tagId)).toBe(0);
      expect(junctionRowCount('knowledge_tags', tagId)).toBe(0);
      expect(junctionRowCount('goal_tags', tagId)).toBe(0);
      expect(junctionRowCount('person_tags', tagId)).toBe(0);

      // brain_dump_tags link present (tag itself created normally).
      const dumpLink = sqliteExec(
        `SELECT COUNT(*) FROM brain_dump_tags ` +
          `WHERE brain_dump_id=${dumpId} AND tag_id=${tagId};`,
      ).trim();
      expect(dumpLink).toBe('1');

      // Task sibling still pending (we never approved it).
      expect(body.processed_items.items[0].status).toBe('suggested');
      expect(body.processed_items.items[0].created_id).toBeNull();
    } finally {
      await api.dispose();
    }
  });

  // ────────────────────────────────────────────────────────────────
  // Case 6: Approve-handler reach
  //   handle_approve_item passes `processed_items["items"]` as
  //   sibling_items. A tag approved through the UI fans out to siblings
  //   that already have created_id populated. This case exercises that
  //   pass-through end-to-end with a person sibling (different junction
  //   table from cases 1/2 to broaden coverage).
  // ────────────────────────────────────────────────────────────────
  test('case 6 approve-handler reach: tag fans out via sibling pass-through', async ({
    baseURL,
    password,
  }) => {
    const personSrc = `${CANARY_PREFIX}person-src-6`;
    const tagName = `${CANARY_PREFIX}tag6-${Date.now()}`;
    const personName = `${CANARY_PREFIX}person6-${Date.now()}`;
    const dumpId = injectDump('case6-approve-reach', [
      {
        type: 'person_new',
        source_text: personSrc,
        confidence: 0.95,
        status: 'suggested',
        created_id: null,
        data: { name: personName },
      },
      {
        type: 'tag',
        source_text: tagName,
        confidence: 0.95,
        status: 'suggested',
        created_id: null,
        data: {
          tag_name: tagName,
          is_new: true,
          matched_existing_id: null,
          apply_to: [{ type: 'person_new', source_text: personSrc }],
        },
      },
    ]);

    const api = await newAuthedApi(baseURL!, password);
    try {
      // Approve person first so created_id populates for fan-out.
      await approveItem(api, dumpId, 0);
      const body = await approveItem(api, dumpId, 1);

      const tagItem = body.processed_items.items[1];
      expect(tagItem.status).toBe('approved');
      const tagId = tagItem.created_id as number;

      // person_tags row attached via the approve-handler's sibling pass.
      expect(junctionRowCount('person_tags', tagId)).toBe(1);
      expect(junctionRowCount('task_tags', tagId)).toBe(0);
      expect(junctionRowCount('knowledge_tags', tagId)).toBe(0);
      expect(junctionRowCount('goal_tags', tagId)).toBe(0);

      // The person_tags row points at the person we just approved.
      const personItem = body.processed_items.items[0];
      const linked = sqliteExec(
        `SELECT person_id FROM person_tags WHERE tag_id=${tagId};`,
      ).trim();
      expect(linked).toBe(String(personItem.created_id));
    } finally {
      await api.dispose();
    }
  });
});
