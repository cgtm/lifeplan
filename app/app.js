// ── Mount prefix ────────────────────────────────────────
// The app is served at "/" locally and "/lifeplan/" in production (behind
// nginx). Compute the mount prefix once from the current pathname so that
// redirects and fetches resolve correctly regardless of where we're mounted.
// Strips any trailing path segment (e.g. "/lifeplan/index.html" → "/lifeplan/")
// so this works even if the page URL doesn't end in "/".
const MOUNT = window.location.pathname.replace(/[^/]*$/, '');

// ── Theme Manager ───────────────────────────────────────
const ThemeManager = (() => {
  const STORAGE_KEY = 'lifeplan-theme';
  const MODES = ['auto', 'light', 'dark'];
  const html = document.documentElement;
  let currentMode = 'auto';
  let systemDarkMq = window.matchMedia('(prefers-color-scheme: dark)');

  function getStoredMode() {
    try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
  }

  function storeMode(mode) {
    try { localStorage.setItem(STORAGE_KEY, mode); } catch {}
  }

  function applyTheme() {
    let isDark;
    if (currentMode === 'dark') {
      isDark = true;
    } else if (currentMode === 'light') {
      isDark = false;
    } else {
      isDark = systemDarkMq.matches;
    }

    html.setAttribute('data-theme', isDark ? 'dark' : 'light');
    html.style.colorScheme = isDark ? 'dark' : 'light';

    // Update theme-color meta tags for the browser/PWA chrome
    const metaLight = document.querySelector('meta[name="theme-color"][media*="light"]');
    const metaDark = document.querySelector('meta[name="theme-color"][media*="dark"]');
    if (metaLight && metaDark) {
      if (currentMode === 'auto') {
        metaLight.setAttribute('content', '#fafaf9');
        metaDark.setAttribute('content', '#1c1917');
        metaLight.removeAttribute('media');
        metaDark.removeAttribute('media');
        metaLight.setAttribute('media', '(prefers-color-scheme: light)');
        metaDark.setAttribute('media', '(prefers-color-scheme: dark)');
      } else {
        metaLight.setAttribute('content', isDark ? '#1c1917' : '#fafaf9');
        metaDark.setAttribute('content', isDark ? '#1c1917' : '#fafaf9');
      }
    }

    updateButtons();
  }

  function updateButtons() {
    const desktopBtn = document.getElementById('themeToggle');
    const mobileLabel = document.getElementById('mobileThemeLabel');
    if (desktopBtn) desktopBtn.textContent = currentMode;
    if (mobileLabel) mobileLabel.textContent = currentMode;
  }

  function cycle() {
    const idx = MODES.indexOf(currentMode);
    currentMode = MODES[(idx + 1) % MODES.length];
    storeMode(currentMode);
    applyTheme();
  }

  function init() {
    const stored = getStoredMode();
    if (stored && MODES.includes(stored)) {
      currentMode = stored;
    }
    applyTheme();

    // Listen for system theme changes (relevant when mode is 'auto')
    systemDarkMq.addEventListener('change', () => {
      if (currentMode === 'auto') applyTheme();
    });

    // Bind desktop toggle
    const desktopBtn = document.getElementById('themeToggle');
    if (desktopBtn) desktopBtn.addEventListener('click', cycle);

    // Bind mobile toggle
    const mobileBtn = document.getElementById('mobileThemeToggle');
    if (mobileBtn) mobileBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      cycle();
    });
  }

  return { init, cycle };
})();

// Initialise theme immediately so it applies before paint
ThemeManager.init();

// ── Utilities ───────────────────────────────────────────
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

function esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function fmtDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtDateLong(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function fmtTimestamp(ts) {
  if (!ts) return '';
  const d = new Date(ts.replace(' ', 'T') + 'Z');
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtRelative(ts) {
  if (!ts) return '';
  const d = new Date(ts.replace(' ', 'T') + 'Z');
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return fmtDate(ts.slice(0, 10));
}

function statusPill(status) {
  return `<span class="status status-${esc(status)}">${esc(status)}</span>`;
}

function tagChipHtml(t) {
  // Standard clickable chip. The id is required to drive the drawer; we
  // tolerate legacy tag rows that only have a name (rare) by falling back
  // to a non-button span.
  if (!t || (t.id == null && !t.name)) return '';
  if (t.id == null) return `<span class="tag">${esc(t.name)}</span>`;
  return `<button type="button" class="tag tag-chip" data-tag-id="${t.id}" data-tag-name="${esc(t.name)}">${esc(t.name)}</button>`;
}

function tagsHtml(tags) {
  if (!tags || !tags.length) return '';
  return `<div class="tags-row">${tags.map(tagChipHtml).join('')}</div>`;
}

function typePill(type) {
  return `<span class="knowledge-type type-${esc(type)}">${esc(type)}</span>`;
}

// ── Global progress bar ────────────────────────────────
// Tracks in-flight api() calls. Bar appears when any single request
// exceeds 250ms; vanishes when everything in flight resolves.
const _lpProgress = (() => {
  let inflight = 0;
  let visible = false;
  let showTimer = null;

  function el() { return document.getElementById('lpProgress'); }

  function show() {
    visible = true;
    const e = el();
    if (e) e.classList.add('visible');
  }

  function hide() {
    visible = false;
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }
    const e = el();
    if (e) e.classList.remove('visible');
  }

  function start() {
    inflight += 1;
    if (inflight === 1 && !visible && !showTimer) {
      showTimer = setTimeout(() => { showTimer = null; show(); }, 250);
    }
  }

  function end() {
    inflight = Math.max(0, inflight - 1);
    if (inflight === 0) hide();
  }

  return { start, end };
})();

// ── apiError() — single failure-surfacing helper ───────────
// On 5xx → toast + Retry button (caller passes a retry fn).
// On 404 → toast + refresh hook.
// On network error → "offline" toast (auto-clears on next success).
// On 401 → existing redirect (handled by api()).
let _offlineToastShown = false;

function _clearOfflineToastIfShown() {
  if (_offlineToastShown) {
    const t = document.getElementById('lpToast');
    if (t) t.classList.remove('visible');
    _offlineToastShown = false;
  }
}

function _toastWithAction(message, actionLabel, onAction) {
  let el = document.getElementById('lpToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'lpToast';
    el.className = 'lp-toast';
    document.body.appendChild(el);
  }
  el.classList.add('has-action');
  el.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = message;
  el.appendChild(span);
  if (actionLabel && typeof onAction === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lp-toast-retry';
    btn.textContent = actionLabel;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      el.classList.remove('visible');
      onAction();
    });
    el.appendChild(btn);
  }
  requestAnimationFrame(() => el.classList.add('visible'));
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('visible'), 5500);
}

function apiError(err, opts = {}) {
  const status = err && err.status;
  const retry = typeof opts.retry === 'function' ? opts.retry : null;
  const onRefresh = typeof opts.onRefresh === 'function' ? opts.onRefresh : null;

  if (status === 401) {
    // api() already redirects; nothing to surface.
    return;
  }

  if (status === 404) {
    showToast('That item is no longer here.');
    if (onRefresh) onRefresh();
    return;
  }

  if (status && status >= 500) {
    if (retry) {
      _toastWithAction('Something went wrong. Try again.', 'Retry', retry);
    } else {
      showToast('Something went wrong. Try again.');
    }
    return;
  }

  // Network error (fetch rejected) — err.networkError flag set by api().
  if (err && err.networkError) {
    _offlineToastShown = true;
    showToast('You appear to be offline. Reconnecting…');
    return;
  }

  // Anything else (e.g. 400 with no caller-side handling): generic toast.
  showToast('Something went wrong.');
}

