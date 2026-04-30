# Unlink Safety Heuristic — auto-created items

**Status:** accepted
**Author:** Reed (Knowledge Architect)
**Date:** 2026-04-23
**Triggered by:** Iris's UX dispatch for an "Unlink" affordance on
`auto_created` items in the dump-detail modal. Vault will encode this
heuristic in a new `action='unlink'` on `handle_approve_item`.
**Companion contracts:**
[`app/contracts/auto-create-item.md`](../../app/contracts/auto-create-item.md),
[`data/SCHEMA.md`](../../data/SCHEMA.md) v0.6+.

---

## 1. The rule (Cam's framing, restated plain)

> If the item was created as a new item, and it holds no other data than
> what was added in the brain dump in question, then it's safe to delete.
> If it existed before, or it contains data other than what was added by
> the brain dump in question, just unlink it.

In operational terms, when a user clicks "Unlink" on an `auto_created`
(or `approved`) item inside the dump-detail modal:

1. **Verdict.** Decide whether the underlying entity row is *safe to
   delete* (still exactly as this dump created it, with no later
   evolution) or *detach-only* (other data has accreted to it — other
   dumps, other tasks under it, edits, junction rows from elsewhere,
   etc.).
2. **Act.** If safe-to-delete: drop the entity row (and its junction
   rows) AND null out `created_id` on the dump's per-item record AND
   set the per-item status to `unlinked`. If detach-only: leave the
   entity row alone, only sever the *link from this dump* — null the
   dump's `created_id`, set status to `unlinked`, and remove the
   junction row(s) this dump itself contributed (e.g. the
   `brain_dump_tags` row for a tag, the `goal_people` row for a
   `goal_new`'s `people_ids[]` entries — see per-entity rules).
3. **Confirm.** When the verdict is detach-only, return a structured
   *reason payload* so Iris's confirm dialog can render
   "this person is mentioned in 2 other brain dumps and linked to 3
   tasks" rather than a flat "can't delete."

The `unlinked` per-item status is new. It's a string in the JSON blob
inside `brain_dumps.processed_items`; per the auto-create contract's
"Why `failed`" reasoning, no schema change is needed. Frontend filter
update (`app.js:508`, `:839`) is one line.

---

## 2. The verdict shape (Vault's return contract)

`_unlink_verdict(conn, dump_id, item)` returns a dict:

```python
{
    "safe_to_delete": bool,
    "entity_kind": "task" | "goal" | "person" | "knowledge" | "tag",
    "entity_id": int | None,           # None if entity already gone (race)
    "reasons": [                        # populated when safe_to_delete=False
        {"kind": "edited",        "detail": "..."},
        {"kind": "other_dumps",   "count": int, "dump_ids": [int, ...]},
        {"kind": "linked_tasks",  "count": int},
        {"kind": "linked_goals",  "count": int},
        {"kind": "applied_tags",  "count": int},   # tag/person/etc. has tag rows from elsewhere
        {"kind": "blockers",      "count": int},
        {"kind": "junction_apply_to", "count": int, "junction": "task_tags" | ...},
        {"kind": "completed",     "detail": "completed_at=YYYY-MM-DD"},
        ...
    ],
}
```

`reasons` is the rendered detach explanation. It is intentionally an
*ordered list* (not a flat string) so Iris can choose copy per kind and
collapse/expand as needed. Empty `reasons` and `safe_to_delete=True`
means "go ahead and delete." Non-empty `reasons` and
`safe_to_delete=False` means "render confirm dialog with these bullets."

`entity_id is None` means the row is already gone (race) — Vault treats
this as a no-op success: the dump's `created_id` is nulled, status
flipped to `unlinked`, and Iris is told "already cleaned up." See §5.

---

## 3. Per-entity heuristic

The same skeleton applies to every entity:

> **safe_to_delete = (row was created by THIS dump's auto-fanout) AND
> (row has not evolved since) AND (no foreign accretions exist).**

What "this dump created it" and "evolved since" mean differs per type.
The closest signal we have for "this dump created it" is the per-item
record itself: `processed_items.items[i].created_id` matches the entity
row's id, AND that item's `status` is `auto_created` or `approved`. In
SQL we don't query the JSON blob — we trust the caller (Vault's handler
already has `item_index`, the item dict, and `created_id` in hand). The
SQL below is just for the "evolved / accretions" half.

The "row was created by THIS dump" signal hardens with a sanity check:
`entity.created_at` matches the dump's `processed_at` (or the
auto-create timestamp `ts` baked into the row by `_auto_create_item`)
to within a few seconds. `_auto_create_item` stamps `created_at` and
`updated_at` to the same `now_utc()` call, so equality of those two on
the row is the load-bearing "no edits since" check.

