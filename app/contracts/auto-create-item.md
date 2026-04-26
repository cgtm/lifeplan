# Contract: auto-create-item

**Authors:** Vault (server), supervised by Cairn
**Status:** proposed
**Last updated:** 2026-04-23

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
def _auto_create_item(conn, item, dump_id) -> int | None
```

- `conn` — open `sqlite3.Connection` from the worker's transactional
  scope or `handle_approve_item`'s scope. Not committed inside.
- `item` — one entry from `processed_items["items"]`. Shape:
  `{"type": <itype>, "data": {...}, "confidence": <float>, ...}`.
- `dump_id` — the parent `brain_dumps.id` for logging and FK linkage.
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
| `tag`             | If `is_new=True` OR (`is_new=False` AND no `matched_existing_id`): `INSERT OR IGNORE` into `tags`, look up id, link in `brain_dump_tags`. Else: link existing id | **fall-through to alternative create** (recover `is_new=False` + no match by creating a new tag — already implemented). The `if tag_row:` guard becomes `assert tag_row is not None, "tag insert succeeded but row missing"` (invariant: `INSERT OR IGNORE` on `UNIQUE` always leaves a readable row) | `AssertionError` (programming error if it ever fires); `MalformedItemData("tag", "tag_name")` if `tag_name` missing | `tags.id` (matched or new)   |
| `goal_link`       | If `goal_id` present: return it (no INSERT — this branch only links to an existing goal) | **log + None** — there is no recoverable create. A `goal_link` by definition references an existing goal; we have no goal title/description to synthesise one from. Caller marks `failed` | none beyond programming errors                  | `goals.id`         |
| *unknown `itype`* | n/a                                                                  | **raise** `UnknownItemType(itype)` — covers invariant 4. Future branch additions can't accidentally drop a whole class of items | `UnknownItemType`                                | n/a                |

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

## Open questions

- **Should a DB-level error (`sqlite3.OperationalError`) abort the
  whole dump, or just drop the one item?** Today: drop the one item
  (because the bare-except did). After patch: same (catching
  `sqlite3.Error` keeps the behaviour, just logged now). Cairn /
  product call whether to escalate. *Default: keep current behaviour;
  revisit if it causes pain.*
- **`dropped_count` reporting in `processing.done` log line.** Worth
  adding alongside `auto_created` and `suggested`? Trivial change;
  flagging for Cairn's call so the patch scope is bounded.
- **Lumen's badge for per-item `status="failed"`.** Out of scope for
  this audit (the audit is back-end truthfulness; UX of the new
  per-item state is a separate dispatch). Frontend filter
  (`app.js:508`, `:839`) will need a one-line update to either include
  or explicitly exclude `failed` from its counts. Flagged here so it
  isn't forgotten.
- **`UnknownItemType` from `handle_approve_item`.** Currently the
  approve path would 500. That is the correct shape (programming
  error), but the response body should match the cookie-auth /
  background-processing convention of `{"error": "..."}` with no
  exception text. Patch will need to wrap the call in `handle_approve_item`
  with a try/except for `UnknownItemType` and return
  `500, {"error": "internal error"}` — confirm this is the desired
  shape with Cairn before patching.

Status: `proposed` until Cairn signs off; then `accepted`, then patch
lands in the same PR.

## Provenance

- Audit brief: [`docs/processes/audits/2026-04-23-auto-create-item-status-truthfulness.md`](../../docs/processes/audits/2026-04-23-auto-create-item-status-truthfulness.md).
- Parent contract: [`background-processing.md`](./background-processing.md).
- Practice §1 (contract-before-code): [`docs/processes/team-practices.md`](../../docs/processes/team-practices.md).
- Hit-list source: Vault's pre-flagged silent-None paths from the
  tag/goal_link fix (commit 8c52331, 2026-04-23).
- Per-branch fix precedents: person_mention (2026-04-23); tag/goal_link
  (commit 8c52331).
