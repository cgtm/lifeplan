# Brain-dump Detail Modal

**Author:** Iris (Senior Interaction Designer)
**Date:** 2026-04-27
**Status:** proposed
**Implementer:** Lumen (UI), Vault (API endpoints), Probe (regression)
**Audit ref:** `docs/ux-audit/2026-04-26-system-wide-audit.md`, P1 punch list item #2
**Sibling design:** `docs/ux-design/2026-04-26-tags-first-class.md` (lateral-navigation pattern)

---

## Pitch

> The brain dump stops being a one-way drop box. Tap any captured thought and you land on a single surface that shows what you wrote, what the LLM made of it, what got created, what's still pending — and lets you act on every one of those things without leaving the modal.

This is the surface where Cam comes back to a dump. Today, capture is well-shaped (input → toast → status badge), but the moment a dump leaves the input it falls off a cliff. There is no way to read the full content again, no way to see *why* the row says "Needs review," no way to tell whether the LLM extracted nine items or one. The Review modal exists but is reachable only via a button that only appears in one of five lifecycle states. The detail modal makes the dump's whole story addressable from a single tap.

---

## Three-line surface contract

**Surface: Brain Dump Detail (modal)**
**Job:** Read what I captured, audit what the LLM made of it, and act on every extracted item — approve, reject, retry, follow, or kill the whole thing.
**Next action:** Approve a pending suggestion · open an auto-created task · retry a failed extraction · re-process · delete · close.

---

## Top three affordances

These are the three things the modal earns its existence by making first-class:

1. **Per-item act-on-it.** Every extracted item in the body is a launchpad: suggested → Approve / Reject; auto_created → click the row, open its detail; failed → Retry; rejected → Un-reject. No item is decoration.
2. **Top-level Re-process / Retry.** A single button at the top of the modal (label depends on status — "Retry" when failed, "Re-process" when terminal) re-queues the dump for a fresh extraction pass. This is the recovery affordance for *the dump* (vs the per-item retry above, which acts on a single extraction).
3. **Read + edit the captured content.** Tap-to-edit the original text, with an explicit "Save & re-process" affordance. This is the surface where Cam gets to fix a typo'd dump or expand a too-terse one and rerun the LLM on the corrected text.

---

## Surface and shape

### Decision: modal over drawer over route

**Modal**, matching the existing pattern (`#reviewOverlay`, `#goalDetailOverlay`, `#dumpDeleteOverlay`). Reasons:

- The dumps view *is* the triage surface. Detail belongs as a launched overlay over that triage context, not a route the user has to navigate back from.
- Lateral navigation (clicking an auto-created task → opens task detail → close → returns *here*) is already the pattern for goal-detail and the tag drawer. Modals stack and pop cleanly.
- A drawer would work, but the dump has more vertical content (full text, items list, actions) than a drawer's typical use (a sidebar of supplementary detail). Modal gives the height.
- A full route would force a navigation away from `view-dump` filtered state — every time the user closed the detail, they'd lose their filter pill selection.

### Mobile-first behaviour

- **Phone (≤ 720px):** modal occupies the whole viewport (full-bleed `bottom-sheet` style, slides up from bottom, top corners rounded `--radius-lg`). Same shape as the existing `#goalDetailOverlay` already uses on mobile.
- **Desktop (> 720px):** centred card, max-width `680px`, max-height `90vh`, body scrolls.
- **Dimensions:** padding `var(--space-lg)`, body uses `var(--text-2)` for content text, `var(--text-3)` for meta. Borders/shadows match existing modals.
- **Close affordances:** X button top-right (existing pattern), tap-on-backdrop, Escape key.
- **Lateral navigation:** when the user clicks an auto-created task/goal/person row, the *new* detail modal opens *over* this one (z-index +1). Closing it returns to this modal, which is preserved in DOM. Same pattern Reed proposed in the tag drawer design.

---

## Detail layout

### Top — header band

```
┌───────────────────────────────────────────────────────┐
│ Captured 2 hours ago             [status badge]   [×] │
│ Tue 27 Apr · 14:32                                    │
└───────────────────────────────────────────────────────┘
```