// api() — returns parsed JSON for any non-401 response. Preserves the
// historical lenient contract: callers pattern-match on payload (e.g. a
// `.error` field). For new code that wants HTTP-status branching, use
// apiTry() — it throws an error with `.status` and `.payload` on non-2xx
// and on network failure, ready to feed straight into apiError().
async function api(path, opts = {}) {
  _lpProgress.start();
  try {
    let res;
    try {
      res = await fetch(`${MOUNT}api${path}`, {
        headers: { 'Content-Type': 'application/json' },
        ...opts,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    } catch (_netErr) {
      // Network failure — return undefined so legacy callers that
      // immediately deref .error / .id behave as before (they already
      // crashed silently). New callers should prefer apiTry().
      return undefined;
    }
    if (res.status === 401) {
      window.location.href = `${MOUNT}login`;
      return new Promise(() => {});
    }
    _clearOfflineToastIfShown();
    return res.json();
  } finally {
    _lpProgress.end();
  }
}

async function apiTry(path, opts = {}) {
  _lpProgress.start();
  try {
    let res;
    try {
      res = await fetch(`${MOUNT}api${path}`, {
        headers: { 'Content-Type': 'application/json' },
        ...opts,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    } catch (netErr) {
      const e = new Error('Network error');
      e.networkError = true;
      e.cause = netErr;
      throw e;
    }
    if (res.status === 401) {
      window.location.href = `${MOUNT}login`;
      return new Promise(() => {});
    }
    _clearOfflineToastIfShown();
    let payload = null;
    try { payload = await res.json(); } catch (_) {}
    if (!res.ok) {
      const e = new Error(`HTTP ${res.status}`);
      e.status = res.status;
      e.payload = payload;
      throw e;
    }
    return payload;
  } finally {
    _lpProgress.end();
  }
}

// ── Logout ─────────────────────────────────────────────
async function logout() {
  try {
    await fetch(`${MOUNT}logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  } catch (_) { /* ignore — we redirect regardless */ }
  window.location.href = `${MOUNT}login`;
}

// ── Skeleton loaders ────────────────────────────────────
// Show shimmer placeholders while a list is loading for the first time.
// Hidden as soon as the real render runs.
function renderSkeletonCards(selector, count = 3) {
  const el = typeof selector === 'string' ? $(selector) : selector;
  if (!el) return;
  const card = `
    <div class="lp-skeleton" aria-hidden="true">
      <div class="lp-skeleton-line w-60"></div>
      <div class="lp-skeleton-line w-80"></div>
      <div class="lp-skeleton-line w-40"></div>
    </div>`;
  el.innerHTML = card.repeat(count);
}

// ── Modal helpers ──────────────────────────────────────
function openModal(el) {
  el.classList.remove('hidden');
  requestAnimationFrame(() => el.classList.add('visible'));
}
function closeModal(el) {
  el.classList.remove('visible');
  setTimeout(() => el.classList.add('hidden'), 200);
}

// ══════════════════════════════════════════════════════════
// HELP / USER GUIDE
// ══════════════════════════════════════════════════════════
//
// Renders docs/user-guide.md inside an in-app modal. The server returns
// the raw markdown via GET /api/help/user-guide; we convert client-side
// so the Python server stays out of presentation concerns.
//
// The renderer covers the subset Iris's guide uses: h1-h4, paragraphs,
// **bold**, *italic*, `code`, fenced code blocks, ordered/unordered
// lists (one level of nesting), [links](url), --- horizontal rules,
// pipe tables, and YAML front matter (which we strip).
//
// Rule of thumb: if Iris adds a markdown construct this parser doesn't
// handle, either keep the doc clean or extend the parser — never pull
// in a library. (See Lumen's brief.)

const _helpState = { loaded: false, markdown: null };

function _mdEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Inline transformations: code spans, bold, italic, links. Run on
// already-html-escaped text so the output is safe to insert.
function _renderInline(text) {
  // Code spans first — their contents are inert (no further inline
  // processing). We extract them, substitute placeholders, then
  // re-inject after the other transforms have run.
  const codes = [];
  text = text.replace(/`([^`\n]+)`/g, (_, code) => {
    codes.push(`<code>${code}</code>`);
    return ` C${codes.length - 1} `;
  });

  // Links: [label](url) — url and label both already html-escaped.
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
    // Permit only http(s) and relative — strip anything else for safety.
    const safe = /^(https?:|\/|#)/.test(url) ? url : '#';
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  // Bold then italic. Bold uses ** or __; italic uses * or _.
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  text = text.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  text = text.replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>');

  // Re-inject code spans.
  text = text.replace(/ C(\d+) /g, (_, i) => codes[parseInt(i)]);
  return text;
}

// Block-level parser. Walks the markdown line-by-line, accumulating
// HTML for each block construct it recognises.
function renderMarkdown(src) {
  // Strip a leading YAML front-matter block (--- … ---).
  src = src.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');

  const lines = src.split(/\r?\n/);
  const out = [];
  let i = 0;

  // Helpers ────────────────────────────────────────────────
  const flushParagraph = (buf) => {
    if (!buf.length) return;
    const text = _renderInline(_mdEscape(buf.join(' ')));
    out.push(`<p>${text}</p>`);
    buf.length = 0;
  };

  // Render a list item's text including the inline transforms.
  const renderItemText = (s) => _renderInline(_mdEscape(s));

  // Detect a list line. Returns {ordered, indent, marker, content} or null.
  const matchListLine = (line) => {
    const m = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (!m) return null;
    return {
      ordered: /\d+\./.test(m[2]),
      indent: m[1].length,
      content: m[3],
    };
  };

  // Parse a contiguous list block starting at index `start`. Supports one
  // level of nesting via indentation (>= 2 spaces).
  const parseList = (start) => {
    const first = matchListLine(lines[start]);
    if (!first) return null;
    const baseIndent = first.indent;
    const ordered = first.ordered;
    let j = start;
    const items = []; // [{ content: string, children: htmlString | null }]
    while (j < lines.length) {
      const m = matchListLine(lines[j]);
      if (!m || m.indent < baseIndent) break;
      if (m.indent === baseIndent && m.ordered === ordered) {
        items.push({ content: m.content, children: null });
        j++;
        // Look ahead for a nested list (deeper indent).
        if (j < lines.length) {
          const n = matchListLine(lines[j]);
          if (n && n.indent > baseIndent) {
            const nested = parseList(j);
            if (nested) {
              items[items.length - 1].children = nested.html;
              j = nested.next;
            }
          }
        }
      } else {
        break;
      }
    }
    const tag = ordered ? 'ol' : 'ul';
    const html =
      `<${tag}>` +
      items
        .map(
          (it) =>
            `<li>${renderItemText(it.content)}${it.children || ''}</li>`,
        )
        .join('') +
      `</${tag}>`;
    return { html, next: j };
  };

  // Pipe-table parser: header row, separator row, body rows. Returns
  // {html, next} or null.
  const parseTable = (start) => {
    const headerLine = lines[start];
    const sepLine = lines[start + 1];
    if (!headerLine || !sepLine) return null;
    if (!/^\s*\|.*\|\s*$/.test(headerLine)) return null;
    if (!/^\s*\|?\s*:?-{2,}.*$/.test(sepLine)) return null;
    if (!sepLine.includes('|')) return null;

    const splitRow = (l) =>
      l
        .replace(/^\s*\|/, '')
        .replace(/\|\s*$/, '')
        .split('|')
        .map((c) => c.trim());

    const headers = splitRow(headerLine);
    let j = start + 2;
    const rows = [];
    while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) {
      rows.push(splitRow(lines[j]));
      j++;
    }
    const thead =
      '<thead><tr>' +
      headers.map((h) => `<th>${_renderInline(_mdEscape(h))}</th>`).join('') +
      '</tr></thead>';
    const tbody =
      '<tbody>' +
      rows
        .map(
          (r) =>
            '<tr>' +
            r.map((c) => `<td>${_renderInline(_mdEscape(c))}</td>`).join('') +
            '</tr>',
        )
        .join('') +
      '</tbody>';
    return { html: `<table>${thead}${tbody}</table>`, next: j };
  };

  const paragraphBuf = [];

  while (i < lines.length) {
    const line = lines[i];

    // Blank line — close any open paragraph.
    if (/^\s*$/.test(line)) {
      flushParagraph(paragraphBuf);
      i++;
      continue;
    }

    // Fenced code block: ``` … ```
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      flushParagraph(paragraphBuf);
      const lang = fence[1] || '';
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // consume closing fence (or end-of-input)
      const cls = lang ? ` class="lang-${lang.replace(/[^a-zA-Z0-9_-]/g, '')}"` : '';
      out.push(`<pre><code${cls}>${_mdEscape(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // Horizontal rule: --- or *** (3+).
    if (/^\s*([-*_])\1\1[-*_\s]*$/.test(line)) {
      flushParagraph(paragraphBuf);
      out.push('<hr>');
      i++;
      continue;
    }

    // Heading: # to ####.
    const heading = line.match(/^(#{1,4})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      flushParagraph(paragraphBuf);
      const level = heading[1].length;
      out.push(
        `<h${level}>${_renderInline(_mdEscape(heading[2]))}</h${level}>`,
      );
      i++;
      continue;
    }

    // Block quote: > line.
    if (/^\s*>\s?/.test(line)) {
      flushParagraph(paragraphBuf);
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(
        `<blockquote>${_renderInline(_mdEscape(buf.join(' ')))}</blockquote>`,
      );
      continue;
    }

    // Pipe table.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const table = parseTable(i);
      if (table) {
        flushParagraph(paragraphBuf);
        out.push(table.html);
        i = table.next;
        continue;
      }
    }

    // List.
    if (matchListLine(line)) {
      const list = parseList(i);
      if (list) {
        flushParagraph(paragraphBuf);
        out.push(list.html);
        i = list.next;
        continue;
      }
    }

    // Paragraph line.
    paragraphBuf.push(line.trim());
    i++;
  }

  flushParagraph(paragraphBuf);
  return out.join('\n');
}

async function openHelpModal() {
  const overlay = $('#helpOverlay');
  const body = $('#helpBody');
  openModal(overlay);

  if (!_helpState.loaded) {
    body.innerHTML = '<div class="help-loading">Loading&hellip;</div>';
    try {
      const res = await fetch(`${MOUNT}api/help/user-guide`, {
        headers: { 'Accept': 'text/plain' },
      });
      if (res.status === 401) {
        window.location.href = `${MOUNT}login`;
        return;
      }
      if (!res.ok) {
        body.innerHTML =
          '<div class="help-loading">Could not load the user guide.</div>';
        return;
      }
      _helpState.markdown = await res.text();
      _helpState.loaded = true;
    } catch (_) {
      body.innerHTML =
        '<div class="help-loading">Network error — try again.</div>';
      return;
    }
  }

  body.innerHTML = `<div class="help-content">${renderMarkdown(_helpState.markdown)}</div>`;
  // Reset the body scroll on open so re-opens always start at the top.
  body.scrollTop = 0;
}

function closeHelpModal() {
  closeModal($('#helpOverlay'));
}

// Wire up Help nav entries (desktop link + mobile More menu) and modal
// close patterns: × button, click-outside, Esc (handled in the global
// keydown block).
{
  const desktopBtn = document.getElementById('navHelpBtnDesktop');
  if (desktopBtn) desktopBtn.addEventListener('click', openHelpModal);
  const mobileBtn = document.getElementById('navHelpBtn');
  if (mobileBtn) {
    mobileBtn.addEventListener('click', () => {
      const menu = document.getElementById('navMoreMenu');
      if (menu) menu.classList.add('hidden');
      openHelpModal();
    });
  }
  const closeBtn = document.getElementById('helpClose');
  if (closeBtn) closeBtn.addEventListener('click', closeHelpModal);
  const overlay = document.getElementById('helpOverlay');
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeHelpModal();
    });
  }
}

// ── Action menu helpers ────────────────────────────────
// Close any open action menus when clicking elsewhere
document.addEventListener('click', (e) => {
  if (!e.target.closest('.card-actions')) {
    $$('.card-actions-menu.open').forEach(m => m.classList.remove('open'));
    $$('.card-actions-btn.open').forEach(b => b.classList.remove('open'));
  }
});

function toggleActionMenu(btn) {
  const menu = btn.nextElementSibling;
  const wasOpen = menu.classList.contains('open');
  // Close all others
  $$('.card-actions-menu.open').forEach(m => m.classList.remove('open'));
  $$('.card-actions-btn.open').forEach(b => b.classList.remove('open'));
  if (!wasOpen) {
    menu.classList.add('open');
    btn.classList.add('open');
  }
}

function actionsHtml(editFn, deleteFn) {
  return `<div class="card-actions">
    <button class="card-actions-btn" onclick="event.stopPropagation();toggleActionMenu(this)">&ctdot;</button>
    <div class="card-actions-menu">
      ${editFn ? `<button onclick="event.stopPropagation();${editFn}">Edit</button>` : ''}
      <button class="action-delete" onclick="event.stopPropagation();${deleteFn}">Delete</button>
    </div>
  </div>`;
}

// ── Navigation ─────────────────────────────────────────
let currentView = 'home';

function navigate(view) {
  // Stop brain-dump polling when leaving any dump-rendering surface.
  if (view !== 'dump' && view !== 'home') stopBrainDumpPolling();
  currentView = view;
  $$('.view').forEach(v => v.classList.remove('active'));
  $(`#view-${view}`).classList.add('active');
  $$('.nav-link').forEach(l => l.classList.toggle('active', l.dataset.view === view));
  $$('.nav-more-item').forEach(l => l.classList.toggle('active', l.dataset.view === view));
  // Highlight "More" tab when a sub-view is active
  const moreViews = ['people', 'journal', 'knowledge', 'tags'];
  const moreBtn = $('#navMoreBtn');
  if (moreBtn) moreBtn.classList.toggle('active', moreViews.includes(view));
  // Close more menu on navigate
  const moreMenu = $('#navMoreMenu');
  if (moreMenu) moreMenu.classList.add('hidden');
  window.scrollTo(0, 0);

  // Load data for view
  if (view === 'home') loadHome();
  else if (view === 'dump') loadDumps();
  else if (view === 'goals') loadGoals();
  else if (view === 'tasks') loadTasks();
  else if (view === 'people') loadPeople();
  else if (view === 'journal') loadJournal();
  else if (view === 'knowledge') loadKnowledge();
  else if (view === 'tags') loadTagsView();
}

$$('.nav-link, .nav-brand').forEach(el => {
  el.addEventListener('click', () => {
    if (el.id === 'navMoreBtn') return; // handled separately
    if (el.id === 'navHelpBtnDesktop') return; // opens the help modal, no view change
    navigate(el.dataset.view || 'home');
  });
});

// Desktop log out chip
const navLogoutDesktopBtn = $('#navLogoutDesktopBtn');
if (navLogoutDesktopBtn) {
  navLogoutDesktopBtn.addEventListener('click', logout);
}

// Mobile "More" menu
const navMoreBtn = $('#navMoreBtn');
const navMoreMenu = $('#navMoreMenu');
if (navMoreBtn && navMoreMenu) {
  navMoreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    navMoreMenu.classList.toggle('hidden');
  });
  $$('.nav-more-item').forEach(el => {
    el.addEventListener('click', () => {
      if (el.id === 'navLogoutBtn') {
        navMoreMenu.classList.add('hidden');
        logout();
        return;
      }
      if (el.id === 'navHelpBtn') {
        // Help opens a modal — no view navigation. The dedicated handler
        // (registered in the help-modal block) hides the More menu and
        // opens the modal; we just bail here so navigate() doesn't fire
        // a stray loadHome().
        return;
      }
      navigate(el.dataset.view);
    });
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.nav-more-menu') && !e.target.closest('#navMoreBtn')) {
      navMoreMenu.classList.add('hidden');
    }
  });
}

// ══════════════════════════════════════════════════════════
// HOME VIEW
// ══════════════════════════════════════════════════════════

async function loadHome() {
  const data = await api('/dashboard');
  renderHome(data);
  loadPrompts();
  // Refresh prompts in the background — don't block the UI
  api('/prompts/generate', { method: 'POST' }).catch(() => {});
}

function renderHome(data) {
  // Primary goal hero
  const pg = data.primary_goal;
  if (pg) {
    // Hero shows active blockers only (per Iris's spec). Resolved ones
    // surface inside the goal-detail modal so they're not lost — just
    // not in the hero's "what's blocking me right now?" attention area.
    const unresolvedBlockers = (pg.blockers || []).filter(b => !b.resolved);
    $('#homeHero').innerHTML = `
      <div class="hero-goal hero-goal--clickable fade-in" data-goal-id="${pg.id}" role="button" tabindex="0" aria-label="Open ${esc(pg.title)}">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          ${statusPill(pg.status)}
          ${pg.target_date ? `<span style="font-size:0.6875rem;color:var(--text-3)">Target: ${fmtDate(pg.target_date)}</span>` : ''}
        </div>
        <div class="hero-goal-title">${esc(pg.title)}</div>
        <div class="hero-goal-desc">${esc(pg.description)}</div>
        ${unresolvedBlockers.length ? `
          <div class="blockers-label">Blockers (${unresolvedBlockers.length} unresolved)</div>
          <div class="hero-blockers" data-stop-card-click="1">
            ${unresolvedBlockers.map(b => renderBlockerItem(b)).join('')}
          </div>
        ` : '<div style="font-size:0.8125rem;color:var(--green)">No unresolved blockers</div>'}
      </div>
    `;
    bindHeroGoalCard(pg.id);
    bindBlockerItems('#homeHero', {
      surface: 'home',
      onRefresh: () => loadHome(),
    });
    renderUndoResolveChip('home');
  }

  // Active goals
  const activeGoals = data.active_goals || [];
  if (activeGoals.length) {
    $('#homeGoals').innerHTML = `
      <div class="section-header" style="margin-top:24px">Active Goals</div>
      ${activeGoals.map(g => {
        const pct = g.task_total > 0 ? Math.round((g.task_completed / g.task_total) * 100) : 0;
        return `
        <div class="card goal-card fade-in" data-goal-id="${g.id}">
          <div class="goal-card-header">
            <span class="goal-card-title">${esc(g.title)}</span>
            <span class="goal-card-meta">${g.task_completed}/${g.task_total} tasks</span>
          </div>
          ${g.task_total > 0 ? `
            <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
            <div class="progress-text">${pct}% complete</div>
          ` : ''}
          ${tagsHtml(g.tags)}
        </div>`;
      }).join('')}
    `;
    bindGoalCards('#homeGoals');
  }

  // Stalled goals
  const stalledGoals = data.stalled_goals || [];
  if (stalledGoals.length) {
    $('#homeStalled').innerHTML = `
      <div class="section-header" style="margin-top:24px">Needs Attention</div>
      ${stalledGoals.map(g => `
        <div class="card goal-card fade-in" data-goal-id="${g.id}" style="border-left:3px solid var(--amber)">
          <div class="goal-card-header">
            <span class="goal-card-title">${esc(g.title)}</span>
            ${statusPill('stalled')}
          </div>
          ${tagsHtml(g.tags)}
        </div>
      `).join('')}
    `;
    bindGoalCards('#homeStalled');
  } else {
    $('#homeStalled').innerHTML = '';
  }

  // Update badge from dashboard data
  if (data.needs_review_count !== undefined) {
    updateDumpBadge(data.needs_review_count);
  }

  // Recent dumps
  const dumps = data.recent_dumps || [];
  if (dumps.length) {
    $('#homeRecentDumps').innerHTML = `
      <div class="section-header" style="margin-top:32px">Recent Captures</div>
      ${dumps.map(d => `
        <div class="dump-item dump-item-clickable fade-in" data-dump-id="${d.id}" role="button" tabindex="0">
          <div class="dump-item-header">
            <span class="dump-time">${fmtRelative(d.captured_at)}</span>
            ${processingStatusLabel(d)}
            ${retryButton(d)}
          </div>
          <div class="dump-item-content">${esc(d.content)}</div>
          ${processingResultsPills(d)}
          ${tagsHtml(d.tags)}
        </div>
      `).join('')}
    `;
    bindResultPills('#homeRecentDumps');
    // Wire failed-dump Retry buttons (same pattern as the Dump view).
    $('#homeRecentDumps').querySelectorAll('.dump-retry-btn[data-action="retry"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.dumpId);
        btn.disabled = true;
        retryBrainDump(id);
      });
    });
    // Whole-row click opens the detail drawer. Home doesn't keep the
    // dump list in allDumps, so we fetch the row by id on demand.
    $('#homeRecentDumps').querySelectorAll('.dump-item-clickable').forEach(row => {
      const open = async () => {
        const id = parseInt(row.dataset.dumpId);
        // Sync allDumps so the detail drawer can read from local state
        // (it's the source of truth for poll-driven re-renders).
        try {
          allDumps = await api('/brain-dumps');
        } catch (_) { /* fall through; the detail will still render from
                         the dashboard row if the network blips */ }
        const dump = (allDumps || []).find(d => d.id === id) ||
                     (data.recent_dumps || []).find(d => d.id === id);
        if (dump) openDumpDetail(dump);
      };
      row.addEventListener('click', (e) => {
        if (e.target.closest('.card-actions')) return;
        if (e.target.closest('.dump-retry-btn')) return;
        if (e.target.closest('.result-pill-clickable')) return;
        if (e.target.closest('.result-detail-item')) return;
        if (e.target.closest('.tag-chip')) return;
        open();
      });
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
    });
  } else {
    $('#homeRecentDumps').innerHTML = '';
  }

  // Polling: kick off if a recent dump is in flight.
  if (currentView === 'home') {
    if (_hasInflightDump()) startBrainDumpPolling();
    else stopBrainDumpPolling();
  }
}

// Whole-card click on the hero opens the goal detail. Clicks on
// blocker rows (which have their own toggle/navigate logic) bubble up
// here and we filter them out via the [data-stop-card-click] guard.
function bindHeroGoalCard(goalId) {
  const card = document.querySelector('.hero-goal--clickable');
  if (!card) return;
  const open = () => openGoalDetail(goalId);
  card.addEventListener('click', (e) => {
    if (e.target.closest('[data-stop-card-click]')) return;
    if (e.target.closest('.blocker-item')) return;
    open();
  });
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });
}

// ── Home brain dump ─────────────────────────────────────
const homeDump = $('#homeDump');
const homeDumpSend = $('#homeDumpSend');
const homeDumpSuccess = $('#homeDumpSuccess');
const homeDumpStatus = $('#homeDumpStatus');

homeDump.addEventListener('input', () => {
  homeDumpSend.classList.toggle('visible', homeDump.value.trim().length > 0);
  autoResize(homeDump);
});

homeDumpSend.addEventListener('click', submitHomeDump);

async function submitHomeDump() {
  const content = homeDump.value.trim();
  if (!content) return;

  // Phase 1: immediate feedback
  homeDumpSend.disabled = true;
  homeDumpSend.textContent = 'Capturing...';
  homeDump.value = '';
  homeDumpSend.classList.remove('visible');
  autoResize(homeDump);
  showDumpStatus(homeDumpStatus, 'processing', 'Capturing...');

  try {
    const result = await api('/brain-dumps', { method: 'POST', body: { content } });

    if (result && result.error) {
      showDumpStatus(homeDumpStatus, 'error', 'Couldn’t save dump. Try again.');
    } else {
      // 202 Accepted — dump queued; worker will process in background.
      showDumpStatus(homeDumpStatus, 'success', 'Captured. Processing in background.');
      scheduleDumpStatusClear(homeDumpStatus, 3500);
    }

    // Refresh home data — loadHome() will see the new queued row and
    // startBrainDumpPolling() is called from renderHome's tail.
    loadHome();
  } catch (err) {
    showDumpStatus(homeDumpStatus, 'error', 'Something went wrong. Your text has been saved — try refreshing.');
  } finally {
    homeDumpSend.disabled = false;
    homeDumpSend.textContent = 'Capture';
  }
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

// ── Dump status helpers ──────────────────────────────────
const _dumpStatusTimers = new WeakMap();

function showDumpStatus(el, type, message) {
  // Clear any pending fade-out timer
  const prev = _dumpStatusTimers.get(el);
  if (prev) clearTimeout(prev);

  el.className = 'dump-status visible';
  if (type === 'processing') {
    el.innerHTML = `<span class="dump-status-dot"></span>${esc(message)}`;
  } else if (type === 'success') {
    el.classList.add('success');
    el.textContent = message;
  } else if (type === 'error') {
    el.classList.add('error');
    el.textContent = message;
  }
}

function scheduleDumpStatusClear(el, delay) {
  const timer = setTimeout(() => {
    el.classList.remove('visible');
    // After opacity transition finishes, clean up classes
    setTimeout(() => { el.className = 'dump-status'; el.textContent = ''; }, 350);
  }, delay);
  _dumpStatusTimers.set(el, timer);
}

function buildCompletionMessage(result) {
  if (!result) return 'Done.';
  // Check if there are items needing review
  const status = result.processing_status;
  const items = result.processed_items && result.processed_items.items;
  if (status === 'needs_review' && items) {
    const reviewCount = items.filter(i => i.status === 'suggested').length;
    if (reviewCount > 0) {
      return `Done — ${reviewCount} item${reviewCount > 1 ? 's' : ''} need${reviewCount === 1 ? 's' : ''} your review.`;
    }
  }
  // Summarize what was extracted
  if (items && items.length > 0) {
    const counts = {};
    items.forEach(i => {
      if (i.status === 'auto_created' || i.status === 'approved' || i.status === 'suggested') {
        const t = i.type;
        const label = (t === 'person_mention' || t === 'person_new') ? 'person' :
                      (t === 'goal_link' || t === 'goal_new') ? 'goal' :
                      t === 'knowledge' ? 'knowledge' :
                      t === 'tag' ? 'tag' :
                      t === 'task' ? 'task' : t;
        counts[label] = (counts[label] || 0) + 1;
      }
    });
    const pluralMap = { person: 'people', task: 'tasks', goal: 'goals', tag: 'tags', knowledge: 'knowledge' };
    const parts = Object.entries(counts).map(([label, n]) => {
      const display = n === 1 ? label : (pluralMap[label] || label + 's');
      return `${n} ${display}`;
    });
    if (parts.length > 0) return `Done — ${parts.join(', ')} extracted.`;
  }
  return 'Done — captured and processed.';
}

// ══════════════════════════════════════════════════════════
// PROMPTS
// ══════════════════════════════════════════════════════════

let allPrompts = [];
const _promptSeenTimers = new Map();

function updatePromptBadge(count) {
  const badge = $('#promptBadge');
  if (count > 0) {
    badge.textContent = count;
    badge.classList.add('visible');
  } else {
    badge.classList.remove('visible');
  }
}

async function loadPrompts() {
  try {
    const [prompts, countData] = await Promise.all([
      api('/prompts'),
      api('/prompts/count'),
    ]);
    allPrompts = prompts;
    renderPrompts();
    updatePromptBadge(countData.count || 0);
  } catch (e) {
    // Prompts are non-critical; don't break the page
  }
}

function renderPrompts() {
  const el = $('#homePrompts');
  if (!allPrompts || !allPrompts.length) {
    el.innerHTML = '';
    return;
  }

  el.innerHTML = allPrompts.map(p => {
    const hasSource = p.source_type && p.source_id;
    const isActivityGap = p.prompt_type === 'activity_gap' && p.trigger_rule && p.trigger_rule.includes('dump');
    const isKnowledgeGap = p.prompt_type === 'knowledge_gap';
    const isBlockerAwareness = p.prompt_type === 'blocker_awareness';

    // Iris paper-cut #3: "Got it" reads as dismissive even though the action
    // is genuinely useful (mark prompt seen, keep moving). "Noted" lands
    // closer to "I've absorbed this" — same behaviour, calmer word.
    let actionsHtml = `<button class="prompt-btn" onclick="dismissPrompt(${p.id})">Noted</button>`;
    if (isKnowledgeGap) {
      actionsHtml += `<button class="prompt-btn prompt-btn-primary" onclick="addNoteFromPrompt(${p.id})">Add a note</button>`;
    }
    if (isBlockerAwareness && hasSource && p.source_type === 'goal') {
      // Iris W4: dedicated CTAs replacing the generic "Take me there".
      actionsHtml += `<button class="prompt-btn prompt-btn-primary" onclick="openGoalFromPrompt(${p.source_id})">Open the goal</button>`;
      actionsHtml += `<button class="prompt-btn prompt-btn-primary" onclick="resolveBlockerFromPrompt(${p.id}, ${p.source_id})">Mark resolved</button>`;
    } else if (hasSource) {
      actionsHtml += `<button class="prompt-btn prompt-btn-primary" onclick="navigateToPromptSource('${esc(p.source_type)}', ${p.source_id})">Take me there</button>`;
    }
    if (isActivityGap) {
      actionsHtml += `<button class="prompt-btn prompt-btn-primary" onclick="focusBrainDump()">Brain dump</button>`;
    }

    return `
      <div class="prompt-card fade-in" id="prompt-${p.id}" data-prompt-id="${p.id}" data-status="${esc(p.status)}">
        <div class="prompt-dot ${esc(p.prompt_type)}"></div>
        <div class="prompt-content">
          <div class="prompt-title">${esc(p.title)}</div>
          <div class="prompt-body" id="prompt-body-${p.id}">${esc(p.body)}</div>
          <span class="prompt-expand" onclick="togglePromptBody(${p.id})">more</span>
          <div class="prompt-actions">${actionsHtml}</div>
        </div>
      </div>
    `;
  }).join('');

  // Mark unseen prompts as seen after 2 seconds
  _promptSeenTimers.forEach(t => clearTimeout(t));
  _promptSeenTimers.clear();

  allPrompts.forEach(p => {
    if (p.status === 'active') {
      const timer = setTimeout(() => markPromptSeen(p.id), 2000);
      _promptSeenTimers.set(p.id, timer);
    }
  });
}

function togglePromptBody(id) {
  const body = $(`#prompt-body-${id}`);
  const expander = body.nextElementSibling;
  if (body.classList.contains('expanded')) {
    body.classList.remove('expanded');
    expander.textContent = 'more';
  } else {
    body.classList.add('expanded');
    expander.textContent = 'less';
  }
}

async function markPromptSeen(id) {
  try {
    await api(`/prompts/${id}`, { method: 'PUT', body: { status: 'seen' } });
    const card = $(`#prompt-${id}`);
    if (card) card.dataset.status = 'seen';
    const p = allPrompts.find(x => x.id === id);
    if (p) p.status = 'seen';
    const countData = await api('/prompts/count');
    updatePromptBadge(countData.count || 0);
  } catch (e) {
    // Non-critical
  }
}

async function dismissPrompt(id) {
  const card = $(`#prompt-${id}`);
  if (card) card.classList.add('dismissing');
  try {
    await api(`/prompts/${id}`, { method: 'PUT', body: { status: 'dismissed' } });
  } catch (e) {
    // Non-critical
  }
  setTimeout(() => {
    allPrompts = allPrompts.filter(p => p.id !== id);
    renderPrompts();
  }, 300);
}

function navigateToPromptSource(sourceType, sourceId) {
  if (sourceType === 'goal') {
    navigate('goals');
    setTimeout(() => openGoalDetail(sourceId), 200);
  } else if (sourceType === 'task') {
    navigate('tasks');
  }
}

// blocker_awareness CTA: "Open the goal".
function openGoalFromPrompt(goalId) {
  navigate('goals');
  setTimeout(() => openGoalDetail(goalId), 200);
}

// blocker_awareness CTA: "Mark resolved". One blocker → resolve directly
// with toast undo. Multiple → tiny picker. Zero → tell the user.
async function resolveBlockerFromPrompt(promptId, goalId) {
  let goal;
  try {
    goal = await apiTry(`/goals/${goalId}`);
  } catch (err) {
    apiError(err);
    return;
  }
  const active = (goal.blockers || []).filter(b => !b.resolved);
  if (!active.length) {
    showToast('No active blockers on this goal.');
    return;
  }
  if (active.length === 1) {
    await toggleBlockerResolved(active[0].id, true, {
      surface: 'home',
      goalId,
      blockerName: active[0].blocker_name || '',
      onRefresh: () => loadHome(),
    });
    return;
  }
  openBlockerPicker(active, async (blockerId) => {
    const picked = active.find(b => b.id === blockerId);
    await toggleBlockerResolved(blockerId, true, {
      surface: 'home',
      goalId,
      blockerName: picked ? picked.blocker_name || '' : '',
      onRefresh: () => loadHome(),
    });
  });
}

// Tiny inline picker — appended to body, dismissible via overlay tap.
// Lives outside the prompt card so it's not clipped by the card's
// overflow/padding.
function openBlockerPicker(blockers, onPick) {
  // Strip any existing instance.
  document.querySelectorAll('.blocker-picker-overlay').forEach(el => el.remove());
  const overlay = document.createElement('div');
  overlay.className = 'blocker-picker-overlay';
  overlay.innerHTML = `
    <div class="blocker-picker" role="dialog" aria-label="Pick a blocker to resolve">
      <div class="blocker-picker-title">Which blocker?</div>
      ${blockers.map(b => `
        <button type="button" class="blocker-picker-item" data-blocker-id="${b.id}">
          <span class="blocker-icon blocking">!</span>
          <span class="blocker-name">${esc(b.blocker_name || '(unnamed)')}</span>
          <span class="blocker-type">${esc(b.blocker_type)}</span>
        </button>
      `).join('')}
      <button type="button" class="blocker-picker-cancel">Cancel</button>
    </div>
  `;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('visible'));

  const close = () => {
    overlay.classList.remove('visible');
    setTimeout(() => overlay.remove(), 200);
  };
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector('.blocker-picker-cancel').addEventListener('click', close);
  overlay.querySelectorAll('.blocker-picker-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.dataset.blockerId);
      close();
      onPick(id);
    });
  });
}

function focusBrainDump() {
  homeDump.focus();
  homeDump.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Extract a tag from a knowledge_gap prompt body — first quoted token.
// Handles both straight ("…") and curly (“…” / ‘…’) quotes. Returns null
// when no quoted token is present, so callers can fall back gracefully.
function extractPromptTag(body) {
  if (!body || typeof body !== 'string') return null;
  const m = body.match(/["“‘']([^"”’']{1,60})["”’']/);
  if (!m) return null;
  const raw = m[1].trim().toLowerCase();
  if (!raw) return null;
  // Tags are short single tokens; reject anything that looks like a sentence.
  if (raw.length > 40) return null;
  return raw;
}

function addNoteFromPrompt(promptId) {
  const p = (allPrompts || []).find(x => x.id === promptId);
  const tag = p ? extractPromptTag(p.body) : null;

  const params = new URLSearchParams();
  params.set('addNote', '1');
  if (tag) {
    params.set('tag', tag);
    params.set('prefillTitle', tag);
  }

  // Push the search params (keep current path so the static SPA still loads
  // on refresh) — applyKnowledgeUrlParams() will read and then strip them.
  const newUrl = window.location.pathname + '?' + params.toString();
  window.history.pushState({}, '', newUrl);
  navigate('knowledge');
}

// ══════════════════════════════════════════════════════════
// BRAIN DUMP VIEW
// ══════════════════════════════════════════════════════════

let dumpFilter = 'all';
let allDumps = [];

function updateDumpBadge(count) {
  const badge = $('#dumpBadge');
  if (count > 0) {
    badge.textContent = count;
    badge.classList.add('visible');
  } else {
    badge.classList.remove('visible');
  }
}

async function loadDumps() {
  let params = '';
  if (dumpFilter === 'needs_review') params = '?status=needs_review';
  else if (dumpFilter === 'processed') params = '?status=processed';
  else if (dumpFilter === 'unprocessed') params = '?status=unprocessed';
  allDumps = await api(`/brain-dumps${params}`);
  renderDumps();

  // Update badge count
  const allData = dumpFilter === 'all' ? allDumps : await api('/brain-dumps');
  const reviewCount = (dumpFilter === 'all' ? allDumps : allData).filter(
    d => d.processing_status === 'needs_review'
  ).length;
  updateDumpBadge(reviewCount);
}

// Background-processing contract — Visual states.
// `unprocessed` (legacy) renders identically to `queued`.
function processingStatusLabel(d) {
  const st = d.processing_status || (d.processed ? 'processed' : 'unprocessed');
  if (st === 'queued' || st === 'unprocessed') {
    return `<span class="dump-badge pending" data-dump-status="${esc(st)}">Pending</span>`;
  }
  if (st === 'processing') {
    return `<span class="dump-badge processing" data-dump-status="processing"><span class="dump-badge-spinner"></span>Processing</span>`;
  }
  if (st === 'processed') {
    return `<span class="dump-badge done" data-dump-status="processed">Done</span>`;
  }
  if (st === 'needs_review') {
    return `<span class="dump-badge review" data-dump-status="needs_review">Needs review</span>`;
  }
  if (st === 'failed') {
    return `<span class="dump-badge failed" data-dump-status="failed">Failed</span>`;
  }
  // Defensive — unknown status, render as pending so it never looks terminal.
  return `<span class="dump-badge pending" data-dump-status="${esc(st)}">${esc(st)}</span>`;
}

// Inline button that sits next to a Failed badge.
function retryButton(d) {
  if (d.processing_status !== 'failed') return '';
  return `<button class="dump-retry-btn" data-dump-id="${d.id}" data-action="retry">Retry</button>`;
}

// ── Brain-dump polling (background-processing contract) ─────
// 3s setTimeout recursion (NOT setInterval). Bound to currentView so it
// stops on navigation. Stops once no visible dump is in {queued, unprocessed,
// processing}. Restarts after Retry.
const POLL_INTERVAL_MS = 3000;
const INFLIGHT_STATES = new Set(['queued', 'unprocessed', 'processing']);
let _dumpPollTimer = null;

function _pageShowsDumps() {
  return currentView === 'dump' || currentView === 'home';
}

function _hasInflightDump() {
  // Source list depends on which view is showing dumps.
  if (currentView === 'dump') {
    return allDumps.some(d => INFLIGHT_STATES.has(d.processing_status));
  }
  if (currentView === 'home') {
    const cards = document.querySelectorAll('#homeRecentDumps .dump-badge[data-dump-status]');
    for (const c of cards) {
      if (INFLIGHT_STATES.has(c.dataset.dumpStatus)) return true;
    }
  }
  return false;
}

async function _pollOnce() {
  _dumpPollTimer = null;
  if (!_pageShowsDumps()) return;
  try {
    if (currentView === 'dump') {
      await loadDumps();
    } else if (currentView === 'home') {
      // Only the recent-dumps strip needs refresh; reuse loadHome but it's
      // cheap and also keeps prompts/goals fresh.
      const data = await api('/dashboard');
      renderHome(data);
    }
    // Iris's spec: "the existing 3s poll updates the modal in place".
    // If a dump drawer is open, re-render it from the freshly-loaded
    // allDumps so worker progress (queued -> processing -> processed)
    // shows without forcing the user to close and reopen.
    //
    // Don't-clobber-edit-mode: when the user is in tap-to-edit, skip
    // the re-render entirely. _refreshDumpDetail does a full rebuild of
    // the body, including replacing the textarea node, which would wipe
    // mid-typing input and steal focus. The header staleness during an
    // edit session is the lesser evil; saving or cancelling triggers a
    // fresh render immediately afterwards.
    if (_currentDumpDetailId != null
        && !$('#dumpDetailOverlay').classList.contains('hidden')
        && !_dumpDetailEditing) {
      _refreshDumpDetail();
    }
  } catch (_) {
    // Network error — keep polling; the contract says "polling will resync".
  }
  if (_pageShowsDumps() && _hasInflightDump()) {
    _dumpPollTimer = setTimeout(_pollOnce, POLL_INTERVAL_MS);
  }
}

function startBrainDumpPolling() {
  if (_dumpPollTimer) return; // already polling
  if (!_pageShowsDumps()) return;
  if (!_hasInflightDump()) return;
  _dumpPollTimer = setTimeout(_pollOnce, POLL_INTERVAL_MS);
}

function stopBrainDumpPolling() {
  if (_dumpPollTimer) { clearTimeout(_dumpPollTimer); _dumpPollTimer = null; }
}

// ── Tiny toast (used for retry race feedback) ───────────────
let _toastTimer = null;
function showToast(msg) {
  let el = document.getElementById('lpToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'lpToast';
    el.className = 'lp-toast';
    document.body.appendChild(el);
  }
  el.classList.remove('has-action');
  el.textContent = msg;
  requestAnimationFrame(() => el.classList.add('visible'));
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('visible'), 2800);
}

