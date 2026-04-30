# Brain Dumps Trigger Updates To Existing Items

**Author:** Iris (Senior Interaction Designer)
**Date:** 2026-04-30
**Status:** proposed
**Implementers:** Vault (LLM prompt + extraction + apply), Reed (schema
verification + per-type field policy), Lumen (UI), Probe (regression)
**Contracts touched:** `app/contracts/auto-create-item.md`,
`app/contracts/background-processing.md`
**Sibling designs:**
`docs/ux-design/2026-04-27-brain-dump-detail.md`,
`docs/ux-design/2026-04-30-unlink-auto-created.md`

---

## Pitch

> A brain dump that says "I booked the flights" should be able to walk
> over to the *Book flights* task and tick it off. Today the LLM only
> creates; it never updates. This plan teaches it to propose updates,
> renders those updates as their own group in the dump-detail modal,
> and applies them on Cam's approval — with the matched entity named
> in the row so a wrong match is caught before it ships.

The existing extraction pipeline already understands "this dump
mentions an existing goal" (via `goal_link`) and "this dump mentions
an existing person" (via `person_mention`). It just doesn't take the
next step — *if it knows which goal, it can also know which task on
that goal looks newly done.* This plan is that next step.

---

## Three-line surface contract

**Surface: Update group inside the dump-detail modal**
**Job:** Tell me which existing things this dump implies a change to,
named clearly enough that I can spot a wrong match, with one tap to
apply or reject the change.
**Next action:** Tap **Approve** on a confidently-matched update
(e.g. "Mark *Book flights to Seoul* complete") to apply it; tap
**Reject** to ignore it; tap the entity title to launchpad into the
target if I want to verify in context first.

---

## Top three affordances

1. **An "Updates" group** in the dump-detail modal, visually distinct
   from the create groups (different icon, different verb in the row,
   different colour accent) — Cam never confuses *new thing* with
   *change to existing thing*.
2. **The matched entity is named in the row, with its current state
   beside the proposed new state** — "Book flights to Seoul: active
   → completed" — so a wrong match (right-shaped task on the wrong
   trip) is visible at a glance, before Cam taps Approve.
3. **One-tap Approve / Reject / Edit-and-approve**, mirroring the
   existing `suggested` row affordances. Approve applies the update,
   flashes the changed field on the entity row, and flips the item to
   `approved`. Reject leaves the entity untouched.

---

## Scope — what's in, what's out (first cut)

### In scope (Phase 1)

| Item type | Field | Direction | Rationale |
|---|---|---|---|
| `task_update` | `status` | `active` → `completed` | The headline use case. "I booked the flights." |
| `task_update` | `due_date` | any → any (or null) | Frequent in dumps: "moved to Tuesday." |
| `task_update` | `description` | append | Low-risk additive; preserves history. |
| `goal_update` | `target_date` | any → any (or null) | Cam's stated example: "going in October instead." |
| `goal_update` | `description` | append | Same low-risk additive shape. |
| `goal_update` | `status` | `active` → `completed` \| `cancelled` | Cam's explicit example: "decided to drop the gym membership goal." Both already supported by the schema. |
| `blocker_update` | `resolved` | `0` → `1` (with `resolved_at`) | "Nadia's visa came through." Already in the data model post-0004 migration. |
| `blocker_update` | `notes` | append | Same low-risk additive shape. |
| `person_update` | `notes` | append | "Talked to mum about the loan." |

### Out of scope (deferred, flagged for a follow-up phase)

- Status transitions other than the ones listed (no `active` →
  `waiting`/`someday`/`stalled` from a dump in v1; Cam can do those
  manually, and the LLM is more likely to misclassify them).
- Reverse transitions (`completed` → `active`, `cancelled` →
  `active`). If Cam meant to undo, he goes to the entity.
- Updates to `knowledge_items`. Knowledge items *are* notes; the dump
  pattern there is "create a new knowledge item," not "edit the old
  one."
- Updates to `tasks.title` or `goals.title`. Title rewrites from a
  dump are too high-risk-of-mismatch and Cam edits these inline on
  the entity surface anyway.
- Type changes (e.g. converting a `knowledge_item` into a `task`).
  Out of scope for this plan; surface separately if it earns its
  weight.
