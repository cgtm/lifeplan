import { test, expect } from './fixtures/auth';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import { request as pwRequest, type APIRequestContext } from '@playwright/test';

/**
 * Run a small Python program. We base64 the source so we don't fight the
 * shell over multiline strings, embedded quotes, or backslashes — `python3
 * -c` interprets `\n` etc. inconsistently across zsh/bash quoting layers.
 */
function runPython(source: string): string {
  const b64 = Buffer.from(source, 'utf8').toString('base64');
  return execSync(
    `python3 -c "import base64,sys;exec(compile(base64.b64decode('${b64}'),'<probe-truthfulness>','exec'))"`,
    { encoding: 'utf8' },
  );
}

/**
 * Regression test for the `_auto_create_item` status-truthfulness audit
 * (`docs/processes/audits/2026-04-23-auto-create-item-status-truthfulness.md`).
 *
 * Contract under test:
 *   `app/contracts/auto-create-item.md`
 *
 * Central invariant (Invariant 1 from the contract):
 *   When `_auto_create_item` returns `None` for ANY reason, the item's
 *   per-item `status` is NEVER `auto_created` / `approved`. It MUST be
 *   `failed` and `created_id` MUST be `null`.
 *
 * Hit-list coverage (Vault's pre-flagged silent-None paths):
 *   1. tag with is_new=False AND no matched_existing_id  -> fall-through
 *      to create-new (recovery shape; item ends `approved` with real id).
 *   2. person_mention with person_id=None                -> fall-through
 *      to create-new from person_name (recovery shape; item ends
 *      `approved` with real id pointing at a new people row).
 *   3. goal_link with goal_id=None                       -> log + None
 *      -> item ends `failed` with created_id=null.
 *   4. task with missing `title`                         -> raises
 *      MalformedItemData -> caught -> log + None -> item ends `failed`.
 *   5. knowledge with missing `title`                    -> same as 4.
 *   6. unknown `itype`                                   -> raises
 *      UnknownItemType. Tested at TWO surfaces:
 *        (a) `handle_approve_item` -> 500 with class-name-only body.
 *        (b) `_auto_create_item` direct call (proves the dispatcher
 *            else-branch raises rather than silently returning None).
 *            The worker's retry-to-failed end state is covered by the
 *            existing FORCE_FAIL_TEST in background-processing.spec.ts;
 *            we don't duplicate that 60s wait here.
 *
 * Approach: skip the LLM and inject crafted `processed_items` JSON
 * directly into `brain_dumps.processed_items`, then drive each assertion
 * via POST /api/brain-dumps/<id>/approve-item. This is the only
 * deterministic path for cases 4, 5, 6 (the LLM is too robust to coerce
 * into emitting malformed items), and it's simpler than the LLM route
 * for cases 1, 2, 3 too.
 *
 * Privacy: every injected item's `data` uses canary strings
 * (`probe-truth-<timestamp>`). No personal content lands in test rows.
 *
 * Cleanup: every test row created during this suite (brain_dumps,
 * work_queue, people, tags) is removed in teardown. Cleanup keys off
 * the canary prefix `probe-truth-`.
 */

// Direct-DB injection requires sqlite3 CLI + the local DB. CI without
// these gets the whole spec skipped (consistent with the gated tests in
// background-processing.spec.ts).
const DB_PATH =
  process.env.LIFEPLAN_DB_PATH ||
  '/Users/cam/dev/personal/lifeplan/data/lifeplan.db';

const APP_DIR = '/Users/cam/dev/personal/lifeplan';
const CANARY_PREFIX = 'probe-truth-';

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
 * Insert a brain_dumps row whose processed_items JSON is hand-crafted to
 * the shape `_auto_create_item` reads. Returns the new id.
 *
 * `items` is the array put under processed_items.items[]. Each entry is
 * an item dict shaped like the LLM's output: type, confidence, status
 * ("suggested" so handle_approve_item will act on it), data{}.
 *
 * processing_status starts as 'needs_review' so the dump looks like one
 * the worker has already classified for user approval.
 */
function injectDump(label: string, items: unknown[]): number {
  const content = `${CANARY_PREFIX}${label}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const processed = {
    version: 1,
    processed_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    extraction_method: 'probe-truthfulness-injected',
    items,
  };
  // Use SQL parameter binding to avoid shell-escaping JSON. We do this by
  // shelling out a small Python one-liner that uses the sqlite3 module
  // (which has parameter binding); the shell quoting for raw `sqlite3`
  // CLI gets adversarial fast with embedded JSON.
  const py = `
import sqlite3, json, sys
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
  const out = runPython(py).trim();
  return parseInt(out, 10);
}