// ── Blocker UI helpers (shared across hero, goal-detail, prompts) ──
//
// Contract: app/contracts/blockers.md. PUT ${MOUNT}api/blockers/<id>
// with {resolved: bool}. The handler dual-writes resolved + resolved_at.
//
// Render contract: a blocker row is clickable-to-navigate (if it has a
// related entity) and tap-to-resolve (the leading icon is the toggle).
// Resolved rows render dimmed via .blocker--resolved.
function renderBlockerItem(b, opts = {}) {
  // opts: { onResolveRefresh, allowNavigate=true }
  const resolved = !!b.resolved;
  const navigable =
    opts.allowNavigate !== false &&
    (b.blocker_type === 'goal' || b.blocker_type === 'task') &&
    b.blocker_id != null;
  const resolvedTag =
    resolved && b.resolved_at
      ? `<span class="blocker-resolved-tag">resolved ${esc(fmtRelative(b.resolved_at))}</span>`
      : '';
  return `
    <div class="blocker-item ${resolved ? 'blocker--resolved' : ''} ${
    navigable ? 'blocker--navigable' : ''
  }" data-blocker-id="${b.id}" data-blocker-type="${esc(b.blocker_type)}" data-blocker-target-id="${b.blocker_id ?? ''}">
      <button type="button" class="blocker-toggle" data-action="toggle-resolve"
              aria-label="${resolved ? 'Mark unresolved' : 'Mark resolved'}"
              aria-pressed="${resolved}">
        <span class="blocker-icon ${resolved ? 'resolved' : 'blocking'}">${
    resolved ? '✓' : '!'
  }</span>
      </button>
      <span class="blocker-name" data-action="${navigable ? 'navigate' : ''}">${esc(b.blocker_name || '(unnamed)')}</span>
      <span class="blocker-type">${esc(b.blocker_type)}</span>
      ${b.blocker_status && !resolved ? statusPill(b.blocker_status) : ''}
      ${resolvedTag}
    </div>`;
}

// Wires up tap-to-resolve and click-to-navigate within a container that
// has rendered .blocker-item rows via renderBlockerItem(). Idempotent —
// safe to call after each re-render (binds via closure on the elements
// that exist now).
function bindBlockerItems(container, opts = {}) {
  const root = typeof container === 'string' ? document.querySelector(container) : container;
  if (!root) return;
  root.querySelectorAll('.blocker-item').forEach(row => {
    const blockerId = parseInt(row.dataset.blockerId);
    const blockerType = row.dataset.blockerType;
    const targetId = row.dataset.blockerTargetId
      ? parseInt(row.dataset.blockerTargetId)
      : null;

    // Resolve toggle — leading icon button.
    const toggle = row.querySelector('[data-action="toggle-resolve"]');
    if (toggle) {
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasResolved = row.classList.contains('blocker--resolved');
        toggleBlockerResolved(blockerId, !wasResolved, {
          onRefresh: opts.onRefresh,
          row,
          // Surface/goalId thread through so the persistent undo chip
          // knows which canvas to pin to and where to refresh on undo.
          surface: opts.surface,
          goalId: opts.goalId,
          blockerName: row.querySelector('.blocker-name')?.textContent,
        });
      });
    }

    // Whole-row click navigates when navigable. Skipped on the toggle.
    if (row.classList.contains('blocker--navigable')) {
      row.addEventListener('click', (e) => {
        if (e.target.closest('[data-action="toggle-resolve"]')) return;
        e.stopPropagation();
        navigateToBlockerTarget(blockerType, targetId);
      });
    }
  });
}

function navigateToBlockerTarget(blockerType, targetId) {
  if (!targetId) return;
  if (blockerType === 'goal') {
    // Close the goal-detail modal first if it's open — opening another
    // goal detail on top of itself looks broken.
    const existing = document.querySelector('#goalDetailOverlay.visible');
    if (existing) closeModal($('#goalDetailOverlay'));
    setTimeout(() => openGoalDetail(targetId), existing ? 220 : 0);
  } else if (blockerType === 'task') {
    // No task-detail modal yet; navigate to the tasks list.
    navigate('tasks');
  }
  // external_system has no detail surface — silent no-op.
}

// ── Persistent "Undo last resolve" chip ─────────────────────
// Iris paper-cut #2: the 5-second undo toast disappears too fast. The
// toast still fires (immediate, low-friction); this chip is the
// longer-tail safety net — pinned to the surface where the resolve
// happened, visible until clicked or the window (30 minutes) expires.
//
// Only `mark resolved` actions land in here — un-resolves (the
// "I clicked the wrong row" path) don't need their own undo affordance
// because the un-resolve action is already itself an undo.
const UNDO_CHIP_WINDOW_MS = 30 * 60 * 1000;
let _lastResolvedBlocker = null; // {id, blockerName, surface, resolvedAt}

function _surfaceContainer(surface) {
  if (surface === 'home') return document.getElementById('homeHero');
  if (surface === 'goal-detail') return document.getElementById('goalDetailBody');
  return null;
}

// Idempotent: removes any stale chip first, then re-renders fresh state.
function renderUndoResolveChip(surface) {
  // Strip every chip on the page first — there should only ever be one
  // visible, on the active surface. (Re-renders of either surface call
  // through here on each refresh.)
  document.querySelectorAll('.undo-resolve-chip').forEach(el => el.remove());

  const last = _lastResolvedBlocker;
  if (!last) return;
  if (last.surface !== surface) return;
  if (Date.now() - last.resolvedAt > UNDO_CHIP_WINDOW_MS) {
    _lastResolvedBlocker = null;
    return;
  }
  const container = _surfaceContainer(surface);
  if (!container) return;

  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'undo-resolve-chip';
  chip.setAttribute('aria-label', 'Undo last resolve');
  const name = last.blockerName ? `"${last.blockerName}"` : 'last blocker';
  chip.innerHTML =
    `<span class="undo-resolve-chip-arrow">↶</span>` +
    `<span>Undo resolving ${esc(name)}</span>`;
  chip.addEventListener('click', async (e) => {
    e.stopPropagation();
    // Capture before clearing — the un-resolve refreshes the surface,
    // which calls renderUndoResolveChip again and would otherwise see
    // stale state.
    const target = _lastResolvedBlocker;
    _lastResolvedBlocker = null;
    chip.remove();
    if (!target) return;
    // Fire the inverse. Surface refreshes the surface that originated it.
    await toggleBlockerResolved(target.id, false, {
      onRefresh:
        target.surface === 'goal-detail'
          ? () => openGoalDetail(target.goalId)
          : () => loadHome(),
      _isUndoChip: true, // suppress re-recording
    });
  });
  container.appendChild(chip);
}

// Optimistic resolve / un-resolve with toast undo.
//
// `nextResolved` is the desired post-click state (true = mark resolved).
// On success we update row classes + the toast offers Undo for ~5s.
// On failure we revert + show a generic error toast.
async function toggleBlockerResolved(blockerId, nextResolved, opts = {}) {
  const row = opts.row || document.querySelector(`.blocker-item[data-blocker-id="${blockerId}"]`);
  // Optimistic flip — class only; the next refresh will re-render with
  // the resolved_at timestamp tag.
  if (row) {
    row.classList.toggle('blocker--resolved', nextResolved);
    const icon = row.querySelector('.blocker-icon');
    if (icon) {
      icon.classList.toggle('resolved', nextResolved);
      icon.classList.toggle('blocking', !nextResolved);
      icon.textContent = nextResolved ? '✓' : '!';
    }
  }
  try {
    await apiTry(`/blockers/${blockerId}`, {
      method: 'PUT',
      body: { resolved: nextResolved },
    });
    // Success — offer Undo via toast.
    _toastWithAction(
      nextResolved ? 'Marked resolved.' : 'Marked unresolved.',
      'Undo',
      () => toggleBlockerResolved(blockerId, !nextResolved, opts),
    );
    // Record for the persistent undo chip — only on the resolve direction
    // (un-resolves are themselves undos). Skip when the click came from
    // the undo chip itself (would re-arm the chip immediately otherwise).
    if (nextResolved && !opts._isUndoChip) {
      const blockerName =
        opts.blockerName ||
        (row ? row.querySelector('.blocker-name')?.textContent : null) ||
        '';
      _lastResolvedBlocker = {
        id: blockerId,
        blockerName,
        surface: opts.surface || 'home',
        goalId: opts.goalId || null,
        resolvedAt: Date.now(),
      };
    }
    if (typeof opts.onRefresh === 'function') opts.onRefresh();
  } catch (err) {
    // Revert.
    if (row) {
      row.classList.toggle('blocker--resolved', !nextResolved);
      const icon = row.querySelector('.blocker-icon');
      if (icon) {
        icon.classList.toggle('resolved', !nextResolved);
        icon.classList.toggle('blocking', nextResolved);
        icon.textContent = !nextResolved ? '✓' : '!';
      }
    }
    if (err && err.status === 404) {
      showToast('That blocker is no longer here.');
      if (typeof opts.onRefresh === 'function') opts.onRefresh();
    } else {
      showToast(nextResolved ? "Couldn't mark resolved." : "Couldn't undo.");
    }
  }
}

// ── Retry handler (background-processing contract) ──────────
async function retryBrainDump(id) {
  const dump = allDumps.find(d => d.id === id);
  // Optimistic flip — mutate local model, re-render, then fire request.
  if (dump) dump.processing_status = 'queued';
  if (currentView === 'dump') renderDumps();
  // On home, the dump lives in dashboard data not allDumps. Flip the
  // badge in place so the user sees the state change without waiting
  // for the next 3s poll.
  if (currentView === 'home') {
    const homeBadge = document.querySelector(
      `#homeRecentDumps .dump-item .dump-badge[data-dump-status="failed"]`,
    );
    // Best-effort: if there's exactly one failed badge in the list,
    // flip its label. Otherwise the polling round will resync.
    if (homeBadge) {
      homeBadge.dataset.dumpStatus = 'queued';
      homeBadge.className = 'dump-badge pending';
      homeBadge.textContent = 'Pending';
    }
    const retryBtn = document.querySelector(
      `#homeRecentDumps .dump-retry-btn[data-dump-id="${id}"]`,
    );
    if (retryBtn) retryBtn.remove();
  }
  try {
    const res = await fetch(`${MOUNT}api/brain-dumps/${id}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (res.status === 401) { window.location.href = `${MOUNT}login`; return; }
    if (res.status === 202) {
      // Optimistic flip already applied; just kick polling.
      startBrainDumpPolling();
      return;
    }
    if (res.status === 409) {
      showToast('Could not retry: already in progress.');
      // Resync from server so badge reflects truth.
      if (currentView === 'dump') loadDumps();
      else if (currentView === 'home') loadHome();
      return;
    }
    if (res.status === 404) {
      showToast('That dump no longer exists.');
      if (currentView === 'dump') loadDumps();
      return;
    }
    showToast('Retry failed.');
    // Roll the badge back to failed.
    if (dump) dump.processing_status = 'failed';
    if (currentView === 'dump') renderDumps();
  } catch (_) {
    showToast('Network error.');
    if (dump) dump.processing_status = 'failed';
    if (currentView === 'dump') renderDumps();
  }
}

function processingResultsPills(d) {
  if (!d.processed_items || !d.processed_items.items) return '';
  const items = d.processed_items.items;
  const counts = {};
  const itemsByCategory = {};
  items.forEach(i => {
    if (i.status === 'auto_created' || i.status === 'approved') {
      const t = i.type;
      // For goal_link, only count if something was actually linked
      if (t === 'goal_link' && !i.created_id) return;
      const label = t === 'person_mention' ? 'people' :
                    t === 'person_new' ? 'people' :
                    t === 'goal_link' ? 'goals' :
                    t === 'goal_new' ? 'goals' :
                    t === 'knowledge' ? 'knowledge' :
                    t === 'tag' ? 'tags' :
                    t === 'task' ? 'tasks' : t;
      counts[label] = (counts[label] || 0) + 1;
      if (!itemsByCategory[label]) itemsByCategory[label] = [];
      itemsByCategory[label].push(i);
    }
  });
  if (Object.keys(counts).length === 0) return '';
  const singulars = { tasks: 'task', people: 'person', knowledge: 'knowledge', tags: 'tag', goals: 'goal' };
  const dumpId = d.id || 0;
  const pills = Object.entries(counts).map(([label, count]) => {
    const display = count === 1 ? (singulars[label] || label) : label;
    return `<span class="result-pill result-pill-clickable ${esc(label)}" data-dump-id="${dumpId}" data-category="${esc(label)}">${count} ${esc(display)}</span>`;
  }).join('');
  const detailItems = Object.entries(itemsByCategory).map(([label, catItems]) => {
    return catItems.map(i => {
      const t = i.type;
      const data = i.data || {};
      let title = '';
      let viewTarget = '';
      if (t === 'task') { title = data.title || 'Untitled task'; viewTarget = 'tasks'; }
      else if (t === 'goal_link') { title = data.goal_title || 'Linked goal'; viewTarget = 'goals'; }
      else if (t === 'goal_new') { title = data.title || 'New goal'; viewTarget = 'goals'; }
      else if (t === 'person_new') { title = data.name || 'New person'; viewTarget = 'people'; }
      else if (t === 'person_mention') { title = data.person_name || 'Person'; viewTarget = 'people'; }
      else if (t === 'knowledge') { title = data.title || 'Knowledge'; viewTarget = 'knowledge'; }
      else if (t === 'tag') { title = data.tag_name || 'Tag'; viewTarget = ''; }
      else { title = data.title || data.name || t; viewTarget = ''; }
      const typeLabel = t === 'person_mention' ? 'person' :
                        t === 'person_new' ? 'person' :
                        t === 'goal_link' ? 'goal' :
                        t === 'goal_new' ? 'goal' : t;
      const goalId = (t === 'goal_link' || t === 'goal_new') ? (i.created_id || '') : '';
      return `<div class="result-detail-item" data-view="${esc(viewTarget)}" data-goal-id="${goalId}">
        <span class="result-detail-type ${esc(label)}">${esc(typeLabel)}</span>
        <span class="result-detail-title">${esc(title)}</span>
      </div>`;
    }).join('');
  }).join('');
  return `<div class="processing-results" data-dump-id="${dumpId}">${pills}</div>
    <div class="result-details" id="resultDetails-${dumpId}" style="display:none">${detailItems}</div>`;
}

function bindResultPills(container) {
  const el = typeof container === 'string' ? $(container) : container;
  if (!el) return;
  el.querySelectorAll('.result-pill-clickable').forEach(pill => {
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      const dumpId = pill.dataset.dumpId;
      const detailsEl = el.querySelector(`#resultDetails-${dumpId}`);
      if (!detailsEl) return;
      const isVisible = detailsEl.style.display !== 'none';
      // Close all other open details in this container
      el.querySelectorAll('.result-details').forEach(d => d.style.display = 'none');
      el.querySelectorAll('.result-pill-clickable').forEach(p => p.classList.remove('active'));
      if (!isVisible) {
        detailsEl.style.display = 'block';
        pill.classList.add('active');
      }
    });
  });
  // Bind navigation on detail items
  el.querySelectorAll('.result-detail-item').forEach(item => {
    const viewTarget = item.dataset.view;
    if (!viewTarget) return;
    item.style.cursor = 'pointer';
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const goalId = item.dataset.goalId;
      if (viewTarget === 'goals' && goalId) {
        navigate('goals');
        setTimeout(() => openGoalDetail(parseInt(goalId)), 200);
      } else {
        navigate(viewTarget);
      }
    });
  });
}

function renderDumps() {
  const el = $('#dumpList');
  if (!allDumps.length) {
    el.innerHTML = `<div class="empty-state"><p>No brain dumps yet</p><p class="hint">Type something above and hit Capture</p></div>`;
    return;
  }
  el.innerHTML = allDumps.map(d => {
    const needsReview = d.processing_status === 'needs_review';
    const suggestedCount = needsReview && d.processed_items && d.processed_items.items
      ? d.processed_items.items.filter(i => i.status === 'suggested').length
      : 0;
    return `
      <div class="dump-item dump-item-clickable fade-in" data-dump-id="${d.id}" role="button" tabindex="0">
        <div class="dump-item-header">
          <span class="dump-time">${fmtRelative(d.captured_at)}</span>
          ${processingStatusLabel(d)}
          ${retryButton(d)}
          <span style="flex:1"></span>
          ${needsReview && suggestedCount > 0 ? `
            <span class="dump-suggest-count">${suggestedCount} pending</span>
          ` : ''}
          ${d.processing_status === 'unprocessed' ? `
            <span class="dump-toggle" data-dump-id="${d.id}" data-action="process">Process</span>
          ` : ''}
          ${actionsHtml('', 'deleteBrainDump(' + d.id + ')')}
        </div>
        <div class="dump-item-content">${esc(d.content)}</div>
        ${processingResultsPills(d)}
        ${tagsHtml(d.tags)}
      </div>
    `;
  }).join('');

  // Whole-row click opens the detail drawer. Skip when click originates
  // from a control inside the row (action menu, retry button, process
  // toggle, result pills, tag chips) so those keep their own behaviour.
  el.querySelectorAll('.dump-item-clickable').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.card-actions')) return;
      if (e.target.closest('.dump-retry-btn')) return;
      if (e.target.closest('.dump-toggle')) return;
      if (e.target.closest('.result-pill-clickable')) return;
      if (e.target.closest('.result-detail-item')) return;
      if (e.target.closest('.tag-chip')) return;
      const dumpId = parseInt(row.dataset.dumpId);
      const dump = allDumps.find(d => d.id === dumpId);
      if (dump) openDumpDetail(dump);
    });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const dumpId = parseInt(row.dataset.dumpId);
        const dump = allDumps.find(d => d.id === dumpId);
        if (dump) openDumpDetail(dump);
      }
    });
  });

  // Bind process buttons
  el.querySelectorAll('.dump-toggle[data-action="process"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.dumpId;
      btn.textContent = 'Processing...';
      btn.style.pointerEvents = 'none';
      await api(`/brain-dumps/${id}/process`, { method: 'POST' });
      loadDumps();
    });
  });

  // Bind retry buttons (failed rows)
  el.querySelectorAll('.dump-retry-btn[data-action="retry"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.dataset.dumpId);
      btn.disabled = true;
      retryBrainDump(id);
    });
  });

  // Bind clickable result pills
  bindResultPills(el);

  // Polling: kick off if any visible dump is in flight; stop otherwise.
  if (_hasInflightDump()) startBrainDumpPolling();
  else stopBrainDumpPolling();
}

// Dump filter pills
$('#dumpFilters').addEventListener('click', e => {
  const pill = e.target.closest('.filter-pill');
  if (!pill) return;
  dumpFilter = pill.dataset.filter;
  $('#dumpFilters').querySelectorAll('.filter-pill').forEach(p => p.classList.toggle('active', p.dataset.filter === dumpFilter));
  loadDumps();
});

// Dump input (on dump view)
const dumpInput = $('#dumpInput');
const dumpSend = $('#dumpSend');
const dumpSuccess = $('#dumpSuccess');
const dumpStatus = $('#dumpStatus');

dumpInput.addEventListener('input', () => {
  dumpSend.classList.toggle('visible', dumpInput.value.trim().length > 0);
  autoResize(dumpInput);
});

dumpSend.addEventListener('click', async () => {
  const content = dumpInput.value.trim();
  if (!content) return;

  // Phase 1: immediate feedback
  dumpSend.disabled = true;
  dumpSend.textContent = 'Capturing...';
  dumpInput.value = '';
  dumpSend.classList.remove('visible');
  autoResize(dumpInput);
  showDumpStatus(dumpStatus, 'processing', 'Capturing...');

  try {
    const result = await api('/brain-dumps', { method: 'POST', body: { content } });

    if (result && result.error) {
      showDumpStatus(dumpStatus, 'error', 'Couldn’t save dump. Try again.');
    } else {
      // 202 Accepted — dump queued; worker will process in background.
      showDumpStatus(dumpStatus, 'success', 'Captured. Processing in background.');
      scheduleDumpStatusClear(dumpStatus, 3500);
    }

    // loadDumps() will renderDumps() which kicks polling if anything in flight.
    loadDumps();
  } catch (err) {
    showDumpStatus(dumpStatus, 'error', 'Something went wrong. Your text has been saved — try refreshing.');
  } finally {
    dumpSend.disabled = false;
    dumpSend.textContent = 'Capture';
  }
});

// ══════════════════════════════════════════════════════════
// DUMP DETAIL DRAWER
// ──────────────────────────────────────────────────────────
// Iris's design (docs/ux-design/2026-04-27-brain-dump-detail.md):
// the dump stops being a one-way drop box. Tap any captured thought
// and you land here. Subsumes the old review modal entirely.
// ══════════════════════════════════════════════════════════

let _currentDumpDetailId = null;
let _dumpDetailEditing = false;

function confidenceLabel(conf) {
  if (conf >= 0.80) return 'likely';
  if (conf >= 0.65) return 'maybe';
  return 'uncertain';
}

function reviewItemTitle(item) {
  const t = item.type;
  const d = item.data || {};
  if (t === 'task') return d.title || 'Untitled task';
  if (t === 'knowledge') return d.title || 'Untitled knowledge';
  if (t === 'person_new') return `New person: ${d.name || 'Unknown'}`;
  if (t === 'person_mention') return `Mention: ${d.person_name || 'Unknown'}`;
  if (t === 'tag') return `Tag: ${d.tag_name || ''}`;
  if (t === 'goal_link') return `Link to: ${d.goal_title || 'Unknown goal'}`;
  if (t === 'goal_new') return `New goal: ${d.title || 'Unknown goal'}`;
  return t;
}

function reviewItemTypeLabel(type) {
  const labels = {
    'task': 'Task',
    'knowledge': 'Knowledge',
    'person_new': 'Person',
    'person_mention': 'Person',
    'tag': 'Tag',
    'goal_link': 'Goal',
    'goal_new': 'Goal',
  };
  return labels[type] || type;
}

// Pretty exact-time line under the relative timestamp.
function _dumpDetailExactTime(ts) {
  if (!ts) return '';
  const d = new Date(ts.replace(' ', 'T') + 'Z');
  return d.toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit',
  });
}