Throughout the SQL below, `:entity_id` is the row id from the dump's
`item.created_id`, and `:dump_id` is the parent `brain_dumps.id`.

### 3.1 `task`

**Created by:** `_auto_create_item` `task` branch.
**Payload at create time:** `title`, `description?`, `goal_id?`,
`due_date?`, `status='active'`, `created_at == updated_at == ts`.
**No junction rows are created by this branch** — `task_tags` rows can
appear later via the tag branch's `apply_to` fan-out within the same
dump (see §3.5), and `task_people` rows are not produced by auto-create
at all today.

**Safe-to-delete predicate (SQL):**

```sql
SELECT 1
  FROM tasks t
 WHERE t.id = :entity_id
   AND t.created_at = t.updated_at                 -- no edits since create
   AND t.status     = 'active'                     -- not completed/cancelled
   AND t.completed_at IS NULL
   AND NOT EXISTS (                                -- no foreign tags
       SELECT 1 FROM task_tags tt
       WHERE tt.task_id = t.id
         AND tt.tag_id NOT IN (                    -- only tags this dump itself wrote
             SELECT bt.tag_id FROM brain_dump_tags bt
              WHERE bt.brain_dump_id = :dump_id
         )
   )
   AND NOT EXISTS (                                -- no people linked to it
       SELECT 1 FROM task_people tp WHERE tp.task_id = t.id
   )
   AND NOT EXISTS (                                -- not blocking anything
       SELECT 1 FROM dependencies d
       WHERE (d.blocker_type = 'task' AND d.blocker_id = t.id)
          OR (d.blocked_type = 'task' AND d.blocked_id = t.id)
   );
```

**Detach reason payload on negative:**

| Reason kind     | When                                                        |
|---|---|
| `edited`        | `t.updated_at != t.created_at`                              |
| `completed`     | `t.status != 'active'` or `t.completed_at IS NOT NULL`      |
| `applied_tags`  | `task_tags` rows exist with `tag_id` not in this dump's `brain_dump_tags` |
| `linked_people` | any `task_people` row exists                                |
| `blockers`      | any `dependencies` row references this task on either side  |

**Detach action:** null `created_id` on the dump's item, set
`status='unlinked'`, leave the `tasks` row in place. Do **not** delete
the `task_tags` rows that came from this dump's tag fanout — those are
"the user already kept the task, so the tags it acquired survive too."
Race-safe because the verdict + action share a transaction (§4).

**Safe-delete action:** delete the `tasks` row. SQLite's existing FK
behaviour handles spillover (`tasks.goal_id ON DELETE SET NULL` is
goal-side, irrelevant here; junction tables aren't FK-cascade-defined
on the SCHEMA but in practice a delete of `tasks.id` will leave orphan
junction rows — Vault must explicitly delete `task_tags WHERE task_id =
:entity_id` and `task_people WHERE task_id = :entity_id` and any
`dependencies` rows referencing this task as a defensive sweep). The
predicate already ruled out non-empty `task_people` and `dependencies`,
so those deletes are no-ops; the `task_tags` delete is the live one.

### 3.2 `goal_new` (entity kind: `goal`)

**Created by:** `_auto_create_item` `goal_new` branch.
**Payload at create time:** `title`, `description?`, `target_date?`,
`status='active'`, `created_at == updated_at == ts`. Plus optional
`goal_people` rows for each `data["people_ids"][]` entry, role
`'involved'`.

**Safe-to-delete predicate (SQL):**

```sql
SELECT 1
  FROM goals g
 WHERE g.id = :entity_id
   AND g.created_at = g.updated_at
   AND g.status     = 'active'
   AND g.completed_at IS NULL
   AND NOT EXISTS (                                -- no tasks under it
       SELECT 1 FROM tasks tk WHERE tk.goal_id = g.id
   )
   AND NOT EXISTS (                                -- no foreign tags
       SELECT 1 FROM goal_tags gt
       WHERE gt.goal_id = g.id
         AND gt.tag_id NOT IN (
             SELECT bt.tag_id FROM brain_dump_tags bt
              WHERE bt.brain_dump_id = :dump_id
         )
   )
   AND NOT EXISTS (                                -- not blocked or blocking
       SELECT 1 FROM dependencies d
       WHERE (d.blocker_type = 'goal' AND d.blocker_id = g.id)
          OR (d.blocked_type = 'goal' AND d.blocked_id = g.id)
   );
```

