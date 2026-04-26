# System-wide UX audit — 2026-04-26

**Auditor:** Iris (Senior Interaction Designer)
**Method:** static read of `app/index.html`, `app/app.js`, `app/login.html`,
plus context from `data/SCHEMA.md`, `docs/processes/team-practices.md`,
and the recent retros. **No live walkthrough.** Several items below are
flagged for live confirmation with Probe.
**Rubric:** every visible element is actionable or justified; every surface
has a clear next action; every state continues the flow; the user can
recover from any action.

**Severity:**

- **P1 — broken / missing core action.** Surface fails its primary job. The user feels the dead end.
- **P2 — passive surface, no affordance.** Surface displays data with no path to act on the visible thing. The "flat" feeling.
- **P3 — polish opportunity.** Functional but inert; could feel more alive.

**A note on scope.** I am new. Where I could not verify a behaviour from
the code alone, I say so and queue it for Probe + Cam walkthrough.

---

## Surface-by-surface

### 1. Login (`login.html`)

**Surface:** single password card, "Sign in to continue."
**Job:** authenticate and get into the app.
**Next action:** type password, submit.

- Element scan: form, password input, submit button, error region. All actionable / justified. Subtitle is decoration but earns it (orientation).
- Empty state: N/A (always one input).
- Error state: shows wrong-password / rate-limit / network errors with a clear, dated tone. Recovery path is implicit (re-enter and submit). Good.
- **Verdict: clean.** No password-recovery link, but Cam is the only user — out of scope.

### 2. Home (`view-home`)

**Surface:** dashboard. Brain-dump quick capture, prompts, primary goal hero, active goals, stalled goals, recent captures.
**Job:** land, see what needs me, capture or jump in.
**Next action:** capture a thought, or click into the surface that's pulling the eye.

- Brain-dump quick input: actionable, with success state and inline polling. Clean.
- Prompts section: card with "Got it" + sometimes "Add a note", "Take me there", "Brain dump". Coverage is *uneven by prompt type* — see Prompts surface below. **P1 carry-forward.**
- Hero goal: title, description, status pill, target date, blocker list. **The hero card itself is not clickable.** Hovering the most important goal in the system shouldn't be a dead end — it should open the goal detail. Blocker rows inside the hero are also display-only (name, type, status pill). **P1.**
- Active goals: cards are clickable to open detail (good). Status pill on each is decorative. Tags chips are decorative. **P2.**
- Stalled goals ("Needs Attention"): same as active goals — clickable card, decorative pill/tags. The stalled state could *itself* be an action ("nudge", "mark active", "snooze") — currently the user has to open the modal and edit status. **P3.**
- Recent captures: dump rows render with status badge, content, result pills, tags. Result pills are clickable (good — expands details and navigates). The dump *content row itself is not clickable* — there's no way to open the dump from home. The Failed state on home dumps shows the badge but no Retry button (Retry only appears in the Brain Dump view). **P2 + P1 (Failed without Retry on home).**
- Empty state for recent captures: just hides the section. A first-time user with no dumps gets a hero empty home — no nudge. **P3.**
- Loading state: nothing — sections render as data arrives. Fine for a fast local app; if a network blip leaves a section blank, the user has no signal. **P3.** Confirm with Probe on slow network.

**Verdict: has P1.**

### 3. Brain Dump (`view-dump`)

**Surface:** capture textarea + filter pills + dump list.
**Job:** triage what's been captured; see what's processing; review suggestions.
**Next action:** dump, review, retry, or delete.

- Capture: clean.
- Filter pills (All / Needs Review / Processed / Unprocessed): actionable. Good.
- Dump row: timestamp, status badge, retry button (if failed), Review button (if needs_review), Process button (if unprocessed legacy), three-dot menu with Delete. Result pills are clickable.
- **The dump row itself is not clickable.** A user who wants to read the full content, see what was extracted, or copy the original text has no detail page or modal. The row body is selectable text, not a launchpad. For a triage surface this is the central dead end — every other entity in the app has a detail view. **P1.**
- Status badge is decorative. A failed badge has the Retry button next to it, but a "Needs review" badge doesn't itself open the review modal — the user has to find the separate Review button. Two affordances for the same intent, neither labelled as belonging to the badge. **P3.**
- Tags row at the bottom of each dump: chips, not clickable. Same flatness as elsewhere. **P2.**
- Empty state: "No brain dumps yet — Type something above and hit Capture." Acceptable; doesn't auto-focus the input on load. **P3.**
- Error state per-dump: Failed badge + Retry button. Good. Toasts cover network/409/404 cases. Good.

