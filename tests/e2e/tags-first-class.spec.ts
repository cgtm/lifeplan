import { test, expect } from './fixtures/auth';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';

/**
 * Tags as a first-class surface — Probe ship-verifier suite for Iris's
 * top-three #2.
 *
 * Contract:    app/contracts/tags.md (Vault server, Lumen client).
 * Reed review: docs/architecture/tag-merge-review.md (merge SQL semantics).
 * Iris design: docs/ux-design/2026-04-26-tags-first-class.md.
 *
 * Central invariants under test:
 *   1. Every tag chip across the app (any data-tag-id button.tag-chip)
 *      opens the tag drawer when clicked.
 *   2. POST /api/tags returns 201 on a fresh name, 200 on a case-insensitive
 *      duplicate (returning the existing row, NOT a 409).
 *   3. PUT /api/tags/<id> returns 200 on rename, 409 on collision with
 *      {error, id}.
 *   4. POST /api/tags/<id>/merge re-points all six junction tables, deletes
 *      the source tag, returns the target row, with no duplicate junction
 *      rows when source and target both attach to the same entity.
 *   5. DELETE /api/tags/<id> cascades to all six junctions, returns 204.
 *   6. GET /api/tags/<id>/usages returns the cross-content payload with
 *      every section keyed (sections may be empty arrays).
 *   7. GET /api/tags includes usage_count + breakdown per row.
 *   8. Drawer items navigate to entity detail surfaces and the drawer
 *      remains open underneath so closing the entity returns Cam to the
 *      drawer (lateral-navigation invariant).
 *
 * Approach: direct sqlite injection for tag rows + cleanup by canary
 * prefix `probe-tags-`. Entity seeds (goals/tasks/knowledge/people) go
 * through the create APIs so the helper paths (set_tags_for) light up.
 *
 * Privacy: every string written to the DB is canary-prefixed.
 *
 * Cleanup nukes (in safe order): all six junction tables for any tag
 * with the canary prefix, then those tags, then any seeded canary
 * entities (goals, tasks, knowledge_items, people).
 */

const CANARY_PREFIX = 'probe-tags-';

const DB_PATH =
  process.env.LIFEPLAN_DB_PATH ||
  '/Users/cam/dev/personal/lifeplan/data/lifeplan.db';

function runPython(source: string): string {
  const b64 = Buffer.from(source, 'utf8').toString('base64');
  return execSync(
    `python3 -c "import base64,sys;exec(compile(base64.b64decode('${b64}'),'<probe-tags>','exec'))"`,
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

const uniqueTagName = (suffix: string): string =>
  `${CANARY_PREFIX}${suffix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`
    .toLowerCase();

const uniqueEntityTitle = (suffix: string): string =>
  `${CANARY_PREFIX}${suffix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

/**
 * Insert a tag row directly. Used when we want a pre-existing tag without
 * paying the round-trip cost of POST /api/tags. Returns the row id.
 *
 * The name is stored lowercase to match the canonical storage form.
 */
function injectTag(name: string): number {
  const stored = name.trim().toLowerCase();
  const py = `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(DB_PATH)}, timeout=10.0)
try:
    cur = conn.execute("INSERT INTO tags (name) VALUES (?)", (${JSON.stringify(stored)},))
    conn.commit()
    print(cur.lastrowid)
finally:
    conn.close()
`;
  return parseInt(runPython(py).trim(), 10);
}

/**
 * Insert a junction row directly (entity already exists).
 */
function injectJunction(table: string, fkColumn: string, fkValue: number, tagId: number): void {
  const py = `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(DB_PATH)}, timeout=10.0)
try:
    conn.execute("INSERT OR IGNORE INTO ${table} (${fkColumn}, tag_id) VALUES (?, ?)", (${fkValue}, ${tagId}))
    conn.commit()
finally:
    conn.close()
`;
  runPython(py);
}

function junctionRowCount(table: string, tagId: number): number {
  const py = `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(DB_PATH)}, timeout=10.0)
try:
    n = conn.execute("SELECT COUNT(*) FROM ${table} WHERE tag_id=?", (${tagId},)).fetchone()[0]
    print(n)
finally:
    conn.close()
`;
  return parseInt(runPython(py).trim(), 10);
}

function tagExists(tagId: number): boolean {
  const py = `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(DB_PATH)}, timeout=10.0)