// Open the detail drawer for a dump. Caller supplies a dump row from
// allDumps (or a freshly fetched one). The drawer subscribes to
// _currentDumpDetailId so polling can re-render in place.
function openDumpDetail(dump) {
  if (!dump) return;
  _currentDumpDetailId = dump.id;
  _dumpDetailEditing = false;
  renderDumpDetail(dump);
  openModal($('#dumpDetailOverlay'));
}

// Re-render the currently-open dump detail from the latest allDumps.
// Called after polling, after action mutations, after edits.
function _refreshDumpDetail() {
  if (_currentDumpDetailId == null) return;
  const dump = allDumps.find(d => d.id === _currentDumpDetailId);
  if (!dump) return;
  renderDumpDetail(dump);
}

// Single render path — header, body, items, footer.
function renderDumpDetail(dump) {
  const status = dump.processing_status || 'unprocessed';
  const items = (dump.processed_items && dump.processed_items.items) || [];

  // ── Header (timestamp + status + primary action) ─────────
  $('#dumpDetailTime').textContent = `Captured ${fmtRelative(dump.captured_at)}`;
  const errorLine = (status === 'failed' && dump.processing_error)
    ? ` · <span class="dump-detail-error">${esc(dump.processing_error)}</span>`
    : '';
  $('#dumpDetailMeta').innerHTML =
    `${esc(_dumpDetailExactTime(dump.captured_at))} · ${processingStatusLabel(dump)}${errorLine}`;

  // Top-of-modal primary action: Retry (failed) / Re-process (terminal).
  // Hidden during in-flight states.
  const headerActions = $('#dumpDetailHeaderActions');
  headerActions.innerHTML = '';
  if (status === 'failed') {
    const btn = document.createElement('button');
    btn.className = 'btn-primary dump-detail-primary';
    btn.textContent = 'Retry';
    btn.addEventListener('click', () => _dumpDetailRetryDump(dump.id));
    headerActions.appendChild(btn);
  } else if (status === 'processed' || status === 'needs_review') {
    const btn = document.createElement('button');
    btn.className = 'btn dump-detail-primary';
    btn.textContent = 'Re-process';
    btn.addEventListener('click', () => _dumpDetailReprocessDump(dump.id));
    headerActions.appendChild(btn);
  }

  // ── Body: content (read or edit) + items section ─────────
  const body = $('#dumpDetailBody');

  const contentBlock = _dumpDetailEditing
    ? _renderDumpDetailContentEdit(dump)
    : _renderDumpDetailContentRead(dump);

  const inflight = status === 'queued' || status === 'unprocessed' || status === 'processing';

  let itemsBlock;
  if (inflight) {
    const msg = status === 'processing' ? 'Processing now…' : 'Waiting in the queue.';
    itemsBlock = `
      <div class="dump-detail-section">
        <div class="dump-detail-pending-card">
          <span class="dump-badge-spinner"></span>
          <span>${esc(msg)}</span>
        </div>
      </div>`;
  } else {
    itemsBlock = _renderDumpDetailItems(dump, items, status);
  }

  body.innerHTML = `
    ${contentBlock}
    ${itemsBlock}
  `;

  _bindDumpDetailContent(dump);
  _bindDumpDetailItems(dump);

  // ── Footer: Delete (right) ───────────────────────────────
  $('#dumpDetailFooter').innerHTML = `
    <button class="btn-text btn-text-danger" id="dumpDetailDelete">Delete dump</button>
  `;
  $('#dumpDetailDelete').addEventListener('click', () => _dumpDetailDelete(dump.id));
}

function _renderDumpDetailContentRead(dump) {
  const status = dump.processing_status || 'unprocessed';
  const editDisabled = status === 'processing';
  const editTitle = editDisabled ? 'Wait for the current pass to finish.' : 'Edit content';
  return `
    <div class="dump-detail-section">
      <div class="dump-detail-content" id="dumpDetailContent">${esc(dump.content)}</div>
      <div class="dump-detail-content-actions">
        <button class="btn-text dump-detail-edit-btn" id="dumpDetailEditBtn"
                ${editDisabled ? 'disabled' : ''} title="${esc(editTitle)}">Edit</button>
      </div>
    </div>`;
}

function _renderDumpDetailContentEdit(dump) {
  return `
    <div class="dump-detail-section">
      <textarea class="form-textarea dump-detail-edit-textarea" id="dumpDetailEditTextarea">${esc(dump.content)}</textarea>
      <div class="dump-detail-edit-actions">
        <button class="btn" id="dumpDetailEditCancel">Cancel</button>
        <button class="btn-primary" id="dumpDetailEditSaveReprocess">Save &amp; re-process</button>
      </div>
    </div>`;
}

// Group items by status, render per-status sections in fixed order:
// Pending review · Created · Failed · Rejected. (`needs_review` floats
// pending to the top.) Empty groups are omitted.
function _renderDumpDetailItems(dump, items, dumpStatus) {
  if (!items.length) {
    return `
      <div class="dump-detail-section">
        <div class="dump-detail-section-title">Items</div>
        <div class="empty-state" style="padding:16px 0">
          <p>No items extracted.</p>
        </div>
      </div>`;
  }

  const indexed = items.map((item, idx) => ({ ...item, _index: idx }));
  const created = indexed.filter(i => i.status === 'auto_created' || i.status === 'approved');
  const pending = indexed.filter(i => i.status === 'suggested');
  const failed = indexed.filter(i => i.status === 'failed');
  const rejected = indexed.filter(i => i.status === 'rejected');

  // Order: needs_review puts Pending first; otherwise Created first.
  const groups = (dumpStatus === 'needs_review')
    ? [
        ['pending', 'Pending review', pending],
        ['created', 'Created', created],
        ['failed', 'Failed', failed],
        ['rejected', 'Rejected', rejected],
      ]
    : [
        ['created', 'Created', created],
        ['pending', 'Pending review', pending],
        ['failed', 'Failed', failed],
        ['rejected', 'Rejected', rejected],
      ];

  const showConfidence = pending.length >= 6;

  const sections = groups
    .filter(([_k, _label, list]) => list.length > 0)
    .map(([key, label, list]) => {
      const rows = list.map(i => _renderDumpDetailItemRow(i, key, showConfidence)).join('');
      return `
        <div class="dump-detail-items-group">
          <div class="dump-detail-section-title">${esc(label)} <span class="dump-detail-section-count">(${list.length})</span></div>
          ${rows}
        </div>`;
    }).join('');

  return `
    <div class="dump-detail-section dump-detail-items">
      ${sections}
    </div>`;
}

// Per-item row. The `groupKey` controls which actions are shown.
function _renderDumpDetailItemRow(item, groupKey, showConfidence) {
  const t = item.type;
  const idx = item._index;
  const typeLabel = reviewItemTypeLabel(t);
  const title = reviewItemTitle(item);

  const isLaunch = (groupKey === 'created') &&
    (t === 'task' || t === 'goal_link' || t === 'goal_new' ||
     t === 'person_new' || t === 'person_mention' ||
     t === 'knowledge' || t === 'tag');

  const sourceQuote =
    (groupKey === 'pending' || groupKey === 'failed') && item.source_text
      ? `<div class="dump-detail-item-quote">"${esc(String(item.source_text).substring(0, 200))}"</div>`
      : '';

  const confidence = (groupKey === 'pending' && showConfidence)
    ? `<span class="dump-detail-item-confidence">${esc(confidenceLabel(item.confidence || 0))}</span>`
    : '';

  const errorLine = (groupKey === 'failed' && item.error_class)
    ? `<div class="dump-detail-item-error">${esc(item.error_class)}</div>`
    : '';

  let actions = '';
  if (groupKey === 'pending') {
    actions = `
      <div class="dump-detail-item-actions">
        <button class="btn-approve" data-action="approve" data-index="${idx}">Approve</button>
        <button class="btn-dismiss" data-action="reject" data-index="${idx}">Reject</button>
      </div>`;
  } else if (groupKey === 'failed') {
    actions = `
      <div class="dump-detail-item-actions">
        <button class="btn-approve" data-action="retry" data-index="${idx}">Retry</button>
        <button class="btn-dismiss" data-action="reject-failed" data-index="${idx}">Reject</button>
      </div>`;
  } else if (groupKey === 'rejected') {
    actions = `
      <div class="dump-detail-item-actions">
        <button class="btn" data-action="unreject" data-index="${idx}">↶ Un-reject</button>
      </div>`;
  }

  const launchAttr = isLaunch ? `data-launch="1"` : '';
  const chev = isLaunch
    ? `<span class="dump-detail-item-chev" aria-hidden="true">›</span>`
    : '';

  return `
    <div class="dump-detail-item ${esc('item-status-' + groupKey)}" data-item-index="${idx}" data-item-type="${esc(t)}" ${launchAttr}>
      <div class="dump-detail-item-row">
        <span class="review-type-badge ${esc(t)}">${esc(typeLabel)}</span>
        <span class="dump-detail-item-title">${esc(title)}</span>
        ${confidence}
        ${chev}
      </div>
      ${sourceQuote}
      ${errorLine}
      ${actions}
    </div>`;
}

function _bindDumpDetailContent(dump) {
  if (_dumpDetailEditing) {
    const textarea = $('#dumpDetailEditTextarea');
    if (textarea) {
      autoResize(textarea);
      textarea.addEventListener('input', () => autoResize(textarea));
      // Defer focus so the drawer transition doesn't fight it.
      setTimeout(() => textarea.focus(), 50);
    }
    const cancel = $('#dumpDetailEditCancel');
    if (cancel) cancel.addEventListener('click', () => {
      _dumpDetailEditing = false;
      _refreshDumpDetail();
    });
    const saveAndProcess = $('#dumpDetailEditSaveReprocess');
    if (saveAndProcess) saveAndProcess.addEventListener('click', () => {
      const newText = textarea ? textarea.value : '';
      _dumpDetailSaveAndReprocess(dump.id, newText);
    });
  } else {
    const editBtn = $('#dumpDetailEditBtn');
    if (editBtn && !editBtn.disabled) {
      editBtn.addEventListener('click', () => {
        _dumpDetailEditing = true;
        _refreshDumpDetail();
      });
    }
  }
}

function _bindDumpDetailItems(dump) {
  // Whole-row launch for created/approved items.
  $('#dumpDetailBody').querySelectorAll('.dump-detail-item[data-launch="1"]').forEach(row => {
    row.addEventListener('click', (e) => {
      // Don't intercept clicks on inline buttons.
      if (e.target.closest('button')) return;
      const idx = parseInt(row.dataset.itemIndex);
      const item = (dump.processed_items && dump.processed_items.items[idx]) || null;
      if (item) _dumpDetailLaunchEntity(item);
    });
  });

  // Per-item action buttons.
  $('#dumpDetailBody').querySelectorAll('.dump-detail-item button[data-action]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const idx = parseInt(btn.dataset.index);
      btn.disabled = true;
      const originalLabel = btn.textContent;
      btn.textContent = '…';
      try {
        if (action === 'approve') {
          await _dumpDetailItemAction(dump.id, idx, 'approve');
        } else if (action === 'reject') {
          await _dumpDetailItemAction(dump.id, idx, 'reject');
        } else if (action === 'retry') {
          await _dumpDetailItemAction(dump.id, idx, 'retry');
        } else if (action === 'reject-failed') {
          // Failed → Rejected. Backend has no precondition gate on
          // reject (per contract); accept the failure as a non-issue.
          await _dumpDetailItemAction(dump.id, idx, 'reject');
        } else if (action === 'unreject') {
          await _dumpDetailItemAction(dump.id, idx, 'unreject');
        }
      } catch (err) {
        btn.disabled = false;
        btn.textContent = originalLabel;
        apiError(err);
      }
    });
  });
}

// Open the entity surface for a created/approved item. blocker and
// dependency types have no detail surface today (per spec, render text
// only). Tag uses the existing drawer; goals open the goal-detail
// modal *over* this drawer (lateral navigation). Other types navigate
// to the relevant list view as a fallback until per-item detail
// surfaces ship.
function _dumpDetailLaunchEntity(item) {
  const t = item.type;
  const data = item.data || {};
  const id = item.created_id;
  if (t === 'tag') {
    if (id) openTagDrawer(id);
    return;
  }
  if (t === 'goal_link' || t === 'goal_new') {
    if (id) openGoalDetail(id);
    return;
  }
  if (t === 'task') {
    closeModal($('#dumpDetailOverlay'));
    setTimeout(() => navigate('tasks'), 50);
    return;
  }
  if (t === 'knowledge') {
    closeModal($('#dumpDetailOverlay'));
    setTimeout(() => navigate('knowledge'), 50);
    return;
  }
  if (t === 'person_new' || t === 'person_mention') {
    closeModal($('#dumpDetailOverlay'));
    setTimeout(() => navigate('people'), 50);
    return;
  }
  // Unknown — silent.
}

// ── Mutation helpers ────────────────────────────────────
// All five flow through apiTry() so we can revert + apiError() on
// failure. Optimistic where possible: items flip immediately, then
// the server's response replaces local state on success.

async function _dumpDetailItemAction(dumpId, itemIndex, action) {
  // Optimistic flip — mutate local model + re-render.
  const dump = allDumps.find(d => d.id === dumpId);
  if (!dump || !dump.processed_items || !dump.processed_items.items) return;
  const item = dump.processed_items.items[itemIndex];
  if (!item) return;
  const prevStatus = item.status;
  const optimisticStatus = (
    action === 'approve' ? 'approved' :
    action === 'reject' ? 'rejected' :
    action === 'retry' ? 'approved' :
    action === 'unreject' ? 'suggested' :
    null
  );
  if (optimisticStatus) item.status = optimisticStatus;
  _refreshDumpDetail();
  try {
    const updated = await apiTry(`/brain-dumps/${dumpId}/approve-item`, {
      method: 'POST',
      body: { item_index: itemIndex, action },
    });
    // Server returns the updated dump row. Sync local state.
    if (updated && updated.id === dumpId) {
      const i = allDumps.findIndex(d => d.id === dumpId);
      if (i !== -1) allDumps[i] = updated;
      _refreshDumpDetail();
      // Update background list/badge if applicable.
      if (currentView === 'dump') renderDumps();
      const reviewCount = allDumps.filter(d => d.processing_status === 'needs_review').length;
      updateDumpBadge(reviewCount);
    } else {
      // Defensive: re-fetch.
      await loadDumps();
      _refreshDumpDetail();
    }
  } catch (err) {
    // Revert.
    item.status = prevStatus;
    _refreshDumpDetail();
    if (err && err.status === 409) {
      showToast('That item has already changed.');
      await loadDumps();
      _refreshDumpDetail();
      return;
    }
    apiError(err);
    throw err;
  }
}

async function _dumpDetailReprocessDump(dumpId) {
  try {
    await apiTry(`/brain-dumps/${dumpId}/process`, { method: 'POST', body: {} });
    showToast('Re-processing.');
    await loadDumps();
    _refreshDumpDetail();
    startBrainDumpPolling();
  } catch (err) {
    apiError(err);
  }
}

async function _dumpDetailRetryDump(dumpId) {
  try {
    await apiTry(`/brain-dumps/${dumpId}/retry`, { method: 'POST', body: {} });
    showToast('Retrying.');
    await loadDumps();
    _refreshDumpDetail();
    startBrainDumpPolling();
  } catch (err) {
    if (err && err.status === 409) {
      showToast('Could not retry: not in failed state.');
      await loadDumps();
      _refreshDumpDetail();
      return;
    }
    apiError(err);
  }
}

async function _dumpDetailSaveAndReprocess(dumpId, newContent) {
  if (!newContent || !newContent.trim()) {
    showToast('Content cannot be empty.');
    return;
  }
  try {
    await apiTry(`/brain-dumps/${dumpId}`, {
      method: 'PUT',
      body: { content: newContent },
    });
    await apiTry(`/brain-dumps/${dumpId}/process`, { method: 'POST', body: {} });
    _dumpDetailEditing = false;
    showToast('Saved. Re-processing.');
    await loadDumps();
    _refreshDumpDetail();
    startBrainDumpPolling();
  } catch (err) {
    apiError(err);
  }
}

async function _dumpDetailDelete(dumpId) {
  if (!confirm('Delete this brain dump? This cannot be undone.')) return;
  try {
    await apiTry(`/brain-dumps/${dumpId}`, { method: 'DELETE' });
    closeModal($('#dumpDetailOverlay'));
    _currentDumpDetailId = null;
    if (currentView === 'dump') loadDumps();
    else if (currentView === 'home') loadHome();
  } catch (err) {
    apiError(err);
  }
}

// Close handlers. Closing returns focus to the dumps list (no navigation).
$('#dumpDetailClose').addEventListener('click', () => {
  closeModal($('#dumpDetailOverlay'));
  _currentDumpDetailId = null;
  _dumpDetailEditing = false;
});
$('#dumpDetailOverlay').addEventListener('click', (e) => {
  if (e.target === $('#dumpDetailOverlay')) {
    closeModal($('#dumpDetailOverlay'));
    _currentDumpDetailId = null;
    _dumpDetailEditing = false;
  }
});

// ══════════════════════════════════════════════════════════
// GOALS VIEW
// ══════════════════════════════════════════════════════════

let goalFilter = 'all';
let allGoals = [];

async function loadGoals() {
  const params = goalFilter !== 'all' ? `?status=${goalFilter}` : '';
  if (!allGoals.length) renderSkeletonCards('#goalList', 3);
  allGoals = await api(`/goals${params}`);
  renderGoals();
}

function renderGoals() {
  const el = $('#goalList');
  if (!allGoals.length) {
    el.innerHTML = `<div class="empty-state"><p>No goals found</p></div>`;
    return;
  }
  el.innerHTML = allGoals.map(g => {
    const pct = g.task_total > 0 ? Math.round((g.task_completed / g.task_total) * 100) : 0;
    const unresolvedBlockers = (g.blockers || []).filter(b => !b.resolved);
    return `
      <div class="card goal-card fade-in" data-goal-id="${g.id}">
        <div class="goal-card-header">
          ${statusPill(g.status)}
          <span class="goal-card-title">${esc(g.title)}</span>
          <span class="goal-card-meta">${g.task_completed}/${g.task_total}</span>
          ${actionsHtml('openEditGoal(' + g.id + ')', 'deleteGoal(' + g.id + ',' + g.task_total + ')')}
        </div>
        ${g.description ? `<div style="font-size:0.8125rem;color:var(--text-2);margin-top:4px;line-height:1.5">${esc(g.description)}</div>` : ''}
        ${g.task_total > 0 ? `
          <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
          <div class="progress-text">${pct}% complete${g.target_date ? ' &middot; Target: ' + fmtDate(g.target_date) : ''}</div>
        ` : (g.target_date ? `<div class="progress-text">Target: ${fmtDate(g.target_date)}</div>` : '')}
        ${unresolvedBlockers.length ? `
          <div style="margin-top:8px;font-size:0.6875rem;color:var(--amber)">
            ${unresolvedBlockers.length} blocker${unresolvedBlockers.length > 1 ? 's' : ''}:
            ${unresolvedBlockers.map(b => esc(b.blocker_name)).join(', ')}
          </div>
        ` : ''}
        ${g.people && g.people.length ? `
          <div style="margin-top:6px;font-size:0.6875rem;color:var(--text-3)">
            ${g.people.map(p => esc(p.name)).join(', ')}
          </div>
        ` : ''}
        ${tagsHtml(g.tags)}
      </div>
    `;
  }).join('');
  bindGoalCards('#goalList');
}

function bindGoalCards(container) {
  document.querySelectorAll(`${container} .goal-card`).forEach(card => {
    card.addEventListener('click', () => openGoalDetail(parseInt(card.dataset.goalId)));
  });
}

async function openGoalDetail(goalId) {
  let goal;
  try {
    goal = await apiTry(`/goals/${goalId}`);
  } catch (err) {
    apiError(err, {
      retry: () => openGoalDetail(goalId),
      onRefresh: () => loadGoals(),
    });
    return;
  }
  if (!goal || goal.error) return;

  $('#goalDetailTitle').textContent = goal.title;
  const tasks = goal.tasks || [];
  const activeTasks = tasks.filter(t => t.status === 'active' || t.status === 'waiting');
  const completedTasks = tasks.filter(t => t.status === 'completed');
  // Blockers section in the modal: show all (active first, then
  // resolved). Resolved render dimmed via .blocker--resolved. This is
  // where the user can find what they recently resolved if they want
  // to undo or re-open it.
  const allBlockers = goal.blockers || [];
  const activeBlockers = allBlockers.filter(b => !b.resolved);
  const resolvedBlockers = allBlockers.filter(b => b.resolved);
  const orderedBlockers = [...activeBlockers, ...resolvedBlockers];

  // Iris's growability spec: Active Tasks and Blockers sections always
  // render, even when empty. The empty states are themselves the action.
  // Section header chips ("+ Task" / "+ Blocker") sit on the right of
  // the section title; tapping expands an inline form (tasks) or opens
  // the unified-search picker (blockers). The goal-detail modal stays
  // open through every flow.
  const blockerHeaderLabel = orderedBlockers.length
    ? `Blockers${activeBlockers.length ? ` (${activeBlockers.length} active)` : ' (all resolved)'}`
    : 'Blockers';
  const taskHeaderLabel = activeTasks.length
    ? `Active Tasks (${activeTasks.length})`
    : 'Active Tasks';

  $('#goalDetailBody').innerHTML = `
    <div class="goal-detail-status">${statusPill(goal.status)}</div>
    ${goal.description ? `<div class="goal-detail-desc">${esc(goal.description)}</div>` : ''}
    ${goal.target_date ? `<div style="font-size:0.8125rem;color:var(--text-3);margin-bottom:16px">Target: ${fmtDate(goal.target_date)}</div>` : ''}

    ${goal.people && goal.people.length ? `
      <div class="goal-detail-section">
        <div class="goal-detail-section-title">People</div>
        ${goal.people.map(p => `
          <div style="font-size:0.8125rem;color:var(--text);padding:3px 0">
            ${esc(p.name)} <span style="color:var(--text-3)">${esc(p.role || p.relationship || '')}</span>
          </div>
        `).join('')}
      </div>
    ` : ''}

    <div class="goal-detail-section" data-section="blockers">
      <div class="goal-detail-section-row">
        <div class="goal-detail-section-title">${blockerHeaderLabel}</div>
        <button type="button" class="grow-chip ${orderedBlockers.length ? '' : 'grow-chip--pulse'}" id="growBlockerChip" aria-label="Add a blocker">+ Blocker</button>
      </div>
      <div class="goal-detail-blockers">
        ${orderedBlockers.length
          ? orderedBlockers.map(b => renderBlockerItem(b)).join('')
          : `<button type="button" class="grow-empty-cta" id="growBlockerEmptyCta">+ Log a blocker</button>`}
      </div>
    </div>

    <div class="goal-detail-section" data-section="tasks">
      <div class="goal-detail-section-row">
        <div class="goal-detail-section-title">${taskHeaderLabel}</div>
        <button type="button" class="grow-chip" id="growTaskChip" aria-label="Add a task">+ Task</button>
      </div>
      <form class="grow-task-form ${activeTasks.length ? 'hidden' : ''}" id="growTaskForm" autocomplete="off">
        <input
          type="text"
          id="growTaskTitle"
          class="form-input grow-task-title"
          placeholder="Add a task…"
          aria-label="New task title"
          maxlength="200"
        />
        <div class="grow-task-extras hidden" id="growTaskExtras">
          <textarea
            id="growTaskDesc"
            class="form-textarea grow-task-desc"
            placeholder="Description (optional)"
            aria-label="Task description"
            rows="2"
          ></textarea>
          <input
            type="date"
            id="growTaskDue"
            class="form-input grow-task-due"
            aria-label="Due date"
          />
        </div>
        <div class="grow-task-actions">
          <span class="grow-task-hint" id="growTaskHint" role="status" aria-live="polite"></span>
          <button type="button" class="btn grow-task-cancel" id="growTaskCancel">Cancel</button>
          <button type="submit" class="btn-primary grow-task-submit" id="growTaskSubmit" disabled>Add</button>
        </div>
      </form>
      <div class="goal-detail-tasks" id="goalDetailTasks">
        ${activeTasks.map(t => renderTaskRow(t)).join('')}
      </div>
    </div>

    ${completedTasks.length ? `
      <div class="goal-detail-section">
        <div class="goal-detail-section-title">Completed (${completedTasks.length})</div>
        ${completedTasks.map(t => `
          <div class="task-row">
            <div class="task-check checked"></div>
            <span class="task-title done">${esc(t.title)}</span>
          </div>
        `).join('')}
      </div>
    ` : ''}

    ${tagsHtml(goal.tags)}
  `;

  // Bind task completion (delegated within the active tasks list).
  bindGoalDetailTaskChecks(goalId);

  // Bind blocker rows — toggle resolve + navigate to related entity.
  bindBlockerItems('#goalDetailBody', {
    surface: 'goal-detail',
    goalId,
    onRefresh: () => openGoalDetail(goalId),
  });
  renderUndoResolveChip('goal-detail');

  // Bind growability affordances.
  bindGrowTaskForm(goalId, { autoFocus: !activeTasks.length });
  bindGrowBlockerChip(goalId, goal);

  // Add edit/delete footer to goal detail modal
  const existingFooter = document.querySelector('#goalDetailOverlay .modal-footer');
  if (existingFooter) existingFooter.remove();
  const footer = document.createElement('div');
  footer.className = 'modal-footer';
  footer.innerHTML = `
    <button class="btn-danger" id="goalDetailDelete">Delete</button>
    <button class="btn" id="goalDetailEdit">Edit</button>
  `;
  document.querySelector('#goalDetailOverlay .modal').appendChild(footer);
  $('#goalDetailEdit').onclick = () => {
    // Load goal into allGoals if not there so openEditGoal can find it
    const existing = allGoals.find(g => g.id === goalId);
    if (!existing) allGoals.push(goal);
    openEditGoal(goalId);
  };
  $('#goalDetailDelete').onclick = () => deleteGoal(goalId, tasks.length);

  openModal($('#goalDetailOverlay'));
}