**`goal_people` is intentionally absent from the predicate.** Reason:
those rows came from the dump itself (`people_ids[]` at create time),
so they ARE "what this dump added." On the safe-delete path Vault must
sweep them with the goal:

```sql
DELETE FROM goal_people WHERE goal_id = :entity_id;
DELETE FROM goal_tags   WHERE goal_id = :entity_id;
DELETE FROM goals       WHERE id      = :entity_id;
```

**Detach reason payload on negative:**

| Reason kind     | When                                                       |
|---|---|
| `edited`        | `g.updated_at != g.created_at`                             |
| `completed`     | `g.status != 'active'` or `g.completed_at IS NOT NULL`     |
| `linked_tasks`  | `tasks.goal_id = g.id` — count tasks                       |
| `applied_tags`  | `goal_tags` rows with `tag_id` not in this dump's `brain_dump_tags` |
| `blockers`      | any `dependencies` row touches this goal                   |

**Detach action:** null `created_id`, status `unlinked`, leave goal
row. Do NOT remove `goal_people` rows on detach — they were the dump's
contribution, but the goal exists on its own merits now (it has tasks
or edits or external accretions); ripping out the people associations
would be a worse outcome than leaving them. (Cam can manage them via
the goal's UI.)

### 3.3 `person_new` (entity kind: `person`)

**Created by:** `_auto_create_item` `person_new` branch (and the
fall-through path in `person_mention` when no `person_id` was matched
and `person_name` was non-empty — both create a `people` row the same
way; we treat them identically for unlink purposes).

**Payload at create time:** `name`, `relationship` (default `'unknown'`
when LLM omitted), `notes?` (often non-empty: derived from `notes` or
`context` field). `created_at == updated_at == ts`. **No junctions
created by the person branch itself.** A `person_new` can however be
referenced by sibling `goal_new` items via `people_ids[]` (creating a
`goal_people` row in the same dump), and by tag `apply_to` fan-out
(creating a `person_tags` row in the same dump).

**Safe-to-delete predicate (SQL):**

```sql
SELECT 1
  FROM people p
 WHERE p.id = :entity_id
   AND p.created_at = p.updated_at
   AND NOT EXISTS (                                 -- no other dump mentions this person
       SELECT 1 FROM brain_dumps b
       WHERE b.id != :dump_id
         AND b.processed_items IS NOT NULL
         AND EXISTS (
             SELECT 1 FROM json_each(b.processed_items, '$.items') je
             WHERE json_extract(je.value, '$.created_id') = p.id
               AND json_extract(je.value, '$.type') IN ('person_new','person_mention')
         )
   )
   AND NOT EXISTS (                                 -- not linked to any goal we didn't create here
       SELECT 1 FROM goal_people gp
       WHERE gp.person_id = p.id
         AND gp.goal_id NOT IN (
             SELECT json_extract(je.value, '$.created_id')
               FROM brain_dumps b, json_each(b.processed_items, '$.items') je
              WHERE b.id = :dump_id
                AND json_extract(je.value, '$.type') = 'goal_new'
                AND json_extract(je.value, '$.created_id') IS NOT NULL
         )
   )
   AND NOT EXISTS (                                 -- not linked to any task at all (tasks aren't created with person links by auto-create)
       SELECT 1 FROM task_people tp WHERE tp.person_id = p.id
   )
   AND NOT EXISTS (                                 -- no foreign tags
       SELECT 1 FROM person_tags pt
       WHERE pt.person_id = p.id
         AND pt.tag_id NOT IN (
             SELECT bt.tag_id FROM brain_dump_tags bt
              WHERE bt.brain_dump_id = :dump_id
         )
   );
```

The `json_each` lookup against other dumps' `processed_items` is the
load-bearing "is this person mentioned elsewhere" check. SQLite has
shipped JSON1 by default since 3.38; both local (~3.43) and the prod
droplet's Ubuntu build support it. (Confirmed: `processed_items` is
already read JSON-side elsewhere — see prompts processing.) If perf
becomes a concern across thousands of dumps, a small index-friendly
denormalisation would be a future optimisation; today the dataset is
small enough that the scan is fine.