- **Captured** — `fmtRelative(captured_at)` (matches the dump-row treatment).
- **Date line** — `--text-3`, exact date+time below the relative label. Both render so Cam doesn't have to hover/long-press to see exact time.
- **Status badge** — the existing `processingStatusLabel(d)` chip (grey "Pending" / spinner "Processing" / green "Done" / amber "Needs review" / red "Failed"). Same vocabulary, same colours.
- **Close X** — top-right.

No title field. Brain dumps don't have titles; the content *is* the title. Adding a derived title (e.g. first sentence) is fragile and adds nothing — the body is right below.

### Body — captured content

```
┌───────────────────────────────────────────────────────┐
│                                                       │
│ Need to chase Nadia about the deposit thing this week,│
│ and remember to sort out the work permit timeline...  │
│ [full content, line-broken, selectable]               │
│                                                       │
│                                          [Edit ✏︎]    │
└───────────────────────────────────────────────────────┘
```

- **Read mode (default).** The dump's `content` rendered with `white-space: pre-wrap` so paragraphs and line breaks survive. Selectable text. Tap-and-hold copies on iOS, same as today.
- **Edit affordance.** A small `Edit` button bottom-right of the content block. Tap → swaps the read view for an inline `<textarea>` (auto-resize, same component as the capture input). Two buttons appear below the textarea:
  - **Save** — saves the new content via `PUT /api/brain-dumps/<id>` with `{content: "..."}`. *Does not* re-process. Toast: "Saved."
  - **Save & re-process** — saves *and* re-queues the dump (`POST /api/brain-dumps/<id>/process`). Use case: the LLM misread a typo, Cam fixes the text, wants the extraction redone. This is the explicit answer to "does editing trigger a re-process?" — *only when the user opts in.* Implicit re-processing on every save would punish typo fixes.
  - **Cancel** — discard, return to read mode.
