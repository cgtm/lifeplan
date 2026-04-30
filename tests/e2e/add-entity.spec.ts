import { test, expect } from './fixtures/auth';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';

/**
 * Add-entity inline-add affordance — combined coverage of the People and
 * Knowledge inline-add forms.
 *
 * Replaces the prior `add-person.spec.ts` + `add-knowledge.spec.ts` per
 * `docs/runbooks/probe-suite-scoping.md` §4 (Cairn-accepted 2026-04-30).
 *
 * People surface (`@people`):
 *   - POST /api/people: 201 / 409 (case-insensitive duplicate) / 400.
 *   - People view: type a name + Enter → new card prepended with focus-flash.
 *   - Re-add same name → 409 toast surfaces "<Name> already exists." and
 *     the existing card gets the focus-flash class re-applied.
 *   - person_mention approval flow (data-layer contract).
 *
 * Knowledge surface (`@knowledge`):
 *   - POST /api/knowledge: 201 / 400 / explicit item_type / duplicate-titles
 *     deliberate divergence from People (201 not 409).
 *   - Knowledge view: type a title + Enter → new card prepended with flash.
 *   - Deep-link `?addNote=1&tag=…&prefillTitle=…` prefills + scrolls + focuses.
 *   - knowledge_gap prompt CTA "Add a note" navigates with tag from quoted body.
 *
 * Privacy: People rows use `ProbeUi…`/`ProbeApi…` prefixes; Knowledge rows
 * key off `probe-knowledge-`. Knowledge cleanup wipes by canary in
 * `afterAll`; People rows are timestamp-suffixed so reruns are idempotent.
 */

// ════════════════════════════════════════════════════════════════════
// Shared helpers
// ════════════════════════════════════════════════════════════════════

const KNOWLEDGE_CANARY = 'probe-knowledge-';

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
    `python3 -c "import base64,sys;exec(compile(base64.b64decode('${b64}'),'<probe-add-entity>','exec'))"`,
    { encoding: 'utf8' },
  );
}

