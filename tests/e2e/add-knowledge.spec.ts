import { test, expect } from './fixtures/auth';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';

/**
 * Knowledge view — Add Knowledge form + knowledge_gap prompt CTA flow.
 *
 * Covers the small ship from Vault (handler + route) and Lumen (form + CTA)
 * against contract `app/contracts/create-knowledge.md` (status: accepted).
 *
 * Central invariants verified:
 *   1. POST /api/knowledge exists, validates, returns 201 with the enriched
 *      row shape (matches one element of GET /api/knowledge).
 *   2. Duplicate titles are accepted (deliberate divergence from People — the
 *      contract is explicit about this; verify 201 not 409).
 *   3. The Add Knowledge UI on the Knowledge view works end-to-end
 *      (type title, hit Enter, new card appears at top with focus flash).
 *   4. URL param flow `?addNote=1&tag=X&prefillTitle=Y` lands on the
 *      Knowledge view with the form scrolled-into-view, focused, and
 *      prefilled.
 *   5. The knowledge_gap prompt CTA "Add a note" navigates to that URL
 *      shape with the tag extracted from the prompt body's quoted token.
 *
 * Cleanup: every row created here keys off the canary prefix
 * `probe-knowledge-`. afterAll wipes knowledge_items, knowledge_tags
 * (via FK), and any tags rows created by the test (also canary-prefixed).
 * No prompts rows are seeded — case 8 mocks the GET /api/prompts response
 * to avoid touching the DB for an ephemeral fixture.
 */

const CANARY_PREFIX = 'probe-knowledge-';

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
    `python3 -c "import base64,sys;exec(compile(base64.b64decode('${b64}'),'<probe-knowledge>','exec'))"`,
    { encoding: 'utf8' },
  );
}

const uniqueTitle = (suffix: string) =>
  `${CANARY_PREFIX}${suffix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

const uniqueTag = (suffix: string) =>
  `${CANARY_PREFIX}${suffix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`.toLowerCase();

/**
 * Suite-level cleanup. Drop knowledge_items and knowledge_tags rows whose
 * title starts with the canary prefix, plus any tags created by these
 * tests (also canary-prefixed). Best-effort — swallow failures so a
 * partial pass doesn't mask the real test result.
 */
function cleanupAll(): void {
  if (!sqliteAvailable()) return;
  const py = `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(DB_PATH)}, timeout=10.0)
try:
    ids = [r[0] for r in conn.execute(
        "SELECT id FROM knowledge_items WHERE title LIKE ?",
        (${JSON.stringify(CANARY_PREFIX + '%')},),
    ).fetchall()]
    for kid in ids:
        conn.execute("DELETE FROM knowledge_tags WHERE knowledge_id=?", (kid,))
        conn.execute("DELETE FROM knowledge_items WHERE id=?", (kid,))
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
    // eslint-disable-next-line no-console
    console.warn('[probe-knowledge] cleanup failed:', e);
  }
}

test.afterAll(() => {
  cleanupAll();
});

// ════════════════════════════════════════════════════════════════════
// HTTP contract — POST /api/knowledge
// ════════════════════════════════════════════════════════════════════

