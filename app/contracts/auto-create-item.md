# Contract: auto-create-item

**Authors:** Vault (server), supervised by Cairn
**Status:** accepted
**Last updated:** 2026-04-23
**Cairn approved:** 2026-04-23 — ready for Vault to patch (separate dispatch).

Internal helper contract carved out of
[`background-processing.md`](./background-processing.md). Spec for the
audit `docs/processes/audits/2026-04-23-auto-create-item-status-truthfulness.md`.
Vault writes both this contract and the patch; Cairn signs off on this
contract first (practice §1, contract-before-code), patch follows.

## Mount story

Not applicable. `_auto_create_item` is an internal helper in
`app/processing.py`; it has no HTTP surface, issues no redirects, and
emits no URLs. Mount-awareness (practice §2) does not apply. Privacy
invariant from [`background-processing.md`](./background-processing.md)
(no user content in logs) **does** apply and is restated below.

## Function contract

### Signature

```python
def _auto_create_item(conn, item, dump_id, sibling_items=None) -> int | None
```

- `conn` — open `sqlite3.Connection` from the worker's transactional
  scope or `handle_approve_item`'s scope. Not committed inside.
- `item` — one entry from `processed_items["items"]`. Shape:
  `{"type": <itype>, "data": {...}, "confidence": <float>, ...}`.
- `dump_id` — the parent `brain_dumps.id` for logging and FK linkage.
- `sibling_items` — optional list of other items in the same
  `processed_items.items` array. **Used only by the `tag` branch** to
  resolve `apply_to` references (see "Per-branch behaviour: `tag`"
  below). When `None` or empty, the tag branch falls back to today's
  dump-level-only behaviour. Other branches ignore it.
- **Returns:** the new (or matched) row id on success; `None` when the
  caller should treat the item as not-created. `None` is a contract
  signal, not an error — see "Caller obligations".
- **Raises:** any exception not listed under "Per-branch behaviour" is a
  programming error. The caller (`process_brain_dump_for_worker` or
  `handle_approve_item`) must propagate to the worker's failure handler
  / 5xx path. The function does **not** swallow exceptions silently
  (invariant 2).

### Side-effect semantics

- Writes to the open connection only. Does **not** commit. Caller owns
  the transaction boundary (this is unchanged from today, restated).
- Writes are scoped to the row(s) needed to satisfy the item: e.g. one
  `tasks` insert; or one `tags` insert plus one `brain_dump_tags` link;
  or one `people` insert.
- Reads are limited to the lookups required to materialise the row (e.g.
  re-reading a tag id after `INSERT OR IGNORE`).
- No network I/O. No LLM calls. No filesystem.

## Status state machine (per-item, inside `processed_items.items[*].status`)

`brain_dumps.processing_status` (from background-processing.md) is
unchanged by this contract. The status under the microscope here is the
**per-item** status carried inside the `processed_items` JSON blob and
read by the UI (`app.js:508`, `:839`). Today's vocabulary, plus the
addition this contract introduces:

| Per-item status | Set by                                  | Meaning |
|---|---|---|
| `auto_created`  | worker (high confidence path)           | Item was created in DB; `created_id` is non-null |
| `suggested`     | worker (low confidence path)            | Item awaits user approval |
| `approved`      | `handle_approve_item` on user approve   | Item was created in DB on approval; `created_id` is non-null |
| `rejected`      | `handle_approve_item` on user reject    | Item discarded, no DB row |
| **`failed`** *(new)* | both callers, when `_auto_create_item` returns `None` | Item could not be created; `created_id` is null; row is honest about that |

**Invariant 1 (return-vs-status correlation):** *If `_auto_create_item`
returns `None`, the item's per-item status MUST NOT be `auto_created`
or `approved`. The caller MUST set `failed` instead and MUST set
`created_id = None` explicitly.*

### Why `failed` (a new per-item status) and not reusing existing values