$('#goalDetailClose').addEventListener('click', () => closeModal($('#goalDetailOverlay')));
$('#goalDetailOverlay').addEventListener('click', e => { if (e.target === $('#goalDetailOverlay')) closeModal($('#goalDetailOverlay')); });

// ── Goal-detail growability (Iris's spec, 2026-04-29) ──────────────
//
// Inline `+ Task` and `+ Blocker` affordances inside the goal-detail
// modal. The modal stays open through every flow — adding a task or
// blocker prepends an optimistic row, focus-flashes it, and resets the
// affordance ready for the next add.

function renderTaskRow(t) {
  return `
    <div class="task-row" data-task-id="${t.id}">
      <div class="task-check" data-task-id="${t.id}"></div>
      <span class="task-title">${esc(t.title)}</span>
      ${statusPill(t.status)}
    </div>`;
}

function bindGoalDetailTaskChecks(goalId) {
  const list = document.getElementById('goalDetailTasks');
  if (!list) return;
  list.querySelectorAll('.task-check:not(.checked)').forEach(check => {
    if (check._lpBound) return;
    check._lpBound = true;
    check.addEventListener('click', async (e) => {
      e.stopPropagation();
      const taskId = check.dataset.taskId;
      await api(`/tasks/${taskId}`, { method: 'PUT', body: { status: 'completed' } });
      openGoalDetail(goalId); // refresh
    });
  });
}

function _focusFlash(row) {
  if (!row) return;
  row.classList.remove('highlight-flash');
  void row.offsetWidth;
  row.classList.add('highlight-flash');
  row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── + Task ─────────────────────────────────────────────────────────
let _growTaskSubmitting = false;

function bindGrowTaskForm(goalId, opts = {}) {
  const chip = document.getElementById('growTaskChip');
  const form = document.getElementById('growTaskForm');
  const titleEl = document.getElementById('growTaskTitle');
  const descEl = document.getElementById('growTaskDesc');
  const dueEl = document.getElementById('growTaskDue');
  const extras = document.getElementById('growTaskExtras');
  const submit = document.getElementById('growTaskSubmit');
  const cancel = document.getElementById('growTaskCancel');
  const hint = document.getElementById('growTaskHint');
  if (!form || !titleEl) return;

  const setHint = (msg, isError) => {
    if (!hint) return;
    hint.textContent = msg || '';
    hint.classList.toggle('error', !!isError && !!msg);
  };

  const expand = () => {
    form.classList.remove('hidden');
    extras?.classList.remove('hidden');
    setTimeout(() => titleEl.focus(), 30);
  };

  // Reset to the default state. Two callers:
  //  - cancel button / Escape → fully collapse (hide extras, hide form
  //    if the section has any tasks).
  //  - successful submit → soft-reset (clear fields, refocus title) so
  //    Cam can stream-add another task without re-opening the chip.
  const reset = ({ keepOpen = false } = {}) => {
    titleEl.value = '';
    if (descEl) descEl.value = '';
    if (dueEl) dueEl.value = '';
    submit.disabled = true;
    setHint('');
    if (!keepOpen) extras?.classList.add('hidden');
    if (!keepOpen) {
      const hasTasks = !!document.querySelector('#goalDetailTasks .task-row');
      if (hasTasks) form.classList.add('hidden');
    }
  };
  const collapse = () => reset({ keepOpen: false });

  if (chip) chip.addEventListener('click', expand);

  // Empty-state autofocus: form is already visible, focus the title.
  if (opts.autoFocus) setTimeout(() => titleEl.focus(), 60);

  titleEl.addEventListener('focus', () => extras?.classList.remove('hidden'));
  titleEl.addEventListener('input', () => {
    submit.disabled = !titleEl.value.trim();
    setHint('');
  });

  titleEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      collapse();
      // Don't auto-collapse when in empty-state mode.
      if (!document.querySelector('#goalDetailTasks .task-row')) {
        form.classList.remove('hidden');
        extras?.classList.add('hidden');
      }
    }
  });

  cancel?.addEventListener('click', () => {
    collapse();
    if (!document.querySelector('#goalDetailTasks .task-row')) {
      form.classList.remove('hidden');
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (_growTaskSubmitting) return;
    const title = titleEl.value.trim();
    if (!title) { setHint('Title is required.', true); return; }

    const body = { title, goal_id: goalId };
    const desc = descEl?.value.trim();
    const due = dueEl?.value.trim();
    if (desc) body.description = desc;
    if (due) body.due_date = due;

    _growTaskSubmitting = true;
    submit.disabled = true;
    setHint('Saving…');

    let created;
    try {
      created = await apiTry('/tasks', { method: 'POST', body });
    } catch (err) {
      _growTaskSubmitting = false;
      submit.disabled = !titleEl.value.trim();
      // Preserve the typed text so Cam doesn't lose work.
      setHint('Couldn\'t save — try again.', true);
      apiError(err, { retry: () => {} });
      return;
    }
    _growTaskSubmitting = false;
    if (!created || !created.id) {
      setHint('Couldn\'t save — try again.', true);
      submit.disabled = !titleEl.value.trim();
      return;
    }

    // Optimistic prepend in the active tasks list.
    const list = document.getElementById('goalDetailTasks');
    if (list) {
      list.insertAdjacentHTML('afterbegin', renderTaskRow(created));
      const row = list.querySelector(`.task-row[data-task-id="${created.id}"]`);
      _focusFlash(row);
      bindGoalDetailTaskChecks(goalId);
    }

    // Update the section header count.
    _updateTaskSectionHeader();

    // Soft-reset: clear fields, leave form visible and focus title so
    // Cam can stream-add another task without re-opening the chip.
    reset({ keepOpen: true });
    setTimeout(() => titleEl.focus(), 30);
  });
}

function _updateTaskSectionHeader() {
  const section = document.querySelector('#goalDetailBody [data-section="tasks"] .goal-detail-section-title');
  if (!section) return;
  const count = document.querySelectorAll('#goalDetailTasks .task-row').length;
  section.textContent = count ? `Active Tasks (${count})` : 'Active Tasks';
}

function _updateBlockerSectionHeader() {
  const section = document.querySelector('#goalDetailBody [data-section="blockers"] .goal-detail-section-title');
  if (!section) return;
  const rows = document.querySelectorAll('#goalDetailBody .goal-detail-blockers .blocker-item');
  if (!rows.length) {
    section.textContent = 'Blockers';
    return;
  }
  let active = 0;
  rows.forEach(r => { if (!r.classList.contains('blocker--resolved')) active++; });
  section.textContent = active
    ? `Blockers (${active} active)`
    : 'Blockers (all resolved)';
}

// ── + Blocker picker ───────────────────────────────────────────────
let _blockerPickerSubmitting = false;

function bindGrowBlockerChip(goalId, goal) {
  const chip = document.getElementById('growBlockerChip');
  const emptyCta = document.getElementById('growBlockerEmptyCta');
  const open = () => openGrowBlockerPicker(goalId, goal);
  if (chip) chip.addEventListener('click', open);
  if (emptyCta) emptyCta.addEventListener('click', open);
}

async function openGrowBlockerPicker(goalId, currentGoal) {
  // Strip any existing instance.
  document.querySelectorAll('.grow-picker-overlay').forEach(el => el.remove());

  const overlay = document.createElement('div');
  overlay.className = 'grow-picker-overlay';
  overlay.innerHTML = `
    <div class="grow-picker" role="dialog" aria-label="Add a blocker">
      <div class="grow-picker-header">
        <div class="grow-picker-title">Add a blocker to <span class="grow-picker-target">${esc(currentGoal.title)}</span></div>
        <button type="button" class="grow-picker-close" aria-label="Close">&times;</button>
      </div>
      <div class="grow-picker-search">
        <input type="search" id="growPickerSearch" class="form-input grow-picker-input"
               placeholder="Search goals, tasks, or systems…"
               aria-label="Search blockers" autocomplete="off" />
      </div>
      <div class="grow-picker-results" id="growPickerResults">
        <div class="grow-picker-loading">Loading…</div>
      </div>
      <div class="grow-picker-notes hidden" id="growPickerNotes">
        <label class="grow-picker-notes-label" for="growPickerNotesInput">Notes (optional)</label>
        <textarea id="growPickerNotesInput" class="form-textarea grow-picker-notes-input"
                  rows="3" placeholder="Why is this blocking?"></textarea>
      </div>
      <div class="grow-picker-footer">
        <button type="button" class="btn grow-picker-cancel">Cancel</button>
        <button type="button" class="btn-primary grow-picker-save" id="growPickerSave" disabled>Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('visible'));

  const input = overlay.querySelector('#growPickerSearch');
  const resultsEl = overlay.querySelector('#growPickerResults');
  const notesWrap = overlay.querySelector('#growPickerNotes');
  const notesEl = overlay.querySelector('#growPickerNotesInput');
  const saveBtn = overlay.querySelector('#growPickerSave');
  const closeBtn = overlay.querySelector('.grow-picker-close');
  const cancelBtn = overlay.querySelector('.grow-picker-cancel');

  let pool = []; // unified merged list
  let picked = null; // { type, id, name }

  const close = () => {
    overlay.classList.remove('visible');
    setTimeout(() => overlay.remove(), 200);
  };
  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  // Fetch in parallel; client-side merge.
  try {
    const [goals, tasks, externals] = await Promise.all([
      apiTry('/goals'),
      apiTry('/tasks'),
      apiTry('/external-systems'),
    ]);
    const gItems = (Array.isArray(goals) ? goals : []).map(g => ({
      type: 'goal', id: g.id, name: g.title, status: g.status,
      disabled: g.id === goalId,
      disabledReason: g.id === goalId ? 'this goal' : null,
    }));
    const tItems = (Array.isArray(tasks) ? tasks : []).map(t => ({
      type: 'task', id: t.id, name: t.title, status: t.status,
      goal_title: t.goal_title,
    }));
    const xItems = (Array.isArray(externals) ? externals : []).map(x => ({
      type: 'external_system', id: x.id, name: x.name,
    }));
    pool = [...gItems, ...tItems, ...xItems];
  } catch (err) {
    apiError(err);
    resultsEl.innerHTML = `<div class="grow-picker-empty">Couldn't load. Close and try again.</div>`;
    return;
  }

  const renderResults = () => {
    const q = (input.value || '').trim().toLowerCase();
    const filtered = q
      ? pool.filter(r => r.name && r.name.toLowerCase().includes(q))
      : pool.slice(0, 30); // sensible cap when query is empty

    if (!filtered.length) {
      // Iris's §5: external_system "no match" signpost.
      resultsEl.innerHTML = `
        <div class="grow-picker-empty">
          <div class="grow-picker-empty-msg">No matches${q ? ` for "${esc(q)}"` : ''}.</div>
          <div class="grow-picker-signpost" aria-disabled="true">
            + Add as new external system
            <span class="grow-picker-signpost-sub">Coming soon — external systems management</span>
          </div>
        </div>
      `;
      return;
    }

    resultsEl.innerHTML = filtered.map(r => {
      const badge = r.type === 'goal' ? 'Goal'
        : r.type === 'task' ? 'Task'
        : 'External';
      const sub = r.type === 'task' && r.goal_title
        ? `<span class="grow-picker-result-sub">${esc(r.goal_title)}</span>`
        : '';
      const disabledAttr = r.disabled ? 'disabled aria-disabled="true"' : '';
      const disabledHint = r.disabled
        ? `<span class="grow-picker-result-sub">${esc(r.disabledReason || 'unavailable')}</span>`
        : '';
      const isPicked = picked && picked.type === r.type && picked.id === r.id;
      return `
        <button type="button" class="grow-picker-result ${isPicked ? 'picked' : ''}" ${disabledAttr}
                data-type="${esc(r.type)}" data-id="${r.id}">
          <span class="grow-picker-result-badge type-${esc(r.type)}">${badge}</span>
          <span class="grow-picker-result-name">${esc(r.name || '(unnamed)')}</span>
          ${sub || disabledHint}
        </button>`;
    }).join('');

    resultsEl.querySelectorAll('.grow-picker-result:not([disabled])').forEach(btn => {
      btn.addEventListener('click', () => {
        const type = btn.dataset.type;
        const id = parseInt(btn.dataset.id);
        const name = btn.querySelector('.grow-picker-result-name')?.textContent || '';
        picked = { type, id, name };
        notesWrap.classList.remove('hidden');
        saveBtn.disabled = false;
        // Visual: mark current selection.
        resultsEl.querySelectorAll('.grow-picker-result').forEach(r => r.classList.remove('picked'));
        btn.classList.add('picked');
      });
    });
  };

  let typingTimer;
  input.addEventListener('input', () => {
    clearTimeout(typingTimer);
    typingTimer = setTimeout(renderResults, 80);
  });

  setTimeout(() => input.focus(), 80);
  renderResults();

  saveBtn.addEventListener('click', async () => {
    if (!picked || _blockerPickerSubmitting) return;
    _blockerPickerSubmitting = true;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';

    const body = {
      goal_id: goalId,
      blocker_type: picked.type,
    };
    if (picked.type === 'goal') body.blocker_goal_id = picked.id;
    else if (picked.type === 'task') body.blocker_task_id = picked.id;
    else if (picked.type === 'external_system') body.blocker_external_system_id = picked.id;
    const notes = (notesEl.value || '').trim();
    if (notes) body.notes = notes;

    let created;
    try {
      created = await apiTry('/blockers', { method: 'POST', body });
    } catch (err) {
      _blockerPickerSubmitting = false;
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';

      const status = err && err.status;
      if (status === 409) {
        // Existing blocker — close picker and flash the existing row in the modal.
        const existingId = err.payload && err.payload.id;
        showToast('Blocker already exists.');
        close();
        if (existingId) {
          requestAnimationFrame(() => {
            const row = document.querySelector(`#goalDetailBody .blocker-item[data-blocker-id="${existingId}"]`);
            _focusFlash(row);
          });
        }
        return;
      }
      if (status === 422) {
        showToast("A goal can't block itself.");
        return;
      }
      if (status === 404) {
        showToast('That item is no longer here.');
        // Refresh the picker results.
        try {
          const [goals, tasks, externals] = await Promise.all([
            apiTry('/goals'), apiTry('/tasks'), apiTry('/external-systems'),
          ]);
          pool = [
            ...goals.map(g => ({ type: 'goal', id: g.id, name: g.title, status: g.status, disabled: g.id === goalId, disabledReason: g.id === goalId ? 'this goal' : null })),
            ...tasks.map(t => ({ type: 'task', id: t.id, name: t.title, status: t.status, goal_title: t.goal_title })),
            ...externals.map(x => ({ type: 'external_system', id: x.id, name: x.name })),
          ];
          picked = null;
          notesWrap.classList.add('hidden');
          saveBtn.disabled = true;
          renderResults();
        } catch (_) { /* fall through */ }
        return;
      }
      apiError(err);
      return;
    }
    _blockerPickerSubmitting = false;

    // Success — optimistically prepend within active blockers in the goal-detail modal.
    const blockersWrap = document.querySelector('#goalDetailBody .goal-detail-blockers');
    if (blockersWrap) {
      // If the wrap currently contains the empty-state CTA, replace it.
      const emptyCta = blockersWrap.querySelector('.grow-empty-cta');
      if (emptyCta) blockersWrap.innerHTML = '';
      // Insert at the top (active blockers come first, then resolved).
      blockersWrap.insertAdjacentHTML('afterbegin', renderBlockerItem(created));
      bindBlockerItems('#goalDetailBody', {
        surface: 'goal-detail',
        goalId,
        onRefresh: () => openGoalDetail(goalId),
      });
      const row = blockersWrap.querySelector(`.blocker-item[data-blocker-id="${created.id}"]`);
      _focusFlash(row);
    }
    _updateBlockerSectionHeader();
    close();
  });
}

// Goal filter pills
$('#goalFilters').addEventListener('click', e => {
  const pill = e.target.closest('.filter-pill');
  if (!pill) return;
  goalFilter = pill.dataset.filter;
  $('#goalFilters').querySelectorAll('.filter-pill').forEach(p => p.classList.toggle('active', p.dataset.filter === goalFilter));
  loadGoals();
});

// ── Inline "Add Goal" affordance ───────────────────────
let _addGoalSubmitting = false;

function _setAddGoalHint(msg, isError) {
  const hint = $('#addGoalHint');
  if (!hint) return;
  hint.textContent = msg || '';
  hint.classList.toggle('error', !!isError && !!msg);
}