const uniquePersonName = (prefix: string) =>
  `${prefix}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

const uniqueKnowledgeTitle = (suffix: string) =>
  `${KNOWLEDGE_CANARY}${suffix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

const uniqueKnowledgeTag = (suffix: string) =>
  `${KNOWLEDGE_CANARY}${suffix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`.toLowerCase();

/**
 * Suite-level cleanup for knowledge rows. Drops knowledge_items and
 * knowledge_tags rows whose title starts with the canary prefix, plus any
 * tags created by these tests (also canary-prefixed). Best-effort.
 */
function cleanupKnowledge(): void {
  if (!sqliteAvailable()) return;
  const py = `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(DB_PATH)}, timeout=10.0)
try:
    ids = [r[0] for r in conn.execute(
        "SELECT id FROM knowledge_items WHERE title LIKE ?",
        (${JSON.stringify(KNOWLEDGE_CANARY + '%')},),
    ).fetchall()]
    for kid in ids:
        conn.execute("DELETE FROM knowledge_tags WHERE knowledge_id=?", (kid,))
        conn.execute("DELETE FROM knowledge_items WHERE id=?", (kid,))
    conn.execute(
        "DELETE FROM tags WHERE name LIKE ?",
        (${JSON.stringify(KNOWLEDGE_CANARY + '%')},),
    )
    conn.commit()
finally:
    conn.close()
`;
  try {
    runPython(py);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[probe-add-entity] knowledge cleanup failed:', e);
  }
}

test.afterAll(() => {
  cleanupKnowledge();
});

// ════════════════════════════════════════════════════════════════════
// PEOPLE — POST /api/people HTTP contract
// ════════════════════════════════════════════════════════════════════

test.describe('POST /api/people (HTTP contract)', () => {
  test('@smoke @people contract: 201 + enriched row on first create', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    const name = uniquePersonName('ProbeApiNew');
    const r = await loggedInPage.request.post(`${mountPrefix}api/people`, {
      headers: { 'Content-Type': 'application/json' },
      data: { name },
    });
    expect(r.status()).toBe(201);
    const body = await r.json();
    expect(body).toMatchObject({
      name,
      relationship: 'unknown',
      tags: [],
      goals: [],
      tasks: [],
    });
    expect(typeof body.id).toBe('number');
  });

  test('@smoke @people contract: 409 + existing id on case-insensitive duplicate', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    const name = uniquePersonName('ProbeApiDup');
    const r1 = await loggedInPage.request.post(`${mountPrefix}api/people`, {
      headers: { 'Content-Type': 'application/json' },
      data: { name },
    });
    expect(r1.status()).toBe(201);
    const created = await r1.json();

    const r2 = await loggedInPage.request.post(`${mountPrefix}api/people`, {
      headers: { 'Content-Type': 'application/json' },
      data: { name: name.toLowerCase() },
    });
    expect(r2.status()).toBe(409);
    const body = await r2.json();
    expect(body).toEqual({ error: 'person already exists', id: created.id });
  });

  // Parametrised 400-on-blank covers the prior pair (empty + whitespace-only).
  // Per scoping plan §3 — both branches share `name.strip() == ''`.
  test('@smoke @people contract: 400 on empty/whitespace-only name', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    for (const blank of ['', '   ']) {
      const r = await loggedInPage.request.post(`${mountPrefix}api/people`, {
        headers: { 'Content-Type': 'application/json' },
        data: { name: blank },
      });
      expect(r.status(), `name=${JSON.stringify(blank)} should 400`).toBe(400);
      expect(await r.json()).toEqual({ error: 'name is required' });
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// PEOPLE — UI: Add Person inline form
// ════════════════════════════════════════════════════════════════════

test.describe('People view — Add Person UI', () => {
  test('@people UI: type name + Enter → new card appears at top with highlight-flash', async ({
    loggedInPage,
  }) => {
    const name = uniquePersonName('ProbeUiNew');

    await loggedInPage.goto('');
    await loggedInPage.locator('[data-view="people"]').first().click();

    const input = loggedInPage.locator('#addPersonInput');
    await expect(input).toBeVisible();

    await input.fill(name);
    await input.press('Enter');

    const firstCard = loggedInPage.locator('.person-card').first();
    await expect(firstCard).toHaveAttribute('data-person-id', /\d+/, {
      timeout: 10_000,
    });
    await expect(firstCard.locator('.person-name')).toHaveText(name);
    await expect(firstCard).toHaveClass(/highlight-flash/);

    await expect(input).toHaveValue('');
    await expect(input).toBeFocused();
  });

  test('@people UI: re-adding same name surfaces 409 toast and re-flashes existing card', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    const name = uniquePersonName('ProbeUiDup');

    const seed = await loggedInPage.request.post(`${mountPrefix}api/people`, {
      headers: { 'Content-Type': 'application/json' },
      data: { name },
    });
    expect(seed.status()).toBe(201);
    const seedBody = await seed.json();

    await loggedInPage.goto('');
    await loggedInPage.locator('[data-view="people"]').first().click();

    const input = loggedInPage.locator('#addPersonInput');
    await expect(input).toBeVisible();
    await input.fill(name);
    await input.press('Enter');

    await expect(loggedInPage.getByText(`${name} already exists.`)).toBeVisible({
      timeout: 5_000,
    });

    const existing = loggedInPage.locator(
      `.person-card[data-person-id="${seedBody.id}"]`,
    );
    await expect(existing).toHaveClass(/highlight-flash/);

    await expect(input).toHaveValue('');
  });
});

test.describe('person_mention approval (data-layer contract)', () => {
  test('@people contract: approving mention with null person_id creates a new people row', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    const name = uniquePersonName('ProbeMentionApprove');

    const create = await loggedInPage.request.post(`${mountPrefix}api/people`, {
      headers: { 'Content-Type': 'application/json' },
      data: { name, relationship: 'unknown', notes: 'mention context' },
    });
    expect(create.status()).toBe(201);

    const list = await loggedInPage.request.get(`${mountPrefix}api/people`);
    expect(list.status()).toBe(200);
    const people = await list.json();
    expect(people.find((p: { name: string }) => p.name === name)).toBeTruthy();
  });
});

// ════════════════════════════════════════════════════════════════════
// KNOWLEDGE — POST /api/knowledge HTTP contract
// ════════════════════════════════════════════════════════════════════

test.describe('POST /api/knowledge (HTTP contract)', () => {
  test('@smoke @knowledge contract: 201 + enriched row with default item_type=note and tags=[]', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    const title = uniqueKnowledgeTitle('default');
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

  test('@knowledge contract: 201 with content + tags persists both, tags enriched on response', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    const title = uniqueKnowledgeTitle('with-tags');
    const tagA = uniqueKnowledgeTag('taga');
    const tagB = uniqueKnowledgeTag('tagb');
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

  test('@knowledge contract: 400 on empty title (after strip)', async ({
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

  test('@knowledge contract: duplicate titles produce two distinct rows (deliberate divergence from People)', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    const title = uniqueKnowledgeTitle('dup');
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
    expect(r2.status()).toBe(201);
    const b2 = await r2.json();
    expect(b2.id).not.toBe(b1.id);
    expect(b2.title).toBe(b1.title);
  });

  test('@knowledge contract: explicit item_type=fact is honored', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    const title = uniqueKnowledgeTitle('fact');
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
// KNOWLEDGE — UI: Add Knowledge form
// ════════════════════════════════════════════════════════════════════

test.describe('Knowledge view — Add Knowledge UI', () => {
  test('@knowledge UI: type title + Enter → new card prepended with highlight-flash', async ({
    loggedInPage,
  }) => {
    const title = uniqueKnowledgeTitle('ui-add');

    await loggedInPage.goto('');
    await loggedInPage.locator('[data-view="knowledge"]').first().click();

    const input = loggedInPage.locator('#addKnowledgeTitle');
    await expect(input).toBeVisible();

    await input.fill(title);
    await input.press('Enter');

    const firstCard = loggedInPage.locator('.knowledge-card').first();
    await expect(firstCard).toHaveAttribute('data-knowledge-id', /\d+/, {
      timeout: 10_000,
    });
    await expect(firstCard.locator('.knowledge-title')).toHaveText(title);
    await expect(firstCard).toHaveClass(/highlight-flash/);

    await expect(input).toHaveValue('');
    await expect(input).toBeFocused();
  });

  test('@knowledge UI: deep link `?addNote=1&tag=…&prefillTitle=…` prefills + scrolls + focuses form', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    const tag = uniqueKnowledgeTag('seoul');
    const prefillTitle = tag;

    await loggedInPage.goto(
      `${mountPrefix}?addNote=1&tag=${encodeURIComponent(tag)}&prefillTitle=${encodeURIComponent(prefillTitle)}`,
    );

    const knowledgeView = loggedInPage.locator('#view-knowledge');
    await expect(knowledgeView).toBeVisible();

    const titleInput = loggedInPage.locator('#addKnowledgeTitle');
    const tagsInput = loggedInPage.locator('#addKnowledgeTags');

    await expect(titleInput).toHaveValue(prefillTitle);
    await expect(tagsInput).toHaveValue(tag);
    await expect(titleInput).toBeFocused();

    await expect(loggedInPage.locator('#addKnowledgeBtn')).toBeEnabled();

    await expect
      .poll(() => new URL(loggedInPage.url()).search, { timeout: 5_000 })
      .toBe('');
  });
});

// ════════════════════════════════════════════════════════════════════
// KNOWLEDGE — UI: knowledge_gap prompt CTA → Add Knowledge URL
// ════════════════════════════════════════════════════════════════════

test.describe('Knowledge gap prompt CTA → Add Knowledge', () => {
  test('@knowledge UI: clicking "Add a note" on a knowledge_gap prompt navigates with tag from quoted body token', async ({
    loggedInPage,
    mountPrefix,
  }) => {
    const fakePromptId = 999_991;
    const tagFromBody = 'language-school';
    const fakePrompt = {
      id: fakePromptId,
      prompt_type: 'knowledge_gap',
      title: 'No notes for "language-school" yet',
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

    const addNoteBtn = loggedInPage.locator(
      `#prompt-${fakePromptId} .prompt-btn-primary`,
      { hasText: 'Add a note' },
    );
    await expect(addNoteBtn).toBeVisible({ timeout: 10_000 });

    await addNoteBtn.click();

    const knowledgeView = loggedInPage.locator('#view-knowledge');
    await expect(knowledgeView).toBeVisible();

    const titleInput = loggedInPage.locator('#addKnowledgeTitle');
    const tagsInput = loggedInPage.locator('#addKnowledgeTags');
    await expect(titleInput).toHaveValue(tagFromBody);
    await expect(tagsInput).toHaveValue(tagFromBody);
    await expect(titleInput).toBeFocused();
  });
});
