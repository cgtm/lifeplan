# Unlink Auto-Created Items From a Brain Dump

**Author:** Iris (Senior Interaction Designer)
**Date:** 2026-04-30
**Status:** proposed
**Implementer:** Lumen (UI), Vault (API), Reed (heuristic), Probe (regression)
**Sibling design:** `docs/ux-design/2026-04-27-brain-dump-detail.md`
**Contract touched:** `app/contracts/auto-create-item.md` — extends the
`handle_approve_item` action matrix.

---

## Pitch

> One affordance, two safe outcomes: a single "Unlink" control on every
> auto-created row that quietly figures out whether the entity is safe to
> delete or only safe to detach, then tells Cam exactly what's about to
> happen before he commits.

This closes the only remaining dead end on the dump-detail modal: an
LLM auto-creates the wrong task, and Cam has nowhere to disown it
without first opening the entity surface and deleting it manually —
which is the wrong recovery shape for "the dump made this up." Unlink
treats the dump as the scene of the crime: undo lives where the mistake
was made.

---

## Three-line surface contract

**Surface: Unlink control on `auto_created` / `approved` rows**
**Job:** Disown a wrong auto-creation from the place it was created,
without making me think about whether the entity is reusable.
**Next action:** Tap Unlink → read the system's read of the situation →
confirm or cancel.

---

## Top three affordances

1. **A single "Unlink" control per created/approved row.** Right-edge of
   the row, inline with the launchpad, never competing with it.
2. **A confirm dialog that names the path explicitly** — "Delete the
   task 'Pay back mum'" vs "Detach this task from the brain dump" —
   sourced from a server-side decision so the same word means the same
   thing every time.
3. **A reversible end state** — the row rerenders as `rejected`, and
   the existing `↶ Un-reject` affordance lets Cam restore the link.
   When the path was *detach*, un-reject simply re-claims credit. When
   the path was *delete*, un-reject is best-effort: see Edge cases.

---

## Affordance — where it lives, what it looks like

### Single button vs two buttons

**Recommendation: single "Unlink" button**, server-routed.

Cam asked one question — *"how do I undo a wrong auto-create?"* — and
the rule he gave is a *system* rule, not a user choice. The user-side
cost of choosing between Delete and Detach is exactly the cost of
knowing the heuristic, which is precisely what the server is for. Two
buttons would force Cam to predict the data state before clicking;
single button + named-path confirm puts the prediction inside the
dialog where it belongs.

The dialog is where the choice gets surfaced — not as a choice, but as
a *decision*. Cam reads what the system decided, and confirms or
cancels.

### Placement

Right edge of the row, in the same gutter as the launchpad chevron
(`›`). Hover-revealed on desktop, always-visible on mobile. The
chevron + Unlink share the gutter; the chevron is the launchpad
affordance, Unlink is the disown affordance. They live one above the
other (chevron leading because the row's primary action is opening the
entity).

```
Desktop, default:
┌─────────────────────────────────────────────────────┐
│ Task   Pay back mum                              ›  │
└─────────────────────────────────────────────────────┘

Desktop, hover:
┌─────────────────────────────────────────────────────┐
│ Task   Pay back mum                          [×]  › │
└─────────────────────────────────────────────────────┘

Mobile (always visible):
┌─────────────────────────────────────────────────────┐
│ Task   Pay back mum                          [×]  › │
└─────────────────────────────────────────────────────┘
```

The control is a small `×` glyph (24×24 tap target with surrounding
hit area to clear 44pt on phones) with `aria-label="Unlink from
dump"`. Subdued tone (`--fg-muted`); on hover/focus it goes to
`--bad` to signal destructive intent. No text label inline — the
label lives in the dialog where it can name the actual action.

**Why `×` and not "Unlink":** the row is dense (type pill, title,
optional confidence, chevron). A text button steals horizontal space
and competes visually with the launchpad. The `×` reads as "remove
this from this list," which is the right mental model — Cam isn't
*deleting an entity from the system*, he's *removing this row's
claim from this dump*. Which is exactly true, regardless of whether
the system path is delete or detach.

**Click behaviour:**
- `e.stopPropagation()` so the launchpad doesn't fire.
- Pre-flight: `POST /api/brain-dumps/<id>/unlink-preview`
  (Vault to add) returns `{path: 'delete' | 'detach', reasons: [...],
  entity_label: '...'}`. On 200 → open the confirm dialog with the
  returned shape. On 5xx / network → toast "Couldn't check — try
  again," button re-enables, no dialog.