function _highlightGoalCard(goalId) {
  requestAnimationFrame(() => {
    const card = document.querySelector(`.goal-card[data-goal-id="${goalId}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.remove('highlight-flash');
    void card.offsetWidth;
    card.classList.add('highlight-flash');
  });
}

function openAddGoalForm() {
  const form = $('#addGoalForm');
  if (!form) return;
  form.classList.remove('hidden');
  setTimeout(() => $('#addGoalTitle')?.focus(), 60);
}

function closeAddGoalForm() {
  const form = $('#addGoalForm');
  if (!form) return;
  form.classList.add('hidden');
  // Reset
  $('#addGoalTitle').value = '';
  $('#addGoalDescription').value = '';
  $('#addGoalTargetDate').value = '';
  $('#addGoalTags').value = '';
  $('#addGoalSubmit').disabled = true;
  _setAddGoalHint('');
}

async function submitAddGoal() {
  if (_addGoalSubmitting) return;
  const title = ($('#addGoalTitle')?.value || '').trim();
  if (!title) { _setAddGoalHint('Title is required.', true); return; }

  const description = ($('#addGoalDescription')?.value || '').trim();
  const targetDate = ($('#addGoalTargetDate')?.value || '').trim();
  const tags = _parseTagsInput($('#addGoalTags')?.value || '');

  const body = { title };
  if (description) body.description = description;
  if (targetDate) body.target_date = targetDate;
  if (tags.length) body.tags = tags;

  _addGoalSubmitting = true;
  $('#addGoalSubmit').disabled = true;
  _setAddGoalHint('');

  try {
    const created = await apiTry('/goals', { method: 'POST', body });
    if (!created || !created.id) {
      _setAddGoalHint('Could not create. Try again.', true);
      return;
    }
    // Optimistic prepend.
    allGoals.unshift(created);
    renderGoals();
    _highlightGoalCard(created.id);
    closeAddGoalForm();
  } catch (err) {
    if (err && err.status === 400) {
      _setAddGoalHint((err.payload && err.payload.error) || 'Title is required.', true);
      return;
    }
    apiError(err, { retry: () => submitAddGoal() });
  } finally {
    _addGoalSubmitting = false;
    const v = ($('#addGoalTitle')?.value || '').trim();
    if ($('#addGoalSubmit')) $('#addGoalSubmit').disabled = !v;
  }
}

function initAddGoalForm() {
  const form = $('#addGoalForm');
  const btn = $('#newGoalBtn');
  const titleInput = $('#addGoalTitle');
  const submitBtn = $('#addGoalSubmit');
  const cancelBtn = $('#addGoalCancel');
  if (!form || !btn || !titleInput || !submitBtn) return;

  btn.addEventListener('click', () => {
    if (form.classList.contains('hidden')) openAddGoalForm();
    else closeAddGoalForm();
  });
  cancelBtn?.addEventListener('click', () => closeAddGoalForm());
  titleInput.addEventListener('input', () => {
    submitBtn.disabled = !titleInput.value.trim();
    if (titleInput.value.trim()) _setAddGoalHint('');
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitAddGoal();
  });
  // Esc closes the form.
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeAddGoalForm(); }
  });
}

// ══════════════════════════════════════════════════════════
// TASKS VIEW
// ══════════════════════════════════════════════════════════

let taskStatusFilter = 'all';
let allTasks = [];
let _taskGoalsCache = []; // goals data for sorting by target_date
const _taskGroupCollapsed = new Map(); // tracks manual collapse state by goalId

async function loadTasks() {
  const params = new URLSearchParams();
  if (taskStatusFilter !== 'all') params.set('status', taskStatusFilter);
  const qs = params.toString();
  if (!allTasks.length) renderSkeletonCards('#taskList', 3);
  const [tasks, goals] = await Promise.all([
    api(`/tasks${qs ? '?' + qs : ''}`),
    api('/goals'),
  ]);
  allTasks = tasks;
  _taskGoalsCache = goals;
  renderTasks();
}

function renderTasks() {
  const el = $('#taskList');
  if (!allTasks.length) {
    el.innerHTML = `<div class="empty-state"><p>No tasks found</p></div>`;
    return;
  }

  // Group tasks by goal
  const groupMap = new Map();
  allTasks.forEach(t => {
    const key = t.goal_id || 'unlinked';
    const title = t.goal_title || 'Unlinked';
    if (!groupMap.has(key)) groupMap.set(key, { goalId: key, goalTitle: title, tasks: [] });
    groupMap.get(key).tasks.push(t);
  });

  // Build sorted groups: within each group, sort active tasks by date then completed to bottom
  const groups = Array.from(groupMap.values()).map(g => {
    const completed = g.tasks.filter(t => t.status === 'completed');
    const active = g.tasks.filter(t => t.status !== 'completed');
    // Among active: tasks with due_date first (soonest-first), then tasks without
    const activeDated = active.filter(t => t.due_date).sort((a, b) => a.due_date.localeCompare(b.due_date));
    const activeUndated = active.filter(t => !t.due_date);
    const sorted = [...activeDated, ...activeUndated, ...completed];
    const allDone = active.length === 0 && completed.length > 0;

    // Calculate earliest date for group ordering:
    // Task dates take priority over goal target_date on this page
    const goalData = g.goalId !== 'unlinked' ? _taskGoalsCache.find(gl => gl.id === g.goalId) : null;
    const goalDate = goalData && goalData.target_date ? goalData.target_date : null;
    const earliestTaskDate = activeDated.length > 0 ? activeDated[0].due_date : null;
    const earliestDate = earliestTaskDate || goalDate;

    return { ...g, tasks: sorted, completedCount: completed.length, totalCount: g.tasks.length, allDone, earliestTaskDate, earliestDate, goalTargetDate: goalDate };
  });

  // Sort groups: all-completed to bottom, then by date priority:
  // 1. Groups with task dates (soonest-first)
  // 2. Groups with only a goal date (soonest-first)
  // 3. Groups with no dates at all
  groups.sort((a, b) => {
    if (a.allDone && !b.allDone) return 1;
    if (!a.allDone && b.allDone) return -1;
    if (a.allDone && b.allDone) return 0;
    // Task dates take priority over goal-only dates
    const aHasTaskDate = !!a.earliestTaskDate;
    const bHasTaskDate = !!b.earliestTaskDate;
    if (aHasTaskDate && !bHasTaskDate) return -1;
    if (!aHasTaskDate && bHasTaskDate) return 1;
    // Same tier — sort by earliest date
    if (a.earliestDate && !b.earliestDate) return -1;
    if (!a.earliestDate && b.earliestDate) return 1;
    if (a.earliestDate && b.earliestDate) return a.earliestDate.localeCompare(b.earliestDate);
    return 0;
  });

  el.innerHTML = groups.map(g => {
    // Determine collapse state: manual override > default (collapsed if all done)
    const hasManual = _taskGroupCollapsed.has(g.goalId);
    const collapsed = hasManual ? _taskGroupCollapsed.get(g.goalId) : g.allDone;
    const pct = g.totalCount > 0 ? Math.round((g.completedCount / g.totalCount) * 100) : 0;

    // Format goal target date as compact "Mon YYYY" and check if overdue
    let targetDateHtml = '';
    if (g.goalTargetDate) {
      const td = new Date(g.goalTargetDate + 'T00:00:00');
      const label = td.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const isOverdue = td < today && !g.allDone;
      targetDateHtml = `<span class="task-group-target${isOverdue ? ' task-group-target-overdue' : ''}">${isOverdue ? 'overdue \u00b7 ' : ''}${esc(label)}</span>`;
    }

    const groupGoalId = g.goalId === 'unlinked' ? '' : g.goalId;
    return `
      <div class="task-group fade-in ${g.allDone ? 'task-group-done' : ''}" data-group-id="${esc(String(g.goalId))}">
        <button class="task-group-header" aria-expanded="${!collapsed}">
          <span class="task-group-chevron ${collapsed ? '' : 'expanded'}"></span>
          <span class="task-group-title">${esc(g.goalTitle)}</span>
          <span class="task-group-progress">${g.completedCount}/${g.totalCount}</span>
          ${targetDateHtml}
          <div class="task-group-bar"><div class="task-group-bar-fill" style="width:${pct}%"></div></div>
        </button>
        <div class="task-group-body ${collapsed ? 'collapsed' : ''}">
          ${g.tasks.map(t => `
            <div class="task-row" data-task-id="${t.id}">
              <div class="task-check ${t.status === 'completed' ? 'checked' : ''}" data-task-id="${t.id}" data-status="${t.status}"></div>
              <span class="task-title ${t.status === 'completed' ? 'done' : ''}">${esc(t.title)}</span>
              ${t.due_date ? `<span style="font-size:0.625rem;color:var(--text-3)">${fmtDate(t.due_date)}</span>` : ''}
              ${t.people && t.people.length ? `<span style="font-size:0.625rem;color:var(--text-3)">${t.people.map(p => esc(p.name)).join(', ')}</span>` : ''}
              ${t.status !== 'completed' && t.status !== 'active' ? statusPill(t.status) : ''}
              ${actionsHtml('openEditTask(' + t.id + ')', 'deleteTask(' + t.id + ')')}
            </div>
          `).join('')}
          <div class="task-group-add">
            <button type="button" class="task-group-add-btn" data-group-goal-id="${esc(String(groupGoalId))}">+ task</button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Bind collapse/expand
  el.querySelectorAll('.task-group-header').forEach(header => {
    header.addEventListener('click', () => {
      const group = header.closest('.task-group');
      const groupId = group.dataset.groupId;
      const body = group.querySelector('.task-group-body');
      const chevron = header.querySelector('.task-group-chevron');
      const isCollapsed = body.classList.contains('collapsed');

      body.classList.toggle('collapsed', !isCollapsed);
      chevron.classList.toggle('expanded', isCollapsed);
      header.setAttribute('aria-expanded', isCollapsed);

      // Store manual override
      const key = groupId === 'unlinked' ? 'unlinked' : (isNaN(groupId) ? groupId : parseInt(groupId));
      _taskGroupCollapsed.set(key, !isCollapsed);
    });
  });

  // Bind task completion
  el.querySelectorAll('.task-check:not(.checked)').forEach(check => {
    check.addEventListener('click', async (e) => {
      e.stopPropagation();
      const taskId = check.dataset.taskId;
      await api(`/tasks/${taskId}`, { method: 'PUT', body: { status: 'completed' } });
      loadTasks();
    });
  });

  // Bind per-group "+ task" chips — pre-fill goal_id for the group.
  el.querySelectorAll('.task-group-add-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const raw = btn.dataset.groupGoalId;
      const goalId = raw && !isNaN(parseInt(raw)) ? parseInt(raw) : null;
      openAddTaskForm({ presetGoalId: goalId });
    });
  });
}

// Task status filter pills
$('#taskFilters').addEventListener('click', e => {
  const pill = e.target.closest('.filter-pill');
  if (!pill) return;
  taskStatusFilter = pill.dataset.filter;
  $('#taskFilters').querySelectorAll('.filter-pill').forEach(p => p.classList.toggle('active', p.dataset.filter === taskStatusFilter));
  loadTasks();
});

// ── Inline "Add Task" affordance ───────────────────────
let _addTaskSubmitting = false;

function _setAddTaskHint(msg, isError) {
  const hint = $('#addTaskHint');
  if (!hint) return;
  hint.textContent = msg || '';
  hint.classList.toggle('error', !!isError && !!msg);
}

function _highlightTaskRow(taskId) {
  requestAnimationFrame(() => {
    const row = document.querySelector(`.task-row[data-task-id="${taskId}"]`);
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.remove('highlight-flash');
    void row.offsetWidth;
    row.classList.add('highlight-flash');
  });
}

function _populateAddTaskGoalSelect() {
  const sel = $('#addTaskGoalId');
  if (!sel) return;
  const current = sel.value;
  const goals = (_taskGoalsCache && _taskGoalsCache.length) ? _taskGoalsCache : (allGoals || []);
  sel.innerHTML = '<option value="">No goal</option>' +
    goals.map(g => `<option value="${g.id}">${esc(g.title)}</option>`).join('');
  if (current) sel.value = current;
}

async function openAddTaskForm({ presetGoalId = null } = {}) {
  const form = $('#addTaskForm');
  if (!form) return;
  // Refresh goal list so the dropdown reflects latest goals.
  if (!_taskGoalsCache.length) {
    try { _taskGoalsCache = await api('/goals') || []; } catch (_) {}
  }
  _populateAddTaskGoalSelect();
  if (presetGoalId != null) $('#addTaskGoalId').value = String(presetGoalId);
  form.classList.remove('hidden');
  setTimeout(() => $('#addTaskTitle')?.focus(), 60);
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeAddTaskForm() {
  const form = $('#addTaskForm');
  if (!form) return;
  form.classList.add('hidden');
  $('#addTaskTitle').value = '';
  $('#addTaskDescription').value = '';
  $('#addTaskDueDate').value = '';
  $('#addTaskGoalId').value = '';
  $('#addTaskTags').value = '';
  $('#addTaskSubmit').disabled = true;
  _setAddTaskHint('');
}

async function submitAddTask() {
  if (_addTaskSubmitting) return;
  const title = ($('#addTaskTitle')?.value || '').trim();
  if (!title) { _setAddTaskHint('Title is required.', true); return; }

  const description = ($('#addTaskDescription')?.value || '').trim();
  const dueDate = ($('#addTaskDueDate')?.value || '').trim();
  const goalIdRaw = ($('#addTaskGoalId')?.value || '').trim();
  const tags = _parseTagsInput($('#addTaskTags')?.value || '');

  const body = { title };
  if (description) body.description = description;
  if (dueDate) body.due_date = dueDate;
  if (goalIdRaw) body.goal_id = parseInt(goalIdRaw);
  if (tags.length) body.tags = tags;

  _addTaskSubmitting = true;
  $('#addTaskSubmit').disabled = true;
  _setAddTaskHint('');

  try {
    const created = await apiTry('/tasks', { method: 'POST', body });
    if (!created || !created.id) {
      _setAddTaskHint('Could not create. Try again.', true);
      return;
    }
    allTasks.unshift(created);
    renderTasks();
    _highlightTaskRow(created.id);
    closeAddTaskForm();
  } catch (err) {
    if (err && err.status === 400) {
      _setAddTaskHint((err.payload && err.payload.error) || 'Title is required.', true);
      return;
    }
    apiError(err, { retry: () => submitAddTask() });
  } finally {
    _addTaskSubmitting = false;
    const v = ($('#addTaskTitle')?.value || '').trim();
    if ($('#addTaskSubmit')) $('#addTaskSubmit').disabled = !v;
  }
}

function initAddTaskForm() {
  const form = $('#addTaskForm');
  const btn = $('#newTaskBtn');
  const titleInput = $('#addTaskTitle');
  const submitBtn = $('#addTaskSubmit');
  const cancelBtn = $('#addTaskCancel');
  if (!form || !btn || !titleInput || !submitBtn) return;

  btn.addEventListener('click', () => {
    if (form.classList.contains('hidden')) openAddTaskForm();
    else closeAddTaskForm();
  });
  cancelBtn?.addEventListener('click', () => closeAddTaskForm());
  titleInput.addEventListener('input', () => {
    submitBtn.disabled = !titleInput.value.trim();
    if (titleInput.value.trim()) _setAddTaskHint('');
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitAddTask();
  });
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeAddTaskForm(); }
  });
}

// ══════════════════════════════════════════════════════════
// PEOPLE VIEW
// ══════════════════════════════════════════════════════════

let allPeople = [];

async function loadPeople() {
  if (!allPeople.length) renderSkeletonCards('#peopleList', 3);
  allPeople = await api('/people');
  renderPeople();
}

function renderPeople() {
  const el = $('#peopleList');
  if (!allPeople.length) {
    el.innerHTML = `<div class="empty-state"><p>No people yet</p></div>`;
    return;
  }

  el.innerHTML = allPeople.map(p => {
    const initials = p.name.split(' ').map(w => w[0]).join('').toUpperCase();
    const goalsList = (p.goals || []).map(g => `<div class="person-conn-item">${esc(g.title)} ${statusPill(g.status)} <span style="color:var(--text-3);font-size:0.625rem">${esc(g.role || '')}</span></div>`).join('');
    const tasksList = (p.tasks || []).map(t => `<div class="person-conn-item">${esc(t.title)} ${statusPill(t.status)}</div>`).join('');

    return `
      <div class="card person-card fade-in" data-person-id="${p.id}">
        <div class="person-header">
          <div class="person-avatar">${initials}</div>
          <div style="flex:1">
            <div class="person-name">${esc(p.name)}</div>
            <div class="person-rel">${esc(p.relationship || '')}${p.location ? ' &middot; ' + esc(p.location) : ''}</div>
          </div>
          ${actionsHtml('openEditPerson(' + p.id + ')', 'deletePerson(' + p.id + ')')}
        </div>
        ${p.notes ? `<div style="font-size:0.8125rem;color:var(--text-2);margin-top:10px;line-height:1.5">${esc(p.notes)}</div>` : ''}
        ${goalsList || tasksList ? `
          <div class="person-connections">
            ${goalsList ? `<div class="person-conn-label">Goals</div>${goalsList}` : ''}
            ${tasksList ? `<div class="person-conn-label" style="margin-top:8px">Tasks</div>${tasksList}` : ''}
          </div>
        ` : ''}
        ${tagsHtml(p.tags)}
      </div>
    `;
  }).join('');
}

// ── Inline "Add Person" affordance ───────────────────────
let _addPersonSubmitting = false;

function _setAddPersonHint(msg, isError) {
  const hint = $('#addPersonHint');
  if (!hint) return;
  hint.textContent = msg || '';
  hint.classList.toggle('error', !!isError && !!msg);
}

