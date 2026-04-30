# Contract: braindump-updates

**Authors:** Vault (server + worker), supervised by Cairn
**Status:** accepted
**Last updated:** 2026-04-23
**Cairn approved 2026-04-30** — Vault unblocked for Phase 1b after Reed's Phase 1a verification. Five open questions resolved inline in §10; no substantive changes required to the body of the contract.

Spec for Iris's brain-dump-triggered-updates plan
([`docs/ux-design/2026-04-30-braindump-updates-plan.md`](../../docs/ux-design/2026-04-30-braindump-updates-plan.md)).
This is a sibling to [`auto-create-item.md`](./auto-create-item.md) — the
create path lives there, the **update / resolve / append-note** paths
live here. They share one HTTP surface
(`POST /api/brain-dumps/<id>/approve-item`) and one parser
(`_llm_response_to_items`); the dispatch inside is the carve-out.

The two contracts must be read together. Where the create contract's
invariants apply unchanged, this contract restates them in one line and
points at the source. Where this contract diverges, the divergence is
called out explicitly.

## Mount story

Not applicable. The new helpers (`_apply_item_update` and per-type
sub-helpers) are internal to `app/processing.py`; no HTTP surface, no
redirects, no URLs emitted. The privacy invariant from
[`background-processing.md`](./background-processing.md) (no user
content in logs) applies and is restated below.

The user-visible HTTP surface is the existing
`POST /api/brain-dumps/<id>/approve-item` (see "Approve handler
extension"). No new endpoints, no new routes.

## Why a separate file

`auto-create-item.md` is already ~700 lines covering create, retry,
unreject, and unlink. Folding the update path in would push it past
"one-page contract" into "reference manual." Update items have
materially different invariants (drift detection, no auto-apply, no
created entity) — easier to reason about side-by-side than woven in.
The two files cross-reference; neither is self-sufficient.

## What's in scope (Phase 1)

Per Iris's plan §"In scope (Phase 1)" and Cam's three product sign-offs
(2026-04-23):

- New per-item types: `task_update`, `goal_update`, `blocker_resolve`,
  `person_note_append`. *(Choice rationale below.)*
- LLM prompt extensions to extract them.
- Per-field allow-list, verified against `data/SCHEMA.md`.
- Apply path on `action='approve'` / `'edit_approve'`.
- Drift detection inside `BEGIN IMMEDIATE`.
- Reject path (status flip only, no DB write).
- Always-suggested in v1, regardless of confidence ≥ 0.50. No
  auto-apply branch.
- Append format for `notes` / `description` fields with provenance
  prefix.

## What's out of scope (Phase 1)

- Auto-apply at high confidence. Always suggested in v1; revisit after
  first fortnight of real-world false-match data. Iris's plan
  §"Confidence and approval" carries the rationale; Cam signed off.
- Reverse-this-update affordance. The entity surface is the right
  place for an edit-undo. Cam signed off.
- `knowledge_items` updates. Knowledge items *are* notes; if a dump
  augments knowledge it should land as a new `knowledge` create item,
  not an update. The LLM is told this in the prompt; a stray
  `knowledge_update` from prompt drift is dropped at parse time.
- `blocker_note_append`. Iris's plan listed it; Cairn ratified the
  drop for v1 per §10.3 (low-frequency append target; structural cost
  to add later is small). If first-fortnight real-world use shows
  Cam wanting to append to blocker notes via dump, Vault adds it as
  a follow-up — parallel shape to `person_note_append`.
- Status transitions other than `active → completed | cancelled`.
- Reverse transitions (`completed → active` etc.).
- `tasks.title` / `goals.title` rewrites.
- Type changes (e.g. converting a knowledge item into a task).
- `retry` on failed update items — see §6.

## 1. Item types and shapes

### Decision: per-entity types, not unified `item_update`

Iris's plan proposed per-entity types (`task_update`, `goal_update`,
`blocker_update`, `person_update`). Vault considered a unified
`item_update` with a `target_type` discriminator. **Decision:
per-entity types**, with two refinements from Iris's draft:

- Blocker updates collapse to a single resolve-only type
  `blocker_resolve` (the only blocker mutation v1 supports beyond
  notes; making it its own type makes the constraint structural rather
  than a prompt-time hope).
- Person updates collapse to `person_note_append` (the only person
  mutation v1 supports). Same rationale.