- Deleting / archiving from a dump. Disowning a *creation* lives in
  the unlink design; deleting an *existing* entity from a dump is a
  destructive action that should not live behind extraction
  inference. Hard out.

### What this plan deliberately does not do

It does not introduce a new `notes` column anywhere. Tasks already
have `description`; goals already have `description`; people and
blockers already have `notes`. We append to the existing free-text
fields. (Reed will weigh in on whether append should be plain
concatenation or structured — see open questions.)

---

## The LLM extraction shape

Each update item is a sibling of the existing item types in
`processed_items.items`. Same envelope (`type`, `data`, `confidence`,
`source_text`), new types and a new `data` shape.

### `task_update`

```json
{
  "type": "task_update",
  "data": {
    "task_id": 42,
    "task_title_at_extraction": "Book flights to Seoul",
    "field": "status",
    "current_value_at_extraction": "active",
    "new_value": "completed"
  },
  "confidence": 0.88,
  "source_text": "I booked the flights this morning"
}
```

For `field: "due_date"`: `new_value` is an ISO 8601 date string or
`null`. For `field: "description"`: `new_value` is the text to
append (the LLM proposes the appended snippet, not the merged final
value).

### `goal_update`

Same envelope, swapping `task_id` → `goal_id` and `task_title_at_extraction`
→ `goal_title_at_extraction`. Allowed `field` values: `status` (with
`new_value` ∈ {`completed`, `cancelled`}), `target_date`,
`description`.

### `blocker_update`

```json
{
  "type": "blocker_update",
  "data": {
    "blocker_id": 7,
    "blocker_label_at_extraction": "Nadia's D-4 visa pending",
    "field": "resolved",
    "new_value": true
  },
  "confidence": 0.90,
  "source_text": "Nadia's visa came through this morning"
}
```

`blocker_label_at_extraction` is a server-built label of the form
"`<blocker_type> blocker on <blocked_label>`" so the LLM (and Cam)
can disambiguate which row in `dependencies`. Vault decides the exact
label format; the contract is just that the LLM can echo something
human-recognisable back into the row.

For `field: "notes"`: `new_value` is the text to append.

### `person_update`

Same envelope. Allowed `field` values: `notes` only (append). The
schema field is `people.notes`.

### Why `*_at_extraction` echoed values

Two jobs:

1. **Cam's verification.** The dump-detail row reads "Book flights to
   Seoul: active → completed." If the LLM matched the wrong task,
   Cam sees the wrong title and rejects. This is the same trick the
   blockers and unlink designs use: the system narrates its match
   back to the user before committing.
2. **Drift detection at apply time.** When Cam approves, the apply
   helper recomputes the entity's *current* state and compares
   against `current_value_at_extraction`. If they disagree, return
   `409 conflict` with a clear reason — exactly the unlink-drift
   shape. (Cam may have ticked the task off in another tab between
   extraction and approval; we don't silently re-apply on top of his
   manual change.)

### Schema additions to the prompt's output schema

The extraction prompt's "Output schema" block (currently lists
`tasks`, `people_mentions`, `new_people`, `knowledge_items`,
`goal_links`, `new_goals`, `tags`) gains four arrays:
`task_updates`, `goal_updates`, `blocker_updates`, `person_updates`.
Vault converts these into `processed_items.items` entries with the
right `type` strings during the standard
"structured-JSON → processed_items" pass.

---

## How the LLM finds the right entity

Today's prompt already injects the active goals (id, title, status),
known people (id, name), and known tags (names) — see
`app/processing.py` around the `prompt = f"""You are an extraction
engine ..."""` block. Updates need *more* context, but only modestly
more.

### What gets added to the prompt's "Database context"

1. **Open tasks.** A list of `id`, `title`, `status`, `due_date`,
   `goal_id` for tasks where `status = 'active'`. Cap at the most
   recently-updated 50 (drop the cap if Cam reports the LLM missing
   matches; the prompt is already large). Tasks the dump might
   complete are by definition active.
2. **Active blockers.** From `dependencies WHERE resolved = 0`:
   `id`, a server-built label ("blocker on goal *Move to Seoul*"),
   and the source text from `notes` if any. Cap at 30.
3. **Recent goals.** Already there for `goal_link`; reused.
4. **Known people.** Already there for `person_mention`; reused.

### Matching policy

