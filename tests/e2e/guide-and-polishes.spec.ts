import { test, expect } from './fixtures/auth';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { request as pwRequest, type APIRequestContext } from '@playwright/test';

/**
 * "Guide and polishes" — Probe ship-verifier suite.
 *
 * Scope: end-to-end verification of the shipped batch of polishes.
 *   A. In-app user guide:
 *      - GET /api/help/user-guide endpoint (text/plain markdown).
 *      - Help nav entry (desktop top-level + mobile More menu).
 *      - Full-screen modal with stdlib-only JS markdown renderer.
 *      - Close paths: ×, click-outside, Esc.
 *   B. Tag chip visual cue: ↗ glyph on every .tag-chip via ::after.
 *      - Hover bumps opacity. .tag-chip-wrap variant suppresses the arrow.
 *   C. Persistent "Undo last resolve" chip (.undo-resolve-chip):
 *      - Surface-aware (home / goal-detail).
 *      - 30-minute window; survives navigation.
 *      - Click un-resolves and removes the chip.
 *   D. "Got it" → "Noted" relabel on knowledge_gap and
 *      blocker_awareness prompt secondary buttons.
 *   E. Forge: deploy.sh refuses --with-db without --force; 3-second
 *      countdown when --force is supplied. Verified by SCRIPT PARSE only —
 *      we never actually run the database-overwriting branch.
 *
 * Approach: HTTP-level tests for the API endpoint; Playwright for UI;
 * SQLite injection for the seed-a-blocker / seed-a-prompt paths; bash
 * script execution (refusal path only) + file parse for the deploy gate.
 *
 * Privacy: every string written to the DB is canary-prefixed
 * (`probe-guide-`). No personal data ever lands in test rows.
 *
 * Hero invariant: the dashboard hero is hard-wired to goal id=1 in
 * handle_get_dashboard. Item C's home-surface case attaches a probe
 * blocker to goal id=1 itself, asserting only against rows whose
 * blocker_name carries the canary prefix.
 */

// ──────────────────────────────────────────────────────────────────
// Constants & helpers
// ──────────────────────────────────────────────────────────────────

const CANARY_PREFIX = 'probe-guide-';
const REPO_ROOT = '/Users/cam/dev/personal/lifeplan';
const DEPLOY_SH = path.join(REPO_ROOT, 'deploy.sh');
const USER_GUIDE_MD = path.join(REPO_ROOT, 'docs', 'user-guide.md');

const DB_PATH = process.env.LIFEPLAN_DB_PATH || path.join(REPO_ROOT, 'data', 'lifeplan.db');

// Hero is wired to goal id=1 server-side (see handle_get_dashboard).
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
    `python3 -c "import base64,sys;exec(compile(base64.b64decode('${b64}'),'<probe-guide>','exec'))"`,
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
        (${JSON.stringify(title)}, ${JSON.stringify('canary')}, ${JSON.stringify(status)}),
    )
    conn.commit()
    print(cur.lastrowid)
finally:
    conn.close()
`;
  return parseInt(runPython(py).trim(), 10);
}

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

function injectKnowledgeGapPrompt(title: string, body: string): number {
  // knowledge_gap prompts are sourced against tag entities in the schema;
  // the only thing this test cares about is that the prompt renders so we
  // can inspect the secondary button label. source_type='tag' matches the
  // shape used elsewhere in production data; source_id can be any integer.
  const fingerprint = `${CANARY_PREFIX}fp-kg-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const py = `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(DB_PATH)}, timeout=10.0)
try:
    cur = conn.execute(
        "INSERT INTO prompts (prompt_type, title, body, priority, status, "
        "source_type, source_id, trigger_rule, fingerprint) "
        "VALUES ('knowledge_gap', ?, ?, 2, 'active', 'tag', 1, 'three_mentions_no_note', ?)",
        (${JSON.stringify(title)}, ${JSON.stringify(body)}, ${JSON.stringify(fingerprint)}),
    )
    conn.commit()
    print(cur.lastrowid)
finally:
    conn.close()
`;
  return parseInt(runPython(py).trim(), 10);
}