The audit brief (`§contract item 1`) leaves the choice to Vault and
flags that *Reed is not on the hook for an enum value unless one is
needed*. The per-item status is a string field inside a JSON column
(`brain_dumps.processed_items`); it is **not** an enum on a SQL CHECK
constraint. Adding a new value is a one-line frontend filter update
(`app.js:508`, `:839`) and zero-line schema work. No request to Reed.

Alternatives considered and rejected:

- **Reuse `rejected`.** Wrong semantics — `rejected` is a deliberate
  user action; conflating with system-side failure loses signal in any
  future audit ("did the user reject this, or did the system drop it?").
- **Reuse `suggested`.** Wrong semantics — `suggested` invites the user
  to approve, which would re-attempt the same broken create.
- **Set status *before* the call and overwrite on `None`.** Mechanically
  works but leaves a window where status is wrong; explicit "set after
  return" is simpler and matches `handle_approve_item`'s existing flow.
- **Have `_auto_create_item` raise on drop and the caller catch.** More
  ceremony for no gain; `None` is already the function's documented
  signal.

`brain_dumps.processing_status` rollup (`processed` vs `needs_review`)
is unchanged: `failed` per-item rows do not reopen `needs_review`
(the user can't fix a system bug by clicking a button — they'd need to
edit the underlying data and re-process). They render in the UI as a
quiet "couldn't create" annotation; Lumen owns the look (out of scope
for this contract — flagged in "Caller obligations" as a follow-up).

## Per-branch behaviour table

Every branch documents (in code comments AND here) its create-failed
recovery shape. Recovery shapes:

- **raise** — propagate the exception to the caller (programming bug or
  unrecoverable data integrity violation).
- **log + None** — log a structured event and return `None`; caller
  marks the item `failed`.
- **fall-through to alternative create** — internal recovery within the
  branch (e.g. LLM said `is_new=False` but no match; we create a new
  row instead). On success, return the new id; on failure of the
  alternative, log + None.

