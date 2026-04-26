# System-wide UX audit — 2026-04-26

**Auditor:** Iris (Senior Interaction Designer)
**Method:** static read of `app/index.html`, `app/app.js`, `app/login.html`,
plus context from `data/SCHEMA.md`, `docs/processes/team-practices.md`,
and the recent retros. **No live walkthrough.** Several items below are
flagged for live confirmation with Probe.
**Rubric:** every visible element is actionable or justified; every surface
has a clear next action; every state continues the flow; the user can
recover from any action.

**Update — 2026-04-26 walkthrough:** the six unknowns originally queued
for live walkthrough have now been resolved jointly with Probe against
the running local app (Playwright recon + curl + DB read). See
"Walkthrough resolutions" below; the punch list and top-three have been
revised where the findings warranted.

---

## Walkthrough resolutions (Probe + Iris, 2026-04-26)

For each unknown: original question · observed behaviour (Probe) ·
verdict + revised P-rating + concrete next step (Iris).

### W1. Add Goal affordance on `view-goals`

- **Question:** does any "Add goal" affordance exist on the goals view?
- **Observed (Probe):** none. The view's full markup is `page-header`
  + filter pills + `#goalList`. A Playwright count of `button:has-text("Add"), button:has-text("New"), input[placeholder*="goal"], form` inside `#view-goals` returns **0**. Goal creation today is brain-dump-only (the user types something, the LLM extracts a `goal_new`, the user approves it in the review modal). The "Add" path is therefore three clicks and an LLM round-trip behind a different surface.
- **Verdict (Iris):** confirmed P1, and *escalated*. This is not a missing
  button — it's a missing on-ramp for the most important entity in the
  system. Promote in the punch list from "pending" to actively blocking.
- **Affordance proposal (free rein):** *primary* affordance is a
  prominent **"+ New goal"** button in the page header (right-aligned,
  same row as `<h1>Goals</h1>`), opening a **right-side drawer** (not a
  modal) with: title (required), description, target date, status
  (default Active), tags. Save returns the user to the list with the new
  goal flashing at the top (same optimistic-insert + highlight pattern
  People and Knowledge already use). *Secondary* affordance: each empty
  filter state ("No stalled goals") gets a contextual CTA — *"Nothing
  stalled — keep it that way. New goal?"* The drawer pattern (vs the
  inline single-line input the People view uses) is the right shape
  because goals carry richer required context than a person's name.
  Keep the brain-dump path — that's how most goals will still be born —
  but stop forcing it to be the only door.

### W2. Add Task affordance on `view-tasks`

- **Question:** does any "Add task" affordance exist on the tasks view?
- **Observed (Probe):** none. Identical shape to goals — header +
  filter pills + `#taskList`. Playwright count = **0**.
- **Verdict (Iris):** confirmed P1. Same shape, same escalation.
- **Affordance proposal:** *primary* — a **"+ New task"** button in the
  page header, opening a slim drawer with: title (required), goal
  (autocomplete, defaults to last-touched goal or "Unlinked"), due
  date, people. *Secondary* — each goal-grouped section in the list
  gets a hover/tap-revealed **"+ task"** chip on the group header so
  the user can add a task *into the goal context they're already
  reading*. This is the affordance that actually drives momentum —
  most tasks are born while looking at the goal they belong to. The
  bare "Add task" button on its own would be useful but lonely; the
  per-goal inline-add is the one that earns its keep daily.

### W3. Loading-state behaviour on slow network

- **Question:** what does the user see during a slow fetch — skeletons,
  spinners, blank?
- **Observed (Probe):** with `/api/goals` throttled to 5 s, the goals
  view shows the **previous render's contents** for the entire wait
  (sampled at 0.5 s, 2.5 s, 6 s — `#goalList` byte-count and visible
  text identical across all three). On *first* navigation (no prior
  render) the user gets the page header and empty filter pills, then
  nothing visible until the data lands. There is no spinner, no
  skeleton, no "Loading…" text. The brain-dump processing badge
  (`dump-badge processing` with spinner) is the *only* loading
  indicator anywhere in the app, and it's per-row, not per-section.
