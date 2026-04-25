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

function tagsHtml(tags) {
  if (!tags || !tags.length) return '';
  return `<div class="tags-row">${tags.map(t => `<span class="tag">${esc(t.name)}</span>`).join('')}</div>`;
}

function typePill(type) {
  return `<span class="knowledge-type type-${esc(type)}">${esc(type)}</span>`;
}

async function api(path, opts = {}) {
  const res = await fetch(`${MOUNT}api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    window.location.href = `${MOUNT}login`;
    // Return a never-resolving promise so callers don't error mid-redirect
    return new Promise(() => {});
  }
  return res.json();
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

// ── Modal helpers ──────────────────────────────────────
function openModal(el) {
  el.classList.remove('hidden');
  requestAnimationFrame(() => el.classList.add('visible'));
}
function closeModal(el) {
  el.classList.remove('visible');
  setTimeout(() => el.classList.add('hidden'), 200);
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
  const moreViews = ['people', 'journal', 'knowledge'];
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
}

$$('.nav-link, .nav-brand').forEach(el => {
  el.addEventListener('click', () => {
    if (el.id === 'navMoreBtn') return; // handled separately
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
    const unresolvedBlockers = pg.blockers.filter(b => !b.resolved);
    const resolvedBlockers = pg.blockers.filter(b => b.resolved);
    $('#homeHero').innerHTML = `
      <div class="hero-goal fade-in">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          ${statusPill(pg.status)}
          ${pg.target_date ? `<span style="font-size:0.6875rem;color:var(--text-3)">Target: ${fmtDate(pg.target_date)}</span>` : ''}
        </div>
        <div class="hero-goal-title">${esc(pg.title)}</div>
        <div class="hero-goal-desc">${esc(pg.description)}</div>
        ${unresolvedBlockers.length ? `
          <div class="blockers-label">Blockers (${unresolvedBlockers.length} unresolved)</div>
          ${unresolvedBlockers.map(b => `
            <div class="blocker-item">
              <div class="blocker-icon blocking">!</div>
              <span class="blocker-name">${esc(b.blocker_name)}</span>
              <span class="blocker-type">${esc(b.blocker_type)}</span>
              ${b.blocker_status ? statusPill(b.blocker_status) : ''}
            </div>
          `).join('')}
        ` : '<div style="font-size:0.8125rem;color:var(--green)">No unresolved blockers</div>'}
      </div>
    `;
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
        <div class="dump-item fade-in">
          <div class="dump-item-header">
            <span class="dump-time">${fmtRelative(d.captured_at)}</span>
            ${processingStatusLabel(d)}
          </div>
          <div class="dump-item-content">${esc(d.content)}</div>
          ${processingResultsPills(d)}
          ${tagsHtml(d.tags)}
        </div>
      `).join('')}
    `;
    bindResultPills('#homeRecentDumps');
  } else {
    $('#homeRecentDumps').innerHTML = '';
  }

  // Polling: kick off if a recent dump is in flight.
  if (currentView === 'home') {
    if (_hasInflightDump()) startBrainDumpPolling();
    else stopBrainDumpPolling();
  }
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

    let actionsHtml = `<button class="prompt-btn" onclick="dismissPrompt(${p.id})">Got it</button>`;
    if (hasSource) {
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

function focusBrainDump() {
  homeDump.focus();
  homeDump.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
  el.textContent = msg;
  requestAnimationFrame(() => el.classList.add('visible'));
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('visible'), 2800);
}

// ── Retry handler (background-processing contract) ──────────
async function retryBrainDump(id) {
  const dump = allDumps.find(d => d.id === id);
  // Optimistic flip — mutate local model, re-render, then fire request.
  if (dump) dump.processing_status = 'queued';
  if (currentView === 'dump') renderDumps();
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
      <div class="dump-item fade-in">
        <div class="dump-item-header">
          <span class="dump-time">${fmtRelative(d.captured_at)}</span>
          ${processingStatusLabel(d)}
          ${retryButton(d)}
          <span style="flex:1"></span>
          ${needsReview && suggestedCount > 0 ? `
            <button class="btn-review" data-dump-id="${d.id}">
              Review ${suggestedCount} suggestion${suggestedCount > 1 ? 's' : ''}
            </button>
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

  // Bind review buttons
  el.querySelectorAll('.btn-review').forEach(btn => {
    btn.addEventListener('click', () => {
      const dumpId = parseInt(btn.dataset.dumpId);
      const dump = allDumps.find(d => d.id === dumpId);
      if (dump) openReviewModal(dump);
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
// REVIEW MODAL
// ══════════════════════════════════════════════════════════

let reviewingDumpId = null;

function confidenceLabel(conf) {
  if (conf >= 0.80) return 'likely';
  if (conf >= 0.65) return 'maybe';
  return 'uncertain';
}

function reviewItemTitle(item) {
  const t = item.type;
  const d = item.data;
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
    'person_new': 'New Person',
    'person_mention': 'Person',
    'tag': 'Tag',
    'goal_link': 'Goal Link',
    'goal_new': 'New Goal',
  };
  return labels[type] || type;
}

function openReviewModal(dump) {
  reviewingDumpId = dump.id;
  const items = dump.processed_items && dump.processed_items.items
    ? dump.processed_items.items
    : [];

  const suggested = items
    .map((item, idx) => ({ ...item, _index: idx }))
    .filter(i => i.status === 'suggested');

  if (!suggested.length) {
    // No suggestions left
    $('#reviewBody').innerHTML = `
      <div class="empty-state" style="padding:30px 0">
        <p>All suggestions have been reviewed</p>
      </div>
    `;
    openModal($('#reviewOverlay'));
    return;
  }

  $('#reviewTitle').textContent = `Review ${suggested.length} suggestion${suggested.length > 1 ? 's' : ''}`;

  $('#reviewBody').innerHTML = suggested.map(item => {
    const goalInfo = item.data.goal_title
      ? `<div class="review-item-goal">Linked to goal: ${esc(item.data.goal_title)}</div>`
      : '';

    return `
      <div class="review-item" data-item-index="${item._index}">
        <div class="review-item-header">
          <span class="review-type-badge ${esc(item.type)}">${esc(reviewItemTypeLabel(item.type))}</span>
          <span class="review-confidence">${esc(confidenceLabel(item.confidence))}</span>
        </div>
        <div class="review-item-title">${esc(reviewItemTitle(item))}</div>
        ${item.source_text ? `<div class="review-item-context">"${esc(item.source_text.substring(0, 200))}"</div>` : ''}
        ${goalInfo}
        <div class="review-actions">
          <button class="btn-approve" data-action="approve" data-index="${item._index}">Approve</button>
          <button class="btn-edit-approve" data-action="edit" data-index="${item._index}">Edit & Approve</button>
          <button class="btn-dismiss" data-action="reject" data-index="${item._index}">Dismiss</button>
        </div>
        <div class="edit-form" id="editForm-${item._index}">
          ${item.type === 'task' ? `
            <input type="text" class="form-input" id="editTitle-${item._index}" value="${esc(item.data.title || '')}" placeholder="Task title">
          ` : item.type === 'knowledge' ? `
            <input type="text" class="form-input" id="editTitle-${item._index}" value="${esc(item.data.title || '')}" placeholder="Title">
          ` : item.type === 'person_new' ? `
            <input type="text" class="form-input" id="editTitle-${item._index}" value="${esc(item.data.name || '')}" placeholder="Person name">
          ` : item.type === 'goal_new' ? `
            <input type="text" class="form-input" id="editTitle-${item._index}" value="${esc(item.data.title || '')}" placeholder="Goal title">
          ` : `
            <input type="text" class="form-input" id="editTitle-${item._index}" value="${esc(item.data.tag_name || item.data.title || '')}" placeholder="Value">
          `}
          <div class="edit-form-actions">
            <button class="btn" data-action="cancel-edit" data-index="${item._index}" style="font-size:0.6875rem;padding:4px 10px">Cancel</button>
            <button class="btn-approve" data-action="save-edit" data-index="${item._index}" style="font-size:0.6875rem;padding:4px 10px">Save & Approve</button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Bind review actions
  $('#reviewBody').querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const index = parseInt(btn.dataset.index);

      if (action === 'approve') {
        btn.textContent = '...';
        btn.disabled = true;
        await api(`/brain-dumps/${reviewingDumpId}/approve-item`, {
          method: 'POST',
          body: { item_index: index, action: 'approve' },
        });
        refreshReview();
      } else if (action === 'reject') {
        btn.textContent = '...';
        btn.disabled = true;
        await api(`/brain-dumps/${reviewingDumpId}/approve-item`, {
          method: 'POST',
          body: { item_index: index, action: 'reject' },
        });
        refreshReview();
      } else if (action === 'edit') {
        const form = $(`#editForm-${index}`);
        form.classList.toggle('visible');
      } else if (action === 'cancel-edit') {
        $(`#editForm-${index}`).classList.remove('visible');
      } else if (action === 'save-edit') {
        const titleInput = $(`#editTitle-${index}`);
        const newVal = titleInput ? titleInput.value.trim() : '';
        if (!newVal) return;

        // Build edit_data based on item type
        const itemEl = btn.closest('.review-item');
        const itemIndex = parseInt(itemEl.dataset.itemIndex);
        const dump = allDumps.find(d => d.id === reviewingDumpId);
        const item = dump && dump.processed_items && dump.processed_items.items[itemIndex];

        let editData = {};
        if (item) {
          if (item.type === 'task') editData = { title: newVal };
          else if (item.type === 'knowledge') editData = { title: newVal };
          else if (item.type === 'person_new') editData = { name: newVal };
          else if (item.type === 'goal_new') editData = { title: newVal };
          else if (item.type === 'tag') editData = { tag_name: newVal };
        }

        btn.textContent = '...';
        btn.disabled = true;
        await api(`/brain-dumps/${reviewingDumpId}/approve-item`, {
          method: 'POST',
          body: { item_index: index, action: 'edit_approve', edit_data: editData },
        });
        refreshReview();
      }
    });
  });

  openModal($('#reviewOverlay'));
}