**Verdict: has P1** (no dump detail).

### 4. Review modal (suggestions)

**Surface:** modal launched from a needs-review dump. List of suggested items with type badge, confidence label, source-text quote, Approve / Edit & Approve / Dismiss.
**Job:** triage LLM-suggested extractions per item.
**Next action:** approve, edit, or dismiss each suggested item.

- Per-item actions are all present and labelled. Good.
- Type badge ("Task" / "Person" / "Tag" / etc.) is decorative — not a filter, not a link to the list view. **P3.**
- Confidence label ("likely" / "maybe" / "uncertain") is decorative. Could plausibly drive a sort or filter when there are many items, but for the current volume that's a P3 at best.
- "All suggestions reviewed" success state: shows a message and stops. Modal closes via X. The success state should propose the next thing — *"3 items added. View the dump?"* or auto-close + scroll-to-dump. Currently the user is stranded in a tombstone screen. **P2.**
- Bulk-approve / bulk-dismiss: not present. For a multi-item dump this is a friction point. **P3.** Defer until volumes justify.

**Verdict: has P2** (success state is a tombstone).

### 5. Goals list (`view-goals`)

**Surface:** filter pills (All/Active/Stalled/Completed/Someday) + goal cards.
**Job:** scan goals, jump into one, manage state.
**Next action:** open a goal, edit, or delete.

- Filter pills: actionable.
- Goal card: status pill, title, task counts, three-dot Edit/Delete menu, progress bar, target date, blocker summary, people, tags. Card itself is clickable to open detail. Good.
- Status pill is decorative (cannot click "stalled" to filter to stalled, or click to change status). **P2.**
- People row on the card ("Nadia, Mum"): names are display-only — not clickable to open the person, not styled as links. For a system whose whole point is connecting things, person mentions should always be clickable. **P2 — same shape as the original `person_mention` retro.**
- Blocker summary on card ("2 blockers: deposit, work permit"): names are display-only. Cannot click a blocker to navigate or edit. **P2.**
- Tags row: chips, not clickable. **P2.**
- **Add goal:** *I cannot find an "Add goal" affordance on this view.* The People and Knowledge views have inline add-forms; this one apparently doesn't. Confirm with Cam — if true, this is a structural P1 (you can't create a goal from the goal list; you have to brain-dump and approve a `goal_new` extraction). **Flag for live walkthrough with Probe.**
- Empty state: "No goals found." No CTA to add. **P1 if no add affordance exists; P2 otherwise.**

**Verdict: has P1 (pending live confirmation of the missing Add Goal).**

### 6. Goal detail modal

**Surface:** title, status, description, target date, people, blockers, active tasks, completed tasks, tags. Footer: Edit / Delete.
**Job:** see one goal end to end and act on it.
**Next action:** complete a task, edit the goal, manage blockers, navigate to people.

- Active tasks: have a check circle (clickable to mark complete — good) and a status pill. Title is display-only — not clickable to open the task editor. **P2.**
- Completed tasks: title, struck through, no actions. Cannot un-complete from here. **P2.**
- People list: name + role, display-only. Same person-mention dead end as everywhere else. **P2.**
- Blocker list: icon, name, type, status pill. No way to mark resolved, edit, navigate. **P2 — likely P1 given the hero on home prominently surfaces blockers.** Cam needs a way to act on a blocker the moment he sees it, not bounce out and back.
- Tags row: chips, not clickable. **P2.**
- Add task / add blocker / add person from goal: not present. Cannot grow a goal from inside its own detail view. **P1.**
- Footer Edit / Delete: present and good.