- **Verdict (Iris):** **P3 → P2.** Audit had this as P3 ("acceptable
  for fast local DB"). Walkthrough revises upward because (a) the app
  ships as a PWA — it *will* run on Cam's iPhone on cellular in a
  basement somewhere, and (b) showing stale data with no signal that
  a fetch is in flight is worse than showing nothing — the user can't
  tell whether they're looking at fresh state or a cached frame.
- **Concrete next step:** **add a thin top-of-viewport progress bar**
  (the Vercel/YouTube pattern — 2 px, accent colour, indeterminate
  shimmer) that appears whenever any `api()` call is in flight for
  > 250 ms. One implementation, every surface covered, no per-section
  skeletons needed. *Plus* one targeted skeleton: on first-load of
  goals/tasks/people/knowledge when the list is empty *because the
  fetch hasn't returned yet*, render three placeholder card outlines.
  Subsequent re-renders (filter switch, post-action refresh) keep the
  current contents and rely on the top progress bar — no flicker.

### W4. Which `prompt_type` values exist in production right now?

- **Question:** which of the seven enum values are actually live, so
  the P1 prompt-CTA work is sized correctly?
- **Observed (Probe):** queried prod DB read-only:
  ```
  prompt_type        | status     | count
  blocker_awareness  | seen       | 2
  knowledge_gap      | dismissed  | 1
  knowledge_gap      | seen       | 3
  ```
  *Two* prompt types in flight. Five enum values (`stale_goal`,
  `activity_gap`, `pattern`, `elicitation`, `milestone`) have **never
  fired** in this database. The schema permits them; `generate_prompts.py`
  presumably can emit them; nothing has triggered the rules yet.
- **Verdict (Iris):** **P1 scope shrinks dramatically.** The audit
  treated the missing CTAs as a system-wide problem; the walkthrough
  shows it's a *single live case*: `blocker_awareness` is the only
  prompt-type-actually-fired-today that lacks a CTA. The full action-
  path table is still the right design for when those other types
  start firing — but it's no longer urgent. Triage:
  - **Ship now (P1, narrow):** add CTAs for `blocker_awareness`.
  - **Ship next (P2):** add the other five action paths, but don't
    block the felt-experience work behind them. They can land
    incrementally, paired with whichever rule starts firing.
- **Concrete CTA proposals per type** (the full table, for when each
  type goes live):

  | `prompt_type` | Live? | Primary CTA | Destination / behaviour |
  |---|---|---|---|
  | `knowledge_gap` | yes | "Add a note" *(exists)* | `/knowledge?addNote=1&tag=…` *(precedent)* |
  | `blocker_awareness` | **yes — gap** | "Open the goal" + "Mark a blocker resolved" | First button: `openGoalDetail(source_id)` (already wired via "Take me there" — but rename to "Open the goal" for clarity). Second button: opens the goal detail with the Blockers section scrolled to and each row in a quick-resolve state (each blocker chip becomes a button that flips `resolved: true` with a single tap and a toast undo). |
  | `activity_gap` | no | "Brain dump" *(exists)* | Focus the dump input *(precedent)* |
  | `stale_goal` | no | "Open goal" + "Mark someday" | First: `openGoalDetail`. Second: one-tap status flip to `someday` with toast undo (no modal). |
  | `pattern` | no | "Show the dumps" + "Save as knowledge" | First: dump list filtered to the matching tag/source. Second: `/knowledge?addNote=1&content=<pattern body>&tag=…` — the prompt body becomes the knowledge draft. |
  | `elicitation` | no | "Answer" (inline) | Expand an inline textarea inside the prompt card; submit creates a brain dump with `tag = elicitation:<topic>`. No navigation away. |
  | `milestone` | no | "Celebrate" + "What's next?" | First: writes a journal entry pre-filled with the milestone text (`/journal?new=1&content=…&tag=milestone`). Second: focus brain-dump pre-filled with *"Now that <milestone>, what's next for <goal>?"* |

  Common rule: every prompt always carries the existing "Got it"
  dismiss, *plus* at least one positive next action. "Got it" alone is
  the dead end the audit flagged.

### W5. Does `openGoalDetail` failure silently no-op in practice?

- **Question:** when a goal-detail fetch fails, what does the user see?
- **Observed (Probe):** confirmed silent dead end. With `/api/goals/*`
  forced to 500 and `openGoalDetail(1)` invoked, the modal does not
  open (modal-visible-count = 0), no toast appears (visible-toast count
  = 0). The function reads `goal.error` and `return`s with no UI side
  effect. Server log shows the request was received and the 500
  returned cleanly — failure is purely client-side silent.
  Source confirmed:
  ```js
  async function openGoalDetail(goalId) {
    const goal = await api(`/goals/${goalId}`);
    if (goal.error) return;            // ← silent dead end
    …
  }
  ```
  Same `if (x.error) return;` pattern likely repeats across other
  detail-loaders (worth a Probe sweep but out of scope here).
- **Verdict (Iris):** confirmed **P2 → P1**. Audit had this as P2.
  Walkthrough escalates because the user's *only* signal that something
  went wrong is the absence of a modal — they tap, nothing happens,
  they tap again, still nothing. That's the worst possible failure
  mode: the system looks broken in a way the user can't distinguish
  from "I missed the click." Promote.
- **Concrete next step:** every `api()` error response surfaces a toast
  via a single shared `apiError(err, fallbackMessage)` helper:
  - 404: *"That goal no longer exists. Refreshing the list…"* +
    triggers a `loadGoals()` so the stale card disappears.
  - 5xx: *"Couldn't load goal — try again."* with a Retry button on
    the toast that re-invokes `openGoalDetail(goalId)`.
  - Network/offline: *"You're offline. Changes will sync when you're
    back."*
  Apply the same wrapper to `openTaskDetail`, `openPersonDetail` (when
  it exists), `openJournalDetail`, etc. Single helper, every detail
  loader inherits the recovery story.

### W6. Mobile gestures / pull-to-refresh

- **Question:** markup hints exist (`#ptrIndicator`); does it work?
- **Observed (Probe):** pull-to-refresh is **fully implemented** in
  `app.js:2440-2501`. Activates only on touch devices (`'ontouchstart'
  in window`), threshold 60 px, refreshes the current view's data
  source (`loadHome` / `loadDumps` / `loadGoals` / etc.), respects
  modals/overlays, indicator class transitions are clean. No other
  gestures (swipe, long-press) are wired anywhere in the codebase.
- **Verdict (Iris):** confirmed working — drop from the audit's
  "unverified" list. **No new finding.** The PTR implementation is the
  pattern; future gestures (swipe-to-dismiss on dump rows, long-press
  on chips for a context menu) are P3 enhancements, not gaps. Note for
  the next mobile pass: the PTR refresh has a hard `setTimeout(600 ms)`
  for the indicator hide — fine, but the underlying `load*()` calls
  are async and may not have completed by then. Cosmetic only —
  user sees fresh data when it arrives, just sometimes after the
  indicator's already hidden. Add to the P3 polish list.

---


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
| 1 | `blocker_awareness` prompts (the only type live today besides `knowledge_gap`) ship with only "Got it." | Lumen | Add the two CTAs from the W4 table: "Open the goal" and "Mark a blocker resolved" (latter requires Vault for `PUT /blockers/:id`). The other five prompt types are P2 and ship as each rule starts firing — see W4. |
| 2 | Brain-dump rows have no detail view — central triage surface has no expand/open. | Lumen | Make the dump row click open a detail modal: full content, all extracted items (approved + suggested + dismissed), retry, delete, re-process. |
| 3 | Hero goal on home is not clickable. | Lumen | Make the hero card open the goal detail. Make in-hero blocker rows actionable (mark resolved, navigate). |
| 4 | Goal detail cannot grow the goal. No add-task / add-blocker / add-person from inside the modal. | Lumen | Inline "+ Task" and "+ Blocker" affordances inside the goal detail body; person attach is a deferred dispatch. |
| 5 | Blocker rows everywhere are display-only — no resolve, no navigate, no edit. | Lumen (probably needs Vault for a `PUT /blockers/:id`) | Make every blocker chip a launcher: tap → resolve / edit / open the related entity. |
| 6 | Failed dumps on home don't show Retry. | Lumen | Reuse `retryButton(d)` in the home recent-captures render. |
| 7 | Tags have no management surface. Decorative chips everywhere; no rename / merge / delete / usage view. | Lumen (UI) + Reed (confirm tag-merge semantics) + Vault (endpoints if missing) | Stand up a Tags view: list, count of usages, click-through to filter, rename, merge, delete. Make every tag chip in the app clickable to filter the relevant list. |
| 8 | **Confirmed** — no "Add goal" affordance on `view-goals`. Goal creation is brain-dump-only. | Lumen | "+ New goal" header button → right-side drawer (title required, description, target date, status, tags); optimistic insert + flash. See W1 for full spec. |
| 9 | **Confirmed** — no "Add task" affordance on `view-tasks`. | Lumen | "+ New task" header button → drawer; *plus* per-goal-group "+ task" inline chip on each group header (the affordance that earns its keep daily). See W2. |
| 9b | **Promoted from P2** — `openGoalDetail` (and likely sibling detail-loaders) silently no-op on error. | Lumen | Single shared `apiError()` helper — toast on 404/5xx/offline with Retry. See W5. |

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
| 19 | *(Promoted to P1 row 9b after walkthrough — see W5.)* Other detail-loaders (`openTaskDetail`, `openJournalDetail`, future `openPersonDetail`) likely share the same silent-no-op pattern. | Lumen | Apply the W5 `apiError()` wrapper across all detail-loaders. |
| 19b | Five prompt types (`stale_goal`, `pattern`, `elicitation`, `milestone`, `activity_gap`-without-handler) have no live data yet but no CTAs designed. | Lumen | Land per the W4 table as each rule starts firing. Don't pre-build all five. |
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
| 28 | *(Promoted to P2 — see W3.)* Slow-network behaviour: stale prior render shown silently, no in-flight signal. | Lumen | Top-of-viewport indeterminate progress bar on any `api()` call > 250 ms; first-load skeleton (3 placeholder cards) for empty list views. See W3. |
| 28b | PTR indicator's `setTimeout(600)` hide is decoupled from the actual reload completion. | Lumen | Tie the indicator hide to the `load*()` promise resolution rather than a fixed timer. |
| 29 | Empty state on home (first-time user, no dumps, no goals) is sparse. | Lumen | Welcome card with "Capture your first thought" pulling the eye to the dump input. |
| 30 | Three-dot action menus are always-visible; could collapse to hover-revealed on desktop and tap-only on mobile. | Lumen | Style refinement only; works as-is. |

---

## Top three recommendations *(revised post-walkthrough)*

The walkthrough shifted priorities. Prompts shrank — only two types are
firing today, and `knowledge_gap` already has its CTA — so prompt-CTA
work is no longer the *first* thing to ship. What rose: the Add-Goal /
Add-Task gap (now confirmed, not pending) and silent-error recovery
(promoted from P2 to P1 after watching the failure mode).

If three things shipped, the felt experience would shift from passive to alive:

1. **Open the front doors: ship `+ New goal` and `+ New task` on their
   list views.** Confirmed in the walkthrough — the most important
   entity in the system has no creation path on the surface dedicated
   to it, and the second-most-used surface doesn't either. Until this
   ships, every new goal costs a brain dump, an LLM round-trip, and a
   review tap; that is too much friction for the *primary* on-ramp to
   the *primary* entity. Header buttons + drawers (W1, W2). Per-goal
   inline `+ task` chip is the underrated half of this — it's where
   tasks actually want to be born. *(Replaces the previous #3
   recommendation about goal-detail growability — same principle, but
   the create-from-scratch case is the one that's currently impossible,
   not just clunky.)*

2. **Stand up Tags as a first-class surface, and make every tag chip
   clickable.** Unchanged from the original audit. Tags are the
   connective tissue — they sit on every entity but are pure decoration
   today. One feature retroactively converts dozens of dead-end chips
   into launchpads. Highest leverage-per-line-of-code in the punch
   list.

3. **Make the system stop failing silently: shared `apiError()` toast +
   recovery, plus a global in-flight progress bar.** Two findings from
   the walkthrough collapse into one shippable change. (a) Today, when
   `openGoalDetail` hits a 500, the user taps and *nothing happens* —
   indistinguishable from a missed click (W5). (b) On a slow fetch,
   the user sees stale data with no signal a refresh is in flight
   (W3). Both are violations of *"the user can recover from any
   action"* and *"every state continues the flow."* Single shared
   helper for errors + a single thin top-of-viewport progress bar gets
   recovery and responsiveness across the entire app in one pass —
   no per-surface skeleton work, no per-handler error code.

**Demoted from the previous top three:** the prompts CTA work. Still
P1 for `blocker_awareness` (the one live gap), but the audit's
original framing — *"every prompt type is a dead end"* — turns out to
be theoretical. Five of the seven enum values have never fired. Land
the `blocker_awareness` CTAs as part of normal P1 work; design the
other five per the W4 table; ship each as its rule starts firing.

**Also still queued, just below the top three:** the brain-dump detail
view and goal-detail growability (was #3). Both still P1, both still
matter, but the walkthrough surfaced that the *create* path matters
more than the *grow* path right now — you can't grow what doesn't
exist, and right now creation has no front door.

Common thread: **stop treating data display as the end state.** Every
chip, name, badge, and pill in this app is a piece of structured
knowledge — and structured knowledge is exactly the thing that should
be clickable. The walkthrough adds a second thread: **the system's
silences are louder than its noises.** A failed fetch that says
nothing, an Add button that doesn't exist, a prompt with no second
button — these are the moments the user feels the system isn't really
*there*. Fix the silences first.

---

## Surfaces I could not audit from code alone — queue with Probe

*All six items resolved in the Walkthrough resolutions section above
(2026-04-26 dispatch).* Two items remain genuinely deferred:

- **Real iPhone PWA pass** — pull-to-refresh works in browser; iOS
  PWA standalone-mode quirks are out of scope for this dispatch.
  Probe will sweep on next mobile-touching change.
- **Sweep for sibling silent-no-op patterns** — `openTaskDetail`,
  `openJournalDetail`, etc. likely share `openGoalDetail`'s
  `if (x.error) return;` pattern. Probe to enumerate before the W5
  fix lands so the `apiError()` helper covers them all in one pass.

---

*Iris, 2026-04-26. First artefact + walkthrough resolutions.
Audit revised after live recon with Probe; top three reflect the
new evidence. Expect a second iteration after the first P1 fixes
ship and Cam uses them on his phone for a week.*