try:
    r = conn.execute("SELECT 1 FROM tags WHERE id=?", (${tagId},)).fetchone()
    print('1' if r else '0')
finally:
    conn.close()
`;
  return runPython(py).trim() === '1';
}

/**
 * Suite-wide cleanup. Order:
 *   1. Junctions referencing any canary tag (defensive — CASCADE handles it,
 *      but explicit is harmless and survives migration drift).
 *   2. Canary tags themselves.
 *   3. Canary entity rows (goals/tasks/knowledge_items/people) — entity-side
 *      CASCADE drops their junction rows.
 */
function cleanupAll(): void {
  if (!sqliteAvailable()) return;
  const py = `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(DB_PATH)}, timeout=10.0)
try:
    canary = ${JSON.stringify(CANARY_PREFIX + '%')}
    tag_ids = [r[0] for r in conn.execute("SELECT id FROM tags WHERE name LIKE ?", (canary,)).fetchall()]
    for tid in tag_ids:
        for tbl in ("goal_tags", "task_tags", "person_tags", "knowledge_tags", "entry_tags", "brain_dump_tags"):
            conn.execute(f"DELETE FROM {tbl} WHERE tag_id=?", (tid,))
    conn.execute("DELETE FROM tags WHERE name LIKE ?", (canary,))
    # Canary-titled entities (CASCADE will sweep any straggler junctions).
    conn.execute("DELETE FROM tasks WHERE title LIKE ?", (canary,))
    conn.execute("DELETE FROM knowledge_items WHERE title LIKE ?", (canary,))
    conn.execute("DELETE FROM goals WHERE title LIKE ?", (canary,))
    conn.execute("DELETE FROM people WHERE name LIKE ?", (canary,))
    conn.commit()
finally:
    conn.close()