The LLM is asked to **only emit an update item when it can name the
exact entity from the lists above**. No fuzzy "probably the flight
booking task." If the dump says "I booked the flights" and there's no
matching task in the open-tasks list, the LLM emits *nothing* for the
update — not a low-confidence guess. (The dump might still produce a
new task or a knowledge item, but that's the existing extraction's
job.)

This matches the existing policy on `goal_link` and `person_mention`,
which only emit when an `id` from the context list is named.

### Confidence guidelines (added to the prompt)

- Explicit completion language + exact title match: 0.90–0.95
  ("I booked the flights" + a task titled "Book flights to Seoul").
- Explicit completion language + paraphrased title match: 0.80–0.85.
- Implicit completion ("flights are sorted") + exact title: 0.75.
- Date update with explicit new date: 0.85.
- Append-note items: 0.70 default; the bar is lower because they're
  additive.
- Below 0.50: don't emit (already the cross-cutting rule).

---

## Confidence and approval

### Iris's recommendation: **suggested-only for updates in v1**, regardless of confidence

Rationale, in order:

1. **Updates change existing state.** A wrong creation is a row Cam
   can unlink (per the just-shipped design). A wrong update has
   already mutated something he was relying on — a task he marked
   active is now suddenly completed, a goal's target date jumped
   without his consent. The blast radius is qualitatively different.
2. **The match-correctness risk is the new risk.** For creates, the
   LLM hallucinating a slightly wrong title produces a slightly
   wrong row, which Cam edits or unlinks. For updates, the LLM
   hallucinating the *target* of the change is silent damage to the
   right-shaped entity. The dialog must show the match before
   committing — auto-apply skips the dialog.
3. **Cam can gauge the LLM's match quality from the suggested
   queue.** First fortnight of real use will reveal whether the LLM
   matches reliably enough to trust auto-apply. If the false-match
   rate is genuinely zero on high-confidence items after that,
   relaxing to auto-apply at ≥0.90 is a one-line change.
4. **Cost of approving is low.** A tap. Cam already approves
   suggestions. The flow doesn't add a step *if you remember he was
   already going to scan the dump-detail modal anyway.*

So: every `*_update` item lands as `suggested` regardless of
confidence ≥0.50. Below 0.50, it's dropped. Same as today's create
items at the bottom of the threshold.

This is a **first-cut** decision. Open question for Cam below.

---

## The dump-detail UI

### Group placement

A new **"Updates"** group renders inside the dump-detail modal,
above the existing groups. Order from top:

1. **Updates** (new) — change-to-existing-thing
2. Tasks, Knowledge, People, Goals, Tags (creates) — new things
3. Failed / Rejected (existing tail)

Why above: the user-job order is "what does this dump mean for what
already exists, then what new things does it create." Cam will read
the modal top-down and dispatch the high-stakes decisions first.

Per Cam's just-saved newer-first guideline: within the Updates
group, items render in the order the LLM emitted them (which mirrors
their occurrence in the dump text — the natural reading order).
Status sub-ordering inside the group follows the established modal
convention: Suggested → Approved → Rejected → Failed.

### The update row

Each row carries:

```
[icon] Mark "Book flights to Seoul" complete       [Approve] [Reject]
       Task · active → completed · 88% match               [Edit]
       "I booked the flights this morning"           [open task ›]
```

Composition, top to bottom:
- **Verb-led title.** "Mark *Book flights to Seoul* complete." Not
  "Update task 42." The verb names what will happen if Cam approves.
- **Metadata strip.** Entity type · current → new · confidence. The
  arrow is the visual signature of an update.
- **Source quote.** Italicised, the exact `source_text`. Same as
  creates.
- **Actions.** Approve (primary), Reject (secondary), Edit (tertiary,
  opens an inline editor for `new_value`), Launchpad (`›`) into the
  entity.

### Visual differentiation from creates

Three layers:

1. **Icon.** Updates use a *pencil-on-card* glyph; creates use the
   existing *plus-card* glyph. Distinct silhouettes at a glance.
2. **Colour accent.** Updates carry a soft amber left-border (matching
   "this is a change in state"); creates keep the existing neutral.
   Approved updates flip to the existing approved-green; rejected to
   the existing rejected-grey.