async function refreshReview() {
  // Reload dump data and re-render
  const dumps = await api('/brain-dumps');
  allDumps = dumps;
  const dump = allDumps.find(d => d.id === reviewingDumpId);

  if (dump) {
    const items = dump.processed_items && dump.processed_items.items
      ? dump.processed_items.items : [];
    const suggested = items.filter(i => i.status === 'suggested');

    if (suggested.length === 0) {
      $('#reviewBody').innerHTML = `
        <div class="empty-state" style="padding:30px 0">
          <p>All suggestions reviewed</p>
          <p class="hint">Processing complete</p>
        </div>
      `;
      // Refresh the dump list in the background
      setTimeout(() => {
        renderDumps();
        const reviewCount = allDumps.filter(d => d.processing_status === 'needs_review').length;
        updateDumpBadge(reviewCount);
      }, 300);
      return;
    }
    openReviewModal(dump);
  }
}

$('#reviewClose').addEventListener('click', () => {
  closeModal($('#reviewOverlay'));
  reviewingDumpId = null;
  loadDumps();
});

$('#reviewOverlay').addEventListener('click', e => {
  if (e.target === $('#reviewOverlay')) {
    closeModal($('#reviewOverlay'));
    reviewingDumpId = null;
    loadDumps();
  }
});