`;
  try {
    runPython(py);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[probe-tags] cleanup failed:', e);
  }
}

test.beforeAll(() => {
  cleanupAll();
});

test.afterAll(() => {
  cleanupAll();
});

// ════════════════════════════════════════════════════════════════════
// HTTP — POST /api/tags  (create vs. focus-on-duplicate)
// ════════════════════════════════════════════════════════════════════

test.describe('POST /api/tags', () => {
  test('contract: 201 on a fresh name; 200 on a case-insensitive duplicate with the existing row', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    const base = uniqueTagName('dup');
    // 1) fresh create → 201
    const r1 = await loggedInPage.request.post(`${mountPrefix}api/tags`, {
      headers: { 'Content-Type': 'application/json' },
      data: { name: base },
    });
    expect(r1.status()).toBe(201);
    const b1 = await r1.json();
    expect(typeof b1.id).toBe('number');
    expect(b1.name).toBe(base.toLowerCase());

    // 2) same case-different (UPPERCASE) → 200 with the same id (NOT 409).
    //    This is the deliberate divergence from the dispatch brief — Iris's
    //    UX intent ("Cam typed it because he wanted to find it") signed off
    //    by Reed.
    const r2 = await loggedInPage.request.post(`${mountPrefix}api/tags`, {
      headers: { 'Content-Type': 'application/json' },
      data: { name: base.toUpperCase() },
    });
    expect(r2.status()).toBe(200);
    const b2 = await r2.json();
    expect(b2.id).toBe(b1.id);
    expect(b2.name).toBe(b1.name);
  });
});

// ════════════════════════════════════════════════════════════════════
// HTTP — PUT /api/tags/<id>  (rename vs. collision)
// ════════════════════════════════════════════════════════════════════

test.describe('PUT /api/tags/<id>', () => {
  test('contract: 200 on rename to a free name; 409 with {error, id} on collision with another tag', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    const a = uniqueTagName('rename-a');
    const b = uniqueTagName('rename-b');
    const idA = injectTag(a);
    const idB = injectTag(b);

    // Rename A to a brand-new free name → 200.
    const fresh = uniqueTagName('rename-fresh');
    const ok = await loggedInPage.request.put(`${mountPrefix}api/tags/${idA}`, {
      headers: { 'Content-Type': 'application/json' },
      data: { name: fresh },
    });
    expect(ok.status()).toBe(200);
    const okBody = await ok.json();
    expect(okBody).toEqual({ id: idA, name: fresh });

    // Now try to rename A (currently `fresh`) to B's name → 409 + B's id.
    const clash = await loggedInPage.request.put(`${mountPrefix}api/tags/${idA}`, {
      headers: { 'Content-Type': 'application/json' },
      data: { name: b },
    });
    expect(clash.status()).toBe(409);
    const clashBody = await clash.json();
    expect(clashBody).toEqual({ error: 'name already in use', id: idB });
  });
});

// ════════════════════════════════════════════════════════════════════
// HTTP — POST /api/tags/<id>/merge
// ════════════════════════════════════════════════════════════════════

test.describe('POST /api/tags/<id>/merge', () => {
  test('contract: merge re-points junctions, drops source, dedups overlap (no duplicate junction row)', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    // Seed: source + target tag.
    const source = uniqueTagName('merge-src');
    const target = uniqueTagName('merge-tgt');
    const sourceId = injectTag(source);
    const targetId = injectTag(target);

    // Seed a goal that already has BOTH tags attached. The "overlap" case
    // is the load-bearing one: after merge, goal should have target ONCE,
    // not twice. We attach via the create API so the junction goes through
    // set_tags_for (the canonical write path).
    const goalTitle = uniqueEntityTitle('merge-goal');
    const goalRes = await loggedInPage.request.post(`${mountPrefix}api/goals`, {
      headers: { 'Content-Type': 'application/json' },
      data: { title: goalTitle, tags: [source, target] },
    });
    expect(goalRes.status()).toBe(201);
    const goal = await goalRes.json();

    // Sanity: both junction rows present pre-merge.
    expect(junctionRowCount('goal_tags', sourceId)).toBe(1);
    expect(junctionRowCount('goal_tags', targetId)).toBe(1);

    // Merge source → target.
    const merge = await loggedInPage.request.post(
      `${mountPrefix}api/tags/${sourceId}/merge`,
      {
        headers: { 'Content-Type': 'application/json' },
        data: { target_id: targetId },
      },
    );
    expect(merge.status()).toBe(200);
    const mergeBody = await merge.json();
    expect(mergeBody.ok).toBe(true);
    expect(mergeBody.target).toEqual({ id: targetId, name: target });

    // Source is gone.
    expect(tagExists(sourceId)).toBe(false);
    // Target's goal_tags row count is exactly 1 — INSERT OR IGNORE absorbed
    // the duplicate, the DELETE wiped the source row. The goal is tagged
    // once with the survivor.
    expect(junctionRowCount('goal_tags', targetId)).toBe(1);
    expect(junctionRowCount('goal_tags', sourceId)).toBe(0);

    // The goal's tag list now contains target only.
    const after = await loggedInPage.request.get(`${mountPrefix}api/goals/${goal.id}`);
    expect(after.status()).toBe(200);
    const goalAfter = await after.json();
    const names = (goalAfter.tags || []).map((t: { name: string }) => t.name);
    expect(names).toEqual([target]);
  });
});

// ════════════════════════════════════════════════════════════════════
// HTTP — DELETE /api/tags/<id>  (cascade across all six junctions)
// ════════════════════════════════════════════════════════════════════

test.describe('DELETE /api/tags/<id>', () => {
  test('contract: 204 + cascades to junction rows in three different tables', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    test.skip(!sqliteAvailable(), 'sqlite3 not available; cannot verify cascade');

    const tagName = uniqueTagName('del');
    const tagId = injectTag(tagName);

    // Seed three different entities, attach our tag to each via set_tags_for.
    const goalRes = await loggedInPage.request.post(`${mountPrefix}api/goals`, {
      headers: { 'Content-Type': 'application/json' },
      data: { title: uniqueEntityTitle('del-goal'), tags: [tagName] },
    });
    expect(goalRes.status()).toBe(201);

    const knowledgeRes = await loggedInPage.request.post(
      `${mountPrefix}api/knowledge`,
      {
        headers: { 'Content-Type': 'application/json' },
        data: { title: uniqueEntityTitle('del-know'), tags: [tagName] },
      },
    );
    expect(knowledgeRes.status()).toBe(201);

    const personRes = await loggedInPage.request.post(`${mountPrefix}api/people`, {
      headers: { 'Content-Type': 'application/json' },
      data: { name: uniqueEntityTitle('del-person'), tags: [tagName] },
    });
    expect(personRes.status()).toBe(201);

    // Three junction rows pre-delete (one per entity type).
    expect(junctionRowCount('goal_tags', tagId)).toBe(1);
    expect(junctionRowCount('knowledge_tags', tagId)).toBe(1);
    expect(junctionRowCount('person_tags', tagId)).toBe(1);

    // DELETE → 204, no body.
    //
    // DELETE is exempt from the JSON content-type gate (see
    // cookie-auth.md "All other routes" + server.py do_DELETE). The
    // header here is harmless — the gate would accept it either way —
    // but it isn't required. The bare-fetch UI path is exercised by
    // the "Tag delete flow — Probe-found gap" suite below.
    const del = await loggedInPage.request.delete(`${mountPrefix}api/tags/${tagId}`, {
      headers: { 'Content-Type': 'application/json' },
    });
    expect(del.status()).toBe(204);
    expect(await del.text()).toBe('');

    // Tag row gone, every junction wiped via ON DELETE CASCADE.
    expect(tagExists(tagId)).toBe(false);
    for (const tbl of [
      'goal_tags',
      'task_tags',
      'person_tags',
      'knowledge_tags',
      'entry_tags',
      'brain_dump_tags',
    ]) {
      expect(junctionRowCount(tbl, tagId)).toBe(0);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// HTTP — GET /api/tags  (usage_count + breakdown extension)
// ════════════════════════════════════════════════════════════════════

test.describe('GET /api/tags', () => {
  test('contract: each row carries usage_count + breakdown across the six junctions', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    const tagName = uniqueTagName('listed');
    const tagId = injectTag(tagName);

    // Attach to a goal and a knowledge item so the breakdown has real numbers.
    const goalRes = await loggedInPage.request.post(`${mountPrefix}api/goals`, {
      headers: { 'Content-Type': 'application/json' },
      data: { title: uniqueEntityTitle('listed-goal'), tags: [tagName] },
    });
    expect(goalRes.status()).toBe(201);
    const knowledgeRes = await loggedInPage.request.post(
      `${mountPrefix}api/knowledge`,
      {
        headers: { 'Content-Type': 'application/json' },
        data: { title: uniqueEntityTitle('listed-know'), tags: [tagName] },
      },
    );
    expect(knowledgeRes.status()).toBe(201);

    const list = await loggedInPage.request.get(`${mountPrefix}api/tags`);
    expect(list.status()).toBe(200);
    const rows = await list.json();
    expect(Array.isArray(rows)).toBe(true);

    const row = rows.find((r: { id: number }) => r.id === tagId);
    expect(row, 'seeded tag should appear in /api/tags').toBeTruthy();
    expect(row.name).toBe(tagName);
    expect(row.usage_count).toBe(2);
    // Legacy alias preserved per contract for the journal filter consumer.
    expect(row.total_count).toBe(2);
    expect(row.breakdown).toEqual({
      goals: 1,
      tasks: 0,
      people: 0,
      knowledge: 1,
      journal_entries: 0,
      brain_dumps: 0,
    });
  });
});

// ════════════════════════════════════════════════════════════════════
// HTTP — GET /api/tags/<id>/usages  (drawer payload)
// ════════════════════════════════════════════════════════════════════

test.describe('GET /api/tags/<id>/usages', () => {
  test('contract: payload has tag + usages with all six sections keyed', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    const tagName = uniqueTagName('usages');
    const tagId = injectTag(tagName);

    // Attach to a goal so at least one section is non-empty.
    const goalRes = await loggedInPage.request.post(`${mountPrefix}api/goals`, {
      headers: { 'Content-Type': 'application/json' },
      data: { title: uniqueEntityTitle('usages-goal'), tags: [tagName] },
    });
    expect(goalRes.status()).toBe(201);
    const goal = await goalRes.json();

    const r = await loggedInPage.request.get(`${mountPrefix}api/tags/${tagId}/usages`);
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.tag).toEqual({ id: tagId, name: tagName });
    expect(body.usages).toBeTruthy();
    // All six section keys present (empty arrays count).
    for (const key of [
      'goals',
      'tasks',
      'people',
      'knowledge',
      'journal_entries',
      'brain_dumps',
    ]) {
      expect(Array.isArray(body.usages[key])).toBe(true);
    }
    // The seeded goal shows up.
    const goalIds = body.usages.goals.map((g: { id: number }) => g.id);
    expect(goalIds).toContain(goal.id);
  });
});

// ════════════════════════════════════════════════════════════════════
// UI — chip click anywhere → drawer opens with that tag
// ════════════════════════════════════════════════════════════════════

test.describe('Chip click → drawer (cross-app)', () => {
  test('UI: clicking a tag chip on a goal card opens the drawer for that tag', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    const tagName = uniqueTagName('chip');
    // Seed goal with this tag via the API so the goals view will render
    // a chip for it.
    const goalTitle = uniqueEntityTitle('chip-goal');
    const goalRes = await loggedInPage.request.post(`${mountPrefix}api/goals`, {
      headers: { 'Content-Type': 'application/json' },
      data: { title: goalTitle, tags: [tagName] },
    });
    expect(goalRes.status()).toBe(201);
    const goal = await goalRes.json();
    const tagId: number = goal.tags[0].id;

    await loggedInPage.goto('');
    // Switch to goals view — the chip renders on goal cards there.
    await loggedInPage.locator('[data-view="goals"]').first().click();
    await expect(loggedInPage.locator('#view-goals')).toBeVisible();

    // Find the chip whose data-tag-id matches our seeded tag, scoped to
    // the goals view (the same tag may render elsewhere).
    const chip = loggedInPage.locator(
      `#view-goals button.tag-chip[data-tag-id="${tagId}"]`,
    ).first();
    await expect(chip).toBeVisible({ timeout: 10_000 });
    await chip.click();

    // Drawer opens with this tag.
    const drawer = loggedInPage.locator('#tagDrawerOverlay');
    await expect(drawer).toBeVisible();
    await expect(loggedInPage.locator('#tagDrawerName')).toHaveText(tagName);
  });
});