function _highlightPersonCard(personId) {
  // Wait a tick so the row is in the DOM after any re-render.
  requestAnimationFrame(() => {
    const card = document.querySelector(`.person-card[data-person-id="${personId}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.remove('highlight-flash');
    // Force reflow so the animation re-triggers if user re-adds same name.
    void card.offsetWidth;
    card.classList.add('highlight-flash');
  });
}

async function submitAddPerson() {
  if (_addPersonSubmitting) return;
  const input = $('#addPersonInput');
  const btn = $('#addPersonBtn');
  if (!input || !btn) return;

  const name = (input.value || '').trim();
  if (!name) {
    _setAddPersonHint('Enter a name first.', true);
    return;
  }

  _addPersonSubmitting = true;
  btn.disabled = true;
  _setAddPersonHint('');

  try {
    const res = await fetch(`${MOUNT}api/people`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });

    if (res.status === 401) {
      window.location.href = `${MOUNT}login`;
      return;
    }

    let payload = null;
    try { payload = await res.json(); } catch (_) { /* ignore parse error */ }

    if (res.status === 201 && payload && payload.id) {
      input.value = '';
      // Optimistic prepend — no full re-fetch needed.
      allPeople.unshift(payload);
      renderPeople();
      _highlightPersonCard(payload.id);
      _setAddPersonHint('');
      input.focus();
      return;
    }

    if (res.status === 400) {
      _setAddPersonHint((payload && payload.error) || 'Name is required.', true);
      return;
    }

    if (res.status === 409 && payload && payload.id) {
      showToast(`${name} already exists.`);
      // If we don't already have them in our local list, refresh.
      const have = allPeople.some(p => p.id === payload.id);
      if (!have) {
        await loadPeople();
      }
      _highlightPersonCard(payload.id);
      input.value = '';
      _setAddPersonHint('');
      return;
    }

    // 500 or anything else.
    showToast("Couldn't add. Try again.");
  } catch (_) {
    showToast('Network error.');
  } finally {
    _addPersonSubmitting = false;
    // Re-evaluate disabled state from current input contents.
    const v = ($('#addPersonInput')?.value || '').trim();
    if ($('#addPersonBtn')) $('#addPersonBtn').disabled = !v;
  }
}

function initAddPersonForm() {
  const form = $('#addPersonForm');
  const input = $('#addPersonInput');
  const btn = $('#addPersonBtn');
  if (!form || !input || !btn) return;

  // Disable button until there's non-whitespace content.
  input.addEventListener('input', () => {
    btn.disabled = !input.value.trim();
    if (input.value.trim()) _setAddPersonHint('');
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitAddPerson();
  });
}

// ══════════════════════════════════════════════════════════
// JOURNAL VIEW (preserves all v1 functionality)
// ══════════════════════════════════════════════════════════

let journalEntries = [];
let journalTags = [];
let journalActiveTag = null;
let journalEditingId = null;
let journalDebounce = null;

async function loadJournal() {
  await Promise.all([loadJournalEntries(), loadJournalTags()]);
}

async function loadJournalEntries() {
  const params = new URLSearchParams();
  const q = $('#journalSearch').value.trim();
  const d = $('#journalDateFilter').value;
  if (q) params.set('q', q);
  if (d) params.set('date', d);
  if (journalActiveTag) params.set('tag', journalActiveTag);

  $('#journalClear').style.display = (q || d || journalActiveTag) ? 'inline' : 'none';

  const qs = params.toString();
  journalEntries = await api(`/entries${qs ? '?' + qs : ''}`);
  renderJournalEntries();
  $('#journalSubtitle').textContent = `${journalEntries.length} entr${journalEntries.length === 1 ? 'y' : 'ies'}`;
}

async function loadJournalTags() {
  journalTags = await api('/tags');
  renderJournalTags();
}

function renderJournalEntries() {
  const el = $('#journalEntries');
  if (!journalEntries.length) {
    el.innerHTML = `<div class="empty-state"><p>No entries found</p><p class="hint">Press <kbd>N</kbd> on the journal view to write one</p></div>`;
    return;
  }
  el.innerHTML = journalEntries.map(e => `
    <div class="entry-card" data-id="${e.id}">
      <div class="entry-date">${fmtDateLong(e.entry_date)}</div>
      <div class="entry-preview">${esc(e.content)}</div>
      ${e.tags.length ? `<div class="entry-tags-row">${e.tags.map(tagChipHtml).join('')}</div>` : ''}
    </div>
  `).join('');

  el.querySelectorAll('.entry-card').forEach(card => {
    card.addEventListener('click', () => openJournalDetail(Number(card.dataset.id)));
  });
}

function renderJournalTags() {
  const el = $('#journalTagsBar');
  // Only show tags that have entry_count (filter tags to those used in entries)
  const entryTags = journalTags.filter(t => t.total_count > 0);
  el.innerHTML = entryTags.slice(0, 15).map(t => `
    <span class="filter-pill ${journalActiveTag === t.name ? 'active' : ''}" data-tag="${esc(t.name)}" style="font-size:0.625rem;padding:3px 8px">
      ${esc(t.name)}
    </span>
  `).join('');

  el.querySelectorAll('.filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      const tag = pill.dataset.tag;
      journalActiveTag = journalActiveTag === tag ? null : tag;
      loadJournal();
    });
  });
}

// Journal search
$('#journalSearch').addEventListener('input', () => {
  clearTimeout(journalDebounce);
  journalDebounce = setTimeout(loadJournalEntries, 200);
});
$('#journalDateFilter').addEventListener('change', loadJournalEntries);
$('#journalClear').addEventListener('click', () => {
  $('#journalSearch').value = '';
  $('#journalDateFilter').value = '';
  journalActiveTag = null;
  loadJournal();
});

// Journal compose
function openJournalComposer(entry = null) {
  journalEditingId = entry ? entry.id : null;
  $('#journalModalTitle').textContent = entry ? 'Edit entry' : 'New entry';
  $('#journalEntryDate').value = entry ? entry.entry_date : new Date().toISOString().slice(0, 10);
  $('#journalEntryContent').value = entry ? entry.content : '';
  $('#journalEntryTags').value = entry ? entry.tags.map(t => t.name).join(', ') : '';
  $('#journalDeleteEntry').style.display = entry ? 'inline' : 'none';
  openModal($('#journalOverlay'));
  setTimeout(() => $('#journalEntryContent').focus(), 250);
}

function closeJournalComposer() {
  closeModal($('#journalOverlay'));
  journalEditingId = null;
}

async function saveJournalEntry() {
  const date = $('#journalEntryDate').value;
  const content = $('#journalEntryContent').value.trim();
  const tagsRaw = $('#journalEntryTags').value;
  const tags = tagsRaw.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
  if (!content) return;

  $('#journalSaveEntry').disabled = true;
  try {
    if (journalEditingId) {
      await api(`/entries/${journalEditingId}`, { method: 'PUT', body: { entry_date: date, content, tags } });
    } else {
      await api('/entries', { method: 'POST', body: { entry_date: date, content, tags } });
    }
    closeJournalComposer();
    await loadJournal();
  } finally {
    $('#journalSaveEntry').disabled = false;
  }
}

async function deleteJournalEntry() {
  if (!journalEditingId) return;
  if (!confirm('Delete this entry?')) return;
  await api(`/entries/${journalEditingId}`, { method: 'DELETE' });
  closeJournalComposer();
  closeModal($('#journalDetailOverlay'));
  await loadJournal();
}

function openJournalDetail(id) {
  const entry = journalEntries.find(e => e.id === id);
  if (!entry) return;

  $('#journalDetailDate').textContent = fmtDateLong(entry.entry_date);
  $('#journalDetailContent').textContent = entry.content;
  $('#journalDetailTags').innerHTML = entry.tags.map(tagChipHtml).join('');
  $('#journalDetailMeta').textContent = `Created ${fmtTimestamp(entry.created_at)}` +
    (entry.updated_at !== entry.created_at ? ` \u00b7 Updated ${fmtTimestamp(entry.updated_at)}` : '');

  $('#journalDetailEdit').onclick = () => {
    closeModal($('#journalDetailOverlay'));
    setTimeout(() => openJournalComposer(entry), 220);
  };

  openModal($('#journalDetailOverlay'));
}

// Journal event listeners
$('#journalNew').addEventListener('click', () => openJournalComposer());
$('#journalModalClose').addEventListener('click', closeJournalComposer);
$('#journalCancelEntry').addEventListener('click', closeJournalComposer);
$('#journalSaveEntry').addEventListener('click', saveJournalEntry);
$('#journalDeleteEntry').addEventListener('click', deleteJournalEntry);
$('#journalDetailClose').addEventListener('click', () => closeModal($('#journalDetailOverlay')));

$('#journalOverlay').addEventListener('click', e => { if (e.target === $('#journalOverlay')) closeJournalComposer(); });
$('#journalDetailOverlay').addEventListener('click', e => { if (e.target === $('#journalDetailOverlay')) closeModal($('#journalDetailOverlay')); });

// ══════════════════════════════════════════════════════════
// KNOWLEDGE VIEW
// ══════════════════════════════════════════════════════════

let knowledgeFilter = 'all';
let allKnowledge = [];
let knowledgeDebounce = null;

async function loadKnowledge() {
  const params = new URLSearchParams();
  const q = $('#knowledgeSearch').value.trim();
  if (q) params.set('q', q);
  if (knowledgeFilter !== 'all') params.set('type', knowledgeFilter);
  const qs = params.toString();
  if (!allKnowledge.length) renderSkeletonCards('#knowledgeList', 3);
  allKnowledge = await api(`/knowledge${qs ? '?' + qs : ''}`);
  renderKnowledge();
  // Apply any incoming URL params (?addNote=1&tag=...&prefillTitle=...)
  applyKnowledgeUrlParams();
}

function renderKnowledge() {
  const el = $('#knowledgeList');
  if (!allKnowledge.length) {
    el.innerHTML = `<div class="empty-state"><p>No knowledge items found</p></div>`;
    return;
  }

  el.innerHTML = allKnowledge.map(k => `
    <div class="card knowledge-card fade-in" data-knowledge-id="${k.id}">
      <div style="display:flex;align-items:center;gap:8px">
        ${typePill(k.item_type)}
        <span style="flex:1"></span>
        ${actionsHtml('openEditKnowledge(' + k.id + ')', 'deleteKnowledge(' + k.id + ')')}
      </div>
      <div class="knowledge-title">${esc(k.title)}</div>
      ${k.content ? `<div class="knowledge-content">${esc(k.content)}</div>` : ''}
      ${k.source ? `<div class="knowledge-source">Source: ${esc(k.source)}</div>` : ''}
      ${tagsHtml(k.tags)}
    </div>
  `).join('');
}

// ── Add knowledge inline form ──────────────────────────────
let _addKnowledgeSubmitting = false;

function _setAddKnowledgeHint(msg, isError) {
  const hint = $('#addKnowledgeHint');
  if (!hint) return;
  hint.textContent = msg || '';
  hint.classList.toggle('error', !!isError && !!msg);
}

function _highlightKnowledgeCard(id) {
  requestAnimationFrame(() => {
    const card = document.querySelector(`.knowledge-card[data-knowledge-id="${id}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.remove('highlight-flash');
    void card.offsetWidth;
    card.classList.add('highlight-flash');
  });
}

function _parseTagsInput(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map(t => t.trim().toLowerCase())
    .filter(Boolean);
}

async function submitAddKnowledge() {
  if (_addKnowledgeSubmitting) return;
  const titleInput = $('#addKnowledgeTitle');
  const contentInput = $('#addKnowledgeContent');
  const tagsInput = $('#addKnowledgeTags');
  const btn = $('#addKnowledgeBtn');
  if (!titleInput || !btn) return;

  const title = (titleInput.value || '').trim();
  if (!title) {
    _setAddKnowledgeHint('Enter a title first.', true);
    return;
  }

  const content = (contentInput?.value || '').trim();
  const tags = _parseTagsInput(tagsInput?.value || '');

  _addKnowledgeSubmitting = true;
  btn.disabled = true;
  _setAddKnowledgeHint('');

  const body = { title };
  if (content) body.content = content;
  if (tags.length) body.tags = tags;

  try {
    const res = await fetch(`${MOUNT}api/knowledge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.status === 401) {
      window.location.href = `${MOUNT}login`;
      return;
    }

    let payload = null;
    try { payload = await res.json(); } catch (_) { /* ignore parse error */ }

    if (res.status === 201 && payload && payload.id) {
      titleInput.value = '';
      if (contentInput) contentInput.value = '';
      if (tagsInput) tagsInput.value = '';
      // Optimistic prepend.
      allKnowledge.unshift(payload);
      renderKnowledge();
      _highlightKnowledgeCard(payload.id);
      _setAddKnowledgeHint('');
      titleInput.focus();
      return;
    }

    if (res.status === 400) {
      _setAddKnowledgeHint((payload && payload.error) || 'Title is required.', true);
      return;
    }

    showToast("Couldn't add. Try again.");
  } catch (_) {
    showToast('Network error.');
  } finally {
    _addKnowledgeSubmitting = false;
    const v = ($('#addKnowledgeTitle')?.value || '').trim();
    if ($('#addKnowledgeBtn')) $('#addKnowledgeBtn').disabled = !v;
  }
}

function initAddKnowledgeForm() {
  const form = $('#addKnowledgeForm');
  const titleInput = $('#addKnowledgeTitle');
  const btn = $('#addKnowledgeBtn');
  if (!form || !titleInput || !btn) return;

  titleInput.addEventListener('input', () => {
    btn.disabled = !titleInput.value.trim();
    if (titleInput.value.trim()) _setAddKnowledgeHint('');
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitAddKnowledge();
  });
}

// Returns true if URL params were consumed (form was prefilled).
function applyKnowledgeUrlParams() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('addNote') !== '1') return false;

  const titleInput = $('#addKnowledgeTitle');
  const tagsInput = $('#addKnowledgeTags');
  const btn = $('#addKnowledgeBtn');
  const form = $('#addKnowledgeForm');
  if (!titleInput || !form) return false;

  const prefillTitle = params.get('prefillTitle') || '';
  const tag = params.get('tag') || '';

  if (prefillTitle) titleInput.value = prefillTitle;
  if (tag && tagsInput) tagsInput.value = tag;
  if (btn) btn.disabled = !titleInput.value.trim();

  // Scroll & focus after the view is visible.
  requestAnimationFrame(() => {
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    titleInput.focus();
    // Place caret at end so Cam can edit immediately.
    const v = titleInput.value;
    titleInput.setSelectionRange(v.length, v.length);
  });

  // Strip the params from the URL so a refresh doesn't re-apply them.
  const cleaned = window.location.pathname + window.location.hash;
  window.history.replaceState({}, '', cleaned);
  return true;
}

// Knowledge filters
$('#view-knowledge .filters').addEventListener('click', e => {
  const pill = e.target.closest('.filter-pill');
  if (!pill) return;
  knowledgeFilter = pill.dataset.filter;
  $('#view-knowledge .filters').querySelectorAll('.filter-pill').forEach(p => p.classList.toggle('active', p.dataset.filter === knowledgeFilter));
  loadKnowledge();
});

$('#knowledgeSearch').addEventListener('input', () => {
  clearTimeout(knowledgeDebounce);
  knowledgeDebounce = setTimeout(loadKnowledge, 200);
});

// ══════════════════════════════════════════════════════════
// TAGS VIEW
// ══════════════════════════════════════════════════════════

let allTags = [];
let tagsSort = 'most-used';   // most-used | alpha | unused
let tagsSearchQ = '';
let tagsSearchDebounce = null;
let _addTagSubmitting = false;

async function loadTagsView() {
  if (!allTags.length) renderSkeletonCards('#tagsList', 4);
  const data = await api('/tags');
  allTags = Array.isArray(data) ? data : [];
  renderTagsView();
}

function _filteredSortedTags() {
  const q = tagsSearchQ.trim().toLowerCase();
  let list = allTags.slice();
  if (q) list = list.filter(t => t.name.toLowerCase().includes(q));
  if (tagsSort === 'unused') {
    list = list.filter(t => (t.usage_count || 0) === 0);
    list.sort((a, b) => a.name.localeCompare(b.name));
  } else if (tagsSort === 'alpha') {
    list.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    // most-used: backend already sorts by usage_count DESC, name ASC. Keep order.
  }
  return list;
}

function _tagBreakdownHtml(t) {
  const b = t.breakdown || {};
  const parts = [];
  if (b.goals)           parts.push(`${b.goals} goal${b.goals === 1 ? '' : 's'}`);
  if (b.tasks)           parts.push(`${b.tasks} task${b.tasks === 1 ? '' : 's'}`);
  if (b.knowledge)       parts.push(`${b.knowledge} knowledge`);
  if (b.people)          parts.push(`${b.people} ${b.people === 1 ? 'person' : 'people'}`);
  if (b.journal_entries) parts.push(`${b.journal_entries} entr${b.journal_entries === 1 ? 'y' : 'ies'}`);
  if (b.brain_dumps)     parts.push(`${b.brain_dumps} dump${b.brain_dumps === 1 ? '' : 's'}`);
  if (!parts.length) return `<div class="tag-row-breakdown empty">Not yet used.</div>`;
  return `<div class="tag-row-breakdown">${parts.join(' · ')}</div>`;
}

function renderTagsView() {
  const subtitle = $('#tagsSubtitle');
  const list = $('#tagsList');
  if (!list) return;

  const total = allTags.length;
  const totalUsages = allTags.reduce((sum, t) => sum + (t.usage_count || 0), 0);
  if (subtitle) {
    subtitle.textContent = total === 0
      ? 'No tags yet'
      : `${total} tag${total === 1 ? '' : 's'} · ${totalUsages} usage${totalUsages === 1 ? '' : 's'}`;
  }

  // Empty (no tags at all)
  if (!total) {
    list.innerHTML = `<div class="empty-state">
      <p>No tags yet</p>
      <p class="hint">Tags appear automatically as you brain-dump, or add one above to start a vocabulary.</p>
    </div>`;
    return;
  }

  const rows = _filteredSortedTags();

  // No-search-results launchpad
  if (!rows.length && tagsSearchQ.trim()) {
    const q = tagsSearchQ.trim();
    list.innerHTML = `<div class="empty-state">
      <p>No tags match "${esc(q)}"</p>
      <p class="hint"><button type="button" class="btn-text" id="tagsCreateFromSearch">Create "${esc(q)}" as a new tag</button></p>
    </div>`;
    const btn = $('#tagsCreateFromSearch');
    if (btn) btn.addEventListener('click', () => {
      const input = $('#addTagInput');
      if (input) { input.value = q; input.dispatchEvent(new Event('input')); }
      submitAddTag();
    });
    return;
  }

  if (!rows.length) {
    list.innerHTML = `<div class="empty-state"><p>No tags match the current filter.</p></div>`;
    return;
  }

  list.innerHTML = rows.map(t => {
    const dim = (t.usage_count || 0) === 0 ? ' dim' : '';
    return `
    <div class="tag-row" data-tag-id="${t.id}" data-tag-name="${esc(t.name)}">
      <div class="tag-row-main">
        <div class="tag-row-top">
          <span class="tag-row-name${dim}">${esc(t.name)}</span>
          <span class="tag-row-count">${t.usage_count || 0}</span>
        </div>
        ${_tagBreakdownHtml(t)}
      </div>
      <div class="card-actions" onclick="event.stopPropagation()">
        <button class="card-actions-btn" onclick="event.stopPropagation();toggleActionMenu(this)" aria-label="Tag actions">&ctdot;</button>
        <div class="card-actions-menu">
          <button onclick="event.stopPropagation();openTagRename(${t.id})">Rename</button>
          <button onclick="event.stopPropagation();openTagMerge(${t.id})">Merge into&hellip;</button>
          <button class="action-delete" onclick="event.stopPropagation();openTagDelete(${t.id})">Delete</button>
        </div>
      </div>
    </div>`;
  }).join('');

  // Whole-row click → drawer
  list.querySelectorAll('.tag-row').forEach(row => {
    row.addEventListener('click', (e) => {
      // Don't trigger if click came from inside the kebab menu
      if (e.target.closest('.card-actions')) return;
      const id = parseInt(row.dataset.tagId, 10);
      if (id) openTagDrawer(id);
    });
  });
}

// ── Tags toolbar listeners ─────────────────────────────────
function _initTagsView() {
  const search = $('#tagsSearch');
  if (search) {
    search.addEventListener('input', () => {
      clearTimeout(tagsSearchDebounce);
      tagsSearchDebounce = setTimeout(() => {
        tagsSearchQ = search.value;
        renderTagsView();
      }, 120);
    });
  }
  const filters = $('#tagsFilters');
  if (filters) {
    filters.addEventListener('click', (e) => {
      const pill = e.target.closest('.filter-pill');
      if (!pill) return;
      tagsSort = pill.dataset.filter;
      filters.querySelectorAll('.filter-pill').forEach(p =>
        p.classList.toggle('active', p.dataset.filter === tagsSort));
      renderTagsView();
    });
  }
  // Add tag form
  const form = $('#addTagForm');
  const input = $('#addTagInput');
  const btn = $('#addTagBtn');
  if (form && input && btn) {
    input.addEventListener('input', () => {
      btn.disabled = !input.value.trim();
      if (input.value.trim()) _setAddTagHint('');
    });
    form.addEventListener('submit', (e) => { e.preventDefault(); submitAddTag(); });
  }
}

function _setAddTagHint(msg, isError) {
  const hint = $('#addTagHint');
  if (!hint) return;
  hint.textContent = msg || '';
  hint.classList.toggle('error', !!isError && !!msg);
}

function _highlightTagRow(tagId) {
  requestAnimationFrame(() => {
    const row = document.querySelector(`.tag-row[data-tag-id="${tagId}"]`);
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.remove('highlight-flash');
    void row.offsetWidth;
    row.classList.add('highlight-flash');
  });
}

async function submitAddTag() {
  if (_addTagSubmitting) return;
  const input = $('#addTagInput');
  const btn = $('#addTagBtn');
  if (!input || !btn) return;

  const raw = (input.value || '').trim();
  if (!raw) { _setAddTagHint('Enter a tag name.', true); return; }
  // Normalise client-side for the optimistic case (server normalises too).
  const name = raw.toLowerCase().replace(/\s+/g, '-');

  _addTagSubmitting = true;
  btn.disabled = true;
  _setAddTagHint('');

  try {
    const res = await fetch(`${MOUNT}api/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (res.status === 401) { window.location.href = `${MOUNT}login`; return; }

    let payload = null;
    try { payload = await res.json(); } catch (_) {}

    if (res.status === 201 && payload && payload.id) {
      // Created — refresh the list so we get the proper breakdown shape.
      input.value = '';
      _setAddTagHint('');
      await loadTagsView();
      _highlightTagRow(payload.id);
      input.focus();
      return;
    }
    if (res.status === 200 && payload && payload.id) {
      // Duplicate — focus the existing row.
      input.value = '';
      _setAddTagHint('');
      // Make sure the existing tag is in our list.
      if (!allTags.some(t => t.id === payload.id)) await loadTagsView();
      _highlightTagRow(payload.id);
      input.focus();
      return;
    }
    if (res.status === 400) {
      _setAddTagHint((payload && payload.error) || 'Name is required.', true);
      return;
    }
    showToast("Couldn't add. Try again.");
  } catch (_) {
    showToast('Network error.');
  } finally {
    _addTagSubmitting = false;
    const v = ($('#addTagInput')?.value || '').trim();
    if ($('#addTagBtn')) $('#addTagBtn').disabled = !v;
  }
}

// ══════════════════════════════════════════════════════════
// TAG DRAWER
// ══════════════════════════════════════════════════════════

let _currentDrawerTagId = null;
let _currentDrawerTag = null;       // { id, name }
let _currentDrawerUsages = null;    // usages payload

const TAG_DRAWER_SECTIONS = [
  { key: 'goals',           label: 'Goals',         titleField: 'title' },
  { key: 'tasks',           label: 'Tasks',         titleField: 'title' },
  { key: 'people',          label: 'People',        titleField: 'name'  },
  { key: 'knowledge',       label: 'Knowledge',     titleField: 'title' },
  { key: 'journal_entries', label: 'Journal',       titleField: null    }, // custom
  { key: 'brain_dumps',     label: 'Brain dumps',   titleField: null    }, // custom
];

async function openTagDrawer(tagId) {
  _currentDrawerTagId = tagId;

  // Try to find the tag in our cached list first for instant header.
  const cached = allTags.find(t => t.id === tagId);
  $('#tagDrawerName').textContent = cached ? cached.name : '...';
  $('#tagDrawerCount').textContent = cached
    ? `${cached.usage_count || 0} usage${(cached.usage_count || 0) === 1 ? '' : 's'}`
    : 'Loading...';
  $('#tagDrawerBody').innerHTML = `<div class="empty-state"><p>Loading&hellip;</p></div>`;

  openModal($('#tagDrawerOverlay'));

  let data;
  try {
    data = await apiTry(`/tags/${tagId}/usages`);
  } catch (err) {
    apiError(err, {
      retry: () => openTagDrawer(tagId),
      onRefresh: () => closeModal($('#tagDrawerOverlay')),
    });
    return;
  }
  if (!data || !data.tag) return;

  _currentDrawerTag = data.tag;
  _currentDrawerUsages = data.usages || {};
  _renderTagDrawer();
}

function _renderTagDrawer() {
  if (!_currentDrawerTag) return;
  const usages = _currentDrawerUsages || {};
  $('#tagDrawerName').textContent = _currentDrawerTag.name;
  const totalUsages = TAG_DRAWER_SECTIONS.reduce((sum, s) => sum + (usages[s.key]?.length || 0), 0);
  $('#tagDrawerCount').textContent = `${totalUsages} usage${totalUsages === 1 ? '' : 's'}`;

  if (!totalUsages) {
    $('#tagDrawerBody').innerHTML = `<div class="empty-state" style="margin-top:24px"><p>No items use this tag yet.</p></div>`;
    return;
  }

  const html = TAG_DRAWER_SECTIONS.map(s => {
    const items = usages[s.key] || [];
    if (!items.length) return '';
    const collapsed = items.length > 50 ? ' collapsed' : '';
    const itemsHtml = items.map(it => _renderDrawerItem(s, it)).join('');
    return `
      <div class="tag-drawer-section${collapsed}" data-section="${s.key}">
        <div class="tag-drawer-section-header">
          <span>${esc(s.label)} (${items.length})</span>
          <span class="tag-drawer-section-toggle">${collapsed ? 'show' : 'hide'}</span>
        </div>
        <div class="tag-drawer-section-body">${itemsHtml}</div>
      </div>`;
  }).join('');

  $('#tagDrawerBody').innerHTML = html;

  // Section collapse toggle
  $('#tagDrawerBody').querySelectorAll('.tag-drawer-section-header').forEach(h => {
    h.addEventListener('click', () => {
      const sec = h.parentElement;
      sec.classList.toggle('collapsed');
      const tog = h.querySelector('.tag-drawer-section-toggle');
      if (tog) tog.textContent = sec.classList.contains('collapsed') ? 'show' : 'hide';
    });
  });

  // Drawer item click → open entity surface
  $('#tagDrawerBody').querySelectorAll('.tag-drawer-item').forEach(it => {
    it.addEventListener('click', () => {
      const kind = it.dataset.kind;
      const id = parseInt(it.dataset.id, 10);
      _openDrawerItem(kind, id);
    });
  });
}

function _renderDrawerItem(section, item) {
  let title = '';
  let meta = '';
  if (section.key === 'journal_entries') {
    title = item.entry_date ? fmtDateLong(item.entry_date) : '(entry)';
    meta = (item.content || '').slice(0, 80);
  } else if (section.key === 'brain_dumps') {
    title = (item.content_prefix || '').replace(/\s+/g, ' ').trim().slice(0, 80) || '(brain dump)';
    meta = item.captured_at ? fmtRelative(item.captured_at) : '';
  } else {
    title = item[section.titleField] || `(${section.label.toLowerCase()})`;
    if (item.status) meta = item.status;
  }
  return `
    <div class="tag-drawer-item" data-kind="${section.key}" data-id="${item.id}">
      <span class="tag-drawer-item-title">${esc(title)}</span>
      ${meta ? `<span class="tag-drawer-item-meta">${esc(meta)}</span>` : ''}
      <span class="tag-drawer-item-chev">&rsaquo;</span>
    </div>`;
}

function _openDrawerItem(kind, id) {
  // Drawer stays open under the entity modal so closing the entity
  // brings Cam back to the drawer (lateral navigation).
  if (kind === 'goals') {
    openGoalDetail(id);
  } else if (kind === 'tasks') {
    // Tasks open the edit modal. Make sure the task is in allTasks first.
    apiTry(`/tasks/${id}`).then(t => {
      if (!t) return;
      if (!allTasks.some(x => x.id === t.id)) allTasks.push(t);
      openEditTask(id);
    }).catch(() => apiError({ status: 404 }));
  } else if (kind === 'people') {
    apiTry(`/people/${id}`).then(p => {
      if (!p) return;
      if (!allPeople.some(x => x.id === p.id)) allPeople.push(p);
      openEditPerson(id);
    }).catch(() => apiError({ status: 404 }));
  } else if (kind === 'knowledge') {
    apiTry(`/knowledge/${id}`).then(k => {
      if (!k) return;
      if (!allKnowledge.some(x => x.id === k.id)) allKnowledge.push(k);
      openEditKnowledge(id);
    }).catch(() => apiError({ status: 404 }));
  } else if (kind === 'journal_entries') {
    apiTry(`/entries/${id}`).then(entry => {
      if (!entry) return;
      if (!journalEntries.some(x => x.id === entry.id)) journalEntries.push(entry);
      openJournalDetail(entry.id);
    }).catch(() => apiError({ status: 404 }));
  } else if (kind === 'brain_dumps') {
    // Navigate to dump view (no per-dump modal exists today).
    closeModal($('#tagDrawerOverlay'));
    navigate('dump');
  }
}

// ── Drawer event listeners ────────────────────────────────
$('#tagDrawerClose')?.addEventListener('click', () => closeModal($('#tagDrawerOverlay')));
$('#tagDrawerOverlay')?.addEventListener('click', (e) => {
  if (e.target === $('#tagDrawerOverlay')) closeModal($('#tagDrawerOverlay'));
});

// Drawer footer actions
$('#tagDrawerRename')?.addEventListener('click', () => {
  if (_currentDrawerTagId) openTagRename(_currentDrawerTagId);
});
$('#tagDrawerMerge')?.addEventListener('click', () => {
  if (_currentDrawerTagId) openTagMerge(_currentDrawerTagId);
});
$('#tagDrawerDelete')?.addEventListener('click', () => {
  if (_currentDrawerTagId) openTagDelete(_currentDrawerTagId);
});

// ── Document-level chip click delegate ────────────────────
// Any element with data-tag-id opens the drawer. Excludes elements that
// are themselves part of the tags-list rows or the merge picker (they
// have their own bindings).
document.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-tag-id]');
  if (!chip) return;
  // Skip rows in the tags list (already wired) and items inside the drawer body itself.
  if (chip.classList.contains('tag-row')) return;
  if (chip.classList.contains('tag-merge-list-item')) return;
  if (chip.closest('#tagDrawerBody')) return;
  // Only respond to actual chip-y elements (button.tag-chip, span.tag with id, or data-driven elements)
  if (!chip.classList.contains('tag') && !chip.classList.contains('tag-chip') && !chip.dataset.tagChip) {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  const id = parseInt(chip.dataset.tagId, 10);
  if (id) openTagDrawer(id);
});

// ══════════════════════════════════════════════════════════
// TAG RENAME / MERGE / DELETE
// ══════════════════════════════════════════════════════════

function _findTag(id) {
  return allTags.find(t => t.id === id) || (_currentDrawerTag && _currentDrawerTag.id === id ? _currentDrawerTag : null);
}

// ── Rename ────────────────────────────────────────────────
function openTagRename(tagId) {
  const t = _findTag(tagId);
  if (!t) return;
  $('#tagRenameId').value = tagId;
  $('#tagRenameInput').value = t.name;
  $('#tagRenameHint').textContent = '';
  $('#tagRenameHint').classList.remove('error');
  openModal($('#tagRenameOverlay'));
  setTimeout(() => $('#tagRenameInput').focus(), 250);
}

async function submitTagRename() {
  const id = parseInt($('#tagRenameId').value, 10);
  const raw = ($('#tagRenameInput').value || '').trim();
  if (!raw) {
    $('#tagRenameHint').textContent = 'Name is required.';
    $('#tagRenameHint').classList.add('error');
    return;
  }
  const name = raw.toLowerCase().replace(/\s+/g, '-');

  $('#tagRenameSave').disabled = true;
  try {
    const res = await fetch(`${MOUNT}api/tags/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (res.status === 401) { window.location.href = `${MOUNT}login`; return; }
    let payload = null;
    try { payload = await res.json(); } catch (_) {}

    if (res.status === 200 && payload && payload.id) {
      closeModal($('#tagRenameOverlay'));
      // Update local cache
      const t = allTags.find(x => x.id === id);
      if (t) t.name = payload.name;
      if (_currentDrawerTag && _currentDrawerTag.id === id) _currentDrawerTag.name = payload.name;
      // Refresh views
      await loadTagsView();
      if (!$('#tagDrawerOverlay').classList.contains('hidden')) {
        $('#tagDrawerName').textContent = payload.name;
      }
      showToast(`Renamed to "${payload.name}".`);
      return;
    }
    if (res.status === 409 && payload && payload.id) {
      $('#tagRenameHint').innerHTML = `"${esc(name)}" already exists. <button type="button" class="btn-text" id="tagRenameOfferMerge" style="padding:0;font-size:0.75rem;color:var(--text)">Merge instead?</button>`;
      $('#tagRenameHint').classList.add('error');
      const mergeBtn = $('#tagRenameOfferMerge');
      const targetId = payload.id;
      if (mergeBtn) mergeBtn.addEventListener('click', () => {
        closeModal($('#tagRenameOverlay'));
        openTagMerge(id, targetId);
      });
      return;
    }
    if (res.status === 400) {
      $('#tagRenameHint').textContent = (payload && payload.error) || 'Invalid name.';
      $('#tagRenameHint').classList.add('error');
      return;
    }
    if (res.status === 404) {
      showToast('That tag no longer exists.');
      closeModal($('#tagRenameOverlay'));
      await loadTagsView();
      return;
    }
    showToast("Couldn't rename. Try again.");
  } catch (_) {
    showToast('Network error.');
  } finally {
    $('#tagRenameSave').disabled = false;
  }
}

$('#tagRenameClose')?.addEventListener('click', () => closeModal($('#tagRenameOverlay')));
$('#tagRenameCancel')?.addEventListener('click', () => closeModal($('#tagRenameOverlay')));
$('#tagRenameSave')?.addEventListener('click', submitTagRename);
$('#tagRenameInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submitTagRename(); }
});
$('#tagRenameOverlay')?.addEventListener('click', (e) => {
  if (e.target === $('#tagRenameOverlay')) closeModal($('#tagRenameOverlay'));
});

// ── Merge ─────────────────────────────────────────────────
let _tagMergeSelectedTargetId = null;
let _tagMergeSearchDebounce = null;

async function openTagMerge(sourceId, preselectTargetId) {
  // Make sure we have the latest list so the picker is fresh.
  if (!allTags.length) await loadTagsView();
  const source = _findTag(sourceId);
  if (!source) return;
  $('#tagMergeSourceId').value = sourceId;
  $('#tagMergeSourceLabel').textContent = `${source.name} (${source.usage_count || 0} usage${(source.usage_count || 0) === 1 ? '' : 's'})`;
  $('#tagMergeTargetSearch').value = '';
  $('#tagMergePreview').classList.remove('visible');
  $('#tagMergePreview').textContent = '';
  $('#tagMergeConfirm').disabled = true;
  _tagMergeSelectedTargetId = preselectTargetId || null;
  _renderTagMergeList(sourceId, '');
  openModal($('#tagMergeOverlay'));
  setTimeout(() => $('#tagMergeTargetSearch').focus(), 250);
  if (preselectTargetId) {
    _selectTagMergeTarget(preselectTargetId, sourceId);
  }
}

function _renderTagMergeList(sourceId, q) {
  const filter = (q || '').trim().toLowerCase();
  const list = allTags.filter(t => t.id !== sourceId && (!filter || t.name.toLowerCase().includes(filter)));
  list.sort((a, b) => (b.usage_count || 0) - (a.usage_count || 0) || a.name.localeCompare(b.name));
  const el = $('#tagMergeTargetList');
  if (!list.length) {
    el.innerHTML = `<div class="empty-state" style="padding:16px"><p>No other tags.</p></div>`;
    return;
  }
  el.innerHTML = list.slice(0, 100).map(t => `
    <div class="tag-merge-list-item${_tagMergeSelectedTargetId === t.id ? ' selected' : ''}" data-target-id="${t.id}">
      <span>${esc(t.name)}</span>
      <span class="tag-merge-list-item-count">${t.usage_count || 0}</span>
    </div>`).join('');
  el.querySelectorAll('.tag-merge-list-item').forEach(item => {
    item.addEventListener('click', () => {
      const targetId = parseInt(item.dataset.targetId, 10);
      _selectTagMergeTarget(targetId, sourceId);
    });
  });
}

function _selectTagMergeTarget(targetId, sourceId) {
  _tagMergeSelectedTargetId = targetId;
  $('#tagMergeTargetList').querySelectorAll('.tag-merge-list-item').forEach(it => {
    it.classList.toggle('selected', parseInt(it.dataset.targetId, 10) === targetId);
  });
  const source = _findTag(sourceId);
  const target = _findTag(targetId);
  if (!source || !target) return;
  const sCount = source.usage_count || 0;
  const tCount = target.usage_count || 0;
  const preview = `Merging "${source.name}" (${sCount} usage${sCount === 1 ? '' : 's'}) into "${target.name}" (${tCount} usage${tCount === 1 ? '' : 's'}). After merge, "${target.name}" will have up to ${sCount + tCount} usages, and "${source.name}" will be deleted.`;
  $('#tagMergePreview').textContent = preview;
  $('#tagMergePreview').classList.add('visible');
  $('#tagMergeConfirm').disabled = false;
}

async function submitTagMerge() {
  const sourceId = parseInt($('#tagMergeSourceId').value, 10);
  const targetId = _tagMergeSelectedTargetId;
  if (!sourceId || !targetId) return;
  $('#tagMergeConfirm').disabled = true;
  try {
    const res = await fetch(`${MOUNT}api/tags/${sourceId}/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_id: targetId }),
    });
    if (res.status === 401) { window.location.href = `${MOUNT}login`; return; }
    let payload = null;
    try { payload = await res.json(); } catch (_) {}

    if (res.status === 200 && payload && payload.target) {
      closeModal($('#tagMergeOverlay'));
      showToast(`Merged into "${payload.target.name}".`);
      await loadTagsView();
      // Navigate the drawer to the surviving target.
      openTagDrawer(payload.target.id);
      return;
    }
    if (res.status === 503) {
      // Auto-retry once after a short delay.
      setTimeout(submitTagMerge, 750);
      return;
    }
    if (res.status === 400) {
      showToast((payload && payload.error) || 'Invalid merge.');
      return;
    }
    if (res.status === 404) {
      showToast('Tag no longer exists.');
      closeModal($('#tagMergeOverlay'));
      await loadTagsView();
      return;
    }
    showToast("Couldn't merge. Try again.");
  } catch (_) {
    showToast('Network error.');
  } finally {
    $('#tagMergeConfirm').disabled = false;
  }
}

