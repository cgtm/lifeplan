# Goal-detail growability — inline `+ Task` and `+ Blocker`

**Author:** Iris (Senior Interaction Designer)
**Date:** 2026-04-29
**Status:** proposed
**Implementer:** Vault (new POST contract), Lumen (UI), Probe (regression), Iris (device pass)
**Audit ref:** `docs/ux-audit/2026-04-26-system-wide-audit.md`, P1 punch-list item #4
**Sibling designs:**
- `docs/ux-design/2026-04-26-tags-first-class.md` (lateral-navigation pattern, drawer shape)
- `docs/ux-design/2026-04-27-brain-dump-detail.md` (in-modal action pattern, focus-flash on insert)
- Existing inline-add patterns in `view-people` and `view-knowledge` (one-row input → optimistic insert → flash)
- `app/contracts/blockers.md` (existing PUT /api/blockers/:id)

---

## Pitch

> The goal you're looking at is the goal you can grow. Inline `+ Task` and `+ Blocker` affordances inside the goal-detail modal turn the surface from a read-only dossier into a workbench: tasks born where you see the goal, blockers logged the moment you notice one — without ever leaving the modal.

The "Blockers become real" batch made existing blocker rows actionable (resolve, edit, navigate). What's left is the *create* half of the same job: when Cam realises a new task or a new blocker exists *while looking at the goal*, the system should let him add it from there, not bounce him to a different surface and force him to re-establish context.

---

## Three-line surface contract

**Surface: Goal Detail (modal) — growability affordances**
**Job:** Add a task or a blocker to this goal from inside the surface that already shows the goal.
**Next action:** Tap `+ Task` to type a title and hit return · or tap `+ Blocker` to pick what's blocking and add a note.

---

## Top three affordances

1. **Inline `+ Task` row at the top of the Active Tasks section.** One-row text input — type title, hit return, task appears at the top of the list with a focus-flash. `goal_id` is auto-attached. Zero friction; this is where most tasks want to be born.
2. **`+ Blocker` button at the top of the Blockers section, opening a unified-search picker.** One field, type-ahead across goals + tasks + external systems with a type badge on each result. Pick → optional notes → save. The new blocker chip appears at the top of the active blockers list, focus-flash.
3. **Modal-stays-open everywhere.** Adding a task or blocker never closes the goal-detail modal. Cam grows the goal from one place and keeps growing it.

---

## Surface and shape

### Where the affordances live

The existing modal body order today (top → bottom): status pill · description · target date · People · Blockers · Active Tasks · Completed · Tags. The new affordances slot inside the Blockers and Active Tasks sections, *not* as new top-level buttons. Two reasons:

- Placement near the relevant list teaches the affordance: "this button adds a row to *that* list."
- Footer real estate is already Edit / Delete; adding two more buttons there would dilute the destructive action's visibility and force Cam to scroll past content to add a task.

Empty-state and populated-state both get the same affordance position — the section header carries the chip.

### Section header pattern (shared across both)

```
┌──────────────────────────────────────────────────────┐
│ Active Tasks (3)                              [+ Task] │  ← chip, right-aligned
│ ┌──────────────────────────────────────────────┐     │
│ │ ○ <inline input — appears when chip clicked> │     │  ← collapses by default
│ └──────────────────────────────────────────────┘     │
│ ○ Existing task A                              status │
│ ○ Existing task B                              status │
└──────────────────────────────────────────────────────┘
```

```
┌──────────────────────────────────────────────────────┐
│ Blockers (2 active)                       [+ Blocker] │  ← chip, right-aligned
│ <picker drawer / sheet opens on click>               │
│ ⛔ Visa decision                              active   │
│ ⛔ Deposit                                    active   │
└──────────────────────────────────────────────────────┘
```

The chip is a small pill button (text + leading `+` glyph), `var(--text-3)` border, `var(--accent)` text on hover/focus. Sits to the right of the section title. Same chip styling for both — visual consistency teaches the pattern.

### Empty-state behaviour