// ════════════════════════════════════════════════════════════════════
// UI — drawer item navigates to entity detail; drawer survives close
// ════════════════════════════════════════════════════════════════════

test.describe('Drawer → entity → back to drawer', () => {
  test('UI: clicking a drawer item opens the entity, closing it leaves the drawer open', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    const tagName = uniqueTagName('lateral');
    const goalTitle = uniqueEntityTitle('lateral-goal');
    const goalRes = await loggedInPage.request.post(`${mountPrefix}api/goals`, {
      headers: { 'Content-Type': 'application/json' },
      data: { title: goalTitle, tags: [tagName] },
    });
    expect(goalRes.status()).toBe(201);
    const goal = await goalRes.json();
    const tagId: number = goal.tags[0].id;

    await loggedInPage.goto('');
    // Open the Tags view and click the row to open the drawer
    // deterministically (not via a chip — that's covered above).
    await loggedInPage.locator('[data-view="tags"]').first().click();
    await expect(loggedInPage.locator('#view-tags')).toBeVisible();

    const tagRow = loggedInPage.locator(
      `.tag-row[data-tag-id="${tagId}"]`,
    );
    await expect(tagRow).toBeVisible({ timeout: 10_000 });
    await tagRow.click();

    const drawer = loggedInPage.locator('#tagDrawerOverlay');
    await expect(drawer).toBeVisible();
    await expect(loggedInPage.locator('#tagDrawerName')).toHaveText(tagName);

    // Drawer item for our seeded goal.
    const drawerGoalItem = loggedInPage.locator(
      `#tagDrawerBody .tag-drawer-item[data-kind="goals"][data-id="${goal.id}"]`,
    );
    await expect(drawerGoalItem).toBeVisible();
    await drawerGoalItem.click();

    // Goal detail modal opens — assert by its overlay being visible.
    const goalDetail = loggedInPage.locator('#goalDetailOverlay');
    await expect(goalDetail).toBeVisible({ timeout: 5_000 });

    // Drawer is still in the DOM and still showing the same tag name —
    // it sits under the entity modal so closing the entity returns Cam
    // to the drawer (the lateral-navigation invariant).
    await expect(drawer).toBeVisible();
    await expect(loggedInPage.locator('#tagDrawerName')).toHaveText(tagName);

    // Close the goal detail modal; drawer remains open.
    await loggedInPage.locator('#goalDetailOverlay .modal-close').first().click();
    await expect(goalDetail).toBeHidden();
    await expect(drawer).toBeVisible();
    await expect(loggedInPage.locator('#tagDrawerName')).toHaveText(tagName);
  });
});