3. **Verb in the title.** *"Mark X complete"*, *"Move X's date to
   Tuesday"*, *"Append note to mum"* — each row reads as an action
   sentence. Creates read as nouns ("New task: Book flights").

### On approve

1. Backend applies the update. The entity row in any open list
   refreshes (handlers already broadcast updated rows for tasks /
   goals / people).
2. The update item flips to `approved`. The matched entity row
   focus-flashes — the same flash already used after a successful
   inline edit elsewhere — so Cam *sees* the change land. (If the
   entity surface isn't open, this is a no-op; the dump-detail row's
   own state change is the confirmation.)
3. Drift case: if the entity's current state no longer matches
   `current_value_at_extraction`, the apply returns 409 and the row
   renders an inline error: "Cam already changed this — current
   state: completed. **Reject this suggestion?**" with a one-tap
   reject. No silent overwrite.

### On reject

Same as today: row flips to `rejected`. The existing un-reject
affordance restores it. No special behaviour for updates.

### On edit-and-approve

Inline editor on `new_value` only — no editing the matched entity.
For `status` updates, edit is a small select; for `due_date` /
`target_date`, a date picker; for append-note items, a textarea on
the snippet to append. Save → applies as if Cam had approved.

If Cam wants to change *which* entity is being targeted, that's a
reject + manual action on the right entity. We do not let Cam
re-target an update — too easy to compound the LLM's mismatch with
the user's mis-correction.

---

## Per-entity update vocabulary (consolidated)

| Entity | Field | Allowed transitions | Apply policy |
|---|---|---|---|
| `task` | `status` | `active` → `completed` | Set `status='completed'`, `completed_at=now()`. |
| `task` | `due_date` | any → any | Set `due_date`. `null` allowed. |
| `task` | `description` | append | `description = description ∥ separator ∥ new_value` (separator: see open questions). |
| `goal` | `status` | `active` → `completed` \| `cancelled` | Set `status`. `completed_at=now()` for `completed`. Schema already supports both; no migration needed. |
| `goal` | `target_date` | any → any | Set `target_date`. `null` allowed. |
| `goal` | `description` | append | Same as task description. |
| `blocker` | `resolved` | `0` → `1` | Set `resolved=1`, `resolved_at=now()`. The 0004 migration column. |
| `blocker` | `notes` | append | Same shape. |
| `person` | `notes` | append | Same shape. |

`updated_at` ticks for every change (already DEFAULT-driven, but
the apply helper sets it explicitly for clarity).

`knowledge_items`: not updatable from a dump in v1. (Reed may push
back on `note`-type knowledge being append-targets — open question
below.)

---

## Backend gaps

### Vault — LLM prompt

Add the four new output arrays (`task_updates`, `goal_updates`,
`blocker_updates`, `person_updates`) to the schema block. Add the
two new context lists (open tasks, active blockers) to the
"Database context" block. Add the matching policy and confidence
guidelines under the existing "Confidence scoring guidelines"
block. Add at least one example to the "Examples" section showing
a dump that triggers an update, so the LLM has a concrete pattern
to match.

### Vault — extraction translation

`processing.py`'s "structured JSON → processed_items.items" pass
gets four new branches that wrap each entry in the new arrays into
the standard item envelope (`type`, `data`, `confidence`,
`source_text`, `status='suggested'`).

### Vault — apply helpers

A new sibling to `_auto_create_item`: `_apply_item_update(conn,
item, dump_id)`. Per-type dispatch (`task_update`, `goal_update`,
`blocker_update`, `person_update`). Each branch:

1. SELECTs the current entity state, compares against
   `current_value_at_extraction`. Mismatch → raise a
   `UpdateDriftDetected` exception the caller surfaces as 409.
2. Validates the proposed transition is in the allow-list for that
   field.
3. Executes the UPDATE. Sets `updated_at`.
4. Returns `True` on success, raises on failure.

In `_auto_create_item` itself, the dispatcher's else-branch keeps
its existing `UnknownItemType` raise; updates do **not** route
through `_auto_create_item`. Keeping the create / update apply
paths separate is cleaner than overloading one function with two
responsibilities.

### Vault — `handle_approve_item`