**Detach reason payload on negative:**

| Reason kind     | When                                                       |
|---|---|
| `edited`        | `p.updated_at != p.created_at`                             |
| `other_dumps`   | found in another dump's `processed_items` — list `dump_ids`|
| `linked_goals`  | `goal_people` rows exist linking to goals not created by THIS dump |
| `linked_tasks`  | `task_people` rows exist                                   |
| `applied_tags`  | `person_tags` rows with foreign `tag_id`                   |

**Detach action:** null `created_id`, status `unlinked`, leave person.
Vault should also remove `goal_people` rows that link this person to
goals THIS dump created (they're the dump's own contribution) — but
only if those goals themselves are still being unlinked or already
gone; simplest rule: leave all `goal_people` alone on detach. Cam can
clean from the person page.

**Safe-delete action:** sweep `goal_people`, `task_people` (both are
empty per predicate), `person_tags` for this dump's tags, and the
`people` row.

### 3.4 `knowledge`

**Created by:** `_auto_create_item` `knowledge` branch.
**Payload at create time:** `title`, `content?`, `item_type` (default
`'fact'`), `source` (default `f"brain_dump:{dump_id}"`),
`created_at == updated_at == ts`.

The `source` default is a useful tell — if `source LIKE 'brain_dump:%'`
and the suffix is this dump's id, that's belt-and-braces evidence the
row was created by THIS dump. We use it as a sanity check, not a load-
bearing predicate (the `created_id` match from the JSON blob is still
authoritative).

**Safe-to-delete predicate (SQL):**

```sql
SELECT 1
  FROM knowledge_items ki
 WHERE ki.id = :entity_id
   AND ki.created_at = ki.updated_at
   AND (ki.source IS NULL OR ki.source = 'brain_dump:' || :dump_id)
   AND NOT EXISTS (                                 -- no other dump references it
       SELECT 1 FROM brain_dumps b
       WHERE b.id != :dump_id
         AND b.processed_items IS NOT NULL
         AND EXISTS (
             SELECT 1 FROM json_each(b.processed_items, '$.items') je
             WHERE json_extract(je.value, '$.created_id') = ki.id
               AND json_extract(je.value, '$.type') = 'knowledge'
         )
   )
   AND NOT EXISTS (                                 -- no foreign tags
       SELECT 1 FROM knowledge_tags kt
       WHERE kt.knowledge_id = ki.id
         AND kt.tag_id NOT IN (
             SELECT bt.tag_id FROM brain_dump_tags bt
              WHERE bt.brain_dump_id = :dump_id
         )
   );
```

**Detach reason payload on negative:**

| Reason kind     | When                                                       |
|---|---|
| `edited`        | `ki.updated_at != ki.created_at`                           |
| `source_changed`| `ki.source` neither NULL nor `brain_dump:<this_dump_id>`   |
| `other_dumps`   | another dump's `processed_items` references it             |
| `applied_tags`  | foreign `knowledge_tags` rows                              |

**Detach action:** standard. **Safe-delete action:** sweep
`knowledge_tags WHERE knowledge_id = :entity_id` then delete the row.

### 3.5 `tag` — the special case

**Created by:** `_auto_create_item` `tag` branch. Three things happen:

1. The tag row is inserted into `tags` (or matched if existing).
2. A `brain_dump_tags` row is inserted linking THIS dump to the tag.
3. **`apply_to` fan-out**: for each sibling item the tag references,
   a row is inserted into the appropriate per-item junction (`task_tags`,
   `knowledge_tags`, `goal_tags`, `person_tags`).

**Confirmation of Cam's framing:** a tag is *rarely* safe to delete.