- **What happens to existing items when content changes?** They stay until a re-process replaces them. A re-process is a fresh worker run that overwrites `processed_items` (existing worker behaviour). Approved/auto-created items remain in their target tables (the worker doesn't delete `tasks` rows). Cam keeps the goal/task he already approved; the suggestion list refreshes.

### Items section — the audit

The most important part of the modal. Renders `processed_items.items[]` grouped by status, then by type within each group.

```
┌───────────────────────────────────────────────────────┐
│ Extracted (5)                                         │
│                                                       │
│ ── Created (2) ──────────────────────────────────────│
│ ✓ Task   Chase Nadia about deposit                 → │
│ ✓ Person Nadia                                      → │
│                                                       │
│ ── Pending review (2) ──────────────────────────────│
│ ?  Goal   Sort work permit timeline                  │
│           "remember to sort out the work permit..."   │
│           [Approve]  [Edit & approve]  [Reject]      │
│                                                       │
│ ?  Tag    work-permit                                │
│           [Approve]  [Reject]                         │
│                                                       │
│ ── Rejected (1) ────────────────────────────────────│
│ ⊘ Tag    timeline                              [↶]   │
│                                                       │
└───────────────────────────────────────────────────────┘
```

#### Grouping

By **status**, in this fixed order: Created · Pending review · Failed · Rejected. Status is the most action-relevant axis — Cam wants to see "what do I need to act on?" first (pending review), "what got created?" next (auto_created/approved, often a launching pad), and "what got dropped?" last.

Within each group, items render in the order they appear in `processed_items.items` (no secondary sort). This preserves the LLM's narrative order, which usually mirrors how Cam wrote the thought.

Group headers use a thin rule + lowercase label + count, matching the existing `dump-section-header` style. Empty groups are omitted entirely (no "Created (0)").

#### Per-item row

| Element | Treatment |
|---|---|
| **Type icon + label** | Small inline icon (✓ / ? / ✗ / ⊘) prefix encoding status, then a type pill ("Task" / "Goal" / "Person" / "Tag" / "Knowledge" / "Goal link"). Same `review-type-badge` styling already shipped. |
| **Item name/title** | `reviewItemTitle(item)` — already exists. `--text-2`, `--fg`. |
| **Source quote** *(suggested + failed only)* | The `source_text` snippet, italic, `--text-3`, `--fg-muted`. Helps Cam audit *why* the LLM thought this. Hidden for created/approved items because the extraction is already accepted. |
| **Confidence label** *(suggested only, ≥6 items)* | "likely" / "maybe" / "uncertain" — same as today's review modal. Hidden when there are fewer than 6 suggestions; the signal-to-noise isn't worth the extra pixel below the threshold. |
| **Actions** | Per-status, see below. |

#### Per-status item actions

- **`auto_created` and `approved`:** the row is clickable as a whole. Click → opens that entity's detail (task → `openTaskDetail`, goal → `openGoalDetail`, person → person detail [pending], knowledge → knowledge detail [pending], tag → tag drawer [from the tags-first-class design]). A faint right-arrow `→` glyph in the row's right edge signals "this is a link." No three-dot menu — opening the entity is the only verb that makes sense here, and it's primary.

- **`suggested`:** three buttons — `Approve` / `Edit & approve` / `Reject`. Same handlers as today's review modal (`POST /approve-item` with `action: approve | edit_approve | reject`). `Edit & approve` expands an inline form (same shape as today). **Critically — these buttons are the affordance that the audit's "review modal" used to host;** see "Review modal merger" below.

- **`failed`:** error message rendered below the item name in `--bad` colour. Two affordances:
  - `Retry this item` — re-runs the create for just this item. Vault-side: this needs a new endpoint OR the existing `approve-item` handler can be extended (see Backend gaps). Treats the item as if newly suggested.
  - `Reject` — moves the item to rejected, accepting the failure as a non-issue.

- **`rejected`:** a small `↶ Un-reject` button. Returns the item to `suggested`. (See Backend gaps for the un-reject path.) Rationale: rejecting is reversible elsewhere in the app (toast-undo); rejected items shouldn't be a dead end either.

### Actions row — bottom of modal

Sticky to the modal footer (mobile: pinned to bottom of viewport; desktop: pinned to bottom of card).

```
┌───────────────────────────────────────────────────────┐
│ [Re-process]   [Copy raw]                  [Delete]   │
└───────────────────────────────────────────────────────┘
```

- **Re-process** *(or **Retry** when status is failed)* — primary-tone button, left-aligned. Re-queues the dump. Same endpoint, different label per state:
  - `processed` / `needs_review` → "Re-process" → `POST /api/brain-dumps/<id>/process`.
  - `failed` → "Retry" → `POST /api/brain-dumps/<id>/retry`.
  - `queued` / `processing` → button is hidden (re-processing while in flight is meaningless).
- **Copy raw** — copies the dump's raw `content` to clipboard. Useful when Cam wants to paste a captured thought into another tool. Inert button visually, toast confirmation. Low priority but cheap.
- **Delete** — destructive, right-aligned, `--bad` text colour, ghost-button styling (existing modal-footer-delete pattern). Confirm dialog (existing `#dumpDeleteOverlay` already shipped).

The footer row collapses on phones into a single horizontal scroll-band — the three buttons stay on one row at narrow widths because none of the labels are long.

---

## State coverage

How the modal renders for each `processing_status` value.

### `queued` (and legacy `unprocessed`)

- **Header:** grey "Pending" badge.
- **Body:** content read-only with Edit affordance.
- **Items section:** *not rendered.* Replaced by an inline placeholder card: spinner + "Waiting in the queue. The worker will pick this up in a few seconds."
- **Actions row:** Re-process **hidden** (it's already queued; nothing to re-do). Delete + Copy raw visible.
- **Polling:** while the modal is open and the dump is non-terminal, the existing 3s poll updates the modal in place. State transitions render through the modal without requiring a re-open.

### `processing`

- **Header:** grey + spinner "Processing" badge.
- **Body:** content read-only. Edit affordance **disabled** with hover-tooltip "Wait for the current pass to finish." (Editing during a worker pass would race the finalisation guard from the background-processing contract.)
- **Items section:** same placeholder as `queued` but with "Processing now…" copy.
- **Actions:** same as queued.
- **Polling:** as above.

### `processed`

- **Header:** green "Done" badge.
- **Body:** content with Edit affordance.
- **Items section:** all groups render per the layout above. Most items will be in `Created`; some may be `Rejected` (if the user previously rejected suggestions); none should be `Pending review` (otherwise status would be `needs_review`).
- **Actions row:** Re-process · Copy raw · Delete.

### `needs_review`

- **Header:** amber "Needs review" badge with the suggestion count appended ("Needs review · 3 pending").
- **Body:** content with Edit affordance.
- **Items section:** Pending review group is at the top (not in the standard fixed order — it's the action). Created and Rejected groups follow.
- **Actions row:** Re-process · Copy raw · Delete. Plus, as a convenience, a small "Approve all" link in the Pending review group header when there are ≥3 pending. (Bulk approve was a P3 in the audit; this is the cheap version — not bulk-approve-with-edit, just bulk-approve-with-defaults.)

### `failed`

- **Header:** red "Failed" badge. Below it, the error message from `work_queue.error` (the contract says this is `f"{type(exc).__name__}: {exc}"` — short enough to render inline). E.g.: *"TimeoutError: ollama did not respond in 30s · attempt 3/3."*
- **Body:** content with Edit affordance. Editing is allowed — fixing the content might be exactly the recovery the user needs.
- **Items section:** if the worker produced *any* items before failing (partial extraction), they render in the standard layout. If `processed_items` is null/empty, the items section is omitted entirely (no "Extracted (0)" header — feels accusatory and offers no path).
- **Actions row:** **Retry** is the primary action and gets visual emphasis (filled, larger, leftmost). Copy raw + Delete still present.

### Partial-failure rendering (worker errored mid-extraction with some items already created)

Per the auto-create-item contract, individual items can fail (`status: "failed"`) inside a dump that itself succeeded. This is *different* from a worker-level failure. Visualisation:

- The dump's status is `processed` or `needs_review` (the worker finished).
- Inside the items section, a `Failed (N)` group renders with each per-item failure showing its error (`error_class` — never the raw message; the contract says the truncated message stays in logs, not the UI).
- Each failed item gets `Retry this item` + `Reject` affordances (see per-status actions above).

This is where the contract's per-item `failed` status finally has an honest UI surface — the audit flagged this gap and it's part of why the dump-detail modal needs to exist.

---

## Backend gaps

Vault to confirm or build:

### 1. `PUT /api/brain-dumps/<id>` — content edit

**Status: exists** (`handlers.py:601` `handle_update_brain_dump`). Body accepts `{content, processed, tags}`; updates the row and returns the updated dump.

- **Fit:** good. The detail modal will send `{content: "..."}` and treat the response as the new dump. No new endpoint needed.
- **Gap:** the handler accepts `tags` and `processed` flags too, but the modal will only send `content` for the edit-content flow. No issue.
- **Confirm:** route is wired in `server.py:410`. ✓.

### 2. Re-process — reuses existing endpoint

**Status: exists.** `POST /api/brain-dumps/<id>/process` (idempotent re-queue) and `POST /api/brain-dumps/<id>/retry` (failed → queued, attempts reset). Detail modal uses both, dispatched on current status:

- non-failed → `/process`.
- failed → `/retry`.

No new endpoint needed. The "Save & re-process" composite action is a client-side sequence (`PUT` then `POST .../process`), not a server-side composite — keeps the backend honest about what each endpoint does.

### 3. Per-item retry — needs a new code path

**Status: does not exist** as a per-item retry. The current `approve-item` handler (`processing.py:2417`) supports `action: approve | reject | edit_approve` but not "retry the create for an item that previously failed."

**Recommendation: extend the existing `approve-item` handler** rather than adding a new endpoint. Add `action: retry`:

- Reads the item at `item_index`.
- Asserts the item's current `status == "failed"` (else 409).
- Re-invokes `_auto_create_item(conn, item, dump_id, sibling_items=processed_items["items"])` — same call shape as `action: approve`.
- On success: `status: "approved"`, `created_id: <new_id>`. Same as approve.
- On `None` return: stays `failed`, surfaces a 200 with the unchanged status (consistent with the contract's "approve action accepted, underlying create failed" semantics — the user sees no progress and can decide whether to edit or reject).

Why extend rather than add a new endpoint: it's the same concept (run the create for one item) with a different precondition. Splitting introduces two near-identical endpoints; merging keeps the surface tight.

### 4. Un-reject — needs a new code path

**Status: does not exist.** The current `approve-item` handler treats `reject` as terminal-ish but the contract is fine with it being reversible (rejected items still live in `processed_items.items`).

**Recommendation: extend the existing handler.** Add `action: unreject`:

- Reads the item at `item_index`.
- Asserts current `status == "rejected"` (else 409).
- Sets `status: "suggested"`. No DB writes beyond the JSON column update.
- Recomputes `has_pending`; if the dump was `processed` and now has a pending item, flip it back to `needs_review`.

Tiny — five lines of handler code. Worth it for the round-trip undo story.

### 5. The "approve-item" handler's status-flip rules

The handler currently requires the item to be in `suggested` status when approving (implicitly — it just overwrites `status`). With un-reject and per-item retry, the rules become:

- `approve` / `edit_approve`: requires `suggested`.
- `reject`: requires `suggested`.
- `retry`: requires `failed`.
- `unreject`: requires `rejected`.

Vault adds a small precondition gate at the top of the handler. 409 with a meaningful body when the precondition fails (mirrors the contract's existing 409 patterns).

---

## Frontend gaps

Lumen to build:

1. **`#dumpDetailOverlay`** — new modal component matching the goal-detail/review-overlay shape. Reuses existing `.overlay` + `.modal` classes.
2. **Inline-edit textarea component** — auto-resize, with Save / Save & re-process / Cancel buttons. The capture-input already auto-resizes (`autoResize(dumpInput)`); reuse.
3. **Per-item row component (`renderDumpItem(item)`)** — new component with status-aware rendering. Probably extracted as a function so the existing review-modal could call it too if it survives (see merger).
4. **Per-item action menu** — the three-button cluster for `suggested` items is already shipped in the review modal; refactor into a shared component.
5. **Group headers (`Created (N)`, `Pending review (N)`, etc.)** — small new style; reuse `dump-section-header` if it exists or add a thin variant.
6. **Polling integration** — the existing `_hasInflightDump()` poll already covers the dumps list view; the modal opens over that view, so it inherits the poll. Verify the modal re-renders when the dump's row changes during polling (probably needs `if (currentView === 'dump') renderDumps()` to also re-render the open modal — small dispatch hook).
7. **Lateral navigation** — clicking an auto-created task from the items section should call `openTaskDetail(id)` *without* closing this modal (z-index stacking); same for goals, knowledge, persons. Already partially built for goal-detail; extend.
8. **Bottom-sheet behaviour on phones** — slides up from bottom (existing pattern in `#goalDetailOverlay`); reuse.

---

## Review modal merger

**Decision: subsume the review modal entirely.** The detail modal becomes the only review surface.

### Rationale

- The review modal today exists to give `suggested` items a place to live. The detail modal hosts every status, including `suggested`, with the same affordances.
- The "review N suggestions" button on a dump row becomes a *click on the dump row itself* — the row IS clickable now (audit P1 #2), and a needs-review dump opens directly into a modal that shows the pending items group at the top. The button-as-affordance is collapsed into the row-as-affordance.
- The audit's section 4 critique (the success-state tombstone) goes away by construction — there's no "all reviewed" tombstone because the modal isn't *only* a review surface; once the user approves the last suggestion, the items section just shows the Created group, the dump's status flips to `processed`, and the modal stays open and useful.
- One fewer surface to maintain. The `#reviewOverlay` markup, the `openReviewModal` JS, and the `btn-review` button all delete.
- High-volume review sessions (the case for keeping a focused review modal): nothing about the detail modal makes high-volume harder. The Pending-review-group-first layout in `needs_review` state mirrors the focused-review experience. If volume becomes painful, "Approve all" + per-item arrow-key navigation can land later (P3 in the audit).

### Migration plan for Lumen

1. New `#dumpDetailOverlay` ships with the layout above.
2. `dump-item-content` becomes clickable — opens the detail overlay for that dump's id.
3. The `btn-review` button is removed from `renderDumps`.
4. The `openReviewModal` function and `#reviewOverlay` markup are removed.
5. The Edit-and-Approve form logic moves into the detail overlay's per-item row.
6. Probe regresses on: open-from-row, approve, edit-approve, reject, all the old review-modal flows now driven through the new modal.

### Where the review modal stays useful (it doesn't)

I considered keeping a "focused review" mode for high-volume triage sessions — a card-stack interface, one suggestion at a time, swipe to dismiss. Pocketing in iterations.

---

## Open questions for Cam

**None.** Standing authorisation covers all the design calls. The product question I almost asked — *"does editing trigger a re-process?"* — I've answered: only when the user explicitly opts in via "Save & re-process." Implicit re-processing on every typo fix would punish careful editing.

---

## Recommended dispatch order

1. **Reed** — light schema review (5-min): confirm that adding `failed` and (extended) reversible-state items to `processed_items.items[*].status` requires no schema work (per the auto-create contract, it's a JSON column — no CHECK constraint to amend). Confirm `unreject` is purely a JSON status flip with no relational implications.

2. **Vault** — extend `handle_approve_item` (`processing.py:2417`) to support two new actions:
   - `action: retry` — for `status=failed` items; invokes `_auto_create_item` again.
   - `action: unreject` — flips `rejected → suggested`, recomputes `processing_status` rollup (might flip dump from `processed` back to `needs_review`).
   - Add the precondition gate (return 409 when current item status doesn't match the action). One PR, one deploy.

3. **Lumen** — implement the detail modal end-to-end:
   - New `#dumpDetailOverlay` markup + CSS.
   - `openDumpDetail(dump)` function — renders header, body, items section, actions row.
   - Click-on-row in `renderDumps` opens the modal.
   - Inline content edit with Save / Save & re-process.
   - Items rendering with per-status grouping and actions.
   - State coverage for all five lifecycle states + partial-failure.
   - Lateral navigation to task/goal/person/knowledge/tag detail.
   - Remove `#reviewOverlay`, `openReviewModal`, the `btn-review` button.
   - Re-route the existing audit P1 fix (failed-dump retry on home) to also open the detail modal on click.

4. **Probe** — regression sweep, chromium + webkit:
   - Open detail modal from each filter (All / Needs Review / Processed / Unprocessed).
   - Per-state rendering: queued, processing, processed, needs_review, failed.
   - Approve, Edit & Approve, Reject — flow through detail modal.
   - Retry per-item (failed extraction) — flow through detail modal.
   - Un-reject a previously-rejected item.
   - Re-process a processed dump (confirm items refresh).
   - Retry a failed dump.
   - Edit content (with and without re-process).
   - Delete (existing flow, now triggered from inside the detail modal).
   - Lateral navigation: open auto-created task from items list, close, return to detail modal.
   - Polling: open detail on a `queued` dump, watch it transition through `processing` → `processed`/`needs_review` without re-opening.
   - Verify the old `#reviewOverlay` is gone and `btn-review` is gone everywhere.

5. **Iris device pass** — iOS PWA on the actual phone:
   - Bottom-sheet open animation feels right on a thumb-reach.
   - Edit textarea doesn't get covered by the iOS keyboard.
   - Tap targets on per-item action buttons clear 44pt.
   - Modal-stacking (open task detail over dump detail) doesn't break the back-swipe.
   - Long-content scroll inside the modal doesn't conflict with backdrop-tap-to-close.

---

## Iterations (deferred)

Things considered and pocketed for after MVP:

- **Focused review card-stack** — one suggestion at a time, swipe-to-dismiss, keyboard navigation. Justified only if review sessions become high-volume.
- **Approve all** with per-item edits queued — a "review the edits then approve all" two-step flow. Today's "Approve all" idea in `needs_review` state is the simple version (approve each with current data); the queued-edits version is a P3.
- **Diff view on re-process** — when the user re-processes, show what changed in the items list (added / removed / edited) before committing. Useful for the "I edited the content and want to see what the LLM did differently" case. Requires retaining the previous extraction snapshot.
- **Source-text highlighting in the content body** — when an item is selected in the items section, highlight its `source_text` in the content body above. Beautiful, non-trivial, deferred.
- **Per-item provenance** — show the LLM's confidence and reasoning for each created item, not just suggested ones. Useful for auditing the high-confidence path. Currently the contract reserves confidence as a `suggested`-only signal; expanding it is a separate dispatch.
- **Activity log** — show the timeline of "captured · processed · 2 items approved · 1 retried · 1 rejected" inside the modal. Nice-to-have audit trail; deferred until tag debt is solved (because tags will rapidly become Cam's primary audit lens, not per-dump history).

---

*Iris, 2026-04-27. Detail-modal design for the brain-dump triage surface. The dump stops being a one-way drop box and becomes a place Cam can come back to — to read, audit, fix, follow, or kill.*