**Verdict: has P1** (cannot grow a goal from its detail; cannot resolve a blocker from where it appears).

### 7. Tasks (`view-tasks`)

**Surface:** filter pills + tasks grouped by goal.
**Job:** see what's actionable today, complete things, manage state.
**Next action:** check things off; edit a task; navigate to its goal.

- Group header: chevron, title, count, target date, progress bar. Clickable to collapse/expand — good.
- **Group title is the goal name but not clickable to open the goal.** A user looking at a stuck task likely wants to pop into the goal context. **P2.**
- Task row: check circle (clickable — good), title (display-only), due date (display-only), people names (display-only), status pill, three-dot Edit/Delete. Title should open the editor on click; right now you have to find the three-dot menu. **P2.**
- People names on tasks: same dead end. **P2.**
- "Unlinked" group: works as a bucket but offers no way to link tasks back to a goal in bulk. **P3.**
- **Add task:** I cannot find an "Add task" affordance. Same shape as goals. **Flag for live walkthrough.** If absent, **P1.**
- Empty state: "No tasks found." No CTA. **P2.**

**Verdict: has P1 (pending live confirmation).**

### 8. People (`view-people`)

**Surface:** inline Add form + people cards.
**Job:** see who matters and how they connect; add new people.
**Next action:** add, open, edit, see what each person is connected to.

- Inline Add form: name field + Add button + status hint. Good. Optimistic insert + highlight flash. Strong work.
- Person card: avatar, name, relationship/location, three-dot Edit/Delete, notes, goals list, tasks list, tags. **The card is not clickable as a whole — there is no person detail page or modal.** Edit opens a small form; that is not the same as a person dossier. The list view is the only view of a person. **P2 — arguably P1 since this is the third "should-be-clickable" surface in a row.**
- Goals list inside the person card: title + status pill + role. Display-only. Cannot click a goal to open it. Same dead end as goal-card people. **P2.**
- Tasks list inside the person card: title + status pill. Display-only. Cannot mark complete from here. **P2.**
- Tags: chips, not clickable. **P2.**
- Empty state: "No people yet." No CTA, but the Add form is *right above* — so the empty state is bearable. The empty state could still actively pull the eye to the input ("Add your first person — type their name above"). **P3.**
- Error states for add: hint text + toast. Good.

**Verdict: has P2 throughout** (no person detail; every connection is a dead-end label).

### 9. Journal (`view-journal`)

**Surface:** search + date filter + clear + new-entry button + tag filters + entries list.
**Job:** read, search, write, tag.
**Next action:** new entry, open existing, filter.