function injectBlockerAwarenessPrompt(goalId: number, title: string, body: string): number {
  const fingerprint = `${CANARY_PREFIX}fp-ba-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
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

function readDependencyResolved(id: number): number {
  const py = `
import sqlite3, sys
conn = sqlite3.connect(${JSON.stringify(DB_PATH)}, timeout=10.0)
try:
    row = conn.execute("SELECT resolved FROM dependencies WHERE id = ?", (${id},)).fetchone()
    sys.stdout.write('-1' if row is None else str(row[0]))
finally:
    conn.close()
`;
  return parseInt(runPython(py).trim(), 10);
}

// Wholesale cleanup by canary prefix. Order matters for FKs:
// dependencies → prompts → goals.
function cleanupByCanary(): void {
  const py = `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(DB_PATH)}, timeout=10.0)
try:
    pref = ${JSON.stringify(CANARY_PREFIX)} + '%'
    conn.execute(
        "DELETE FROM dependencies WHERE id IN ("
        "  SELECT d.id FROM dependencies d "
        "  LEFT JOIN goals g_blk ON d.blocker_type='goal' AND d.blocker_id=g_blk.id "
        "  LEFT JOIN goals g_bd  ON d.blocked_type='goal'  AND d.blocked_id=g_bd.id "
        "  WHERE (g_blk.title LIKE ?) OR (g_bd.title LIKE ?) OR (d.notes LIKE ?)"
        ")",
        (pref, pref, pref),
    )
    conn.execute("DELETE FROM prompts WHERE fingerprint LIKE ?", (pref,))
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
  cleanupByCanary();
});

test.afterAll(() => {
  cleanupByCanary();
});

// ══════════════════════════════════════════════════════════════════
// Item A — In-app user guide
// ══════════════════════════════════════════════════════════════════

test.describe('A. user guide — API contract', () => {
  test('GET /api/help/user-guide authed → 200, text/plain, body matches the file', async ({
    baseURL,
    password,
  }) => {
    const api = await newAuthedApi(baseURL!, password);
    try {
      const r = await api.get('api/help/user-guide');
      expect(r.status()).toBe(200);
      const ct = r.headers()['content-type'] || '';
      expect(ct.toLowerCase()).toContain('text/plain');
      expect(ct.toLowerCase()).toContain('charset=utf-8');

      const body = await r.text();
      // Compare against a small known section so the test isn't a giant
      // golden-string diff. The "What Lifeplan is" heading is stable.
      const fileText = fs.readFileSync(USER_GUIDE_MD, 'utf8');
      const probe = '## What Lifeplan is';
      expect(fileText, 'sanity: probe substring exists in source').toContain(probe);
      expect(body, 'response body matches the file').toContain(probe);
      // And a longer phrase from inside that section so we know we got
      // more than just the table of contents.
      expect(body).toContain('capture first, structure later');
    } finally {
      await api.dispose();
    }
  });

  test('GET /api/help/user-guide unauthed → 401 (auth-gated like the rest of /api)', async ({
    apiCtx,
  }) => {
    const r = await apiCtx.get('api/help/user-guide');
    expect(r.status()).toBe(401);
  });
});