If a section has zero items today, the section is currently *not rendered* (see `openGoalDetail`'s `${activeTasks.length ? ... : ''}`). The new affordances change that:

- **Tasks empty:** the Active Tasks section *always* renders, even with zero tasks. Empty state inside reads:
  ```
  Active Tasks
  ┌──────────────────────────────────────────────┐
  │  + Add the first task                        │  ← full-row CTA, focuses input
  └──────────────────────────────────────────────┘
  ```
  No "(0)" count next to the title — counts only show when populated. Tap the row → the inline input expands and auto-focuses. This is the most important empty state in the modal: a goal without tasks is the ur-case for "grow this."

- **Blockers empty:** Blockers section *also* always renders. Empty state:
  ```
  Blockers
  ┌──────────────────────────────────────────────┐
  │  + Log a blocker                             │  ← full-row CTA, opens picker
  └──────────────────────────────────────────────┘
  ```
  Slightly softer language than tasks — most goals don't have blockers at any given time, so the empty state shouldn't read as a *missing* thing.

The Completed Tasks section continues to render only when populated; that's a historical bucket, no creation needed.

---

## `+ Task` — flow and form

### Decision: inline one-row input, expand on focus

```
[ Add a task…                                      Add ]   ← collapsed default
```

- Default state: a single-line text input + `Add` button, full-width inside the section. Placeholder reads "Add a task…".
- Focus / typing → input grows in place to a slim two-line affordance with optional metadata revealed under the title:
  ```
  [ Buy plane tickets                            Cancel  Add ]
    Due: [pick date]   People: (deferred)
  ```
- Hitting Return submits with the title only; clicking `Add` does the same. Empty submit is a no-op (button disabled until first character).
- Escape clears the field and collapses back to the default.

**Why one-row-expanding, not always-expanded:** the goal-detail modal is already content-dense. An always-expanded full task form steals visual weight from existing tasks (the things Cam came here to look at). The expanding pattern matches the People view's inline add — Cam already knows it.

**Why not a drawer?** A drawer for a one-field form is overkill. Drawers are for goal creation (W1 spec) where the form has five-plus fields and required validation. A task only needs a title to exist.

### Pre-filled fields

- `goal_id` — automatic from the parent modal's goalId. Hidden, non-editable.
- `status` — defaults to `active` (server-side default). No UI to change at creation; edit later via three-dot menu.
- `title` — required, user-supplied.
- `due_date` — optional, deferred metadata. Inline date picker reveals on focus, after first tap into title field.
- `people` — explicitly deferred to the person-attach dispatch. Don't add a People affordance to the inline form.

### Backend

POST /api/tasks already exists with `goal_id` field (verified — `app/contracts/create-task.md`, code path `handle_create_task` in `app.routes.tasks`). **No new endpoint needed for the Add Task half.** Body shape:
```json
{ "title": "...", "goal_id": <id>, "due_date": "...", "status": "active" }
```

### Behaviour after submit

- Optimistic: the new row inserts at the top of Active Tasks immediately with `status: "active"`, focus-flash highlight (use the same `.flash-new` animation People/Knowledge already use).
- The input collapses back to default (empty); cursor returns to it. Cam can immediately type another task — the input is ready for a stream-of-consciousness "add three tasks at once."
- Server response replaces the optimistic row with the canonical row (id, created_at, etc.) — same pattern People uses.
- Failure: optimistic row turns red briefly with a tooltip "Couldn't save — try again", input refilled with the typed text so Cam doesn't lose work. Toast confirms the error.
- Modal stays open. Always.

---

## `+ Blocker` — flow and form

This is the genuinely new design surface, because a blocker is a polymorphic edge.

### Step 1 — picker

**Decision: unified search picker.**

```
┌────────────────────────────────────────────────────┐
│ Add a blocker to: <Goal title>                     │
│                                                    │
│ ┌────────────────────────────────────────────────┐ │
│ │ Search goals, tasks, or systems…           🔍  │ │  ← autofocus
│ └────────────────────────────────────────────────┘ │
│                                                    │
│ Recent ↓                                           │
│  [GOAL]   Visa decision                            │
│  [TASK]   Buy plane tickets                        │
│  [SYSTEM] Finance App                              │
│                                                    │
│  …filters as Cam types…                            │
│  [GOAL]   Sell the house                           │
│  [TASK]   Send DBS form                            │
│                                                    │
│ + Add new external system…                         │  ← see step 1b
└────────────────────────────────────────────────────┘
                                          [Cancel]
```

Why unified search over three-tab or two-step:

- Cam doesn't think "the type then the thing." He thinks "the thing." If he's blocked by "the visa decision," he wants to type "visa" and pick. Forcing him to first pick a tab is a step he didn't ask for.
- Three-tab burns vertical space on three header chips and forces a deliberate cognitive split before he's even thought about which type the blocker is. Wrong default mental load.
- Two-step (pick type → pick entity) is the worst option: same friction as three-tab plus a forced commitment to type before he's seen what's actually available.
- The type *is* knowable from the picked entity — no separate tab needed to disambiguate after selection.

Type badges on each result row carry the type information without a tab being the navigation primitive.

**Result composition (client-side merge — no new search endpoint):**

- Hit `GET /api/goals`, `GET /api/tasks`, `GET /api/external-systems` in parallel on picker open (or use cached lists if already loaded).
- Merge into a single results array with `{ id, type, name, status?, goal_title? }` shape per row.
- Filter client-side as Cam types — substring match on `name`, case-insensitive. Local-app data volumes (~hundreds of items max) make client-side trivial.
- Default ordering when query is empty: a "Recent" group of the last 5–10 items the user touched (across all three types), then the rest alphabetically. Recent list comes from the existing `updated_at` columns server-side; if too expensive to compute, fall back to alphabetical for MVP.
- Self-filter: exclude the current goal from goal results (a goal can't block itself).
- Filter out already-blocking entries: if a `dependencies` row already exists pointing the chosen entity at this goal as blocker, grey it out with a "(already blocking)" label. Prevents duplicate edges.

### Step 1b — external_system create-on-the-fly

**Decision: defer to a future dispatch.** Not blocking MVP.

When Cam types a query that returns zero results, the picker shows:

```
No matches for "vendor X."
+ Add as new external system…   ← greyed out / "Coming soon"
```

The greyed CTA is left in the UI as a *signpost* — it tells Cam the system *knows* this is a thing that should work, even though it doesn't yet. No dead-end "?" — explicit "deferred to: Add external systems from settings" subtext.

For MVP, the workaround is: Cam goes to Settings (when that surface exists; currently no UI to manage external_systems at all — that's a separate gap, see Open Items below) or asks the team to insert a row. In practice, the existing external_systems are hand-seeded by Cam through Reed's data work. For the next 6–12 months, "I'm blocked by a system I haven't tracked" will be rare; deferring this saves picker complexity now.

**Deferred dispatch name:** `external_systems_management` — covers (a) a list/CRUD surface for `external_systems`, (b) the create-on-the-fly path from the blocker picker, (c) an "Add external system" flow from anywhere else that needs it. Lumen + possibly Vault (depending on what endpoints already exist).

### Step 2 — notes + save

After Cam picks an entity, the picker collapses to a confirmation view:

```
┌────────────────────────────────────────────────────┐
│ Add a blocker to: <Goal title>                     │
│                                                    │
│ Blocker:                                           │
│  [GOAL] Visa decision                    [Change]  │  ← Change re-opens search
│                                                    │
│ Notes (optional)                                   │
│ ┌────────────────────────────────────────────────┐ │
│ │                                                │ │  ← textarea, 3 rows
│ │                                                │ │
│ └────────────────────────────────────────────────┘ │
│                                                    │
│                              [Cancel]   [Add blocker] │
└────────────────────────────────────────────────────┘
```

- One picked entity, one optional notes textarea, two buttons.
- "Change" returns to the search step with the previous query preserved.
- Cancel closes the picker, returns to the goal-detail modal unchanged.
- "Add blocker" submits.

### Picker shape: bottom-sheet on mobile, centred modal on desktop

- **Phone (≤ 720px):** bottom-sheet, slides up over the goal-detail modal. Search input docked to the top under the title; results scroll. Same z-index treatment as the lateral-navigation pattern (new modal stacks over old; closing returns to the goal-detail modal).
- **Desktop (> 720px):** centred modal, max-width 480px, max-height 70vh, body scrolls. Stacks above goal-detail.

The picker is a separate modal/overlay. The goal-detail modal stays open underneath; closing the picker returns to it.

### Behaviour after submit

- Optimistic: new blocker row inserts at the top of *active* blockers in the parent goal-detail modal, focus-flash. (Sort: active first, resolved after — already the existing behaviour; new row goes first within active.)
- Picker closes.
- Server response (per the new POST /api/blockers contract — see Backend below) returns the full enriched row, replacing the optimistic placeholder.
- Failure: optimistic row turns red, toast "Couldn't add blocker — try again." Picker reopens with the picked entity and notes preserved.

---

## Backend gaps

### NEW — `POST /api/blockers`

Vault to design and implement. Following the existing PUT contract pattern in `app/contracts/blockers.md`.

**URL:** `POST ${MOUNT}api/blockers`

**Request body:**
```json
{
  "blocked_type": "goal",          // for now, always "goal" from this UI; required
  "blocked_id":   <int>,            // required; the goal-detail's goalId
  "blocker_type": "goal" | "task" | "external_system",   // required
  "blocker_id":   <int>,            // required
  "notes":        "<string>"        // optional
}
```

**Behaviour:**
- Validates that `blocked_id` exists in the right table per `blocked_type` (`goals` for now).
- Validates that `blocker_id` exists in the table referenced by `blocker_type` (`goals` / `tasks` / `external_systems`).
- Rejects `blocker_type=goal` + `blocker_id=blocked_id` (a goal cannot block itself) → 400.
- Rejects duplicate edges: if a row with the same `(blocked_type, blocked_id, blocker_type, blocker_id, resolved=0)` already exists → 409 with the existing row's id in the response, so the client can flash the existing row instead.
- On success: insert with `resolved=0`, `resolved_at=NULL`, `created_at=now()`. Return 201 with the full enriched row in the same shape as the PUT response (i.e. matching `GET /api/dependencies` rows, including `blocker_name` and `blocked_name` derived via JOIN).

**Errors:**
- 400 — missing required field, type/id mismatch, self-block.
- 404 — referenced entity (`blocked_id` or `blocker_id`) not found.
- 409 — duplicate active edge (response includes existing row).
- 415 — non-JSON content-type (per the existing `_enforce_content_type`).

**Response 201:**
```json
{
  "id":           <int>,
  "blocker_type": "...",
  "blocker_id":   <int>,
  "blocker_name": "<derived>",
  "blocked_type": "goal",
  "blocked_id":   <int>,
  "blocked_name": "<derived>",
  "notes":        "<string or null>",
  "resolved":     0,
  "resolved_at":  null,
  "created_at":   "<ISO8601 UTC>"
}
```

Vault writes a sibling contract doc (e.g. `app/contracts/blockers.md` extended, or a new `app/contracts/create-blocker.md`) per the standing contract-before-code rule.

### EXISTING — `POST /api/tasks`

Already exists. Verified in `app/contracts/create-task.md` and `handle_create_task` (`app/routes/tasks.py`). Body accepts `goal_id`, `title`, `description`, `status`, `due_date`. **No change needed for the Add Task half.**

### EXISTING — list endpoints used by the unified-search picker

- `GET /api/goals` — exists, returns all goals with status. Frontend filters client-side.
- `GET /api/tasks` — exists, returns all tasks with goal info. Frontend filters client-side.
- `GET /api/external-systems` — exists (verify with Vault during dispatch; if missing, Vault adds a thin GET-list endpoint at the same time as the POST /api/blockers work).

**No new search endpoint required.** Client-side merge + substring filter is correct for the data volumes; even at 10× growth this is sub-millisecond on the renderer.

---

## Lateral-nav guarantee (modal stays open)

A non-negotiable: every action below leaves the goal-detail modal open and returns Cam to it.

- Submit `+ Task` → row appears at top of Active Tasks in the *same modal*, input collapses, ready for the next task.
- Submit `+ Blocker` → picker closes, blocker chip appears at top of Blockers in the *same modal*.
- Cancel `+ Blocker` picker → picker closes, modal unchanged.
- Tap a blocker's "Open the goal/task" lateral-nav (existing from the previous batch) → opens the related entity over this modal; closing returns here. (Already-existing behaviour; not regressed by this work.)

The point: Cam should be able to land on a goal, add three tasks, log two blockers, close blocker A as resolved, open blocker B's source goal, return, and never have walked across the app once. The goal-detail modal is the workbench for that goal.

---

## Mobile (375px viewport pass)

### `+ Task` chip and inline input

- Section header on mobile: `Active Tasks (3)` left-aligned, `+ Task` chip right-aligned, both on one line. Tap target on the chip ≥ 44pt — pad the chip to clear that.
- Inline input expands to full row width, takes 100% of the section padding box. Mobile keyboard auto-rises; input scrolls into view.
- "Cancel / Add" buttons: stacked or side-by-side fits within 343px content width (375 minus 16+16 padding) — side-by-side, right-aligned, 8px gap. Add is the primary (filled), Cancel is the ghost.

### `+ Blocker` picker

- Bottom-sheet shape on mobile is the right call. Full-width, slides up over the goal-detail modal. The picker takes ~85% of viewport height, leaving a peek of the goal-detail modal at the top — visible reminder of context.
- Search input docked at the top with `position: sticky`. Results scroll under it.
- Each result row: ≥ 44pt tall. Type badge left, name right with status sub-label.
- Step 2 (notes) is the same bottom-sheet, content swapped. Notes textarea ≥ 3 rows; "Add blocker" pinned to the bottom of the sheet (sticky), so Cam doesn't have to scroll past notes to find it.
- Cancel: top-left X *and* a Cancel button at the bottom of step 2. Mobile users hit either.

### Empty-state CTAs

- Both empty-state CTAs ("Add the first task" / "Log a blocker") render as full-width rows on mobile with ≥ 44pt height. The full-row affordance is bigger than the small chip, which is correct — empty state is the moment to make the action loud.

---

## States — design every one

### `+ Task` inline input

| State | Treatment |
|---|---|
| Default (collapsed) | One-line input, placeholder "Add a task…" right-aligned `Add` button (greyed until typing) |
| Focus (expanded) | Cursor in field, optional metadata reveals (Due date), Cancel + Add buttons appear |
| Submitting | Add button → spinner, input disabled |
| Success | Optimistic row appears at top of list with `.flash-new`, input collapses back to default empty state, cursor returns |
| Error (server 500/400) | Input refilled with typed text, red border, toast "Couldn't save — try again", Add button re-enabled |
| Empty state (zero tasks) | Replaces the inline input with a full-row CTA `+ Add the first task` — taps focus the input, which then expands |

### `+ Blocker` picker

| State | Treatment |
|---|---|
| Open (search) | Search input autofocused, "Recent" group rendered, type badges present |
| Typing | Results filter live (debounce 100ms), no-results state shown if zero |
| No results | Centred message "No matches for '<query>'" + greyed "+ Add as new external system…" with "deferred" subtext |
| Loading lists | If the list endpoints haven't returned yet, picker shows "Loading…" centred. Should rarely fire — lists are fetched on app load. |
| Picked (step 2) | Confirmation view, notes textarea, Cancel + Add blocker buttons |
| Submitting | Add blocker → spinner, both buttons disabled |
| Success | Picker closes, optimistic row in goal-detail modal, focus-flash |
| Duplicate (409) | Picker closes, *existing* row in goal-detail modal flashes (not a new row), toast "Already a blocker on this goal." |
| Error (5xx) | Picker stays open at step 2 with the picked entity + notes preserved, toast "Couldn't add blocker — try again." |

---

## Recommended dispatch order

For Atlas to relay:

1. **Vault** — design and write the `POST /api/blockers` contract; publish per Cairn's contract-before-code rule. Then implement. Includes:
   - Write/extend `app/contracts/blockers.md` (or sibling `create-blocker.md`) with the POST shape above.
   - Implement handler with the validations (FK existence, self-block reject, duplicate-edge reject with 409).
   - Confirm `GET /api/external-systems` exists; add if missing.
   - One thin handler, deploys with the existing PUT.
2. **Lumen** — wire both UIs end-to-end:
   - Always-render Active Tasks and Blockers sections in `openGoalDetail` (even when empty), with the new section-header chips.
   - `+ Task` inline-input pattern, optimistic insert, focus-flash, modal-stays-open.
   - `+ Blocker` picker overlay (bottom-sheet on mobile, centred on desktop), unified search across goals/tasks/external_systems with client-side merge, type badges, recent group.
   - Step 2 confirmation view with notes textarea.
   - Deferred-CTA placeholder for external_system create-on-the-fly (greyed, "Coming soon" subtext, no handler).
   - Empty-state full-row CTAs.
   - One PR, one deploy.
3. **Probe** — regression sweep on chromium + webkit:
   - Add task → modal stays open → row appears at top → can type another immediately.
   - Add blocker (each of goal / task / external_system) → modal stays open → row appears at top of active blockers.
   - Duplicate-edge: try to add the same blocker twice → expect 409 + flash on existing row + toast.
   - Self-block: try to add the current goal as its own blocker → expect 400 / disabled in picker.
   - Cancel from picker step 1 and step 2 → modal unchanged.
   - 5xx during create → optimistic row reverts; input/picker preserves typed content.
   - Re-run the previous goal-detail regression (resolve / edit / lateral-nav) to confirm no drift.
4. **Iris device pass** — iOS PWA on the actual phone:
   - Tap targets on chips clear 44pt.
   - Inline input keyboard behaviour (input scrolls into view; submit doesn't dismiss keyboard until the user wants).
   - Bottom-sheet picker feels right one-handed; no z-index layering bug over the goal-detail modal.
   - Empty-state CTAs are obvious without being shouty.

---

## Open Items (deferred, named)

These exist as known follow-ups so they don't get re-discovered in a future audit:

- **`person_attach`** — adding people to a goal or task from inside the goal-detail modal. Explicitly out of scope for this dispatch per the brief. Lives as the Person-Attach dispatch.
- **`external_systems_management`** — list/CRUD UI for `external_systems` *and* the create-on-the-fly path from the `+ Blocker` picker. Deferred from this dispatch; the picker shows a greyed signpost.
- **chip-input component for in-context "× untag"** — separate dispatch, pre-existing queue. Not folded in.
- **`+ Task` from `view-tasks`-grouped headers** — the per-goal-group inline `+ task` chip from the W2 audit spec. Different surface (the tasks list, not goal-detail). Same visual pattern reusable. Separate dispatch when ready.
- **In-task creation: `+ Subtask` / `+ Blocker` from inside `openTaskDetail`** — once task detail is a real surface, the same growability pattern applies. Future dispatch.

---

## Iterations (alternatives considered, pocketed)

The MVP commits to: chip in section header, expanding one-row task input, unified-search blocker picker, deferred external_system creation. Pocketed alternatives if any of the above misses on the device pass:

- **Always-expanded task form.** Fallback if Cam reports the expand-on-focus interaction feels fiddly on mobile. Trade-off: more visual weight in the modal, but one fewer tap.
- **Three-tab blocker picker.** Fallback if unified search produces too-noisy results once data grows. Tabs are a known fallback pattern; no design rework needed, just a re-skin of the picker.
- **Modal blocker picker on desktop instead of inline drawer.** Currently picker-as-modal is the spec; if it feels jarring vs inline expansion, reskin to an inline expanding section under the chip (similar to the task pattern, but with the picker UI inside).
- **External_system create-on-the-fly via inline form.** Fallback if Cam hits the deferred path more than once a month. Spec a tiny inline form (name + url + notes) inside the picker's no-results state. Saves a round-trip through Settings.

These stay pocketed unless evidence forces them. Don't pre-build alternatives.

---

## Open questions for Cam

None. All UX calls are in lane:
- Picker shape (unified search) — Iris call, rationale documented.
- External_system create-on-the-fly (deferred) — Iris call, named follow-up dispatch.
- Empty-state CTA copy — Iris call, can iterate post-ship.
- Inline-vs-drawer for `+ Task` — Iris call, matches existing inline-add pattern.

The only thing that *could* be a Cam-shaped question is whether the deferred external_system path is acceptable. Cam's standing authorisation covers the call, and the workaround (hand-seeded external_systems through the team) is the status quo today — this change doesn't regress it. Defer is safe.

---

*Iris, 2026-04-29. Designed tight. The new design surface — the blocker picker — is the only place this dispatch breaks new pattern ground; everything else extends what's already shipped. Two endpoints (one new, one existing), one PR, one deploy.*