// ════════════════════════════════════════════════════════════════════
// UI — inline add on /tags view: 201 path renders new row
// UI — inline add on /tags view: 200 path scrolls + pulse-flashes existing
// ════════════════════════════════════════════════════════════════════

test.describe('Tags view — inline add', () => {
  test('UI: adding a fresh name appends a new row (201 path)', async ({
    loggedInPage,
  }) => {
    const tagName = uniqueTagName('inline-fresh');

    await loggedInPage.goto('');
    await loggedInPage.locator('[data-view="tags"]').first().click();
    await expect(loggedInPage.locator('#view-tags')).toBeVisible();

    const input = loggedInPage.locator('#addTagInput');
    await expect(input).toBeVisible();
    await input.fill(tagName);
    await loggedInPage.locator('#addTagBtn').click();

    const row = loggedInPage.locator(`.tag-row[data-tag-name="${tagName}"]`);
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row).toHaveClass(/highlight-flash/);
    // Input cleared.
    await expect(input).toHaveValue('');
  });

  test('UI: adding an existing name focuses the existing row with highlight-flash (200 path)', async ({
    loggedInPage,
  }) => {
    // Seed an existing tag directly.
    const tagName = uniqueTagName('inline-dup');
    const tagId = injectTag(tagName);

    await loggedInPage.goto('');
    await loggedInPage.locator('[data-view="tags"]').first().click();
    await expect(loggedInPage.locator('#view-tags')).toBeVisible();

    // Confirm the row is present from the initial GET.
    const row = loggedInPage.locator(`.tag-row[data-tag-id="${tagId}"]`);
    await expect(row).toBeVisible({ timeout: 10_000 });

    const input = loggedInPage.locator('#addTagInput');
    // Submit it again — server will return 200 with the existing row.
    await input.fill(tagName.toUpperCase()); // also covers case-insensitive
    await loggedInPage.locator('#addTagBtn').click();

    // The existing row gets the pulse-flash class, not a new row.
    await expect(row).toHaveClass(/highlight-flash/, { timeout: 5_000 });
    await expect(input).toHaveValue('');

    // Ensure no new row was created — only ours, by data-tag-name.
    const matching = loggedInPage.locator(`.tag-row[data-tag-name="${tagName}"]`);
    await expect(matching).toHaveCount(1);
  });
});