/**
 * Authenticated APIRequestContext (mirrors the helper in
 * background-processing.spec.ts).
 */
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
 * Suite-level cleanup: nuke every row whose foreign content keys off our
 * canary prefix. Run in afterAll so a partial test failure still cleans
 * up. Order: dependent rows first.
 */
function cleanupAll(): void {
  if (!sqliteAvailable()) return;
  const py = `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(DB_PATH)}, timeout=10.0)
try:
    # 1. brain_dumps and their tag links / queue rows (CASCADE handles
    #    brain_dump_tags via FK; we drop work_queue manually).
    ids = [r[0] for r in conn.execute(
        "SELECT id FROM brain_dumps WHERE content LIKE ?",
        (${JSON.stringify(CANARY_PREFIX + '%')},),
    ).fetchall()]
    for did in ids:
        conn.execute(
            "DELETE FROM work_queue WHERE job_type='brain_dump' AND target_id=?",
            (did,),
        )
        conn.execute("DELETE FROM brain_dumps WHERE id=?", (did,))
    # 2. people created by person_mention fall-through (canary-named).
    conn.execute(
        "DELETE FROM people WHERE name LIKE ?",
        (${JSON.stringify(CANARY_PREFIX + '%')},),
    )
    # 3. tags created by tag fall-through (canary-named).
    conn.execute(
        "DELETE FROM tags WHERE name LIKE ?",
        (${JSON.stringify(CANARY_PREFIX + '%')},),
    )
    conn.commit()
finally:
    conn.close()
`;
  try {
    runPython(py);
  } catch (e) {
    // Don't fail the suite on cleanup; just emit so we know.
    // eslint-disable-next-line no-console
    console.warn('[probe-truthfulness] cleanup failed:', e);
  }
}