test.describe('POST /api/knowledge (HTTP contract)', () => {
  test('contract: 201 + enriched row with default item_type=note and tags=[]', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    const title = uniqueTitle('default');
    const r = await loggedInPage.request.post(`${mountPrefix}api/knowledge`, {
      headers: { 'Content-Type': 'application/json' },
      data: { title },
    });
    expect(r.status()).toBe(201);
    const body = await r.json();
    expect(body).toMatchObject({
      title,
      content: '',
      item_type: 'note',
      source: null,
      tags: [],
    });
    expect(typeof body.id).toBe('number');
    expect(typeof body.created_at).toBe('string');
    expect(typeof body.updated_at).toBe('string');
  });

  test('contract: 201 with content + tags persists both, tags enriched on response', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    const title = uniqueTitle('with-tags');
    const tagA = uniqueTag('taga');
    const tagB = uniqueTag('tagb');
    const r = await loggedInPage.request.post(`${mountPrefix}api/knowledge`, {
      headers: { 'Content-Type': 'application/json' },
      data: {
        title,
        content: 'canary content body',
        tags: [tagA, tagB],
      },
    });
    expect(r.status()).toBe(201);
    const body = await r.json();
    expect(body.title).toBe(title);
    expect(body.content).toBe('canary content body');
    expect(body.item_type).toBe('note');
    expect(Array.isArray(body.tags)).toBe(true);
    const tagNames = body.tags.map((t: { name: string }) => t.name).sort();
    expect(tagNames).toEqual([tagA, tagB].sort());
    for (const t of body.tags) {
      expect(typeof t.id).toBe('number');
    }
  });

  test('contract: 400 on empty title (after strip)', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    const r = await loggedInPage.request.post(`${mountPrefix}api/knowledge`, {
      headers: { 'Content-Type': 'application/json' },
      data: { title: '   ' },
    });
    expect(r.status()).toBe(400);
    expect(await r.json()).toEqual({ error: 'title is required' });
  });

  test('contract: duplicate titles produce two distinct rows (deliberate divergence from People)', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    const title = uniqueTitle('dup');
    const r1 = await loggedInPage.request.post(`${mountPrefix}api/knowledge`, {
      headers: { 'Content-Type': 'application/json' },
      data: { title },
    });
    expect(r1.status()).toBe(201);
    const b1 = await r1.json();

    const r2 = await loggedInPage.request.post(`${mountPrefix}api/knowledge`, {
      headers: { 'Content-Type': 'application/json' },
      data: { title },
    });
    // Contract is explicit: 201, not 409. Future-Atlas: do not add a 409
    // path here expecting parity with /api/people.
    expect(r2.status()).toBe(201);
    const b2 = await r2.json();
    expect(b2.id).not.toBe(b1.id);
    expect(b2.title).toBe(b1.title);
  });

  test('contract: explicit item_type=fact is honored', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    const title = uniqueTitle('fact');
    const r = await loggedInPage.request.post(`${mountPrefix}api/knowledge`, {
      headers: { 'Content-Type': 'application/json' },
      data: { title, item_type: 'fact' },
    });
    expect(r.status()).toBe(201);
    const body = await r.json();
    expect(body.item_type).toBe('fact');
  });
});

// ════════════════════════════════════════════════════════════════════
// UI — Add Knowledge form
// ════════════════════════════════════════════════════════════════════

test.describe('Knowledge view — Add Knowledge UI', () => {
  test('UI: type title + Enter → new card prepended with highlight-flash', async ({
    loggedInPage,
  }) => {
    const title = uniqueTitle('ui-add');

    await loggedInPage.goto('');
    await loggedInPage.locator('[data-view="knowledge"]').first().click();

    const input = loggedInPage.locator('#addKnowledgeTitle');
    await expect(input).toBeVisible();

    await input.fill(title);
    await input.press('Enter');

    // The new card should be the first .knowledge-card and carry the
    // highlight-flash class (applied via rAF after the 201 response).
    const firstCard = loggedInPage.locator('.knowledge-card').first();
    await expect(firstCard).toHaveAttribute(
      'data-knowledge-id',
      /\d+/,
      { timeout: 10_000 },
    );
    await expect(firstCard.locator('.knowledge-title')).toHaveText(title);
    await expect(firstCard).toHaveClass(/highlight-flash/);

    // Form reset, focus returned to title input.
    await expect(input).toHaveValue('');
    await expect(input).toBeFocused();
  });

  test('UI: deep link `?addNote=1&tag=…&prefillTitle=…` prefills + scrolls + focuses form', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    const tag = uniqueTag('seoul');
    const prefillTitle = tag; // mirrors what addNoteFromPrompt sends

    // Navigate straight to the deep link. The home init code reads
    // ?addNote=1 and switches to the Knowledge view; the Knowledge load
    // path then calls applyKnowledgeUrlParams() which prefills+scrolls.
    await loggedInPage.goto(
      `${mountPrefix}?addNote=1&tag=${encodeURIComponent(tag)}&prefillTitle=${encodeURIComponent(prefillTitle)}`,
    );

    // Knowledge view should be active and the form prefilled.
    const knowledgeView = loggedInPage.locator('#view-knowledge');
    await expect(knowledgeView).toBeVisible();

    const titleInput = loggedInPage.locator('#addKnowledgeTitle');
    const tagsInput = loggedInPage.locator('#addKnowledgeTags');

    await expect(titleInput).toHaveValue(prefillTitle);
    await expect(tagsInput).toHaveValue(tag);
    await expect(titleInput).toBeFocused();

    // Add button enabled because title is non-empty.
    await expect(loggedInPage.locator('#addKnowledgeBtn')).toBeEnabled();

    // The query string should have been stripped from the URL so a
    // refresh doesn't re-apply the params.
    await expect.poll(
      () => new URL(loggedInPage.url()).search,
      { timeout: 5_000 },
    ).toBe('');
  });
});