// ════════════════════════════════════════════════════════════════════
// UI — DELETE flow: bare-fetch DELETE survives the JSON content-type gate
// ════════════════════════════════════════════════════════════════════
//
// Probe-found behaviour gap, fixed by Vault (server-side):
//
//   - Contract `app/contracts/tags.md` for `DELETE /api/tags/<id>` says
//     "Request body: none."
//   - Previously, `app/server.py` `do_DELETE` ran `_enforce_content_type()`
//     which rejected any request whose `Content-Type` was not
//     `application/json` with a 415.
//   - UI `app/app.js` calls `fetch(url, { method: 'DELETE' })` with
//     NO `Content-Type` header. fetch() does not set one for empty-body
//     requests by default — and shouldn't have to.
//   - Fix: DELETE is now exempt from the content-type gate. HTML forms
//     can only issue GET/POST, so DELETE has no form-post CSRF surface
//     for the gate to defend. POST/PUT keep the gate.
//
// This test drives the actual UI confirm-delete click and asserts the
// fixed success path: bare-fetch DELETE with no Content-Type header
// returns 204, the tag is removed from the DB, and junction rows
// cascade.

test.describe('Tag delete flow — Probe-found gap', () => {
  test('UI: clicking Delete in the confirm dialog returns 204 and removes the tag (bare-fetch DELETE survives the content-type gate)', async ({
    loggedInPage,
  }) => {
    // Seed an unused canary tag so we can target it in the UI.
    const tagName = uniqueTagName('del-ui');
    const tagId = injectTag(tagName);

    await loggedInPage.goto('');
    await loggedInPage.locator('[data-view="tags"]').first().click();
    await expect(loggedInPage.locator('#view-tags')).toBeVisible();

    const row = loggedInPage.locator(`.tag-row[data-tag-id="${tagId}"]`);
    await expect(row).toBeVisible({ timeout: 10_000 });

    // Open kebab → Delete.
    await row.locator('.card-actions-btn').click();
    await row.locator('.action-delete').click();

    const deleteOverlay = loggedInPage.locator('#tagDeleteOverlay');
    await expect(deleteOverlay).toBeVisible();

    // Capture the DELETE request to verify the bare-fetch shape.
    const [req, resp] = await Promise.all([
      loggedInPage.waitForRequest(
        (r) => r.method() === 'DELETE' && r.url().includes(`/api/tags/${tagId}`),
        { timeout: 5_000 },
      ),
      loggedInPage.waitForResponse(
        (r) => r.request().method() === 'DELETE' && r.url().includes(`/api/tags/${tagId}`),
        { timeout: 5_000 },
      ),
      loggedInPage.locator('#tagDeleteConfirm').click(),
    ]);

    // The UI sends DELETE without a `Content-Type` header — that's the
    // intended shape (fetch() preserves content-type only when a body is
    // present, and the contract says "Request body: none").
    expect(req.headers()['content-type']).toBeFalsy();
    // Server returns 204 because DELETE is exempt from the content-type gate.
    expect(resp.status()).toBe(204);

    // User-observable success: the tag row is gone from the DB, and every
    // junction it could have been attached to is empty (cascade fired).
    expect(tagExists(tagId)).toBe(false);
    for (const tbl of [
      'goal_tags',
      'task_tags',
      'person_tags',
      'knowledge_tags',
      'entry_tags',
      'brain_dump_tags',
    ]) {
      expect(junctionRowCount(tbl, tagId)).toBe(0);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// UI — rename collision: 409 inline error → "Merge instead?" pivot
// ════════════════════════════════════════════════════════════════════

test.describe('Rename collision → Merge pivot', () => {
  test('UI: renaming A to B collides → inline error → clicking "Merge instead?" opens merge dialog pre-targeting B', async ({
    loggedInPage,
  }) => {
    const a = uniqueTagName('collide-a');
    const b = uniqueTagName('collide-b');
    const idA = injectTag(a);
    injectTag(b);

    await loggedInPage.goto('');
    await loggedInPage.locator('[data-view="tags"]').first().click();
    await expect(loggedInPage.locator('#view-tags')).toBeVisible();

    // Open A's drawer via row click, then trigger rename from the drawer.
    const rowA = loggedInPage.locator(`.tag-row[data-tag-id="${idA}"]`);
    await expect(rowA).toBeVisible({ timeout: 10_000 });
    await rowA.click();

    const drawer = loggedInPage.locator('#tagDrawerOverlay');
    await expect(drawer).toBeVisible();
    await loggedInPage.locator('#tagDrawerRename').click();

    // Rename modal appears with A's name pre-filled.
    const renameOverlay = loggedInPage.locator('#tagRenameOverlay');
    await expect(renameOverlay).toBeVisible();
    const renameInput = loggedInPage.locator('#tagRenameInput');
    await renameInput.fill(b);
    await loggedInPage.locator('#tagRenameSave').click();

    // Inline error with the "Merge instead?" pivot button.
    const offerMerge = loggedInPage.locator('#tagRenameOfferMerge');
    await expect(offerMerge).toBeVisible({ timeout: 5_000 });
    await expect(offerMerge).toHaveText(/merge instead\?/i);

    await offerMerge.click();

    // Rename overlay closes; merge overlay opens with B preselected.
    await expect(renameOverlay).toBeHidden();
    const mergeOverlay = loggedInPage.locator('#tagMergeOverlay');
    await expect(mergeOverlay).toBeVisible();
    // Source label shows A; target list has B selected.
    await expect(loggedInPage.locator('#tagMergeSourceLabel')).toContainText(a);
    const selected = loggedInPage.locator('#tagMergeTargetList .tag-merge-list-item.selected');
    await expect(selected).toContainText(b);
    // Merge button enabled because target preselected.
    await expect(loggedInPage.locator('#tagMergeConfirm')).toBeEnabled();
  });
});