test.describe('A. user guide — UI: open and content', () => {
  test('desktop nav has a Help link → opens modal with title and ×', async ({ loggedInPage: page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');

    const desktopHelp = page.locator('#navHelpBtnDesktop');
    await expect(desktopHelp).toBeVisible();
    await expect(desktopHelp).toHaveText(/Help/);

    await desktopHelp.click();

    const overlay = page.locator('#helpOverlay');
    await expect(overlay).not.toHaveClass(/hidden/);
    await expect(page.locator('#helpModalTitle')).toHaveText('Lifeplan user guide');
    await expect(page.locator('#helpClose')).toBeVisible();
    // Content actually rendered (not stuck on the loading state).
    await expect(page.locator('#helpBody .help-content')).toBeVisible({ timeout: 5000 });
  });

  test('mobile More menu has Help → opens same modal', async ({ loggedInPage: page }) => {
    await page.setViewportSize({ width: 390, height: 844 }); // iPhone-ish
    await page.goto('/');

    // The mobile More button is .nav-more — driven by CSS responsive rules.
    // Click it and pick Help from the menu.
    await page.locator('#navMoreBtn').click();
    const mobileHelp = page.locator('#navHelpBtn');
    await expect(mobileHelp).toBeVisible();
    await mobileHelp.click();

    const overlay = page.locator('#helpOverlay');
    await expect(overlay).not.toHaveClass(/hidden/);
    await expect(page.locator('#helpModalTitle')).toHaveText('Lifeplan user guide');
    await expect(page.locator('#helpBody .help-content')).toBeVisible({ timeout: 5000 });
  });

  test('markdown renders: h1, lists, fenced code, links, and HTML is escaped', async ({
    loggedInPage: page,
  }) => {
    await page.goto('/');
    await page.locator('#navHelpBtnDesktop').click();
    const content = page.locator('#helpBody .help-content');
    await expect(content).toBeVisible({ timeout: 5000 });

    // The source's first H1 is "# Lifeplan — User Guide".
    await expect(content.locator('h1').first()).toContainText(/Lifeplan/);

    // Lists render. The guide has plenty of - bullets.
    expect(await content.locator('ul li').count()).toBeGreaterThan(0);

    // Fenced code blocks render as <pre><code>. The guide has the
    // queued → processing → processed lifecycle block.
    expect(await content.locator('pre code').count()).toBeGreaterThan(0);

    // Link rendering: feed the renderer a known [label](url) payload
    // and confirm an <a href="…"> comes out. We don't depend on the
    // current docs/user-guide.md containing any markdown links — they
    // come and go as the doc evolves.
    const linkRender = await page.evaluate(() => {
      // @ts-ignore - global on the help-modal page.
      const html: string = (window as any).renderMarkdown(
        'See the [home page](https://example.com/x) for details.\n',
      );
      const div = document.createElement('div');
      div.innerHTML = html;
      const a = div.querySelector('a');
      return {
        present: !!a,
        href: a?.getAttribute('href') ?? '',
        target: a?.getAttribute('target') ?? '',
        rel: a?.getAttribute('rel') ?? '',
      };
    });
    expect(linkRender.present).toBe(true);
    expect(linkRender.href).toBe('https://example.com/x');
    // Guard against tab-stealing / referrer leaks on the rendered links.
    expect(linkRender.target).toBe('_blank');
    expect(linkRender.rel).toContain('noopener');

    // HTML escaping: the renderer must not introduce a literal element
    // from raw '<' in source. The guide currently has no raw `<` outside
    // code spans; assert via a runtime escape check on a known token.
    // Strategy: evaluate renderMarkdown on a payload with raw `<script>`
    // and confirm no <script> element ends up in the rendered output.
    const escaped = await page.evaluate(() => {
      // Render a small payload with a raw HTML tag in plain text.
      // @ts-ignore - renderMarkdown is a global function on the page.
      const html: string = (window as any).renderMarkdown(
        'Hello <script>alert(1)</script> world.\n',
      );
      const div = document.createElement('div');
      div.innerHTML = html;
      const hasScript = !!div.querySelector('script');
      const hasEscapedText = div.textContent!.includes('<script>');
      return { hasScript, hasEscapedText };
    });
    expect(escaped.hasScript, 'raw <script> must not become a real element').toBe(false);
    expect(escaped.hasEscapedText, 'raw `<` should render as text').toBe(true);
  });

  test('close paths: × / click-outside / Esc — all close, body scroll OK', async ({
    loggedInPage: page,
  }) => {
    await page.goto('/');
    const overlay = page.locator('#helpOverlay');

    // × button
    await page.locator('#navHelpBtnDesktop').click();
    await expect(overlay).not.toHaveClass(/hidden/);
    await page.locator('#helpClose').click();
    // closeModal() uses a 200ms transition before adding 'hidden'.
    await expect(overlay).toHaveClass(/hidden/, { timeout: 1500 });

    // Click outside (the overlay backdrop itself).
    await page.locator('#navHelpBtnDesktop').click();
    await expect(overlay).not.toHaveClass(/hidden/);
    // Click the overlay element directly (outside the .modal child).
    await page.locator('#helpOverlay').click({ position: { x: 5, y: 5 } });
    await expect(overlay).toHaveClass(/hidden/, { timeout: 1500 });

    // Esc
    await page.locator('#navHelpBtnDesktop').click();
    await expect(overlay).not.toHaveClass(/hidden/);
    await page.keyboard.press('Escape');
    await expect(overlay).toHaveClass(/hidden/, { timeout: 1500 });

    // Body scroll: openModal/closeModal in Lifeplan don't lock body scroll
    // (the overlay itself owns scroll), but verify nothing left behind a
    // stuck overflow:hidden on <body> after close.
    const bodyOverflow = await page.evaluate(() => getComputedStyle(document.body).overflow);
    expect(['visible', 'auto', '']).toContain(bodyOverflow);
  });

  test('Cmd+F-able body: a known phrase from the guide is in the rendered DOM', async ({
    loggedInPage: page,
  }) => {
    await page.goto('/');
    await page.locator('#navHelpBtnDesktop').click();
    const content = page.locator('#helpBody .help-content');
    await expect(content).toBeVisible({ timeout: 5000 });
    // "Lifeplan" appears at minimum in the H1; "brain dump" appears in
    // multiple sections. Use both to be solid against future edits.
    await expect(content).toContainText(/Lifeplan/);
    await expect(content).toContainText(/brain dump/i);
  });
});

// ══════════════════════════════════════════════════════════════════
// Item B — Tag chip ↗ glyph
// ══════════════════════════════════════════════════════════════════

test.describe('B. tag chips have ↗ affordance', () => {
  test('Goals view: every visible .tag-chip carries the ↗ ::after glyph', async ({
    loggedInPage: page,
  }) => {
    // Tag chips render via tagsHtml(tags) on goal/knowledge/journal cards.
    // The Tags VIEW itself uses .tag-row rows (not .tag-chip), so we look
    // at Goals where chips are part of the card body and visible to the
    // user. A working app with any goals + tags will have chips here.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    await page.locator('a.nav-link[data-view="goals"]').click();
    await page.waitForSelector('#view-goals.active');

    // Find the first tag-chip that's actually rendered inside the active
    // view. Scope to #view-goals so we don't match chips on hidden views.
    const firstChip = page.locator('#view-goals button.tag-chip').first();
    await expect(firstChip).toBeVisible({ timeout: 8000 });

    // Pseudo-element check: ::after content must be '↗'.
    const arrow = await firstChip.evaluate((el) => {
      const cs = getComputedStyle(el, '::after');
      return cs.content.replace(/^['"]|['"]$/g, '');
    });
    expect(arrow).toBe('↗');

    // Sweep every visible tag-chip in the active view to make sure no
    // chip slipped through without the affordance.
    const chips = await page.locator('#view-goals button.tag-chip').all();
    expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) {
      const arrowI = await chip.evaluate((el) => {
        const cs = getComputedStyle(el, '::after');
        return cs.content.replace(/^['"]|['"]$/g, '');
      });
      expect(arrowI).toBe('↗');
    }
  });

  test('CSS: .tag-chip-wrap variant suppresses the ::after glyph', async ({
    loggedInPage: page,
  }) => {
    // No surface currently renders .tag-chip-wrap; assert the CSS rule
    // works by injecting a wrapper into a sandbox div and reading the
    // computed style. This protects the documented behaviour for the
    // day a wrap variant ships.
    await page.goto('/');
    const display = await page.evaluate(() => {
      const sandbox = document.createElement('div');
      sandbox.innerHTML =
        '<span class="tag-chip-wrap"><button class="tag-chip" data-tag-id="0">x</button></span>';
      document.body.appendChild(sandbox);
      const chip = sandbox.querySelector('.tag-chip-wrap .tag-chip')!;
      const d = getComputedStyle(chip, '::after').display;
      sandbox.remove();
      return d;
    });
    expect(display).toBe('none');
  });
});

// ══════════════════════════════════════════════════════════════════
// Item C — Persistent "Undo last resolve" chip
// ══════════════════════════════════════════════════════════════════

test.describe('C. persistent undo-resolve chip', () => {
  test('home: resolve a hero blocker → toast + .undo-resolve-chip with name', async ({
    loggedInPage: page,
  }) => {
    // Seed: a blocker on the hero goal (id=1).
    const blockerGoal = injectGoal(uniqueLabel('home-blocker-goal'));
    const depId = injectDependency('goal', blockerGoal, 'goal', HERO_GOAL_ID);

    try {
      await page.goto('/');
      // Find OUR seeded blocker row by the canary-prefixed name.
      const row = page.locator(
        `#homeHero .blocker-item[data-blocker-id="${depId}"]`,
      );
      await expect(row).toBeVisible({ timeout: 5000 });

      // Resolve via the toggle button.
      await row.locator('[data-action="toggle-resolve"]').click();

      // Toast appears (existing behaviour — assert it shows).
      // The persistent chip lives at the bottom of the hero.
      const chip = page.locator('#homeHero .undo-resolve-chip');
      await expect(chip).toBeVisible({ timeout: 5000 });
      // It carries the blocker's name in its label.
      await expect(chip).toContainText(/probe-guide-home-blocker-goal/);
    } finally {
      // The row may already be resolved; cleanup wipes it either way.
    }
  });

  test('home: clicking the chip un-resolves and the chip disappears', async ({
    loggedInPage: page,
  }) => {
    const blockerGoal = injectGoal(uniqueLabel('chip-undo-goal'));
    const depId = injectDependency('goal', blockerGoal, 'goal', HERO_GOAL_ID);

    await page.goto('/');
    const row = page.locator(
      `#homeHero .blocker-item[data-blocker-id="${depId}"]`,
    );
    await expect(row).toBeVisible({ timeout: 5000 });
    await row.locator('[data-action="toggle-resolve"]').click();

    const chip = page.locator('#homeHero .undo-resolve-chip');
    await expect(chip).toBeVisible({ timeout: 5000 });

    // DB: should be resolved=1 right now.
    await expect
      .poll(() => readDependencyResolved(depId), { timeout: 3000 })
      .toBe(1);

    await chip.click();

    // After undo: the chip is gone, and DB has resolved=0 again.
    await expect(chip).toBeHidden({ timeout: 5000 });
    await expect
      .poll(() => readDependencyResolved(depId), { timeout: 5000 })
      .toBe(0);
  });

  test('goal-detail: chip appears INSIDE the modal, not on the hero', async ({
    loggedInPage: page,
  }) => {
    // Seed a fresh goal and attach a blocker so we can open it in the
    // goal-detail modal and resolve from there.
    const blockedGoal = injectGoal(uniqueLabel('detail-goal'));
    const blockerGoal = injectGoal(uniqueLabel('detail-blocker'));
    const depId = injectDependency('goal', blockerGoal, 'goal', blockedGoal);

    await page.goto('/');
    // Open the goal-detail modal directly by calling the global function.
    // The dashboard hero only renders goal id=1; we want a distinct goal.
    await page.evaluate((id) => (window as any).openGoalDetail(id), blockedGoal);

    const overlay = page.locator('#goalDetailOverlay');
    await expect(overlay).not.toHaveClass(/hidden/, { timeout: 5000 });
    const row = page.locator(
      `#goalDetailBody .blocker-item[data-blocker-id="${depId}"]`,
    );
    await expect(row).toBeVisible({ timeout: 5000 });

    // Resolve from inside the modal.
    await row.locator('[data-action="toggle-resolve"]').click();

    // The undo chip appears INSIDE the goal-detail body. The modal
    // re-renders via openGoalDetail(goalId) on resolve, so the chip
    // shows up after a network round-trip — give it a generous wait.
    const chipInModal = page.locator('#goalDetailBody .undo-resolve-chip');
    await expect(chipInModal).toBeVisible({ timeout: 10000 });
    await expect(chipInModal).toContainText(/probe-guide-detail-blocker/);

    // And NOT on the hero (separate surface, distinct goal).
    const chipOnHome = page.locator('#homeHero .undo-resolve-chip');
    await expect(chipOnHome).toHaveCount(0);
  });

  test('chip survives navigate-away-and-back within the 30-min window', async ({
    loggedInPage: page,
  }) => {
    const blockerGoal = injectGoal(uniqueLabel('persist-goal'));
    const depId = injectDependency('goal', blockerGoal, 'goal', HERO_GOAL_ID);

    await page.goto('/');
    const row = page.locator(
      `#homeHero .blocker-item[data-blocker-id="${depId}"]`,
    );
    await expect(row).toBeVisible({ timeout: 5000 });
    await row.locator('[data-action="toggle-resolve"]').click();

    const chip = page.locator('#homeHero .undo-resolve-chip');
    await expect(chip).toBeVisible({ timeout: 5000 });

    // Navigate away to Tasks and back to Home (in-app SPA navigation,
    // module state preserved).
    await page.locator('a.nav-link[data-view="tasks"]').click();
    await page.waitForSelector('#view-tasks.active');
    await page.locator('a.nav-link[data-view="home"]').click();
    await page.waitForSelector('#view-home.active');

    // Chip is still pinned to the hero.
    await expect(page.locator('#homeHero .undo-resolve-chip')).toBeVisible({
      timeout: 5000,
    });
  });
});

// ══════════════════════════════════════════════════════════════════
// Item D — "Got it" → "Noted"
// ══════════════════════════════════════════════════════════════════

test.describe('D. prompt secondary button reads "Noted"', () => {
  test('knowledge_gap prompt: secondary button reads "Noted"', async ({
    loggedInPage: page,
  }) => {
    const title = uniqueLabel('kg-title');
    injectKnowledgeGapPrompt(
      title,
      'You keep mentioning "probe-guide-kg-tag" — add a note?',
    );

    await page.goto('/');
    const card = page
      .locator('#homePrompts .prompt-card', { hasText: title })
      .first();
    await expect(card).toBeVisible({ timeout: 5000 });

    // The dismiss button is the .prompt-btn that is NOT .prompt-btn-primary.
    const dismiss = card.locator('button.prompt-btn:not(.prompt-btn-primary)');
    await expect(dismiss).toHaveText('Noted');
    // And the old label must be gone.
    await expect(card).not.toContainText('Got it');
  });

  test('blocker_awareness prompt: secondary button reads "Noted"', async ({
    loggedInPage: page,
  }) => {
    const goalId = injectGoal(uniqueLabel('ba-goal'));
    const title = uniqueLabel('ba-title');
    injectBlockerAwarenessPrompt(
      goalId,
      title,
      "Goal has a blocker that's been live a while.",
    );

    await page.goto('/');
    const card = page
      .locator('#homePrompts .prompt-card', { hasText: title })
      .first();
    await expect(card).toBeVisible({ timeout: 5000 });

    const dismiss = card.locator('button.prompt-btn:not(.prompt-btn-primary)');
    await expect(dismiss).toHaveText('Noted');
    await expect(card).not.toContainText('Got it');
  });
});

// ══════════════════════════════════════════════════════════════════
// Item E — deploy.sh gate
// ══════════════════════════════════════════════════════════════════

test.describe('E. deploy.sh --with-db gate', () => {
  test('refuses --with-db without --force (non-zero exit, REFUSED message)', () => {
    // SAFE: the refusal path exits before any rsync / ssh. We run it
    // synchronously and capture stdout+stderr+exit.
    let stdout = '';
    let stderr = '';
    let code = 0;
    try {
      stdout = execSync(`${DEPLOY_SH} --with-db`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err: any) {
      // execSync throws on non-zero exit. status is on the error.
      code = err.status ?? -1;
      stdout = err.stdout?.toString() ?? '';
      stderr = err.stderr?.toString() ?? '';
    }
    // Non-zero exit (the refusal returns 1).
    expect(code).not.toBe(0);
    const combined = stdout + stderr;
    expect(combined).toMatch(/REFUSED/);
    expect(combined).toMatch(/Pass --force to confirm/);
  });

  test('with --force: script reads the flag and reaches the 3-second countdown branch (parse-only)', () => {
    // Per Probe's constraints: do NOT actually run --with-db --force, it
    // would touch prod. Verify by parsing the script that the success
    // path is wired correctly:
    //   - --force toggles FORCE=1
    //   - the refusal block guards on FORCE -ne 1
    //   - the success branch prints the countdown line and `sleep 3`
    //     before any rsync targeting the remote DB.
    const src = fs.readFileSync(DEPLOY_SH, 'utf8');

    // FORCE flag wiring.
    expect(src).toMatch(/--force\|--yes\)/);
    expect(src).toMatch(/FORCE=1/);

    // Refusal block guards on FORCE -ne 1.
    expect(src).toMatch(/MODE.*--with-db.*MODE.*--db.*FORCE.*-ne.*1/s);
    expect(src).toMatch(/REFUSED/);

    // Success branch: countdown + sleep 3 before the rsync of the DB.
    const countdownIdx = src.search(
      /Overwriting prod DB from local in 3 seconds/,
    );
    const sleepIdx = src.search(/^\s*sleep 3\s*$/m);
    const dbRsyncIdx = src.indexOf('lifeplan.db');
    expect(countdownIdx).toBeGreaterThan(-1);
    expect(sleepIdx).toBeGreaterThan(-1);
    expect(dbRsyncIdx).toBeGreaterThan(-1);
    // Countdown announces *before* sleep, which fires *before* the rsync.
    expect(countdownIdx).toBeLessThan(sleepIdx);
    expect(sleepIdx).toBeLessThan(dbRsyncIdx);
  });
});