- The pre-flight is the dialog's data source. No client-side guess
  about the path.

### Visibility rules

- Render on `auto_created` and `approved` rows.
- Do NOT render on `suggested`, `failed`, `rejected` — those rows have
  their own action vocabulary (Approve/Reject, Retry, Un-reject) and
  Unlink doesn't apply (they have nothing for the dump to disown).
- Do NOT render on rows where `created_id` is null even with a created
  status — that's the stale-row case (see Edge cases). In that case
  show the same `×` but route to the "already gone" dialog directly,
  no pre-flight.

---

## The dialog

The dialog's shape is fixed; only its copy and the verb on the primary
button change between paths. One overlay component, two content
templates, dispatched from the pre-flight response.

### Common skeleton

```
┌───────────────────────────────────────────────────────┐
│  [headline]                                       [×] │
│                                                       │
│  [body — what the system decided and why]             │
│                                                       │
│  [outcome line — the terminal action in plain words]  │
│                                                       │
│                              [Cancel]  [Primary verb] │
└───────────────────────────────────────────────────────┘
```

- **Headline** — six words or fewer, names the path.
- **Body** — one sentence stating the system's decision and the
  reason. Reasons are server-supplied (see Backend dependencies); the
  UI just renders them.
- **Outcome line** — a single bolded sentence stating exactly what the
  primary verb will do. This is the load-bearing line — the one Cam
  reads last before clicking.
- **Cancel** — secondary tone, always left of primary, dismisses the
  dialog with no side effects.
- **Primary verb** — `--bad` tone for delete-path, default tone for
  detach-path. Disabled-and-spinner during the request.

### Delete path (no other references)

```
┌───────────────────────────────────────────────────────┐
│  Delete this task?                                [×] │
│                                                       │
│  Nothing else references this task — it was created   │
│  by this brain dump and hasn't been edited or used    │
│  anywhere else.                                       │
│                                                       │
│  Delete the task "Pay back mum". The row in this      │
│  dump will be marked rejected.                        │
│                                                       │
│                              [Cancel]      [Delete]   │
└───────────────────────────────────────────────────────┘
```

- Headline names the entity type ("task" / "goal" / "person" / "tag" /
  "knowledge item") so Cam knows what's at stake without reading the
  body.
- Body is the *reason* — server-supplied, but the template is fixed
  per type:
  - task: "Nothing else references this task — it was created by this
    brain dump and hasn't been edited or used anywhere else."
  - goal: "This goal has no tasks under it, no people linked, and was
    created by this brain dump."
  - person: "Nobody else mentions this person, no goals link to them,
    and they were created by this brain dump."
  - knowledge: "No tags or other dumps reference this knowledge item —
    it was created here."
  - tag: "This tag isn't applied to anything outside this dump."
- Outcome line: `Delete the {type} "{label}". The row in this dump
  will be marked rejected.`
- Primary verb: **Delete** (in `--bad` tone, matches existing
  `dumpDeleteOverlay` button styling).

### Detach path (other references exist)

```
┌───────────────────────────────────────────────────────┐
│  Detach from this dump?                           [×] │
│                                                       │
│  This task has changed since it was auto-created:     │
│   • edited 3 days ago                                 │
│   • tagged in 2 other brain dumps                     │
│  Deleting it would lose work the dump didn't make.    │
│                                                       │
│  The task "Pay back mum" stays. This dump will stop   │
│  claiming credit for it; the row will be marked       │
│  rejected.                                            │
│                                                       │
│                              [Cancel]      [Detach]   │
└───────────────────────────────────────────────────────┘
```

- Headline is path-specific ("Detach from this dump?"), not
  type-specific, because the destructive bit isn't on the entity —
  it's on the link.
- Body is a reason **list** rendered as bullets when there are
  multiple, or inline when there's one. Reasons are short, plain,
  human:
  - "edited {relative_time}" (any update to the entity row after
    `created_at`)
  - "has {N} {tasks/people/items/etc.} under it" (children that didn't
    come from this dump)
  - "tagged in {N} other brain dump{s}" (apply_to references from
    other dumps)
  - "applied to {N} other items" (tags only — the cross-dump
    application case Cam called out)
  - "linked to {N} other goals" (people)
  - "referenced by {N} other knowledge items" (knowledge)
  - "linked to a goal you've worked on" (high-level catch-all when the
    entity is part of an active surface)
  Reasons are server-supplied as a list of pre-formatted strings; the
  UI renders them in order without re-templating.