The reason is the cross-content-type vocabulary design (SCHEMA.md
"Tags table is shared. Every content type gets its own junction table
pointing to the same `tags` table. One vocabulary, many content
types"). A tag like `seoul` or `family` is reused across dozens of
brain dumps, tasks, and knowledge items over time. The moment it
appears in a second dump or is applied to anything outside this dump's
fanout, it is detach-only forever.

The only realistic safe-to-delete shape: *a tag the LLM minted brand
new in THIS dump, that has not yet been reused, applied only to
siblings of this dump, and where the user is unlinking before any
other workflow has touched it.* That's a real but narrow window.

**Safe-to-delete predicate (SQL):**

```sql
SELECT 1
  FROM tags tg
 WHERE tg.id = :entity_id
   -- (a) only this dump's brain_dump_tags row references it
   AND NOT EXISTS (
       SELECT 1 FROM brain_dump_tags bt
       WHERE bt.tag_id = tg.id AND bt.brain_dump_id != :dump_id
   )
   -- (b) every per-item junction row pointing at this tag was written
   --     by THIS dump's apply_to fanout, i.e. the target entity itself
   --     was created by this dump (its id matches a sibling's
   --     created_id in this dump's processed_items)
   AND NOT EXISTS (
       SELECT 1 FROM task_tags tt
       WHERE tt.tag_id = tg.id
         AND tt.task_id NOT IN (
             SELECT json_extract(je.value, '$.created_id')
               FROM brain_dumps b, json_each(b.processed_items, '$.items') je
              WHERE b.id = :dump_id
                AND json_extract(je.value, '$.type') = 'task'
                AND json_extract(je.value, '$.created_id') IS NOT NULL
         )
   )
   AND NOT EXISTS (
       SELECT 1 FROM knowledge_tags kt
       WHERE kt.tag_id = tg.id
         AND kt.knowledge_id NOT IN (
             SELECT json_extract(je.value, '$.created_id')
               FROM brain_dumps b, json_each(b.processed_items, '$.items') je
              WHERE b.id = :dump_id
                AND json_extract(je.value, '$.type') = 'knowledge'
                AND json_extract(je.value, '$.created_id') IS NOT NULL
         )
   )
   AND NOT EXISTS (
       SELECT 1 FROM goal_tags gt
       WHERE gt.tag_id = tg.id
         AND gt.goal_id NOT IN (
             SELECT json_extract(je.value, '$.created_id')
               FROM brain_dumps b, json_each(b.processed_items, '$.items') je
              WHERE b.id = :dump_id
                AND json_extract(je.value, '$.type') = 'goal_new'
                AND json_extract(je.value, '$.created_id') IS NOT NULL
         )
   )
   AND NOT EXISTS (
       SELECT 1 FROM person_tags pt
       WHERE pt.tag_id = tg.id
         AND pt.person_id NOT IN (
             SELECT json_extract(je.value, '$.created_id')
               FROM brain_dumps b, json_each(b.processed_items, '$.items') je
              WHERE b.id = :dump_id
                AND json_extract(je.value, '$.type') IN ('person_new','person_mention')
                AND json_extract(je.value, '$.created_id') IS NOT NULL
         )
   )
   -- (c) not on any journal entry (entry_tags is auto-create-blind)
   AND NOT EXISTS (SELECT 1 FROM entry_tags et WHERE et.tag_id = tg.id);
```

**Detach reason payload on negative:**

| Reason kind          | When                                                  |
|---|---|
| `other_dumps`        | `brain_dump_tags` row in another dump                 |
| `junction_apply_to`  | a `task_tags` / `knowledge_tags` / `goal_tags` / `person_tags` row exists for an entity NOT created by this dump. Report counts per junction so Iris can render "applied to 3 tasks, 1 knowledge item." |
| `entry_tags`         | this tag is on a journal entry                        |

**Detach action:** delete the `brain_dump_tags` row for `(dump_id,
tag_id)` only. **Do NOT touch any per-item junction.** Those rows
exist on entities the user is keeping; tearing them out would be a
silent data-loss surprise. Null `created_id` on the dump's item, set
status `unlinked`.

**Safe-delete action:** sweep all junction tables for the tag
(`brain_dump_tags`, `task_tags`, `knowledge_tags`, `goal_tags`,
`person_tags`) — they're all confirmed to belong to this dump's fanout
by the predicate — then delete the `tags` row.

**Confirmed: tag is rarely deletable in practice.** Once a tag has been
reused (next brain dump that uses it, manual application, journal
entry), it's permanently detach-only. This is correct behaviour and
matches Cam's rule literally: "If it existed before [in another dump's
fanout], or contains data other than what was added by the brain dump
in question [other entities applied to it], just unlink it."

---

## 4. Transaction boundary