- Toolbar: search, date filter, clear, new entry — all actionable. Good.
- Tag filter bar: pills, click to filter. Good. **Long-press / right-click to rename or delete a tag is not present.** Tag management lives nowhere. **P2.** (See "Tags" surface below — it doesn't exist.)
- Entry card: date, preview, tag chips. Card clickable to open detail. Good.
- Tag chips on cards: display-only. **P2.**
- Detail modal: date, content, tags, meta. Footer: Edit. Tags display-only. Meta (created/updated) is decorative.
- Compose modal: date, content, tags input, Cancel/Save (and Delete when editing). Clean.
- Empty state: "No entries found — Press N on the journal view to write one." OK; could be a button instead of a hint. **P3.**

**Verdict: has P2** (tag chips inert; no tag management).

### 10. Knowledge (`view-knowledge`)

**Surface:** inline Add form + search + filter pills + knowledge cards.
**Job:** capture and find facts/decisions/learnings/references.
**Next action:** add, search, filter, edit.

- Inline Add (title, content, tags, button): clean. Optimistic insert + highlight + URL-param prefill from prompts (lovely touch — the `addNoteFromPrompt` flow is the right pattern).
- Filter pills + search: good.
- Knowledge card: type pill, three-dot Edit/Delete, title, content, source, tags. Card is not clickable to open a detail view (Edit modal is the only "detail"). Title and content are display-only.
- Type pill: decorative — not clickable to filter to that type. **P2.**
- Tags row: chips, not clickable. **P2.**
- Source field: rendered as plain text. If it's a URL, it should be a link. **P3.**
- Empty state: "No knowledge items found." No CTA — but the Add form sits above. **P3** (same logic as People).

**Verdict: has P2** (type pill and tag chips inert; source not auto-linked).

### 11. Tags

**Surface:** *does not exist as a standalone view.*
**Job:** rename, merge, delete, see usage.
**Next action:** none available.

- Tags appear as decorative chips on Goals, Tasks, People, Knowledge, Journal entries, and dumps.
- The Journal view has a tag filter bar, which is the *only* place a tag is clickable, and even there it only filters within journal — not across the whole system.
- Tags cannot be renamed, deleted, merged, or seen with their usage count.
- The data model clearly supports tagging across all entities (the recent `apply_to` work confirms this), but the system has no UI surface for tag stewardship. Cam will accumulate tag debt — typos ("leaderhip"), near-duplicates ("kids" vs "children"), orphans — with no way to clean up.

**Verdict: P1.** This is the most structural dead end in the system: a first-class data type with zero management surface.

### 12. Prompts

**Surface:** rendered into `#homePrompts` only — no standalone view.
**Job:** notice a system suggestion and act on it.
**Next action:** depends on prompt type.

From the code (`renderPrompts` and the queued audit in team-practices.md):

- All prompts get a "Got it" dismiss button.
- `knowledge_gap` → adds an "Add a note" CTA wired through `addNoteFromPrompt` → Knowledge view with prefill. **Good.** This is the pattern.
- Prompts with `source_type` + `source_id` → "Take me there" → navigates to goal/task. **Good** for `goal` and `task`. The `navigateToPromptSource` switch only handles those two; everything else (e.g. a person- or knowledge-sourced prompt) falls through silently. **P2.**
- `activity_gap` (when triggered by dump count) → "Brain dump" button focuses the input. **Good.**
- **Other prompt types — `stale_goal`, `pattern`, `blocker_awareness`, `elicitation`, `milestone` — get only "Got it."** Confirming against team-practices.md queued audit, this is the *exact* dead-end pattern that produced the audit ticket already. Each of these surfaces a system insight with no path to act on it. **P1, system-wide.**

Specifically (proposed action paths, for Atlas to route):

- `stale_goal` → "Open goal" + "Mark someday" + "Brain dump on this".
- `blocker_awareness` → "Open the blocked goal" + "Mark blocker resolved".
- `pattern` → "Show me the dumps" or "Add as knowledge".
- `elicitation` → "Answer" with an inline text input that becomes a brain dump tagged appropriately.
- `milestone` → "Celebrate" (logs a journal entry) + "What next?" (focus a brain dump on the same goal).

The `more` / `less` toggle on long bodies is good. The prompt body itself is not clickable as a whole — only the explicit buttons are. That's correct.

Empty/error: prompts are non-critical, so silent failure is acceptable. Confirm with Probe that the prompt section disappearing on a 500 doesn't strand the user.

**Verdict: P1.** Already in the team-practices queue; this audit promotes it from "queued" to "actively blocking the felt experience."

### 13. Logout / Settings

**Surface:** Logout chip in the desktop nav and the mobile More menu. Theme toggle in both.
**Job:** sign out; switch theme.
**Next action:** click.

- Both clickable, both work as expected from the code. **Clean.**
- No settings surface. Out of scope until there's something to configure.

### 14. Empty / loading / error states (cross-cutting)

- **Empty states:** "No X found" / "No X yet" everywhere. Mostly textual, no CTA buttons. People and Knowledge get away with it because the Add form is above. Goals, Tasks, Journal entries empty states are flatter. **P3 across the board; promote any to P2 if the surface also lacks a primary add affordance** (Goals + Tasks pending live confirmation).
- **Loading states:** none I can see — surfaces render as data arrives. Acceptable for a fast local DB; risky on slow network. Brain-dump processing has explicit polling + status badges, which is the right pattern. **P3 — confirm with Probe on slow network.**
- **Error states:** brain-dump capture has good error toasts + status messages. Add forms have hint text + toast. Detail-modal errors (e.g. `api()` returning `{error: ...}` after `openGoalDetail`) silently early-return — the modal just doesn't open and the user sees nothing. **P2.** Should at minimum toast.

---

## Prioritised punch list

### P1 — broken / missing core action

| # | Finding | Fix owner | Proposed fix |
|---|---|---|---|
| 1 | Prompt types other than `knowledge_gap`, `activity_gap`, and source-linked → only "Got it." | Lumen (UI), with Vault if any new endpoints needed | Add a per-prompt-type action-path table; each type renders ≥1 primary CTA. Specifics in the Prompts section above. |
| 2 | Brain-dump rows have no detail view — central triage surface has no expand/open. | Lumen | Make the dump row click open a detail modal: full content, all extracted items (approved + suggested + dismissed), retry, delete, re-process. |
| 3 | Hero goal on home is not clickable. | Lumen | Make the hero card open the goal detail. Make in-hero blocker rows actionable (mark resolved, navigate). |
| 4 | Goal detail cannot grow the goal. No add-task / add-blocker / add-person from inside the modal. | Lumen | Inline "+ Task" and "+ Blocker" affordances inside the goal detail body; person attach is a deferred dispatch. |
| 5 | Blocker rows everywhere are display-only — no resolve, no navigate, no edit. | Lumen (probably needs Vault for a `PUT /blockers/:id`) | Make every blocker chip a launcher: tap → resolve / edit / open the related entity. |
| 6 | Failed dumps on home don't show Retry. | Lumen | Reuse `retryButton(d)` in the home recent-captures render. |
| 7 | Tags have no management surface. Decorative chips everywhere; no rename / merge / delete / usage view. | Lumen (UI) + Reed (confirm tag-merge semantics) + Vault (endpoints if missing) | Stand up a Tags view: list, count of usages, click-through to filter, rename, merge, delete. Make every tag chip in the app clickable to filter the relevant list. |
| 8 | (Pending live confirmation) No "Add goal" affordance on `view-goals`. | Lumen | Add the same inline Add pattern used on People / Knowledge. |
| 9 | (Pending live confirmation) No "Add task" affordance on `view-tasks`. | Lumen | Add inline add at the top of the list, optionally per-group. |

### P2 — passive surface / missing affordance

| # | Finding | Fix owner | Proposed fix |
|---|---|---|---|
| 10 | Person names everywhere (goals, tasks, people-card connections) are display-only. | Lumen | Every person mention is a link to that person's view — once that view exists. |
| 11 | No person detail view — Edit modal is the only "detail." | Lumen (probably needs Reed if the person page needs aggregated queries) | Add a person detail view (or modal) that aggregates goals, tasks, knowledge, and recent dump mentions. |
| 12 | Tag chips inert everywhere. | Lumen | Tap a tag → filter the current list to that tag (or open the Tags view filtered to that tag). |
| 13 | Status pills inert everywhere (goals, tasks, dumps, people connections). | Lumen | Tap a status pill → filter list to that status, or (on a single item) cycle/edit status inline. Pick one consistent semantic. |
| 14 | Type pill on knowledge inert. | Lumen | Tap → filter to that type. |
| 15 | Task title in lists / goal-detail not clickable to edit; only the three-dot menu opens edit. | Lumen | Tap title → open editor. Three-dot is the secondary path. |
| 16 | Task group header in `view-tasks` not clickable to open the goal. | Lumen | Add a small "Open goal" affordance on the group header (icon link) that doesn't conflict with the collapse toggle. |
| 17 | Review modal "All suggestions reviewed" tombstone state. | Lumen | Replace with "Done — N items added. [View dump] [Back to dumps]." Or auto-close + scroll-to-dump. |
| 18 | `navigateToPromptSource` only handles `goal` and `task`. Other source types fall through silently. | Lumen | Cover all source types, or render the "Take me there" button only when handled. |
| 19 | Detail-load failures (e.g. `openGoalDetail` on a 500) silently no-op. | Lumen | Toast on `error` payloads from `api()`. |
| 20 | Knowledge `source` rendered as plain text even when it's a URL. | Lumen | Auto-link http(s) sources. |
| 21 | Journal tag bar can filter but cannot rename / delete tags. | Lumen | Once a Tags surface exists, long-press / right-click on a journal tag pill opens the tag in the Tags view. |
| 22 | Empty states on Goals / Tasks / Journal lack a CTA button (text only). | Lumen | Add a primary action button into each empty state ("Add your first goal", "Write your first entry"). |

### P3 — polish

| # | Finding | Fix owner | Proposed fix |
|---|---|---|---|
| 23 | Stalled-goal cards on home: status itself could carry an inline action ("nudge / mark someday"). | Lumen | Inline action menu on hover/tap on the stalled badge. |
| 24 | Confidence label in review modal is decorative — could sort. | Lumen | When ≥ 6 items, add a "low confidence first" toggle. |
| 25 | Type badge in review modal is decorative — could open the relevant list. | Lumen | Tap type badge → close modal + navigate to that list (low priority). |
| 26 | Bulk approve / dismiss in review modal. | Lumen | Add when daily-volume justifies it. |
| 27 | "Needs review" badge on dump rows is not the affordance — separate Review button is. | Lumen | Make the badge itself the trigger; remove the separate button or keep both with the same handler. |
| 28 | Loading states absent on slow network. | Lumen + Probe | Skeleton or shimmer for sections that take > 300 ms. |
| 29 | Empty state on home (first-time user, no dumps, no goals) is sparse. | Lumen | Welcome card with "Capture your first thought" pulling the eye to the dump input. |
| 30 | Three-dot action menus are always-visible; could collapse to hover-revealed on desktop and tap-only on mobile. | Lumen | Style refinement only; works as-is. |

---

## Top three recommendations

If three things shipped, the felt experience would shift from passive to alive:

1. **Make every prompt type carry an action path.** This is already in the queue (`team-practices.md` queued-audits). Promote it. The prompts panel is the *only* place the system speaks to Cam first; if it can't tell him what to do, the system is mute. Without this, the assistant feels passive even when it's working.

2. **Stand up Tags as a first-class surface, and make every tag chip clickable.** Tags are the connective tissue of the entire app — they sit on every entity — but right now they are pure decoration. A Tags view with rename / merge / delete + every chip clicking through to a filtered list would *retroactively* turn every existing decorative tag chip in the app into a launchpad. One feature, dozens of dead ends fixed.

3. **Add a brain-dump detail view, and make the goal detail growable.** Two surfaces, same principle — the most-used triage screen and the most-important entity in the system both currently bottom out. A dump should open into "here's everything I extracted, edit / re-process / see source"; a goal should let you add tasks and resolve blockers without leaving its modal. These two changes end the "view, then leave" pattern at the two surfaces it costs the most.

Common thread: **stop treating data display as the end state.** Every chip, name, badge, and pill in this app is a piece of structured knowledge — and structured knowledge is exactly the thing that should be clickable.

---

## Surfaces I could not audit from code alone — queue with Probe

- **Add Goal** on `view-goals` — I cannot find an inline or modal Add form. Need Probe to confirm whether goal creation is genuinely brain-dump-only or whether I missed it.
- **Add Task** on `view-tasks` — same.
- **Loading states on slow network** — code shows no skeletons; need Probe to confirm whether sections gracefully degrade or flash empty.
- **Prompt types in production** — I read code, not data. Need Probe (or a quick Reed query) to enumerate which `prompt_type` values actually appear in production right now, so the action-path work in P1 is sized correctly.
- **Detail-load error path** — code suggests `openGoalDetail` silently no-ops on `error`. Need Probe to trigger one (force a 500) and confirm the user sees nothing.
- **Mobile gestures** — long-press, swipe, pull-to-refresh — present in markup (`ptr-indicator`) but I haven't traced the JS. Defer to a mobile-specific pass after Probe confirms behaviour.

---

*Iris, 2026-04-26. First artefact. Audit is a first-pass; expect to iterate after the live walkthrough with Probe and Cam.*