- Closing line of body: `"Deleting it would lose work the dump didn't
  make."` — fixed copy, frames the detach choice as the *kind* one,
  not the *weak* one.
- Outcome line: `The {type} "{label}" stays. This dump will stop
  claiming credit for it; the row will be marked rejected.`
- Primary verb: **Detach** (default tone, not `--bad`. Detach isn't
  destructive to the entity, only to the link.)

### Tag-specific dialog notes

Tags are the single special case Cam called out. Reed's heuristic will
tell us *which* of three sub-cases we're in:

- **Tag created here, applied only to items from this dump → delete
  path.** Standard delete dialog, type = "tag," reason fits the tag
  template above.
- **Tag created here, applied to items from this dump AND others →
  detach path.** Reason includes `"applied to {N} other items"`. The
  detach in this case removes only this dump's `brain_dump_tags` link
  AND the tag's `*_tags` junctions for items belonging to *this dump*;
  the tag's other applications stay. Outcome line: `The tag
  "{name}" stays. This dump will stop claiming credit for it; the
  row will be marked rejected.` (Reed's heuristic specifies the
  cleanup; the dialog just announces the outcome.)
- **Tag pre-existed, this dump only used it → detach path.** Reason:
  `"existed before this dump"`. Same detach outcome.

The dialog text doesn't enumerate which sub-case it is — the reason
list says enough. The internal cleanup difference is Reed's problem,
not the user's.

### Already-gone dialog (race / stale row)

```
┌───────────────────────────────────────────────────────┐
│  This is already gone                             [×] │
│                                                       │
│  The {type} this row pointed to no longer exists —    │
│  it looks like it was already deleted somewhere else. │
│                                                       │
│  Mark this row rejected so the dump stops claiming    │
│  credit for it.                                       │
│                                                       │
│                              [Cancel]   [Mark rejected]│
└───────────────────────────────────────────────────────┘
```

Triggered when the pre-flight returns `{path: 'stale'}` (entity not
found by `created_id`), or when the actual unlink returns 404 on the
entity. No `--bad` tone; this is housekeeping.

---

## State coverage

### Click → pre-flight in flight

- Button shows a small spinner in place of the `×`.
- Row stays interactive elsewhere (launchpad still works if Cam
  changes his mind).
- Pre-flight has a soft 4s budget; on timeout, toast "Couldn't check
  — try again" and re-enable the button. No dialog opens.

### Dialog open → primary clicked

- Primary button disables; spinner.
- Body buttons (Cancel, X, backdrop tap) all disabled during request.
- On 200:
  - **Delete path** — toast "Task deleted." Row optimistically flips
    to `rejected`, dialog closes.
  - **Detach path** — toast "Detached from dump." Row optimistically
    flips to `rejected`, dialog closes.
  - In both cases, `_dumpDetailItemAction`-style optimistic mutation:
    `item.status = 'rejected'`, `item.created_id = null`, then the
    server's response replaces local state on the next 200.
- On 4xx with a `{error: "stale"}` body — close the current dialog,
  open the already-gone dialog, do not toast yet.
- On 5xx / network — toast "Couldn't unlink — try again." Button
  re-enables. Row stays in `auto_created` / `approved`. Optimistic
  flip is rolled back (existing `_dumpDetailItemAction` pattern
  already does this).
- On 409 (server's heuristic disagrees with what the pre-flight said
  — race between the two calls, e.g. someone added a child between
  pre-flight and unlink) — close the dialog, toast "Something
  changed — checking again," re-run pre-flight, re-open dialog with
  the new path. Cap at one retry (don't loop forever).

### After success

- The row rerenders in the **Rejected** group (existing dump-detail
  pattern). The existing `↶ Un-reject` affordance is now the row's
  primary action.
- The dump's `processing_status` rollup follows the existing rules:
  rejecting an `auto_created` item does NOT regress to `needs_review`
  (only suggested→pending does that — already true today).
- The other rows in the dump are unaffected.
- If the dump had only one created item and Cam unlinks it, the
  Created group disappears and the modal continues to render the
  Rejected group with the row inside.

### Failure modes summarised

| Scenario | Behaviour |
|---|---|
| Pre-flight timeout | Toast retry; no dialog |
| Pre-flight 5xx | Toast retry; no dialog |
| Confirm 5xx | Toast retry; row stays `auto_created`/`approved` |
| Confirm 404 (entity gone mid-flight) | Already-gone dialog |
| Confirm 409 (heuristic changed) | Re-run pre-flight once, re-open dialog |
| User cancels | No-op; dialog closes |

---

## Edge cases

### 1. Race — entity already deleted elsewhere

Cam opened the launchpad earlier in the day, deleted the task on its
own surface, and now returns to the dump where the row still claims
credit for `created_id=42`. Pre-flight detects this (the entity
lookup returns nothing) and returns `{path: 'stale'}`. UI shows the
already-gone dialog. Confirming flips the row to `rejected` with no
entity-side action. This is the cheapest, kindest recovery — the dump
is wrong, the system tells the truth, no scary "this thing is
missing!" red banner.

### 2. Substantial edit since auto-creation

Per Cam's rule: **edits count as "other data," so the path is
detach.** Reed's heuristic must check `entity.updated_at >
entity.created_at` (or per-type equivalent). The dialog's reason list
includes `"edited {relative_time}"`. This protects the case where the
LLM extracted a rough title, Cam refined it, and now the dump
auto-disowning would feel like a betrayal.

The threshold for "edit" is *any* update to the entity row. Reed
should NOT try to be smart about "trivial" edits (whitespace, etc.) —
the simple rule is the safe rule, and a detach is always safer than a
mistaken delete.

### 3. Tag with cross-dump applications

Per Reed's heuristic and the dialog notes above: detach path. The
detach removes the link only for items belonging to the current dump,
not the tag's broader application graph. The dialog's reason list
makes this visible (`"applied to N other items"`).

### 4. Goal with tasks beneath it (auto-created task happened to land under an auto-created goal)

Reed's heuristic for the *goal* must check `goal_tasks` (tasks linked
to the goal). If any task was created outside this dump, detach. If
ALL tasks under the goal were auto-created by this dump AND each of
them is also unlinkable-as-delete, the goal *is* deletable in
isolation — but the cascade is non-trivial and out of scope for MVP.
**MVP rule: any tasks under the goal → detach.** Cam can unlink each
task separately first; once the goal is empty, a re-pre-flight will
return delete.

### 5. Person-mention vs person-new

Both surface as `auto_created` rows when the LLM created a real
`people` row. Heuristic is the same: any *other* mention, goal link,
or knowledge item referencing this person → detach. Otherwise →
delete.

### 6. Undo after success (re-claiming credit)

The row's `↶ Un-reject` affordance handles this:

- **Detach-path undo** is clean: the entity still exists, un-reject
  flips the row back to `suggested`, the user can re-approve, which
  re-runs `_auto_create_item` and re-establishes the link (`tag` and
  `person_mention` already do this idempotently; for the others the
  branch will succeed and produce a new `created_id`, which is
  semantically what the user wants — the dump claims credit for the
  same entity again). **Vault note:** the existing `_auto_create_item`
  for `task` / `goal_new` / `knowledge` always inserts a new row,
  which would *duplicate* the entity. This is the one wrinkle. See
  Backend dependencies for the resolution.
- **Delete-path undo** is best-effort: the entity is gone. Un-reject
  followed by approve will create a *new* entity from the cached
  `data` (`task.title`, `task.description`, etc. are all in
  `processed_items.items[idx].data`). This is the correct shape — the
  dump's data is still the source of truth, and Cam's recovery path
  is "rebuild from the dump" which is exactly what re-approve does.
  The new entity gets a new id; the old `created_id` was 42, the new
  one might be 87. The row claims credit for 87.

For MVP, the un-reject + re-approve flow is the existing affordance —
no new UI. The undo story is "the row rejoins the dump as a
suggestion, you re-approve." The detach-path's "would re-link to the
existing entity" optimisation is a nice-to-have iteration (see
Iterations).

### 7. Rapid double-click on the `×`

The button disables on click and stays disabled through the
pre-flight + dialog. No double-fire risk.

### 8. Cam clicks `×` on a row, opens the dialog, then closes it via the X / backdrop / Escape

Treated as Cancel. No-op. The button re-enables on next render.

---

## Backend dependencies

### Vault

#### 1. New endpoint: `POST /api/brain-dumps/<id>/unlink-preview`

Body: `{item_index: int}`. Response shape:

```json
{
  "path": "delete" | "detach" | "stale",
  "entity_type": "task" | "goal" | "person" | "tag" | "knowledge",
  "entity_label": "Pay back mum",
  "reasons": ["edited 3 days ago", "tagged in 2 other brain dumps"]
}
```

- Path `'delete'` → `reasons` may be empty or contain a single
  template string (the dialog uses the per-type fallback when
  `reasons` is empty).
- Path `'detach'` → `reasons` is non-empty, ordered by relevance.
- Path `'stale'` → `entity_label` may be a `"the {type}"` placeholder
  (`reasons` ignored by the UI for this path).
- The pre-flight is a read; no mutation. Idempotent.

#### 2. New action on `handle_approve_item`: `'unlink'`

Extends the action matrix in `app/contracts/auto-create-item.md`:

| `action` | Required current item status | Calls `_auto_create_item`? | Success status | Failure | 409 body |
|---|---|---|---|---|---|
| `unlink` | `auto_created` or `approved` | no (delegates to a new helper) | `rejected` | n/a | `{error: "only created items can be unlinked"}` |

Body extension: `{item_index: int, action: 'unlink', confirmed_path:
'delete' | 'detach'}`. The handler:

1. Validates the item is `auto_created` or `approved`.
2. Re-computes the heuristic server-side. **Does not trust
   `confirmed_path` blindly.**
3. If the recomputed path matches `confirmed_path`: proceeds.
4. If they don't match (state changed between pre-flight and
   confirm): returns 409 `{error: "state changed",
   new_path: "<path>", reasons: [...]}` so the UI can re-prompt.
5. On `delete` path: deletes the entity row + its junctions. Sets
   `item.status = 'rejected'`, `item.created_id = null`.
6. On `detach` path: removes only the link(s) to *this* dump. Sets
   `item.status = 'rejected'`, `item.created_id = null`. Entity row
   stays.
7. On `stale`: no entity work; sets `item.status = 'rejected'`,
   `item.created_id = null`.

The `confirmed_path` field is the UI's "I showed the user this
specific path" assertion, used by Vault to detect drift, not as the
authoritative decision. Authority always sits server-side.

#### 3. Re-link semantics for un-reject + re-approve

The wrinkle in Edge case 6: if Cam un-rejects a detached row and
re-approves, today's `_auto_create_item` for `task` / `goal_new` /
`knowledge` would create a *duplicate* entity. Two options:

- **(a) Stash the original `created_id` on detach.** Set
  `item.detached_id = item.created_id` before nulling
  `item.created_id`. On re-approve, if `detached_id` is set and the
  entity still exists, re-link instead of insert. Re-claims credit
  for the original entity, which is the kind shape.
- **(b) Accept duplicates as MVP.** Simpler; Cam can manually merge
  if he hits this. Cheap in code, occasionally annoying in practice.

**Recommendation (b) for MVP**, queue (a) as a separate dispatch.
Reasoning: the un-reject + re-approve case after a detach is
genuinely rare (Cam unlinked because he meant to, then changed his
mind); duplicates from this path will be a drip not a flood. Solve it
when it shows up.

### Reed

#### Per-entity-type safety heuristic

Reed designs the data-side rule that decides `delete | detach | stale`.
The UX needs the heuristic to be:

- **Deterministic.** Same inputs → same answer. No "sometimes safe."
- **Conservative.** When in doubt, return `detach`. The cost of a
  wrong-detach is a stale row Cam can manually delete from the entity
  surface; the cost of a wrong-delete is lost work.
- **Reason-producing.** The heuristic must return a list of human
  reason strings (or the structured shape Vault transforms into
  strings) for the detach path. The dialog has nothing to say without
  them.
- **Cheap.** It runs synchronously on every Unlink click (twice — once
  for pre-flight, once for the unlink itself). Should be one or two
  small queries per entity type, not a graph walk.

UX-side reason templates the heuristic must emit (Reed maps these to
data conditions):

- `"edited {relative_time}"` — entity has been updated since auto-create.
- `"has {N} {child_noun} under it"` — task/goal/person children that
  weren't created by this dump.
- `"tagged in {N} other brain dumps"` — tag's `brain_dump_tags` rows
  beyond the current dump.
- `"applied to {N} other items"` — tag's per-item junctions to items
  outside this dump.
- `"linked to {N} other goals"` — person's `goal_people` rows beyond
  this dump.
- `"referenced by {N} other knowledge items"` — cross-knowledge link
  count.
- `"existed before this dump"` — entity's `created_at` predates the
  dump's `created_at` (covers the "tag pre-existed" case and any
  other pre-existing-entity matched-by-the-LLM situation).
- Fallback: `"used elsewhere"` — when none of the specific reasons
  apply but the heuristic still detected a connection. Rare; should
  be loggable so Reed can refine.

### Probe

Regression checklist (handed to Probe via Atlas after Vault and Lumen
land):

- Click `×` on each entity type's auto_created row, both delete-path
  and detach-path. Confirm dialog content matches templates above.
- Cancel from the dialog (X, backdrop, Escape, Cancel button) — no
  side effects.
- Confirm delete → entity is gone, row is rejected.
- Confirm detach → entity is intact, row is rejected, junctions to
  this dump are gone, junctions to other dumps remain.
- Stale row: pre-delete the entity via direct DB, click Unlink,
  already-gone dialog appears, confirming marks rejected.
- Race-on-confirm: between pre-flight and confirm, mutate the
  underlying entity (add a child); confirm-detach should succeed,
  confirm-delete should 409 → dialog re-runs with detach path.
- Tag with cross-dump applications: heuristic returns detach,
  detach-path removes only this dump's junctions.
- Un-reject → re-approve flow on a detached row (duplicate-accepted
  per option (b)).
- Hover-reveal on desktop, always-visible on mobile, no overlap with
  launchpad gesture.
- Tap target ≥ 44pt on iOS PWA.
- Modal stacking: Unlink dialog opens *over* the dump-detail modal;
  closing it returns to dump-detail modal preserved in DOM.

---

## Recommended dispatch order

1. **Reed** — design the per-entity safety heuristic. Output: a short
   spec listing, per entity type, the queries that distinguish
   delete-path from detach-path, the reason strings each query
   produces, and the stale detection rule. Reed signs off on the rule
   *before* Vault writes the endpoint — contract-before-code.

2. **Vault** — implement, in this order:
   1. The pre-flight endpoint `POST /api/brain-dumps/<id>/unlink-preview`
      using Reed's heuristic.
   2. The `'unlink'` action on `handle_approve_item`, with the
      `confirmed_path` drift check.
   3. Update the action matrix in `app/contracts/auto-create-item.md`
      to include `unlink`.
   4. Per-entity delete and detach helpers (one each per type). Detach
      helpers are the new code; delete helpers can call existing
      delete endpoints' internals where they exist.

3. **Lumen** — implement:
   1. The `×` affordance on `_renderDumpDetailItemRow` for
      `auto_created` and `approved` rows.
   2. The pre-flight call + spinner state on the button.
   3. The unlink confirm overlay (one component, two content
      templates dispatched on `path`).
   4. The already-gone dialog template.
   5. Wire the optimistic flip + rollback on success/failure (extends
      the existing `_dumpDetailItemAction` pattern).
   6. The 409-drift retry-once flow.

4. **Probe** — regression sweep per the checklist above. Chromium +
   webkit, desktop + iOS PWA.

5. **Iris device pass** — actual phone, actual thumb. Specifically
   checking:
   - The `×` on a created row doesn't conflict with the launchpad tap
     when the user's thumb lands ambiguously.
   - The dialog's outcome line is the last thing the eye lands on
     before the primary button (visual hierarchy ladder works).
   - Tag-with-many-applications detach dialog reads cleanly when the
     reason list is two or three bullets long.

---

## Open questions for Cam

**None.** Cam's rule covers the decision; the heuristic encodes it;
the dialog announces it; the `×` invites it. Standing authorisation
covers the visual and placement choices. The duplicate-on-re-approve
edge (option (b)) is a deferred refinement, not a blocking question.

---

## Iterations (deferred)

- **Detach-then-re-link round-trip.** Stash `detached_id` so an
  un-reject + re-approve on a detached row re-claims the original
  entity instead of duplicating. Option (a) above.
- **Bulk unlink.** "Unlink all auto-created" header action when Cam
  realises the whole dump was a misfire. Today's path: unlink each in
  turn, then delete the dump itself. Bulk unlink is a refinement.
- **Cascade-aware delete.** If a goal has only auto-created tasks
  *all from this dump*, offer to delete the goal and the tasks
  together. MVP routes this through detach (per Edge case 4) and lets
  Cam unlink leaves first.
- **Reason refinement telemetry.** Log when the heuristic falls back
  to `"used elsewhere"` so Reed can name the missing rule.
- **In-row preview tooltip.** Hovering `×` on desktop shows a tiny
  preview of the path (`"will detach (3 reasons)"`) before the click.
  Cute; not load-bearing — the dialog already does this work.

---

*Iris, 2026-04-30. The dump-detail modal earns its launchpad-not-dead-end
promise on every status: created rows now have an exit path that
respects what the user has built since auto-creation.*