**Vault wraps the entire verdict-and-action in `BEGIN IMMEDIATE`.** The
verdict computation reads the entity row + junctions + (for person and
knowledge) other dumps' `processed_items` JSON. Between read and write,
a concurrent worker could process a new dump that mentions the same
person, or Cam could edit the entity in another tab. The transaction
boundary is what makes the verdict-and-action atomic.

Concretely, in `handle_approve_item`'s `action='unlink'` arm:

```python
with conn:                              # implicit BEGIN ... COMMIT
    conn.execute("BEGIN IMMEDIATE")     # writer-lock the DB upfront
    verdict = _unlink_verdict(conn, dump_id, item)
    if verdict["entity_id"] is None:
        # Race: entity already gone. Just clean the JSON.
        _mark_item_unlinked(conn, dump_id, item_index)
    elif verdict["safe_to_delete"]:
        _delete_entity_and_junctions(conn, verdict)
        _mark_item_unlinked(conn, dump_id, item_index)
    else:
        _detach_dump_link(conn, dump_id, item, verdict)
        _mark_item_unlinked(conn, dump_id, item_index)
    # Commit on `with conn` exit
```

`BEGIN IMMEDIATE` (matching the worker's claim pattern in `work_queue`)
takes the writer lock at the start so two unlinks against overlapping
entities serialise rather than fight at COMMIT time. The rest of the
app uses the same pattern (see `data/SCHEMA.md` work_queue claim SQL
and the worker's transactional scope), so this is a continuation of
house style, not a new convention.

If the verdict was `safe_to_delete=True` at read time but a concurrent
write would have changed the answer, one of the two transactions
serialises after the other and *its* verdict re-reads the updated
state. The lock is what makes "verdict + act" indivisible.

**No SAVEPOINTs.** The unlink action is either fully applied or fully
rolled back — no partial-delete recovery shape.

---

## 5. Edge cases

### 5.1 Entity already gone (race)

The dump's `created_id` points to a `tasks.id` (etc.) that no longer
exists. Cause: Cam deleted it from the entity's own page between
processing and unlinking, or a previous unlink action raced.

**Verdict:** `entity_id = None`, `safe_to_delete = True` (vacuously),
`reasons = []`. **Action:** null `created_id` on the dump's item, set
status `unlinked`. No DB delete attempted. Vault's response includes a
`reason: "already_gone"` banner so Iris can render "this item had
already been removed elsewhere."

Detection: the same predicate query above starts with `SELECT 1 FROM
<table> WHERE id = :entity_id`. If that returns no row, we're in this
case.

### 5.2 Per-item status is not `auto_created` / `approved`

The unlink action is only valid for items the system created on the
user's behalf. Reject `unlink` on items with status `suggested`,
`rejected`, `failed`, or already `unlinked`.

| Current status | Behaviour              |
|---|---|
| `auto_created`, `approved` | Proceed. |
| `suggested`              | 409 `{error: "only auto-created or approved items can be unlinked; reject this suggestion instead"}`. |
| `rejected`, `failed`     | 409 `{error: "item was never created; nothing to unlink"}`. |
| `unlinked`               | 409 `{error: "already unlinked"}`. |

This mirrors the precondition gate pattern in the auto-create contract
(`approve` requires `suggested`, `retry` requires `failed`, etc.).

### 5.3 `created_id` is null on an `auto_created` item

Should never happen post-Vault's invariant 1 patch (status `auto_created`
implies `created_id is not null`). If it does (legacy row from before
the patch), treat exactly like 5.1: vacuously safe, just clean the
JSON, banner says `"already_gone"`. Log
`processing.unlink.no_created_id dump_id=… item_index=…` for telemetry.

### 5.4 The dump's item was a `tag` whose `apply_to` had already been
broken at create time

The fan-out logs `no_match` / `no_created_id` and skips the junction
insert. The `tag_tags` shape predicate above doesn't notice — it just
sees fewer junction rows, all of which still pass the "belongs to this
dump" check. Verdict is unaffected. No special handling.

### 5.5 Goal had `people_ids[]` pointing at people not created by this
dump

The goal create succeeded, the `goal_people` rows reference people that
existed before this dump (or were created by a sibling `person_new` in
this same dump). Both shapes are fine — the `goal_people` rows came
from THIS dump's auto-create logic, so on safe-delete we sweep them.
Pre-existing people referenced by those rows are NOT touched (we only
delete the junction). The person itself, if it was a `person_new`
sibling, will be unlinked separately when the user unlinks that item.

### 5.6 Concurrent edit between verdict and act

Solved by `BEGIN IMMEDIATE` (§4). Worth restating: no read-modify-write
window. The first writer wins; the second blocks and re-reads.

### 5.7 `processed_items` JSON malformed / missing `items` array

The dump's per-item record can't be located. Vault should 422 with
`{error: "dump processed_items malformed; cannot unlink"}`. This is a
data integrity issue, not an unlink concern.

### 5.8 User unlinks a `person_new`, but a sibling `goal_new` in the
same dump has a `goal_people` row referencing them

Predicate result: the goal-people row is to a goal *created by this
dump* (the goal's id is in the `created_id`-of-sibling-goal_new set),
so the predicate's `goal_id NOT IN (...)` clause excludes it. Person
is still safe-to-delete from this dump's perspective. On safe-delete,
sweep the `goal_people` row.

If, however, the user has *already* unlinked that sibling goal (so
the goal is gone), the `goal_people` row is gone too (we sweep on
goal safe-delete). Same outcome. No special handling.

If the sibling goal is still in `auto_created` state but the user
unlinks the person first, the goal stays — but loses the person link.
That's correct: the goal exists on its own (title, description, and
its other associations from the same dump), and the person is being
explicitly removed.

---

## 6. Open questions for Vault

1. **Where does the `unlinked` per-item status live in the JSON
   blob?** Same place as `failed` (per-item-status string in
   `processed_items.items[i].status`). Confirm no UI work is needed
   beyond the frontend filter update.
2. **Should `_mark_item_unlinked` clear `error` if any was set?** Yes
   — defensive cleanup. Mirrors `unreject` clearing prior `error` per
   the auto-create contract.
3. **JSON1 portability.** The person/knowledge/tag predicates use
   `json_each` and `json_extract` against `brain_dumps.processed_items`.
   Confirm prod's SQLite has JSON1 enabled (it does; the worker already
   reads/writes processed_items JSON-side, so this is already on the
   load-bearing path). No new dependency.