$('#tagMergeClose')?.addEventListener('click', () => closeModal($('#tagMergeOverlay')));
$('#tagMergeCancel')?.addEventListener('click', () => closeModal($('#tagMergeOverlay')));
$('#tagMergeConfirm')?.addEventListener('click', submitTagMerge);
$('#tagMergeOverlay')?.addEventListener('click', (e) => {
  if (e.target === $('#tagMergeOverlay')) closeModal($('#tagMergeOverlay'));
});
$('#tagMergeTargetSearch')?.addEventListener('input', () => {
  clearTimeout(_tagMergeSearchDebounce);
  _tagMergeSearchDebounce = setTimeout(() => {
    const sourceId = parseInt($('#tagMergeSourceId').value, 10);
    _renderTagMergeList(sourceId, $('#tagMergeTargetSearch').value);
  }, 100);
});

// ── Delete ────────────────────────────────────────────────
function openTagDelete(tagId) {
  const t = _findTag(tagId);
  if (!t) return;
  $('#tagDeleteId').value = tagId;
  const b = t.breakdown || {};
  const parts = [];
  if (b.goals)           parts.push(`${b.goals} goal${b.goals === 1 ? '' : 's'}`);
  if (b.tasks)           parts.push(`${b.tasks} task${b.tasks === 1 ? '' : 's'}`);
  if (b.knowledge)       parts.push(`${b.knowledge} knowledge`);
  if (b.people)          parts.push(`${b.people} ${b.people === 1 ? 'person' : 'people'}`);
  if (b.journal_entries) parts.push(`${b.journal_entries} entr${b.journal_entries === 1 ? 'y' : 'ies'}`);
  if (b.brain_dumps)     parts.push(`${b.brain_dumps} dump${b.brain_dumps === 1 ? '' : 's'}`);
  const total = t.usage_count || 0;
  const breakdown = parts.length ? ` (${parts.join(', ')})` : '';
  const msg = total
    ? `Delete "${t.name}"? It will be removed from ${total} item${total === 1 ? '' : 's'}${breakdown}.`
    : `Delete "${t.name}"? It is currently unused.`;
  $('#tagDeleteMessage').textContent = msg;
  openModal($('#tagDeleteOverlay'));
}

async function submitTagDelete() {
  const id = parseInt($('#tagDeleteId').value, 10);
  if (!id) return;
  $('#tagDeleteConfirm').disabled = true;
  try {
    const res = await fetch(`${MOUNT}api/tags/${id}`, { method: 'DELETE' });
    if (res.status === 401) { window.location.href = `${MOUNT}login`; return; }
    if (res.status === 204) {
      closeModal($('#tagDeleteOverlay'));
      // Close drawer if open on the deleted tag
      if (_currentDrawerTagId === id) {
        closeModal($('#tagDrawerOverlay'));
        _currentDrawerTagId = null;
        _currentDrawerTag = null;
      }
      showToast('Tag deleted.');
      await loadTagsView();
      return;
    }
    if (res.status === 404) {
      showToast('That tag no longer exists.');
      closeModal($('#tagDeleteOverlay'));
      await loadTagsView();
      return;
    }
    showToast("Couldn't delete. Try again.");
  } catch (_) {
    showToast('Network error.');
  } finally {
    $('#tagDeleteConfirm').disabled = false;
  }
}

$('#tagDeleteClose')?.addEventListener('click', () => closeModal($('#tagDeleteOverlay')));
$('#tagDeleteCancel')?.addEventListener('click', () => closeModal($('#tagDeleteOverlay')));
$('#tagDeleteConfirm')?.addEventListener('click', submitTagDelete);
$('#tagDeleteOverlay')?.addEventListener('click', (e) => {
  if (e.target === $('#tagDeleteOverlay')) closeModal($('#tagDeleteOverlay'));
});

// ══════════════════════════════════════════════════════════
// EDIT & DELETE — PEOPLE
// ══════════════════════════════════════════════════════════

function openEditPerson(id) {
  const p = allPeople.find(x => x.id === id);
  if (!p) return;
  $('#editPersonId').value = p.id;
  $('#editPersonName').value = p.name || '';
  $('#editPersonRelationship').value = p.relationship || '';
  $('#editPersonNotes').value = p.notes || '';
  openModal($('#editPersonOverlay'));
  setTimeout(() => $('#editPersonName').focus(), 250);
}

$('#savePersonBtn').addEventListener('click', async () => {
  const id = $('#editPersonId').value;
  const body = {
    name: $('#editPersonName').value.trim(),
    relationship: $('#editPersonRelationship').value.trim(),
    notes: $('#editPersonNotes').value.trim(),
  };
  if (!body.name) return;
  $('#savePersonBtn').disabled = true;
  try {
    await api(`/people/${id}`, { method: 'PUT', body });
    closeModal($('#editPersonOverlay'));
    loadPeople();
  } finally {
    $('#savePersonBtn').disabled = false;
  }
});

async function deletePerson(id) {
  const p = allPeople.find(x => x.id === id);
  const name = p ? p.name : 'this person';
  if (!confirm(`Delete ${name}? This cannot be undone.`)) return;
  await api(`/people/${id}`, { method: 'DELETE' });
  loadPeople();
}

// ══════════════════════════════════════════════════════════
// EDIT & DELETE — TASKS
// ══════════════════════════════════════════════════════════

async function openEditTask(id) {
  const t = allTasks.find(x => x.id === id);
  if (!t) return;
  // Populate goal dropdown
  const goals = await api('/goals');
  const sel = $('#editTaskGoalId');
  sel.innerHTML = '<option value="">No goal</option>' +
    goals.map(g => `<option value="${g.id}" ${t.goal_id == g.id ? 'selected' : ''}>${esc(g.title)}</option>`).join('');
  $('#editTaskId').value = t.id;
  $('#editTaskTitle').value = t.title || '';
  $('#editTaskDescription').value = t.description || '';
  $('#editTaskStatus').value = t.status || 'active';
  $('#editTaskDueDate').value = t.due_date || '';
  openModal($('#editTaskOverlay'));
  setTimeout(() => $('#editTaskTitle').focus(), 250);
}

$('#saveTaskBtn').addEventListener('click', async () => {
  const id = $('#editTaskId').value;
  const body = {
    title: $('#editTaskTitle').value.trim(),
    description: $('#editTaskDescription').value.trim(),
    status: $('#editTaskStatus').value,
    due_date: $('#editTaskDueDate').value || null,
    goal_id: $('#editTaskGoalId').value ? parseInt($('#editTaskGoalId').value) : null,
  };
  if (!body.title) return;
  $('#saveTaskBtn').disabled = true;
  try {
    await api(`/tasks/${id}`, { method: 'PUT', body });
    closeModal($('#editTaskOverlay'));
    loadTasks();
  } finally {
    $('#saveTaskBtn').disabled = false;
  }
});

async function deleteTask(id) {
  const t = allTasks.find(x => x.id === id);
  const name = t ? t.title : 'this task';
  if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
  await api(`/tasks/${id}`, { method: 'DELETE' });
  loadTasks();
}

// ══════════════════════════════════════════════════════════
// EDIT & DELETE — GOALS
// ══════════════════════════════════════════════════════════

function openEditGoal(id) {
  const g = allGoals.find(x => x.id === id);
  if (!g) return;
  $('#editGoalId').value = g.id;
  $('#editGoalTitle').value = g.title || '';
  $('#editGoalDescription').value = g.description || '';
  $('#editGoalStatus').value = g.status || 'active';
  $('#editGoalTargetDate').value = g.target_date || '';
  openModal($('#editGoalOverlay'));
  closeModal($('#goalDetailOverlay'));
  setTimeout(() => $('#editGoalTitle').focus(), 250);
}

$('#saveGoalBtn').addEventListener('click', async () => {
  const id = $('#editGoalId').value;
  const body = {
    title: $('#editGoalTitle').value.trim(),
    description: $('#editGoalDescription').value.trim(),
    status: $('#editGoalStatus').value,
    target_date: $('#editGoalTargetDate').value || null,
  };
  if (!body.title) return;
  $('#saveGoalBtn').disabled = true;
  try {
    await api(`/goals/${id}`, { method: 'PUT', body });
    closeModal($('#editGoalOverlay'));
    loadGoals();
  } finally {
    $('#saveGoalBtn').disabled = false;
  }
});

async function deleteGoal(id, taskCount) {
  const g = allGoals.find(x => x.id === id);
  const name = g ? g.title : 'this goal';
  let msg = `Delete "${name}"? This cannot be undone.`;
  if (taskCount > 0) {
    msg = `This goal has ${taskCount} linked task${taskCount > 1 ? 's' : ''}. They will be unlinked (not deleted). Delete "${name}" anyway?`;
  }
  if (!confirm(msg)) return;
  await api(`/goals/${id}`, { method: 'DELETE' });
  closeModal($('#goalDetailOverlay'));
  loadGoals();
}

// ══════════════════════════════════════════════════════════
// EDIT & DELETE — KNOWLEDGE
// ══════════════════════════════════════════════════════════

function openEditKnowledge(id) {
  const k = allKnowledge.find(x => x.id === id);
  if (!k) return;
  $('#editKnowledgeId').value = k.id;
  $('#editKnowledgeTitle').value = k.title || '';
  $('#editKnowledgeContent').value = k.content || '';
  $('#editKnowledgeType').value = k.item_type || 'fact';
  openModal($('#editKnowledgeOverlay'));
  setTimeout(() => $('#editKnowledgeTitle').focus(), 250);
}

$('#saveKnowledgeBtn').addEventListener('click', async () => {
  const id = $('#editKnowledgeId').value;
  const body = {
    title: $('#editKnowledgeTitle').value.trim(),
    content: $('#editKnowledgeContent').value.trim(),
    item_type: $('#editKnowledgeType').value,
  };
  if (!body.title) return;
  $('#saveKnowledgeBtn').disabled = true;
  try {
    await api(`/knowledge/${id}`, { method: 'PUT', body });
    closeModal($('#editKnowledgeOverlay'));
    loadKnowledge();
  } finally {
    $('#saveKnowledgeBtn').disabled = false;
  }
});

async function deleteKnowledge(id) {
  const k = allKnowledge.find(x => x.id === id);
  const name = k ? k.title : 'this item';
  if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
  await api(`/knowledge/${id}`, { method: 'DELETE' });
  loadKnowledge();
}

// ══════════════════════════════════════════════════════════
// DELETE — BRAIN DUMPS
// ══════════════════════════════════════════════════════════

async function deleteBrainDump(id) {
  if (!confirm('Delete this brain dump? This cannot be undone.')) return;
  await api(`/brain-dumps/${id}`, { method: 'DELETE' });
  loadDumps();
}

// ══════════════════════════════════════════════════════════
// KEYBOARD SHORTCUTS
// ══════════════════════════════════════════════════════════

document.addEventListener('keydown', (e) => {
  const isInput = ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);

  // Escape always works
  if (e.key === 'Escape') {
    // Lateral-nav priority: when a detail modal is stacked over the
    // dump drawer (e.g. clicked an auto_created goal item), Escape must
    // close the topmost surface only and leave the drawer behind, so the
    // user lands back on the drawer they navigated from. Without this
    // guard, the drawer-close branch below would fire in the same tick
    // and collapse both at once.
    const goalDetailOpen = !$('#goalDetailOverlay').classList.contains('hidden');
    const dumpDrawerOpen = !$('#dumpDetailOverlay').classList.contains('hidden');
    if (goalDetailOpen && dumpDrawerOpen) {
      closeModal($('#goalDetailOverlay'));
      document.activeElement.blur();
      return;
    }

    closeJournalComposer();
    closeModal($('#journalDetailOverlay'));
    closeModal($('#goalDetailOverlay'));
    closeModal($('#editPersonOverlay'));
    closeModal($('#editTaskOverlay'));
    closeModal($('#editGoalOverlay'));
    closeModal($('#editKnowledgeOverlay'));
    closeModal($('#tagDrawerOverlay'));
    closeModal($('#tagRenameOverlay'));
    closeModal($('#tagMergeOverlay'));
    closeModal($('#tagDeleteOverlay'));
    closeModal($('#helpOverlay'));
    if (!$('#dumpDetailOverlay').classList.contains('hidden')) {
      closeModal($('#dumpDetailOverlay'));
      _currentDumpDetailId = null;
      _dumpDetailEditing = false;
    }
    document.activeElement.blur();
    return;
  }

  // Cmd/Ctrl+Enter to save/submit
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    if (!$('#editPersonOverlay').classList.contains('hidden')) { e.preventDefault(); $('#savePersonBtn').click(); return; }
    if (!$('#editTaskOverlay').classList.contains('hidden')) { e.preventDefault(); $('#saveTaskBtn').click(); return; }
    if (!$('#editGoalOverlay').classList.contains('hidden')) { e.preventDefault(); $('#saveGoalBtn').click(); return; }
    if (!$('#editKnowledgeOverlay').classList.contains('hidden')) { e.preventDefault(); $('#saveKnowledgeBtn').click(); return; }
    if (!$('#tagRenameOverlay').classList.contains('hidden')) { e.preventDefault(); $('#tagRenameSave').click(); return; }
    if (!$('#tagMergeOverlay').classList.contains('hidden') && !$('#tagMergeConfirm').disabled) { e.preventDefault(); $('#tagMergeConfirm').click(); return; }
    if (!$('#journalOverlay').classList.contains('hidden')) {
      e.preventDefault();
      saveJournalEntry();
      return;
    }
    // Submit brain dump from anywhere
    if (document.activeElement === homeDump) {
      e.preventDefault();
      submitHomeDump();
      return;
    }
    if (document.activeElement === dumpInput) {
      e.preventDefault();
      dumpSend.click();
      return;
    }
  }

  if (isInput) return;

  // N = new brain dump (focus the dump input)
  if (e.key === 'n' || e.key === 'N') {
    e.preventDefault();
    if (currentView === 'home') {
      homeDump.focus();
    } else if (currentView === 'dump') {
      dumpInput.focus();
    } else if (currentView === 'journal') {
      openJournalComposer();
    } else {
      navigate('home');
      setTimeout(() => homeDump.focus(), 100);
    }
    return;
  }

  // / = search
  if (e.key === '/') {
    e.preventDefault();
    if (currentView === 'journal') {
      $('#journalSearch').focus();
    } else if (currentView === 'knowledge') {
      $('#knowledgeSearch').focus();
    } else {
      navigate('journal');
      setTimeout(() => $('#journalSearch').focus(), 100);
    }
    return;
  }

  // G = goals
  if (e.key === 'g' || e.key === 'G') {
    e.preventDefault();
    navigate('goals');
    return;
  }

  // T = tasks
  if (e.key === 't' || e.key === 'T') {
    e.preventDefault();
    navigate('tasks');
    return;
  }
});

// ── Click-outside-to-close for edit modals ──────────────
['#editPersonOverlay', '#editTaskOverlay', '#editGoalOverlay', '#editKnowledgeOverlay'].forEach(sel => {
  $(sel).addEventListener('click', e => { if (e.target === $(sel)) closeModal($(sel)); });
});

// ══════════════════════════════════════════════════════════
// PULL TO REFRESH (touch devices only)
// ══════════════════════════════════════════════════════════

(() => {
  // Only activate on touch devices
  if (!('ontouchstart' in window)) return;

  const indicator = document.getElementById('ptrIndicator');
  if (!indicator) return;

  let startY = 0;
  let pulling = false;
  const THRESHOLD = 60;

  function reloadCurrentView() {
    if (currentView === 'home') loadHome();
    else if (currentView === 'dump') loadDumps();
    else if (currentView === 'goals') loadGoals();
    else if (currentView === 'tasks') loadTasks();
    else if (currentView === 'people') loadPeople();
    else if (currentView === 'journal') loadJournal();
    else if (currentView === 'knowledge') loadKnowledge();
    else if (currentView === 'tags') loadTagsView();
  }

  document.addEventListener('touchstart', (e) => {
    // Only start if at scroll top
    if (window.scrollY > 0) return;
    // Don't interfere with inputs or modals
    if (e.target.closest('.modal') || e.target.closest('.overlay:not(.hidden)')) return;
    startY = e.touches[0].clientY;
    pulling = true;
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - startY;
    if (dy < 0 || window.scrollY > 0) {
      indicator.classList.remove('visible');
      pulling = false;
      return;
    }
    if (dy > 10) {
      indicator.classList.add('visible');
      indicator.textContent = dy >= THRESHOLD ? 'Release to refresh' : '\u2193 Pull to refresh';
    }
  }, { passive: true });

  document.addEventListener('touchend', () => {
    if (!pulling) return;
    pulling = false;
    if (indicator.classList.contains('visible') && indicator.textContent === 'Release to refresh') {
      indicator.textContent = 'Refreshing...';
      indicator.classList.add('refreshing');
      reloadCurrentView();
      setTimeout(() => {
        indicator.classList.remove('visible', 'refreshing');
      }, 600);
    } else {
      indicator.classList.remove('visible');
    }
  }, { passive: true });
})();

// ══════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════

initAddPersonForm();
initAddKnowledgeForm();
initAddGoalForm();
initAddTaskForm();
_initTagsView();

// Deep-link: if the page loaded with ?addNote=1, jump straight to Knowledge.
{
  const _params = new URLSearchParams(window.location.search);
  if (_params.get('addNote') === '1') {
    navigate('knowledge');
  } else {
    loadHome();
  }
}