**Rationale for per-entity over unified.** Each branch of
`_apply_item_update` reads cleaner when the type IS the dispatch key
(matches `_auto_create_item`'s existing pattern). The unified shape
forces every branch to read `item["data"]["target_type"]` then
re-dispatch, which is one indirection more for zero readability gain.
The LLM also produces cleaner few-shot examples when the type is
literal in the JSON. *Open question for Cairn — see §10.*

### Envelope (unchanged from create items)

Each update item is an entry in `processed_items.items` with the
existing four-key envelope:

```jsonc
{
  "type": "task_update" | "goal_update" | "blocker_resolve" | "person_note_append",
  "data": { /* type-specific, see below */ },
  "confidence": 0.0–1.0,
  "source_text": "<exact substring from the dump>",
  "status": "suggested",   // always — see §3
  "created_id": null        // populated to target_entity_id on approve, see §4
}
```

### `task_update`

```jsonc
{
  "type": "task_update",
  "data": {
    "task_id": 42,
    "task_title_at_extraction": "Book flights to Seoul",
    "field": "status" | "due_date" | "description",
    "current_value_at_extraction": "active" | "<ISO date>" | null,
    "new_value": "completed" | "cancelled" | "<ISO date>" | null | "<append text>"
  },
  "confidence": 0.88,
  "source_text": "I booked the flights this morning",
  "status": "suggested",
  "created_id": null
}
```

- `field == "status"`: `new_value ∈ {"completed", "cancelled"}`. No
  other status transitions accepted from a dump (see §2).
- `field == "due_date"`: `new_value` is an ISO 8601 date or `null`.
- `field == "description"`: `new_value` is the snippet to **append**
  (the LLM proposes the snippet, not the merged final value). Apply
  helper does the merge per §4.

### `goal_update`

Same envelope, swapping `task_id → goal_id` and
`task_title_at_extraction → goal_title_at_extraction`. Allowed
`field`:

- `"status"` with `new_value ∈ {"completed", "cancelled"}`.
- `"target_date"` with ISO 8601 string or `null`.
- `"description"` with snippet-to-append.

### `blocker_resolve`

```jsonc
{
  "type": "blocker_resolve",
  "data": {
    "blocker_id": 7,
    "blocker_label_at_extraction": "task blocker on goal Move to Seoul",
    "current_resolved_at_extraction": 0,
    "resolved": true
  },
  "confidence": 0.90,
  "source_text": "Nadia's visa came through this morning",
  "status": "suggested",
  "created_id": null
}
```

`blocker_label_at_extraction` is a server-built label of the form
`"<blocker_type> blocker on <blocked_type> <blocked_label>"` (e.g.
`"external_system blocker on goal Move to Seoul"`) — composed in the
prompt builder when the active-blockers list is injected. The label
is what Cam reads in the dump-detail row to verify the match; the LLM
just echoes it back.

The type is **resolve-only**. There is no `blocker_unresolve`,
no `blocker_note_append` in v1. Note appends on blockers are deferred
— if Cam reports needing them in real use, add `blocker_note_append`
in a follow-up; the structural cost is small. *Iris's plan listed
`blocker_update.notes` as in-scope; Vault collapsed it out for v1
because (a) the dispatch text from Cam reads the four shapes
explicitly without `blocker_note_append`, and (b) blocker notes are
the lowest-frequency append target. Flagged for Cairn — see §10.*

### `person_note_append`

```jsonc
{
  "type": "person_note_append",
  "data": {
    "person_id": 12,
    "person_name_at_extraction": "Mum",
    "note_text": "she wants the loan repaid by August"
  },
  "confidence": 0.75,
  "source_text": "talked to mum, she wants the loan back by August",
  "status": "suggested",
  "created_id": null
}
```

Plain-concat semantics with provenance prefix — see §4. Explicit shape
because the apply path is unambiguously "append to `people.notes`."

### Why `*_at_extraction` echoed values

Two jobs (mirrors Iris's plan §"Why `*_at_extraction` echoed values"):

1. **Cam's verification.** The dump-detail row narrates the match
   ("Book flights to Seoul: active → completed"). Wrong match → wrong
   title visible → reject before approve.
2. **Drift detection at apply time.** Apply helper reads the entity's
   current state inside `BEGIN IMMEDIATE` and compares against the
   `current_*_at_extraction` field. Mismatch → 409 with the entity's
   actual current value.

## 2. Per-field allow-list (verified against `data/SCHEMA.md`)

Every field below was checked in `data/SCHEMA.md` on 2026-04-23. No
migration needed.

| Entity (table) | Field column | Allowed transitions | Schema confirmation |
|---|---|---|---|
| `task` (`tasks`) | `status` | `active → completed`, `active → cancelled` | `tasks.status` CHECK includes `completed` and `cancelled` (SCHEMA.md §tasks) |
| `task` (`tasks`) | `due_date` | any → any (or `null`) | `tasks.due_date` is nullable TEXT |
| `task` (`tasks`) | `description` | append (snippet) | `tasks.description` is nullable TEXT |
| `goal` (`goals`) | `status` | `active → completed`, `active → cancelled` | `goals.status` CHECK includes `completed` and `cancelled` (SCHEMA.md §goals) |
| `goal` (`goals`) | `target_date` | any → any (or `null`) | `goals.target_date` is nullable TEXT |
| `goal` (`goals`) | `description` | append (snippet) | `goals.description` is nullable TEXT |
| `blocker` (`dependencies`) | `resolved` | `0 → 1` (always with `resolved_at = datetime('now')`) | `dependencies.resolved` (INTEGER), `dependencies.resolved_at` (nullable TEXT) — both present post-migration 0004 (SCHEMA.md §dependencies) |
| `person` (`people`) | `notes` | append (snippet) | `people.notes` is nullable TEXT |

**`description` vs `notes`.** Iris's plan and Cam's dispatch text use
"notes" generically, but the live schema names the append target
**`description`** on tasks and goals, and **`notes`** on people and
dependencies. The contract follows the schema column names, not the
generic prose. Apply helpers UPDATE the column the schema actually has
— no schema-rename needed. The LLM prompt frames both as "append to
the entity's free-text field" so the model doesn't have to track the
column name.

**Rendering-vs-storage gap (note for Lumen).** The wire/contract uses
the schema column name (`description` for tasks and goals). The
user-facing label in the dump-detail row should still read "Notes" /
"Note appended" — Cam's mental model is "notes," and the schema name
is an implementation detail. The translation lives in Lumen's row
renderer, not in the wire shape. Concretely: a `task_update` with
`field: "description"` renders as "Append note to *Book flights to
Seoul*" in the row title, not "Append description to ..."

**`tasks.completed_at` / `goals.completed_at`.** When `field=status`
transitions to `completed`, the apply helper ALSO sets
`completed_at = datetime('now')`. Schema convention; restated for
clarity. For `cancelled`, `completed_at` stays NULL (cancellation is
not completion).

**`dependencies.resolved_at`.** Set to `datetime('now')` in the same
UPDATE that flips `resolved = 1`. Same pattern as the existing
`PUT /api/blockers/<id>` resolve path
([`blockers.md`](./blockers.md)).

**`updated_at`.** Set explicitly to `datetime('now')` in every apply
UPDATE for clarity, even though the schema's DEFAULT would catch it
on insert (it's not auto-bumped on UPDATE in SQLite — same
hand-bumped pattern as elsewhere).

**Knowledge: NO updates.** If the LLM emits a `knowledge_update`
(prompt drift), the parser drops it silently and emits a
`processing.update.knowledge_drop` log line. Knowledge items are
notes — appending to one is the same operational shape as creating a
new note, and the create path already handles that.

**Fields the schema doesn't yet support:** none. Everything in §1 maps
to an existing column.

## 3. Confidence thresholds

Per Cam's signoff (Iris's plan §"Confidence and approval"):

| Confidence | Action |
|---|---|
| < 0.50 | **Discarded at extraction time.** The parser drops it before it ever lands in `processed_items.items`. Same threshold cross-cutting policy as today's create items. |
| ≥ 0.50 | **`status = "suggested"` always.** No threshold-driven auto-apply branch for update items. |

**No auto-apply for update items, regardless of confidence.** This is
deliberate and structural, not a tuning parameter:

- The blast radius of a wrong update is qualitatively different from a
  wrong create (Iris's plan §"Confidence and approval" rationale 1–2).
- The match-correctness risk is the new risk. Auto-apply skips the
  dialog that surfaces the match.
- First-fortnight false-match data informs whether `≥ 0.90` ever
  earns auto-apply. *Not in v1.*

The line in `_llm_response_to_items` that reads
`status = "auto_created" if conf >= 0.80 else "suggested"` for create
branches is **NOT** copied into the update branches. Update branches
unconditionally write `status = "suggested"` for every item that
clears the 0.50 floor.

## 4. Apply path on approve

Same HTTP surface, same `action: 'approve'` (and `'edit_approve'`). The
existing `handle_approve_item` adds a type-discriminator branch BEFORE
calling `_auto_create_item`. New helper `_apply_item_update` owns the
update path; `_auto_create_item` is unchanged.

### Dispatch in `handle_approve_item`

```python
# Inside the existing approve / edit_approve arm, after the
# `suggested`-precondition check and the optional edit_data merge.
itype = item["type"]
if itype in ("task_update", "goal_update",
             "blocker_resolve", "person_note_append"):
    try:
        target_id = _apply_item_update(conn, item, dump_id)
    except UpdateDrift as drift:
        return 409, {
            "error": "drift",
            "field": drift.field,
            "expected_value": drift.expected,
            "current_value": drift.current,
        }
    except UpdateTargetMissing:
        return 404, {"error": "target entity no longer exists"}
    item["created_id"] = target_id
    item["status"] = "approved"
    if "error" in item:
        item["error"] = None
else:
    # existing create dispatch via _auto_create_item — unchanged
    ...
```

### `_apply_item_update` contract

```python
def _apply_item_update(conn, item, dump_id) -> int:
    """Apply one update / resolve / append item to its target entity.

    Args:
        conn: sqlite3.Connection. Must be inside a BEGIN IMMEDIATE
            owned by the caller (handle_approve_item opens it before
            this call). Caller commits.
        item: one entry from processed_items["items"], type in
            {task_update, goal_update, blocker_resolve, person_note_append}.
        dump_id: the parent brain_dumps.id, for logging and the
            provenance prefix on appends.

    Returns:
        The target entity's id (== item["data"]["task_id"] /
        "goal_id" / "blocker_id" / "person_id"). The caller writes this
        into item["created_id"] for symmetry with the create path's
        provenance.

    Raises:
        UpdateTargetMissing: target entity row not found.
        UpdateDrift: target's current value of the field doesn't match
            current_*_at_extraction. Carries field, expected, current.
        UpdateMalformed: data shape rejects the allow-list (e.g. a
            field name not in §2). Caught by the caller as a 400; the
            item stays `suggested` with an inline error per Iris's
            "malformed-update guardrail" in the plan.
        UnknownItemType: item["type"] is not one of the four. Caller
            propagates per existing 500-with-class-name pattern.
        sqlite3.Error: DB-level failure. Caller propagates (matches
            the existing approve-handler flow; not silently swallowed
            here because the IMMEDIATE transaction needs to roll back).
    """
```

Side-effect semantics match `_auto_create_item`: writes only to the
open connection, does NOT commit, no network I/O.

### `BEGIN IMMEDIATE` ownership

The caller (`handle_approve_item`) opens `BEGIN IMMEDIATE` BEFORE
calling `_apply_item_update`. This matches the existing `unlink`
arm's pattern (`processing.py:2967-2972`). Inside the immediate
transaction:

1. SELECT current state of the target field.
2. Compare to `current_*_at_extraction`. Mismatch → raise
   `UpdateDrift`; caller rolls back and 409s.
3. Validate the proposed transition is in the §2 allow-list. Out of
   allow-list → raise `UpdateMalformed`; caller rolls back and 400s.
4. Execute the UPDATE. Set `updated_at = datetime('now')`.
5. Return the target id.

The caller commits on success, rolls back on raise.

### Per-type SQL (drift recompute + apply, both inside `BEGIN IMMEDIATE`)

#### `task_update`, field=status

```sql
-- recompute
SELECT status FROM tasks WHERE id = :task_id;
-- compare to current_value_at_extraction; raise UpdateDrift on mismatch
-- apply (new_value ∈ completed|cancelled):
UPDATE tasks
   SET status       = :new_value,
       completed_at = CASE WHEN :new_value = 'completed'
                           THEN datetime('now') ELSE completed_at END,
       updated_at   = datetime('now')
 WHERE id = :task_id;
```

#### `task_update`, field=due_date

```sql
SELECT due_date FROM tasks WHERE id = :task_id;
-- drift compare on due_date string equality (NULL == NULL handled
-- explicitly in Python; SQL is just the read)
UPDATE tasks
   SET due_date   = :new_value,
       updated_at = datetime('now')
 WHERE id = :task_id;
```

#### `task_update`, field=description (append) and `goal_update` field=description

```sql
SELECT description FROM tasks WHERE id = :task_id;
-- (no drift compare on append: the previous description is not echoed
--  at extraction; we're adding to whatever's there, see §below)
UPDATE tasks
   SET description = :merged,        -- merged in Python per §append-format
       updated_at  = datetime('now')
 WHERE id = :task_id;
```

#### `goal_update`, field=status / target_date

Mirrors task_update. Table `goals`, key `goal_id`. `completed_at`
hand-set on `status='completed'`, untouched on `cancelled`.

#### `blocker_resolve`

```sql
SELECT resolved FROM dependencies WHERE id = :blocker_id;
-- compare against current_resolved_at_extraction (always 0)
UPDATE dependencies
   SET resolved    = 1,
       resolved_at = datetime('now')
 WHERE id = :blocker_id;
```

(Note: `dependencies` doesn't have an `updated_at` column per the
schema; nothing to bump. Resolved-pair semantics from
`blockers.md` apply.)

#### `person_note_append`

```sql
SELECT notes FROM people WHERE id = :person_id;
UPDATE people
   SET notes      = :merged,
       updated_at = datetime('now')
 WHERE id = :person_id;
```

### Drift-comparison rules (applied in Python after the SELECT)

For non-append fields:

- Strings (`status`): exact equality. NULL never expected here (the
  schema requires `status NOT NULL`), so a NULL read is a
  programming-error shape and raises rather than 409.
- ISO dates (`due_date`, `target_date`): string equality after
  trimming. `null == null` is a match (no drift).
- Booleans (`resolved`): integer equality (`0 == 0`).

For append fields (`description`, `notes`):

**No drift comparison.** Appends are additive and idempotent on the
*snippet*, not the *whole field*. We do not echo the existing
`description` / `notes` at extraction time (the LLM doesn't need it
and including it bloats the prompt). The idempotency check is the
provenance prefix:

> If the merged target already contains the literal substring
> `"[from dump #<dump_id>]"` (case-sensitive, exact bracket match), the
> apply helper rejects with `UpdateDrift(field="<field>",
> expected="not yet appended", current="already appended")` → 409.
> Re-process safety per Iris's plan §"Idempotent append-note."

This protects against the re-process-the-same-dump scenario without
needing to round-trip the LLM-extracted snippet against the entity's
existing text.

### Append format (the load-bearing detail)

Per Cam's signoff: **plain concat with provenance prefix**, **newer
first**.

```python
merged = f"[from dump #{dump_id}] {note_text}\n{existing or ''}".rstrip()
```

Worked example, `dump_id=137`, `existing="prefers texts to calls"`,
`note_text="wants the loan back by August"`:

```
[from dump #137] wants the loan back by August
prefers texts to calls
```

Rules:

- Prefix is literal `[from dump #<dump_id>] ` (single space after the
  closing bracket). No date, no item index, no timestamp. The dump's
  own `captured_at` is one click away via the dump-detail launchpad.
- Separator between new and old is a single `\n`. Not `\n\n` — Cam's
  notes fields are short-form, double-newline produces visible blank
  lines that read poorly in the people detail strip.
- `existing == None` and `existing == ""` both produce the same
  trailing-strip result.
- Newer-first matches Cam's just-saved guideline (Iris's plan
  §"Group placement" referenced it).
- The same exact format is used for `tasks.description`,
  `goals.description`, `people.notes`, and (if added in a follow-up)
  `dependencies.notes`.

### On apply success

- `item["created_id"] = <target_entity_id>` — mirrors the create
  path's "id of the row this item now points at." For updates this is
  the entity that was modified, NOT a newly created row. The
  semantics are "the dump item is bound to this entity" rather than
  "the dump item created this entity."
- `item["status"] = "approved"`. **Never `auto_created`.** Nothing
  was created — `auto_created` would mislead any future audit.
- Worker auto-apply path doesn't exist for update items (see §3), so
  there's no symmetric `auto_created` path to worry about. All
  update-item approvals come through `handle_approve_item` and land
  on `approved`.
- `item["error"] = None` cleared if previously set.

### Failure modes

| Failure | Helper raises | Caller responds | Item state after |
|---|---|---|---|
| Target entity row deleted between extraction and approve | `UpdateTargetMissing` | 404 `{"error": "target entity no longer exists"}` | unchanged (`suggested`) — Cam can reject |
| Field's current value drifted (manual edit, prior dump approval, etc.) | `UpdateDrift(field, expected, current)` | 409 `{"error": "drift", "field": …, "expected_value": …, "current_value": …}` | unchanged (`suggested`) — UI re-prompts per Iris's plan §"On approve" |
| Append already landed (provenance prefix already present) | `UpdateDrift(field, "not yet appended", "already appended")` | 409 same shape | unchanged (`suggested`) |
| Field not in §2 allow-list (prompt drift) | `UpdateMalformed` | 400 `{"error": "field not updatable", "field": …}` | unchanged (`suggested`) — Cam rejects via the inline guardrail per Iris's plan |
| `sqlite3.OperationalError` / `IntegrityError` | propagated | 500 generic per existing pattern | unchanged (`suggested`) |
| Unknown item type (parser bug) | `UnknownItemType` | 500 `{"error": "internal error: UnknownItemType"}` per existing pattern | unchanged |

The HTTP body shape on 409 / 404 is new — the create path doesn't
have these. Lumen reads `error`, `field`, `expected_value`,
`current_value` to render the drift dialog inline on the row per
Iris's plan §"On approve."

## 5. Reject path

`action: 'reject'` on an update / resolve / append item: same as
today's reject on a create item. Status flips to `rejected`. **No DB
write to the target entity.** The matched entity is untouched.

`unreject` semantics from `auto-create-item.md` carry over unchanged:
`rejected → suggested`, no DB row to clear (`created_id` was already
set on prior approval, but for an `unreject` we're going from
`rejected` not `approved`, so this point is moot — `created_id` stays
whatever it was, which is `null` for a never-approved item).

## 6. Retry / Edit-and-approve

### `retry`

**Not applicable to update items in v1.**

The create-side `retry` exists because `_auto_create_item` can return
`None` (failed create with no row). The update-side
`_apply_item_update` does not have a `failed` terminal state by
design — every apply outcome is `approved` (success), `409 drift` /
`404 missing` (item stays `suggested`), or `500` (transient,
retry-via-reload). There is no failure shape that leaves the item in
a state where `retry` would do something different from approve.

If `action = "retry"` arrives on an update item with `status =
"failed"` (which it shouldn't, per the design): the existing
precondition check (`if item.get("status") != "failed": return 409`)
already gates this. The apply path is never invoked because the
contract says no update item ever lands in `failed`.

Documented as out-of-scope; no handler change required.

### `edit_approve`

Works identically to the create-side `edit_approve`. The user edits
the proposed `new_value` (or `note_text`, or any field in `data`)
before approving. The edit_data goes into `item["data"]`:

```python
if edit_data:
    item["data"].update(edit_data)
```

Critically: **edit_data modifies the proposal, not the target
entity.** Editing `new_value` from `"completed"` to `"cancelled"`
changes what the apply helper will write. Editing `task_id` is
permitted by this mechanism but UI-side disabled per Iris's plan
§"On edit-and-approve" ("we do not let Cam re-target an update").
The contract permits the field; the UI declines to expose it. This
is consistent with how create-side `edit_approve` permits arbitrary
data edits without the UI exposing all of them.

For append-note items, `edit_data.note_text` is the editable surface.

The drift recompute and allow-list validation in §4 apply post-edit;
an edit that takes `field` out of the allow-list produces
`UpdateMalformed` → 400.

## 7. LLM prompt extension

Vault implements in Phase 1b. The contract-level shape:

### Database context additions

The existing `prompt = f"""..."""` block (`processing.py:1109+`)
already injects `goals_list`, `people_list`, `tags_list`. Updates need
two more, both server-built before prompt assembly:

1. **Open tasks list.** From `tasks WHERE status = 'active'`, columns
   `id, title, status, due_date, goal_id`. Cap at the 50
   most-recently-updated rows (cap revisited if Cam reports the LLM
   missing matches; the prompt is already large).
2. **Active blockers list.** From `dependencies WHERE resolved = 0`,
   columns `id, blocker_type, blocked_type, blocked_id, notes`. The
   prompt builder composes `blocker_label` for each row (per §1) so
   the LLM has a human-recognisable string to echo back. Cap at 30.

Verified against `processing.py`: open tasks and active blockers are
**not** currently in the prompt context (only goals, people, tags).
Phase 1b adds them.

### Output schema additions

The existing output JSON schema (`tasks`, `people_mentions`,
`new_people`, `knowledge_items`, `goal_links`, `new_goals`, `tags`)
gains four arrays mirroring the four item types:

- `task_updates: [{task_id, task_title_at_extraction, field, current_value_at_extraction, new_value, confidence, source_text}, …]`
- `goal_updates: [{goal_id, goal_title_at_extraction, field, current_value_at_extraction, new_value, confidence, source_text}, …]`
- `blocker_resolves: [{blocker_id, blocker_label_at_extraction, current_resolved_at_extraction, resolved, confidence, source_text}, …]`
- `person_note_appends: [{person_id, person_name_at_extraction, note_text, confidence, source_text}, …]`

The parser (`_llm_response_to_items`) gains four new branches that
wrap each entry into the standard envelope. Each branch:

- Maps the LLM's flat fields into `item["data"]`.
- Sets `status = "suggested"` unconditionally if `confidence >= 0.50`,
  else drops the entry (parser-level filter; doesn't even hit the
  items list).
- Sets `created_id = None`.

### Matching policy (added to the prompt)

The LLM may emit an update item **only when it can name the exact
target entity by `id` from the prompt's context lists.** No fuzzy
matches. If the dump implies an update to a task that's not in the
open-tasks list, the LLM emits *nothing* for the update — not a
low-confidence guess. (The dump may still produce a new task or a
knowledge item; that's the existing extraction's job.)

This matches the existing policy on `goal_link` and `person_mention`
(restated for the LLM in the new section).

### Confidence guidelines (added to the prompt)

- Explicit completion language + exact title match: 0.90–0.95.
- Explicit completion language + paraphrased title match: 0.80–0.85.
- Implicit completion ("flights are sorted") + exact title: 0.75.
- Date update with explicit new date: 0.85.
- Append-note items: 0.70 default (lower because additive).
- Below 0.50: don't emit (cross-cutting rule).

### Few-shot examples

Phase 1b adds at least four examples, one per type:

1. **`task_update` → status completed.** Dump: "I booked the flights
   this morning." Open tasks include `{id: 42, title: "Book flights
   to Seoul", status: "active"}`. Output extracts a `task_update`
   entry, `field=status`, `new_value=completed`, conf 0.92.
2. **`goal_update` → target_date.** Dump: "moved the Seoul trip to
   October instead of August." Goals include `{id: 3, title: "Move
   to Seoul", target_date: "2026-08-01"}`. Output extracts a
   `goal_update`, `field=target_date`, `new_value="2026-10-01"`,
   conf 0.85.
3. **`blocker_resolve`.** Dump: "Nadia's visa came through this
   morning." Active blockers include `{id: 7, label: "external_system
   blocker on goal Move to Seoul", notes: "D-4 visa pending"}`.
   Output: a `blocker_resolves` entry, `resolved: true`, conf 0.90.
4. **`person_note_append`.** Dump: "talked to mum, she wants the
   loan back by August." Known people include `{id: 12, name: "Mum"}`.
   Output: a `person_note_appends` entry,
   `note_text: "she wants the loan back by August"`, conf 0.75.

Examples placed alongside the existing few-shot block (whatever its
current location post-Phase-1b refactor — Vault places them in the
"Examples" section of the prompt).

## 8. Drift recompute SQL

Listed inline in §4 per type. Restated here as a checklist for
Phase 1b implementation:

| Type | SELECT (drift recompute) | Compared against |
|---|---|---|
| `task_update` field=status | `SELECT status FROM tasks WHERE id = :task_id` | `data["current_value_at_extraction"]` |
| `task_update` field=due_date | `SELECT due_date FROM tasks WHERE id = :task_id` | `data["current_value_at_extraction"]` |
| `task_update` field=description | n/a (append; idempotency by provenance prefix scan) | provenance prefix substring on the read |
| `goal_update` field=status | `SELECT status FROM goals WHERE id = :goal_id` | `data["current_value_at_extraction"]` |
| `goal_update` field=target_date | `SELECT target_date FROM goals WHERE id = :goal_id` | `data["current_value_at_extraction"]` |
| `goal_update` field=description | n/a (append) | provenance prefix substring |
| `blocker_resolve` | `SELECT resolved FROM dependencies WHERE id = :blocker_id` | `data["current_resolved_at_extraction"]` (always `0`) |
| `person_note_append` | n/a (append) | provenance prefix substring |

Target-missing check is a separate `SELECT 1 FROM <table> WHERE id =
:id` BEFORE the drift recompute; if no row, raise
`UpdateTargetMissing` → 404.

In practice the drift SELECT and the target-missing check fold into
one query — if the SELECT returns no row, the target is missing; if
it returns a row whose value disagrees, drift.

## 9. Provenance and audit

- **`item["created_id"]`**: target entity id on success. (Reuses the
  existing field; semantics extended to "the entity bound to this
  item," covering both create-and-bind and update-and-bind cases.)
- **`item["data"]`**: the LLM-extracted payload, including
  `*_title_at_extraction` / `*_label_at_extraction` /
  `*_name_at_extraction`. Future audit can answer "what title did the
  LLM see when it matched?" without round-tripping the entity (which
  may have since been renamed).
- **Provenance prefix in append fields**: `[from dump #<dump_id>]
  <text>` is the audit trail in the entity's own free-text. Greppable
  from the entity surface; survives entity rename / re-process /
  manual edit.
- **No new audit table.** `processed_items.items[*]` and the entity's
  `updated_at` jointly cover the audit trail. Adding a dedicated
  audit log is out of scope for this contract; if Cairn wants one it
  attaches as a separate dispatch.

### Logging contract

Two new events on the `lifeplan.worker` (extraction-time) and
`lifeplan.processing` (apply-time) loggers:

| Event | Level | Logger | Fields | When |
|---|---|---|---|---|
| `processing.update.matched` | INFO | `lifeplan.worker` | `dump_id`, `item_index`, `item_type`, `target_id`, `field` (omitted for `blocker_resolve` and `person_note_append` — implicit) | Each update item the parser writes into `processed_items.items` post-extraction |
| `processing.update.applied` | INFO | `lifeplan.processing` | `dump_id`, `item_index`, `item_type`, `target_id`, `field` | `_apply_item_update` returned successfully |
| `processing.update.drift` | WARNING | `lifeplan.processing` | `dump_id`, `item_index`, `item_type`, `target_id`, `field`, `reason` (`value_mismatch` \| `already_appended` \| `target_missing`) | `UpdateDrift` or `UpdateTargetMissing` raised; caller about to 409/404 |
| `processing.update.malformed` | WARNING | `lifeplan.processing` | `dump_id`, `item_index`, `item_type`, `field`, `reason` | `UpdateMalformed` raised (field not in allow-list) |
| `processing.update.knowledge_drop` | INFO | `lifeplan.worker` | `dump_id` | Parser dropped a `knowledge_update` entry from prompt drift |

**Privacy invariant from `background-processing.md` applies
unchanged.** Fields above are all integer ids or static enum-shaped
strings (`item_type` is one of four literals; `field` is one of the
§2 column names; `reason` is one of the listed enum values). **Never
the `new_value` content. Never `note_text`. Never the entity's
`description` / `notes`.** A WARNING-level drift event reveals "Cam
has a task #42 whose status was 'completed' when an update tried to
set it to 'completed'" — that's id-and-enum, no user content.

## 10. Open questions for Cairn — resolved 2026-04-30

Five questions, with Cairn's decision on each.

1. **Per-entity types vs unified `item_update`.** **DECISION:
   ratified — per-entity types.** The type-as-dispatch-key pattern
   matches `_auto_create_item` exactly; reading the two helpers
   side-by-side is part of the workflow and consistency wins. Unified
   shape would force every branch through `data["target_type"]`
   indirection for zero readability gain and makes the few-shot
   examples noisier. Per-entity it is.

2. **Separate file vs extending `auto-create-item.md`.** **DECISION:
   ratified — separate file.** `auto-create-item.md` is already 700
   lines spanning create / retry / unreject / unlink. Folding update
   semantics in pushes it past the one-page contract threshold into
   reference-manual territory. Update-path invariants (drift, no
   auto-apply, no created entity) are materially different from
   create-path invariants and easier to reason about side-by-side
   than woven in. Cross-references at the top of each file are
   sufficient; readers land on the right one from Iris's plan.

3. **`blocker_note_append` collapse.** **DECISION: ratified — drop
   it for v1.** Vault's two reasons hold: Cam's dispatch text reads
   four explicit shapes, and blocker notes are the lowest-frequency
   append target in real use. The structural cost of adding it later
   is small (one type, one prompt example, one apply branch — all
   parallel to `person_note_append`). If first-fortnight real-world
   use shows Cam wanting to append to blocker notes via dump,
   Vault adds it as a follow-up; until then YAGNI. Logged as a known
   deferred item in §"What's out of scope (Phase 1)" — Vault: extend
   the existing `blocker_resolve` bullet there to also note "and
   `blocker_note_append`, deferred per §10.3" so future readers find
   the trail.

4. **Drift body shape on 409.** **DECISION: keep distinct.**
   The two surfaces carry different signals:
   - **Unlink drift** (`auto-create-item.md`): "the heuristic's verdict
     changed between preview and confirm." The body answers *which
     path now and why* (`new_path`, `reasons`).
   - **Update drift** (this contract): "this specific field's value
     changed between extraction and approve." The body answers *which
     field, expected what, found what* (`field`, `expected_value`,
     `current_value`).

   Normalising to one shape would either lose the field-level signal
   the update UI needs to render the per-row inline error, or bloat
   the unlink shape with empty `field`/`expected_value` slots that
   never carry meaning. The shared invariant is the **HTTP signal**
   (409 = "the state you assumed has shifted"), not the body shape.
   Cairn's note for future contracts: when you add a third drift-shaped
   surface, copy *the conceptual contract* (409 + body that names
   what shifted) — not the literal field names of either existing
   case. Each surface speaks its own language; the practice is the
   shared shape, not the shared schema.

5. **Prompt context cap on open tasks.** **DECISION: ratified — 50
   most-recently-updated active tasks.** Reasoning: Cam's active-task
   count today sits in the low-double-digits; 50 covers all of it
   with headroom and survives a year of growth without re-tuning. The
   "most-recently-updated" axis is the right tiebreaker because dumps
   are far more likely to mention recently-touched work than dormant
   tasks. Token budget is fine — 50 rows × ~80 chars/row ≈ 4 KB,
   negligible against the existing prompt. Revisit only if (a) Cam
   reports the LLM missing matches that ARE in the open-tasks set
   (cap raise), or (b) prompts start truncating (cap lower or move
   to retrieval). Both are real-world signals, not pre-tuning.

   **Sub-note for Vault:** the sort key is `tasks.updated_at DESC`,
   not `tasks.created_at DESC`. Restating because the difference
   matters when Cam edits an old task — that edit should pull it
   into context, and `updated_at` is the column that captures it.

The blocker-resolve cap of 30 (§7) is ratified by extension — same
reasoning, smaller working set.

## 11. Open questions for Cam

**None.** Cam signed off the three product questions on 2026-04-23:

1. Always-suggested in v1: yes.
2. Plain concat with provenance prefix: yes.
3. Wait on a "reverse this update" affordance: yes.

If Phase 1b implementation surfaces a new product question, Vault
flags via Atlas; this contract ships without one.

## What this contract does not cover

- **The UI for the Updates group, the row variant, the drift dialog,
  the focus-flash, the visual tokens.** Lumen's lane (Iris's plan
  §"The dump-detail UI" and §"Frontend gaps").
- **The schema verification pass.** Reed's lane (Phase 1a). This
  contract's §2 records Vault's verification; Reed signs off
  separately.
- **Regression testing.** Probe's lane (Phase 3). The contract names
  the invariants Probe will assert.
- **On-device pass.** Iris's lane (Phase 4).
- **Auto-apply tuning after the first fortnight.** Out of v1; revisit
  with real-world false-match data.
- **`knowledge_update`.** Knowledge items aren't update targets in
  v1. The parser drops them; the prompt tells the LLM to emit a new
  `knowledge` create instead.

## Provenance

- Plan: [`docs/ux-design/2026-04-30-braindump-updates-plan.md`](../../docs/ux-design/2026-04-30-braindump-updates-plan.md).
- Sibling contract (create path): [`auto-create-item.md`](./auto-create-item.md).
- Parent contract (worker + queue): [`background-processing.md`](./background-processing.md).
- Sister contract (blockers create + partial update): [`blockers.md`](./blockers.md).
- Schema: [`data/SCHEMA.md`](../../data/SCHEMA.md), §tasks, §goals,
  §dependencies, §people.
- Cam's signoff (three product questions): 2026-04-23, this dispatch.
- Practice §1 (contract-before-code):
  [`docs/processes/team-practices.md`](../../docs/processes/team-practices.md).