4. **`goal_link` and `person_mention` items.** These never create a
   *new* entity (they reference an existing one). The "Unlink" UI
   should not offer the safe-delete path for them; their unlink is
   *always* detach-only. Reasoning: the entity existed before this
   dump by definition. Vault's verdict for these item types should
   short-circuit to `safe_to_delete=False`,
   `reasons=[{kind: "pre_existing"}]`. Iris's confirm dialog can show
   "this is a link to an existing X; we'll just remove the link."
5. **Logging contract.** Suggested events on `lifeplan.processing`:
   - `processing.unlink.safe_delete dump_id=… item_index=… entity_kind=… entity_id=…`
   - `processing.unlink.detach dump_id=… item_index=… entity_kind=… entity_id=… reason_kinds=[…]`
   - `processing.unlink.already_gone dump_id=… item_index=… entity_kind=…`
   No entity titles, names, or tag names — same privacy invariant as
   the auto-create logging contract.
6. **`work_queue` interaction.** Unlink doesn't enqueue work. It's a
   synchronous user action like `approve` / `reject` / `retry` /
   `unreject`. No `work_queue` row.

---

## 7. Open questions for Cam

**None.** Cam supplied the rule; the heuristic is a translation of it.
The five per-entity SQL predicates are direct readings of "no other
data than what this dump added" applied to each row's specific
relational neighbourhood.

---

## 8. Provenance

- Cam's rule (verbatim, given in dispatch 2026-04-23): the framing
  block in §1.
- Iris parallel UX dispatch: confirm-dialog copy will render the
  `reasons` payload from §2.
- Vault parallel implementation dispatch: `action='unlink'` on
  `handle_approve_item`, encoding §3 and §4.
- Auto-create contract:
  [`app/contracts/auto-create-item.md`](../../app/contracts/auto-create-item.md)
  — defines `_auto_create_item`'s create-time payloads (the "what this
  dump added" that the heuristic checks against).
- Schema:
  [`data/SCHEMA.md`](../../data/SCHEMA.md) v0.6+ — junction tables and
  the cross-content tag vocabulary that makes `tag` the special case.
- `apply_to` design: the tag fan-out behaviour the heuristic depends
  on is described in
  [`docs/architecture/tag-apply-to-investigation.md`](./tag-apply-to-investigation.md).