// ══════════════════════════════════════════════════════════
// GOALS VIEW
// ══════════════════════════════════════════════════════════

let goalFilter = 'all';
let allGoals = [];

async function loadGoals() {
  const params = goalFilter !== 'all' ? `?status=${goalFilter}` : '';
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
  const goal = await api(`/goals/${goalId}`);
  if (goal.error) return;

  $('#goalDetailTitle').textContent = goal.title;
  const tasks = goal.tasks || [];
  const activeTasks = tasks.filter(t => t.status === 'active' || t.status === 'waiting');
  const completedTasks = tasks.filter(t => t.status === 'completed');
  const unresolvedBlockers = (goal.blockers || []).filter(b => !b.resolved);

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

    ${unresolvedBlockers.length ? `
      <div class="goal-detail-section">
        <div class="goal-detail-section-title">Blockers</div>
        ${unresolvedBlockers.map(b => `
          <div class="blocker-item">
            <div class="blocker-icon blocking">!</div>
            <span class="blocker-name">${esc(b.blocker_name)}</span>
            <span class="blocker-type">${esc(b.blocker_type)}</span>
          </div>
        `).join('')}
      </div>
    ` : ''}

    ${activeTasks.length ? `
      <div class="goal-detail-section">
        <div class="goal-detail-section-title">Active Tasks (${activeTasks.length})</div>
        ${activeTasks.map(t => `
          <div class="task-row">
            <div class="task-check" data-task-id="${t.id}"></div>
            <span class="task-title">${esc(t.title)}</span>
            ${statusPill(t.status)}
          </div>
        `).join('')}
      </div>
    ` : ''}

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

  // Bind task completion
  $('#goalDetailBody').querySelectorAll('.task-check:not(.checked)').forEach(check => {
    check.addEventListener('click', async (e) => {
      e.stopPropagation();
      const taskId = check.dataset.taskId;
      await api(`/tasks/${taskId}`, { method: 'PUT', body: { status: 'completed' } });
      openGoalDetail(goalId); // refresh
    });
  });

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

// Goal filter pills
$('#goalFilters').addEventListener('click', e => {
  const pill = e.target.closest('.filter-pill');
  if (!pill) return;
  goalFilter = pill.dataset.filter;
  $('#goalFilters').querySelectorAll('.filter-pill').forEach(p => p.classList.toggle('active', p.dataset.filter === goalFilter));
  loadGoals();
});

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
            <div class="task-row">
              <div class="task-check ${t.status === 'completed' ? 'checked' : ''}" data-task-id="${t.id}" data-status="${t.status}"></div>
              <span class="task-title ${t.status === 'completed' ? 'done' : ''}">${esc(t.title)}</span>
              ${t.due_date ? `<span style="font-size:0.625rem;color:var(--text-3)">${fmtDate(t.due_date)}</span>` : ''}
              ${t.people && t.people.length ? `<span style="font-size:0.625rem;color:var(--text-3)">${t.people.map(p => esc(p.name)).join(', ')}</span>` : ''}
              ${t.status !== 'completed' && t.status !== 'active' ? statusPill(t.status) : ''}
              ${actionsHtml('openEditTask(' + t.id + ')', 'deleteTask(' + t.id + ')')}
            </div>
          `).join('')}
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
}

// Task status filter pills
$('#taskFilters').addEventListener('click', e => {
  const pill = e.target.closest('.filter-pill');
  if (!pill) return;
  taskStatusFilter = pill.dataset.filter;
  $('#taskFilters').querySelectorAll('.filter-pill').forEach(p => p.classList.toggle('active', p.dataset.filter === taskStatusFilter));
  loadTasks();
});

// ══════════════════════════════════════════════════════════
// PEOPLE VIEW
// ══════════════════════════════════════════════════════════

let allPeople = [];

async function loadPeople() {
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
      <div class="card person-card fade-in">
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
      ${e.tags.length ? `<div class="entry-tags-row">${e.tags.map(t => `<span class="tag">${esc(t.name)}</span>`).join('')}</div>` : ''}
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
  $('#journalDetailTags').innerHTML = entry.tags.map(t => `<span class="tag">${esc(t.name)}</span>`).join('');
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
  allKnowledge = await api(`/knowledge${qs ? '?' + qs : ''}`);
  renderKnowledge();
}

function renderKnowledge() {
  const el = $('#knowledgeList');
  if (!allKnowledge.length) {
    el.innerHTML = `<div class="empty-state"><p>No knowledge items found</p></div>`;
    return;
  }

  el.innerHTML = allKnowledge.map(k => `
    <div class="card knowledge-card fade-in">
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
    closeJournalComposer();
    closeModal($('#journalDetailOverlay'));
    closeModal($('#goalDetailOverlay'));
    closeModal($('#editPersonOverlay'));
    closeModal($('#editTaskOverlay'));
    closeModal($('#editGoalOverlay'));
    closeModal($('#editKnowledgeOverlay'));
    if (!$('#reviewOverlay').classList.contains('hidden')) {
      closeModal($('#reviewOverlay'));
      reviewingDumpId = null;
      if (currentView === 'dump') loadDumps();
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

loadHome();