| `itype`           | Success path                                                        | Recovery shape                                                                                          | Raises                                          | Returns on success |
|---|---|---|---|---|
| `task`            | INSERT into `tasks` with title/desc/goal_id/due_date                 | Pre-validate `data["title"]` at top of branch; missing → raise `MalformedItemData("task", "title")` (caught by helper's structured-logging wrapper, then log + None) | `MalformedItemData` (caught internally → None) | `tasks.id`         |
| `knowledge`       | INSERT into `knowledge_items`                                        | Same as `task` for `data["title"]`                                                                      | `MalformedItemData` (caught internally → None) | `knowledge_items.id` |
| `goal_new`        | INSERT into `goals`, then link `goal_people` for each `people_ids[]` | Same as `task` for `data["title"]`. `people_ids[]` link failures: log per-link warning, do NOT fail the goal create itself | `MalformedItemData` (caught internally → None) | `goals.id`         |
| `person_new`      | INSERT into `people`                                                 | Pre-validate `data["name"]`; missing → raise `MalformedItemData("person_new", "name")` → log + None     | `MalformedItemData` (caught internally → None) | `people.id`        |
| `person_mention`  | If `person_id` present: return it. Else fall-through: synthesise person from `person_name` and INSERT into `people` | **fall-through to alternative create** (already implemented; documented as the canonical recovery pattern). If neither `person_id` nor `person_name` → log + None | `MalformedItemData` only on truly empty data — covered by the empty-name guard already returning None | `people.id` (matched or new) |
| `tag`             | If `is_new=True` OR (`is_new=False` AND no `matched_existing_id`): `INSERT OR IGNORE` into `tags`, look up id, link in `brain_dump_tags`. Else: link existing id. **Then per-item fan-out**: for each `apply_to` ref `{type, source_text}`, find the matching sibling item; if it has `created_id`, `INSERT OR IGNORE` into the appropriate junction table (`task_tags`, `knowledge_tags`, `goal_tags`, `person_tags`). | **fall-through to alternative create** (recover `is_new=False` + no match by creating a new tag — already implemented). The `if tag_row:` guard becomes `assert tag_row is not None, "tag insert succeeded but row missing"` (invariant: `INSERT OR IGNORE` on `UNIQUE` always leaves a readable row). Per-item fan-out failures (FK violation, etc.) log `processing.auto_create.tag.fanout_failed` and continue with remaining refs — they MUST NOT regress the tag's own create or its `brain_dump_tags` link. | `AssertionError` (programming error if it ever fires); `MalformedItemData("tag", "tag_name")` if `tag_name` missing | `tags.id` (matched or new)   |
| `goal_link`       | If `goal_id` present: return it (no INSERT — this branch only links to an existing goal) | **log + None** — there is no recoverable create. A `goal_link` by definition references an existing goal; we have no goal title/description to synthesise one from. Caller marks `failed` | none beyond programming errors                  | `goals.id`         |
| *unknown `itype`* | n/a                                                                  | **raise** `UnknownItemType(itype)` — covers invariant 4. Future branch additions can't accidentally drop a whole class of items | `UnknownItemType`                                | n/a                |

### `tag` branch — `apply_to` fan-out (added 2026-04-23)

The `tag` branch attaches each tag to per-item junction tables when the
LLM populated `apply_to` on the tag item. This is the implementation of
recommendation (C) from `docs/architecture/tag-apply-to-investigation.md`.

**Format.** `apply_to` is a list of `{"type": str, "source_text": str}`
references. `type` is one of `task`, `knowledge`, `goal_new`,
`person_new`, `person_mention` (the item types that produce a real DB
row this tag can hang off; `goal_link` and `tag` are intentionally
absent because they don't create a row a tag could attach to).
`source_text` MUST equal the target sibling item's `source_text`.
Sanitised on read by `_sanitise_apply_to`; malformed entries are
silently dropped.

**Why semantic refs, not numeric indices.** The LLM's natural output is
keyed by item kind (`tasks`, `knowledge_items`, `tags`, …), not a flat
indexed list. Asking the LLM to count across multiple sub-arrays is
fragile; `source_text` is already a field every item carries and the
LLM produces verbatim. Robust pairing without making the model count.

**Pass-ordering invariant — option (a), inside the worker loop.** All
non-tag items are processed BEFORE tag items so siblings already have
`created_id` populated by the time the tag branch reads them. The
worker loop calls `_order_items_tags_last(filtered_items)` to drive
iteration; the persisted JSON keeps extraction order so the UI is
unaffected. (Option (b) — caller post-pass — was rejected: it would
have spread tag-fan-out logic across both callers; (a) keeps it inside
`_auto_create_item`'s tag branch where the rest of the tag logic lives.)

**Junction tables (confirmed against `data/SCHEMA.md`):**

| `apply_to` type   | Junction table   | FK column      |
|---|---|---|
| `task`            | `task_tags`      | `task_id`      |
| `knowledge`       | `knowledge_tags` | `knowledge_id` |
| `goal_new`        | `goal_tags`      | `goal_id`      |
| `person_new`      | `person_tags`    | `person_id`    |
| `person_mention`  | `person_tags`    | `person_id`    |

**Backwards compat.** When `apply_to` is empty or absent, behaviour is
unchanged: tag inserted into `tags`, linked into `brain_dump_tags`, no
per-item attachment. No migration. No regression for old
`processed_items` blobs (their `apply_to: []` reads through and
exercises the unchanged path).

**Privacy.** `apply_to` carries `source_text` strings, which match
sibling items' `source_text` — already part of the items list and never
logged. Fan-out logs report only counts and the static junction-table
name (`processing.auto_create.tag.fanout dump_id=… attached=N
no_match=N no_created_id=N`). No tag names, no source_text, no user
content.

**Approve-handler reach.** `handle_approve_item` passes
`processed_items["items"]` as `sibling_items` so a tag approved through
the UI can also fan out — but only to siblings that already have
`created_id` populated. Pending `suggested` siblings count as
`no_created_id` and are skipped. If the user later approves those
pending siblings, the tag is NOT retroactively attached (the user can
attach manually via the UI). This is the consciously simple shape; a
future "approve-and-cascade" is a separate dispatch.

### Branch-specific notes for Cairn's review

- **`goal_link` has no in-branch recovery.** Named explicitly in the
  brief as a debatable case; documented choice: log + None. The dropped
  link is recoverable by the user editing the goal manually or
  re-processing the dump after the LLM produces a `goal_id`.
- **`person_mention` and `tag` use fall-through to create-new.** This
  is the pattern that emerged from the recent fixes (2026-04-23 person,
  2026-04-23 tag/goal_link in commit 8c52331). Promoted from
  per-branch heuristic to **documented option** here. It is **not** the
  default — branches add it deliberately when there's a sensible
  alternative create.
- **`goal_new`'s `people_ids[]` link failures are isolated.** A bad
  person_id in `people_ids` (e.g. FK violation) does not roll back the
  goal create. Log per-link warning, continue. Rationale: the goal is
  the primary artefact; the link is auxiliary. This matches today's
  behaviour and is restated for clarity.

## Exception discipline (invariant 2)

The bare `except Exception: pass` at the bottom of `_auto_create_item`
goes away. Replacement:

```python
except (MalformedItemData, sqlite3.Error) as exc:
    logger.warning(
        "processing.auto_create.failed dump_id=%s item_type=%s "
        "error_class=%s error_message=%s",
        dump_id, itype, type(exc).__name__,
        _truncate_error_message(str(exc)),
    )
    return None
```

- **No bare `except`.** Catches are typed: `MalformedItemData` (our
  sentinel for missing required keys, raised at the top of each branch)
  and `sqlite3.Error` (the DB layer's umbrella). Anything else
  (e.g. `KeyError` from a forgotten pre-validate, `UnknownItemType`)
  propagates — that's a programming bug, the worker's failure handler
  is the right place to surface it.
- **Structured fields.** At minimum: `dump_id`, `item_type`,
  `error_class`, `error_message_truncated` (cap at ~200 chars).
- **Privacy invariant.** From background-processing.md: "Worker logs
  contain no user content. Only IDs, status, and error type-and-message."
  `item_type` is one of the static enum values (`task`, `knowledge`,
  `tag`, …); never user content. `error_message_truncated` is a
  best-effort hedge — `sqlite3.Error` messages occasionally embed
  parameter values (e.g. constraint violations cite the offending
  value). Truncation is not a guarantee. The truncation length is
  Vault's call (proposed: 200 chars, sufficient for "FOREIGN KEY
  constraint failed" + table name and similar).
- **Logger.** `lifeplan.worker` (matches background-processing.md
  §"Logging contract"). `logger` is the module-level logger in
  `processing.py`.

### `MalformedItemData` (new exception class)

```python
class MalformedItemData(Exception):
    """LLM produced an item dict missing a required key for its branch."""
    def __init__(self, branch: str, missing_key: str):
        self.branch = branch
        self.missing_key = missing_key
        super().__init__(f"{branch}: missing required key '{missing_key}'")
```

Defined in `processing.py` next to `BrainDumpNotFound`. Caught by the
helper's structured-logging wrapper above; routes to log + None. Both
`branch` and `missing_key` are static enum-shaped strings — safe to
log.

### `UnknownItemType` (new exception class)

```python
class UnknownItemType(Exception):
    """Dispatcher reached the end without matching a branch."""
    def __init__(self, itype: str):
        self.itype = itype
        super().__init__(f"unknown itype: {itype!r}")
```

NOT caught by `_auto_create_item`. Propagates to the caller, which
treats it as a programming error (worker fails the job, retries up to
the contract's 3-attempt ceiling, then `failed`). The `itype` value is
LLM-supplied so technically untrusted — the `!r` repr in the message
is fine because `itype` is short and the `error_message_truncated` cap
applies upstream if the worker logs it.

## Logging contract

Events emitted by `_auto_create_item` and the two callers, on the
`lifeplan.worker` logger (and `lifeplan.processing` for the
`handle_approve_item` synchronous path):

| Event                                         | Level   | Fields                                                                  | When |
|---|---|---|---|
| `processing.auto_create.failed`               | WARNING | `dump_id`, `item_type`, `error_class`, `error_message_truncated`        | Caught `MalformedItemData` or `sqlite3.Error` inside `_auto_create_item` |
| `processing.auto_create.tag.recover`          | INFO    | `dump_id`, `reason=match_failed_create_instead`                         | Existing — `tag` branch fell through to create-new (kept as-is) |
| `processing.auto_create.tag.fanout`           | INFO    | `dump_id`, `attached`, `no_match`, `no_created_id`                      | Per-item fan-out summary for one tag's `apply_to`. Counts only — never tag_name or source_text. Suppressed when no work was done. |
| `processing.auto_create.tag.fanout_failed`    | WARNING | `dump_id`, `junction` (static table name), `error_class`, `error_message_truncated` | One junction-table INSERT raised `sqlite3.Error` (e.g. FK violation). Loop continues with remaining refs. The tag's own create + `brain_dump_tags` link are NOT regressed. |
| `processing.auto_create.goal_link.drop`       | WARNING | `dump_id`, `reason=missing_goal_id`                                     | Existing — `goal_link` log + None path (kept as-is) |
| `processing.auto_create.person_mention.drop`  | WARNING | `dump_id`, `reason=empty_person_name`                                   | Existing in spirit — currently silent; promoted to logged drop |
| `processing.auto_create.dropped` *(caller)*   | WARNING | `dump_id`, `item_index`, `item_type`, `caller=worker\|approve`          | Either caller, when `_auto_create_item` returns `None` and the caller marks the item `failed` |

`item_type` is the dispatch enum value, never user content. `dump_id`
is an integer. `item_index` is the index into `processed_items.items`.

## Caller obligations

### `process_brain_dump_for_worker` (worker path)

Today (`processing.py:1840-1844`):

```python
if item["confidence"] >= 0.80:
    item["status"] = "auto_created"
    created_id = _auto_create_item(conn, item, dump_id)
    item["created_id"] = created_id
    auto_count += 1
```

After this contract:

```python
if item["confidence"] >= 0.80:
    created_id = _auto_create_item(conn, item, dump_id)
    if created_id is None:
        item["status"] = "failed"
        item["created_id"] = None
        logger.warning(
            "processing.auto_create.dropped dump_id=%s item_index=%d "
            "item_type=%s caller=worker",
            dump_id, idx, item["type"],
        )
        # Note: item still counted in auto_count? No -- see below.
    else:
        item["status"] = "auto_created"
        item["created_id"] = created_id
    auto_count += 1  # see counter semantics below
```

- **Status set AFTER the call**, based on the return value (invariant 1).
- **`auto_count` semantics:** continues to count the *attempted* high-
  confidence path (matches today's behaviour and the contract's
  `processing.done` log line stays comparable across the patch). A
  separate `dropped_count` could be added but is out of scope — flagged
  as an open question for Lumen's review at the badge stage.
- **`UnknownItemType` and other propagated exceptions** bubble up to
  the worker's failure handler unchanged. The worker's existing
  `attempts < 3 ⇒ retry, else failed` path applies. This is correct:
  an unknown itype is a code bug, not a data bug, and a retry won't
  help — but `attempts >= 3 ⇒ failed` is the right end state regardless
  of root cause, and surfacing it to logs is what we want.

### `handle_approve_item` (user-approval path)

Today (`processing.py:2105-2109`):

```python
if edit_data:
    item["data"].update(edit_data)
created_id = _auto_create_item(conn, item, dump_id)
item["created_id"] = created_id
item["status"] = "approved"
```

After this contract:

```python
if edit_data:
    item["data"].update(edit_data)
created_id = _auto_create_item(conn, item, dump_id)
if created_id is None:
    item["status"] = "failed"
    item["created_id"] = None
    logger.warning(
        "processing.auto_create.dropped dump_id=%s item_index=%d "
        "item_type=%s caller=approve",
        dump_id, item_index, item["type"],
    )
    # The HTTP response still 200s -- the approve action was
    # accepted; the underlying create failed. Surface to the user via
    # the returned row (per-item status is `failed`).
else:
    item["created_id"] = created_id
    item["status"] = "approved"
```

- **HTTP shape unchanged** — still 200 with the updated dump row.
  `item.status == "failed"` is the user-visible signal. (Lumen will
  decide the badge; flagged below.)
- **`needs_review` rollup unchanged.** The existing
  `has_pending = any(i["status"] == "suggested" …)` check stays
  correct: `failed` is terminal, not pending, so a `failed` item does
  not keep the dump in `needs_review`.

## Error matrix

| Failure mode                                        | Branch path                          | What `_auto_create_item` does | What caller does |
|---|---|---|---|
| LLM omits `data["title"]` (task / knowledge / goal_new) | branch raises `MalformedItemData`    | Caught → log `processing.auto_create.failed` → return `None` | Mark item `failed` |
| LLM omits `data["name"]` (person_new)               | branch raises `MalformedItemData`    | Caught → log → return `None` | Mark item `failed` |
| LLM omits `data["tag_name"]`                        | branch raises `MalformedItemData`    | Caught → log → return `None` | Mark item `failed` |
| `person_mention` with empty `person_name` and no `person_id` | empty-name guard returns `None` directly | Log `processing.auto_create.person_mention.drop`, return `None` | Mark item `failed` |
| `goal_link` with no `goal_id`                       | branch returns `None` after warn     | Log `processing.auto_create.goal_link.drop`, return `None` | Mark item `failed` |
| `tag` `is_new=False` with no `matched_existing_id`  | branch falls through to create-new   | Log recover info; create new tag; return new id | Mark item `auto_created` (or `approved`) |
| `tag` insert + lookup returns no row                | `assert tag_row is not None, …` raises `AssertionError` | NOT caught — propagates | Worker fails the job; retry/terminal per work_queue rules |
| `sqlite3.IntegrityError` (e.g. FK violation)        | any branch                           | Caught → log `processing.auto_create.failed` → return `None` | Mark item `failed` |
| `sqlite3.OperationalError` (DB locked, schema mismatch) | any branch                       | Caught → log → return `None` | Mark item `failed`. Worker continues with remaining items. (Open question: should a DB-level error abort the whole dump? See "Open questions") |
| Unknown `itype`                                     | dispatcher's explicit `else`         | Raises `UnknownItemType` — NOT caught | Worker fails the job; retry/terminal per work_queue rules. `handle_approve_item` returns 500 with generic error body (no exception text leak) |
| Any other unexpected exception                      | any branch                           | NOT caught (only `MalformedItemData` and `sqlite3.Error` are) | Worker fails the job; same as above |

## Test plan (what Probe asserts post-patch)

Probe owns the regression test. The contract requires it cover:

1. **Invariant 1 — return-vs-status correlation.** For each of the
   four hit-list paths (bare-except swallow, missing `title`, unknown
   itype, missing `tag_row`), inject the failure and assert the
   resulting item's `status == "failed"` and `created_id is None`.
   Specifically: `status` is never `auto_created` when the underlying
   row was not created.
2. **Per-branch recovery.** `tag` `is_new=False` + no match creates a
   new tag and returns its id (recovery is exercised, not regressed).
   `person_mention` with empty `person_name` and no `person_id` returns
   `None` and the item is marked `failed`.
3. **Logging.** At least one assertion that
   `processing.auto_create.failed` is emitted with the documented
   structured fields (caplog or stdlib `assertLogs`). No raw
   brain-dump content in the log record.
4. **Unknown itype.** Construct an item with a fabricated `itype`
   (e.g. `"this_does_not_exist"`); call `_auto_create_item` directly;
   assert `UnknownItemType` is raised, not silently returned-`None`.
5. **Caller obligation in `handle_approve_item`.** Mock
   `_auto_create_item` to return `None`; call `handle_approve_item`
   with `action="approve"`; assert the response 200, the item's
   `status == "failed"`, and the dump's `processing_status` is **not**
   regressed to `processed` if other suggestions remain.

## Open questions — resolved by Cairn 2026-04-23

- **Should a DB-level error (`sqlite3.OperationalError`) abort the
  whole dump, or just drop the one item?** **DECISION: drop the one
  item (keep current behaviour).** Rationale: aborting the whole dump
  on a single per-item DB error punishes nine good items for one bad
  one, and the new structured logging gives us the signal we were
  missing. If we see a pattern of `OperationalError` (e.g. recurring
  `database is locked`), that's a separate audit trigger — fix at the
  worker / connection layer, not by escalating per-item failures.
  Revisit if the logs show this firing more than once per week.
- **`dropped_count` in the `processing.done` log line.** **DECISION:
  YES, add it.** Rationale: cheap (one int), and the line already
  reports `auto_created` + `suggested`. Without `dropped_count` an
  operator reading the log can't reconcile `len(items)` against the
  reported counts when drops occur — exactly the silent-loss shape
  this audit exists to eliminate. Field name: `dropped` (matches the
  terse style of `auto_created` / `suggested`). In scope for this
  patch.
- **`UnknownItemType` from `handle_approve_item` — 500 body shape.**
  **DECISION: `500, {"error": f"internal error: {type(e).__name__}"}`**
  Rationale: matches the existing pattern at `processing.py:1922`
  (`f"Processing failed: {type(e).__name__}"`) — class name only, no
  message text, no leak risk. Lowercase, short, consistent with the
  rest of the handler shapes (`processing.py:1898/1978/1993/...`).
  Plain `{"error": "internal error"}` would also be acceptable house
  style but loses the class-name signal that's already conventional
  here. Wrap the `_auto_create_item` call in `handle_approve_item`
  with a typed `except UnknownItemType` only — do NOT broaden to
  `except Exception` (that would re-introduce the swallow this audit
  is killing). Any other unexpected exception bubbles to the framework
  500 handler unchanged.
- **Lumen's badge for per-item `status="failed"`.** **DECISION:
  accept the gap; queue as separate dispatch.** Rationale: backend
  truthfulness is the load-bearing fix; without it, the UI has nothing
  honest to render. Shipping the contract + patch + regression test
  first means `failed` rows exist and are inspectable in the JSON
  before Lumen designs the badge. The frontend filter
  (`app.js:508`, `:839`) will continue to render unknown statuses
  with default styling — ugly but not wrong, and not user-visible
  until a `failed` row actually appears in production. Atlas to queue
  a separate Lumen dispatch (`failed` badge + filter copy) after this
  patch lands and Probe's regression test goes green.

## Cairn confirmations on Vault's branch-recovery shape

- **`goal_link` → log + None.** Confirmed. No recoverable create
  shape; the documented behaviour is correct.
- **`person_mention` + `tag` → fall-through to create-new.** Confirmed
  as documented option (opt-in per branch, not default). The
  contract's wording in "Branch-specific notes" is the canonical
  statement of the pattern; future branches reference it rather than
  re-derive it.
- **`tag`'s `if tag_row:` → `assert tag_row is not None`.** Confirmed.
  `INSERT OR IGNORE` on `UNIQUE` always leaves a readable row; the
  guard was hiding a programming-error shape as a data-error shape.
  The assertion is correct and surfaces loudly if the invariant is
  ever violated.
- **`MalformedItemData` exception class.** Confirmed. Constructor
  shape (`branch`, `missing_key`) is right — both fields are static
  enum-ish strings, safe to log.
- **`UnknownItemType` exception class.** Confirmed. Not caught by
  `_auto_create_item`; caller responsibility (worker retry/terminal,
  approve-handler 500-with-class-name per decision above).

## Provenance

- Audit brief: [`docs/processes/audits/2026-04-23-auto-create-item-status-truthfulness.md`](../../docs/processes/audits/2026-04-23-auto-create-item-status-truthfulness.md).
- Parent contract: [`background-processing.md`](./background-processing.md).
- Practice §1 (contract-before-code): [`docs/processes/team-practices.md`](../../docs/processes/team-practices.md).
- Hit-list source: Vault's pre-flagged silent-None paths from the
  tag/goal_link fix (commit 8c52331, 2026-04-23).
- Per-branch fix precedents: person_mention (2026-04-23); tag/goal_link
  (commit 8c52331).