// ════════════════════════════════════════════════════════════════════
// UI — knowledge_gap prompt CTA → Add Knowledge URL
// ════════════════════════════════════════════════════════════════════

test.describe('Knowledge gap prompt CTA → Add Knowledge', () => {
  test('UI: clicking "Add a note" on a knowledge_gap prompt navigates with tag from quoted body token', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    // Mock the prompts API responses so this test is deterministic and
    // doesn't depend on the gap-detector having generated a real
    // knowledge_gap prompt. Cleaner than seeding the prompts table for
    // an ephemeral fixture.
    const fakePromptId = 999_991;
    const tagFromBody = 'language-school';
    const fakePrompt = {
      id: fakePromptId,
      prompt_type: 'knowledge_gap',
      title: 'No notes for "language-school" yet',
      // The contract for extractPromptTag() is "first quoted token".
      // Body deliberately contains a single-quoted token Lumen can extract.
      // Body contains a single double-quoted token. Avoid stray apostrophes
      // (e.g. "You've") because extractPromptTag()'s regex also accepts
      // straight apostrophes as quote chars and would match the wrong span.
      body: `Tag "${tagFromBody}" has no associated knowledge notes yet.`,
      priority: 3,
      status: 'active',
      source_type: null,
      source_id: null,
      trigger_rule: 'no_knowledge_for_tag',
      generated_at: '2026-04-23 10:00:00',
      expires_at: null,
    };

    await loggedInPage.route(`**${mountPrefix}api/prompts`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([fakePrompt]),
      });
    });
    await loggedInPage.route(`**${mountPrefix}api/prompts/count`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 1 }),
      });
    });

    await loggedInPage.goto('');

    // The mocked prompt should render with its CTA.
    const addNoteBtn = loggedInPage.locator(
      `#prompt-${fakePromptId} .prompt-btn-primary`,
      { hasText: 'Add a note' },
    );
    await expect(addNoteBtn).toBeVisible({ timeout: 10_000 });

    await addNoteBtn.click();

    // After click: navigated to Knowledge view with prefilled form. The
    // URL params are read and then stripped, so we assert on the form
    // state — that's the user-observable signal.
    const knowledgeView = loggedInPage.locator('#view-knowledge');
    await expect(knowledgeView).toBeVisible();

    const titleInput = loggedInPage.locator('#addKnowledgeTitle');
    const tagsInput = loggedInPage.locator('#addKnowledgeTags');
    await expect(titleInput).toHaveValue(tagFromBody);
    await expect(tagsInput).toHaveValue(tagFromBody);
    await expect(titleInput).toBeFocused();
  });
});