// Skip the entire spec if sqlite3 isn't available — the spec depends on
// it for both injection and cleanup. This mirrors the gating used in
// background-processing.spec.ts for the FORCE_FAIL_TEST/WATCHDOG tests.
test.describe('_auto_create_item status-truthfulness (Invariant 1)', () => {
  test.skip(
    !sqliteAvailable(),
    'sqlite3 CLI / local DB not available — direct-injection spec skipped',
  );

  test.afterAll(() => {
    cleanupAll();
  });

  // ────────────────────────────────────────────────────────────────
  // Case 1: tag with is_new=False AND matched_existing_id=None
  //         -> fall-through to create-new -> status=approved with real id.
  // ────────────────────────────────────────────────────────────────
  test('@worker @dump @tags hit-list 1: tag is_new=False + no match -> falls through, status=approved with real id', async ({
    baseURL,
    password,
  }) => {
    const tagName = `${CANARY_PREFIX}tag1-${Date.now()}`;
    const dumpId = injectDump('tag-fallthrough', [
      {
        type: 'tag',
        confidence: 0.95,
        status: 'suggested',
        data: {
          tag_name: tagName,
          is_new: false,
          matched_existing_id: null,
        },
      },
    ]);

    const api = await newAuthedApi(baseURL!, password);
    try {
      const r = await api.post(`api/brain-dumps/${dumpId}/approve-item`, {
        headers: { 'Content-Type': 'application/json' },
        data: { item_index: 0, action: 'approve' },
      });
      expect(r.status()).toBe(200);
      const body = await r.json();
      const item = body.processed_items.items[0];

      // Recovery shape: existing fall-through creates a new tag.
      expect(item.status).toBe('approved');
      expect(item.created_id).not.toBeNull();
      expect(typeof item.created_id).toBe('number');

      // The new tag really exists (and we'll clean it up via canary prefix).
      const found = sqliteExec(
        `SELECT id FROM tags WHERE id=${item.created_id};`,
      ).trim();
      expect(found).not.toBe('');
    } finally {
      await api.dispose();
    }
  });

  // ────────────────────────────────────────────────────────────────
  // Case 2: person_mention with person_id=None
  //         -> fall-through to create-new from person_name.
  // ────────────────────────────────────────────────────────────────
  test('@worker @dump @people hit-list 2: person_mention with null person_id -> falls through, status=approved + real people row', async ({
    baseURL,
    password,
  }) => {
    const personName = `${CANARY_PREFIX}person2-${Date.now()}`;
    const dumpId = injectDump('person-fallthrough', [
      {
        type: 'person_mention',
        confidence: 0.95,
        status: 'suggested',
        data: {
          person_id: null,
          person_name: personName,
          context: `${CANARY_PREFIX}context`,
        },
      },
    ]);

    const api = await newAuthedApi(baseURL!, password);
    try {
      const r = await api.post(`api/brain-dumps/${dumpId}/approve-item`, {
        headers: { 'Content-Type': 'application/json' },
        data: { item_index: 0, action: 'approve' },
      });
      expect(r.status()).toBe(200);
      const body = await r.json();
      const item = body.processed_items.items[0];

      expect(item.status).toBe('approved');
      expect(item.created_id).not.toBeNull();
      expect(typeof item.created_id).toBe('number');

      // The new people row really exists with the canary name.
      const found = sqliteExec(
        `SELECT name FROM people WHERE id=${item.created_id};`,
      ).trim();
      expect(found).toBe(personName);
    } finally {
      await api.dispose();
    }
  });

  // ────────────────────────────────────────────────────────────────
  // Case 3: goal_link with goal_id=None
  //         -> log + None -> status=failed (NEW behaviour).
  //         Pre-patch: silently auto_created with created_id=null.
  // ────────────────────────────────────────────────────────────────
  test('@worker @dump @goal hit-list 3: goal_link with null goal_id -> status=failed, created_id=null (NOT auto_created)', async ({
    baseURL,
    password,
  }) => {
    const dumpId = injectDump('goal-link-no-target', [
      {
        type: 'goal_link',
        confidence: 0.95,
        status: 'suggested',
        data: {
          goal_id: null,
          goal_title: `${CANARY_PREFIX}goal-link-text`,
        },
      },
    ]);

    const api = await newAuthedApi(baseURL!, password);
    try {
      const r = await api.post(`api/brain-dumps/${dumpId}/approve-item`, {
        headers: { 'Content-Type': 'application/json' },
        data: { item_index: 0, action: 'approve' },
      });
      // HTTP shape unchanged per contract: 200 even when create failed.
      expect(r.status()).toBe(200);
      const body = await r.json();
      const item = body.processed_items.items[0];

      // Invariant 1: status is `failed`, NEVER `approved`/`auto_created`.
      expect(item.status).toBe('failed');
      expect(item.status).not.toBe('approved');
      expect(item.status).not.toBe('auto_created');
      expect(item.created_id).toBeNull();
    } finally {
      await api.dispose();
    }
  });

  // ────────────────────────────────────────────────────────────────
  // Case 4: task with missing `title`
  //         -> MalformedItemData -> caught -> log + None -> status=failed.
  //         Pre-patch: KeyError into bare-except -> silent auto_created.
  // ────────────────────────────────────────────────────────────────
  test('@worker @dump hit-list 4: task with missing title -> status=failed (was silently auto_created pre-patch)', async ({
    baseURL,
    password,
  }) => {
    const dumpId = injectDump('task-no-title', [
      {
        type: 'task',
        confidence: 0.95,
        status: 'suggested',
        data: {
          // intentionally NO `title`
          description: `${CANARY_PREFIX}desc`,
        },
      },
    ]);

    const api = await newAuthedApi(baseURL!, password);
    try {
      const r = await api.post(`api/brain-dumps/${dumpId}/approve-item`, {
        headers: { 'Content-Type': 'application/json' },
        data: { item_index: 0, action: 'approve' },
      });
      expect(r.status()).toBe(200);
      const body = await r.json();
      const item = body.processed_items.items[0];

      expect(item.status).toBe('failed');
      expect(item.status).not.toBe('approved');
      expect(item.created_id).toBeNull();
    } finally {
      await api.dispose();
    }
  });

  // ────────────────────────────────────────────────────────────────
  // Case 5: knowledge with missing `title` -> same shape as case 4.
  // ────────────────────────────────────────────────────────────────
  test('@worker @dump @knowledge hit-list 5: knowledge with missing title -> status=failed', async ({
    baseURL,
    password,
  }) => {
    const dumpId = injectDump('knowledge-no-title', [
      {
        type: 'knowledge',
        confidence: 0.95,
        status: 'suggested',
        data: {
          // intentionally NO `title`
          content: `${CANARY_PREFIX}body`,
        },
      },
    ]);

    const api = await newAuthedApi(baseURL!, password);
    try {
      const r = await api.post(`api/brain-dumps/${dumpId}/approve-item`, {
        headers: { 'Content-Type': 'application/json' },
        data: { item_index: 0, action: 'approve' },
      });
      expect(r.status()).toBe(200);
      const body = await r.json();
      const item = body.processed_items.items[0];

      expect(item.status).toBe('failed');
      expect(item.status).not.toBe('approved');
      expect(item.created_id).toBeNull();
    } finally {
      await api.dispose();
    }
  });

  // ────────────────────────────────────────────────────────────────
  // Case 6a: unknown itype via handle_approve_item
  //          -> raises UnknownItemType, caught by approve handler,
  //             returns 500 with class-name-only body.
  //          Pre-patch: silently fell past every elif -> status=approved
  //             with created_id=null.
  // ────────────────────────────────────────────────────────────────
  test('@worker @dump hit-list 6a (approve surface): unknown itype -> 500 with class-name body, item status untouched', async ({
    baseURL,
    password,
  }) => {
    const dumpId = injectDump('unknown-itype-approve', [
      {
        type: 'this_does_not_exist',
        confidence: 0.95,
        status: 'suggested',
        data: { junk: `${CANARY_PREFIX}junk` },
      },
    ]);

    const api = await newAuthedApi(baseURL!, password);
    try {
      const r = await api.post(`api/brain-dumps/${dumpId}/approve-item`, {
        headers: { 'Content-Type': 'application/json' },
        data: { item_index: 0, action: 'approve' },
      });
      // Per Cairn's resolved open question:
      //   500, {"error": "internal error: UnknownItemType"}
      expect(r.status()).toBe(500);
      const body = await r.json();
      expect(body).toEqual({
        error: 'internal error: UnknownItemType',
      });
      // No exception text leak — only the class name.
      expect(JSON.stringify(body)).not.toContain('this_does_not_exist');

      // The item was NOT mutated to status=approved on the failed call.
      // (handle_approve_item bails before the status assignment.)
      const stored = sqliteExec(
        `SELECT json_extract(processed_items, '$.items[0].status') ` +
          `FROM brain_dumps WHERE id=${dumpId};`,
      ).trim();
      expect(stored).not.toBe('approved');
      expect(stored).not.toBe('auto_created');
    } finally {
      await api.dispose();
    }
  });

  // ────────────────────────────────────────────────────────────────
  // Case 6b: unknown itype direct -> _auto_create_item raises, never
  //          silently returns None. Worker surface end-state (retry to
  //          failed after 3 attempts) is covered by the existing
  //          FORCE_FAIL_TEST in background-processing.spec.ts; we just
  //          verify the function-level invariant here.
  // ────────────────────────────────────────────────────────────────
  test('@worker @dump hit-list 6b (worker surface): _auto_create_item raises UnknownItemType (never silent None)', async () => {
    // Drive a Python harness that imports the function and calls it on a
    // fabricated item. Exit code 0 + "RAISED:UnknownItemType" on stdout
    // proves the dispatcher else raises rather than returning None.
    const py = `
import sys
sys.path.insert(0, ${JSON.stringify(APP_DIR)})
import sqlite3
from app.processing import _auto_create_item, UnknownItemType
conn = sqlite3.connect(":memory:")
try:
    item = {
        "type": "this_does_not_exist",
        "confidence": 0.95,
        "data": {"junk": "${CANARY_PREFIX}junk"},
    }
    try:
        result = _auto_create_item(conn, item, 0)
    except UnknownItemType as e:
        print("RAISED:UnknownItemType")
        sys.exit(0)
    # If we got here, the contract is broken: silent None.
    print(f"DID_NOT_RAISE:result={result!r}")
    sys.exit(1)
finally:
    conn.close()
`;
    const out = runPython(py).trim();
    expect(out).toBe('RAISED:UnknownItemType');
  });

  // ────────────────────────────────────────────────────────────────
  // Cross-cutting: a dump with one bad item + one good suggestion
  // shouldn't escape `needs_review` until the good one is also actioned.
  // (Caller-obligation check: `failed` doesn't reopen needs_review, but
  // it doesn't prematurely close it either.)
  // ────────────────────────────────────────────────────────────────
  test('@worker @dump caller obligation: failed item alongside pending suggestion keeps dump in needs_review', async ({
    baseURL,
    password,
  }) => {
    const dumpId = injectDump('mixed-failed-pending', [
      {
        type: 'goal_link',
        confidence: 0.95,
        status: 'suggested',
        data: { goal_id: null },
      },
      {
        type: 'task',
        confidence: 0.6,
        status: 'suggested',
        data: { title: `${CANARY_PREFIX}stay-pending` },
      },
    ]);

    const api = await newAuthedApi(baseURL!, password);
    try {
      // Approve only item 0 (the goal_link with no target -> failed).
      const r = await api.post(`api/brain-dumps/${dumpId}/approve-item`, {
        headers: { 'Content-Type': 'application/json' },
        data: { item_index: 0, action: 'approve' },
      });
      expect(r.status()).toBe(200);
      const body = await r.json();

      expect(body.processed_items.items[0].status).toBe('failed');
      expect(body.processed_items.items[1].status).toBe('suggested');
      // The dump should still be in needs_review because item 1 is pending.
      expect(body.processing_status).toBe('needs_review');
    } finally {
      await api.dispose();
    }
  });
});