Today's flow: SELECT the dump row → find the item by
`item_index` → call `_auto_create_item` → mark `approved`. New
flow: same lookup, but if `item['type']` ends in `_update`, route
to `_apply_item_update` instead. Drift conflict → 409 with
`{"error": "drift", "current_value": "...", "expected_value":
"..."}` so the frontend can render the drift dialog from §"On
approve" above. Reject and unreject paths: noop on the entity (an
update item doesn't have a `created_id` to clear); only the item's
own status changes.

### Vault — worker auto-apply path

Update items never auto-apply in v1 (per the threshold decision
above). The worker writes them as `suggested` regardless of
confidence ≥0.50, drops below 0.50. The
`status = "auto_created" if conf >= 0.80 else "suggested"` line
that lives at the top of every create branch in `processing.py`
is **not** copied to the update branches.

### Reed — schema

Verify-only pass. The findings I expect:

- `tasks.status` allows `cancelled`. Confirmed in the live DB.
- `goals.status` allows `cancelled` and `completed`. Confirmed.
- `dependencies.resolved` and `dependencies.resolved_at` exist
  (post-0004). Confirmed.
- `people.notes` exists. Confirmed.
- `tasks.description`, `goals.description` exist. Confirmed.

Net: **no migration required.** Reed verifies and signs off; if
something I read wrong shifts that, Reed catches it.

### Contract updates

- `app/contracts/auto-create-item.md`: new section *"Update item
  types"* listing the four `*_update` types, their `data` shapes,
  the apply helper, the drift-detection rule, and the
  always-suggested rule for v1.
- `app/contracts/background-processing.md`: extends the prompt
  schema and the per-item-type list. The "How items become
  database rows" section gets an "Updates" subsection.

---

## Frontend gaps (Lumen)

1. **`renderItemRow` (or wherever item rows render in
   `app.js`)** gains an `update` variant. Verb-led title,
   `current → new` strip, source quote, the four actions.
2. **`renderDumpDetailGroups`** gains an "Updates" group at the
   top, with the established status-subgroup ordering inside.
3. **`_dumpDetailItemAction`** (the existing action dispatcher
   per the dump-detail design) takes the new action shapes
   (`approve`/`reject`/`edit-and-approve` on update items). The
   network call hits the same `POST
   /api/brain-dumps/<id>/approve-item` endpoint with the same
   `{item_index, action, payload?}` body shape.
4. **Drift dialog.** A small inline error block on the row, with
   the recompute → reject one-tap. No new modal.
5. **Focus-flash on the matched entity row** when the entity is
   visible in any open list. Reuses the existing flash class.
6. **Visual tokens.** Pencil-on-card icon SVG, amber-left-border
   class, verb-leading title text style. All in `styles.css`,
   tagged with the existing dump-detail block prefix.

---

## Risk and edge cases

### LLM matches the wrong entity

Mitigations, in layered order:

1. **Strict context-list matching** (LLM may only emit an update
   if it can name the entity by `id` from the prompt's context).
2. **Echoed title in the row** so Cam sees the match before
   approving.
3. **Suggested-only in v1** so no update lands without Cam's tap.

### Same dump processed twice (re-process)

The existing audit shape applies. `processed_items.items` is the
authority on what was emitted; re-processing replaces it. If the
old version had `approved` updates, those updates have already
landed on the entity — re-processing doesn't replay them. The new
items emitted by the re-process are themselves new
`suggested`-status update items; if Cam approves one and the
entity is already in the new state (because the previous approval
landed it there), drift detection catches it: the entity's
`current_value` matches `new_value`, not
`current_value_at_extraction`, and the apply returns 409 with a
clear "already in this state — reject?" Same row treatment as
above. No double-apply.

### Concurrent edits

The drift detection above is the answer for both
"Cam edited the entity in another tab" and "Cam approved another
suggestion that touched the same field." The 409 surfaces the
mismatch; Cam rejects and moves on.

### A Cam-approved update is wrong in retrospect

He goes to the entity surface and edits it. The dump's update
item stays `approved` as audit trail. **No "undo update from
dump" affordance in v1.** Iris's call: the symmetry argument with
unlink doesn't apply. Unlink is "the dump created this and the
dump is the right place to disown it." Updates are "the dump
suggested a change to a thing that exists outside the dump"; the
right place to undo is the thing's own surface, where every other
edit lives. Adding a v1 "reverse the update" path would build a
parallel undo lane that competes with the entity's own edit
controls, which violates *every surface is a launchpad* in spirit
— the entity surface is where edits live, not the dump-detail
modal.

If Cam disagrees, the alternative is a "Reverse this update"
action on `approved` update items that pushes the entity back to
`current_value_at_extraction`. Easy to add later if v1 reveals
the symmetric ask. Flagged in open questions.

### LLM emits an update for a field not in the allow-list

Apply helper rejects it as malformed at apply time (returns 400);
the row stays as `suggested` with an inline "this update isn't a
type Lifeplan applies — reject?" message. Same one-tap reject.
This is a guardrail against prompt-drift; if it fires often,
that's a prompt-tuning trigger, not a feature gap.

### Idempotent append-note

If Cam approves an append-note update twice (e.g. via re-process),
the same snippet would land twice. Mitigation: each append carries
an internal marker like `[from dump #137 on 2026-04-30]` (Vault's
exact format) that the apply helper checks for before appending.
If the marker is already present in the target field, return 409
"already appended." Cheap, content-safe.

---

## Phased rollout

| Phase | Owner | Output |
|---|---|---|
| **0** | Vault (drafting) → Cairn (sign-off) | Contract amendments to `auto-create-item.md` and `background-processing.md`. No code yet. |
| **1a** | Reed | Schema verification pass. Confirms zero-migration. Confirms (or pushes back on) per-field allow-lists. Confirms append separator. |
| **1b** | Vault | LLM prompt changes (new arrays, new context, examples), extraction translation, `_apply_item_update`, `handle_approve_item` extension, drift detection, the malformed-update guardrail. |
| **2** | Lumen | Update-row variant, Updates group, action wiring, drift dialog, focus-flash, visual tokens. |
| **3** | Probe | Regression: existing creates still create; existing approve/reject paths intact; new update paths apply correctly; drift returns 409 cleanly; idempotent append; below-threshold drop. Includes a manual scenario script for Cam to run on real dumps. |
| **4** | Iris | On-device pass on the iOS PWA. Verb-leading titles read right one-handed; the icon/colour distinction is legible at a glance; the drift dialog isn't a dead end. Punch-list back to Lumen. |

Phase 1a + 1b can run in parallel after Phase 0 if Reed's verify
finishes first; Lumen's Phase 2 needs Vault's Phase 1b shape
locked.

---

## Open product questions for Cam

These are calls only Cam can make. Three, low but non-zero given
the scope:

1. **Auto-apply at high confidence, or always-suggested in v1?**
   Iris recommends **always-suggested for v1**, with a planned
   re-evaluation after the first fortnight of real use. The
   alternative is `auto_apply if confidence >= 0.85`, which mirrors
   the create-side threshold but raises the blast radius of a wrong
   match. *Cam's call.*

2. **Append-note shape: plain concatenation or structured?** Two
   options:
   - **Plain concat.** `description = old_description + "\n\n" +
     new_value`. Simple. Reads naturally in the entity surface.
     Loses provenance unless we mark with a prefix like `[from
     dump #137]`.
   - **Structured.** A new linked `knowledge_items` row of
     `item_type='note'` with a soft link back to the entity
     (people, tasks, goals).
   Iris recommends **plain concat with a provenance prefix** (Reed
   to specify exact format) — simpler, single source of truth,
   matches where notes live today. *Cam + Reed call.*

3. **"Reverse this update" affordance on approved update items —
   ship in v1, or wait?** Iris recommends **wait**, on the basis
   that the entity surface is the right place for an edit-undo,
   not the dump-detail modal. If Cam disagrees from first
   principles, easy to add. *Cam's call.*

(Schema question — "do we need to add `cancelled` to goal status?"
— is **not** in this list because the live DB already supports it.
Reed confirms in Phase 1a.)

---

## Recommended dispatch order after sign-off

1. **Vault** — draft contract amendments (Phase 0).
2. **Cairn** — sign off the contract.
3. **Reed** — schema verification + per-field allow-list sanity
   (Phase 1a).
4. **Vault** — LLM prompt + extraction + `_apply_item_update` +
   `handle_approve_item` (Phase 1b).
5. **Lumen** — Updates group, update-row variant, drift dialog,
   visual tokens (Phase 2).
6. **Probe** — regression + manual scenarios (Phase 3).
7. **Iris** — on-device pass and punch-list (Phase 4).
