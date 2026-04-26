---
status: in flight
opened: 2026-04-23
owner: Cairn (queue) · Vault (patch) · Probe (regression test)
queue source: docs/processes/team-practices.md "Queued audits"
---

# Audit — `_auto_create_item` status-truthfulness

## Why this audit exists

`brain_dump_items.status` is set to `auto_created` *upstream* of
`_auto_create_item` in `process_brain_dump_for_worker`. Any branch inside
`_auto_create_item` that silently returns `None` therefore leaves a row
claiming `auto_created` with `created_id=null` — a status that does not
match reality. The UI and downstream consumers trust the status; the row
lies to them.

This is a contract problem, not three branch bugs. Per-branch patches have
landed twice (person_mention 2026-04-23; tag/goal_link this session, commit
8c52331). The third occurrence is the trigger for fixing the contract
rather than a third branch.

## Trigger

Per `docs/processes/team-practices.md` "Queued audits", trigger condition
was: *"third silent-drop occurrence, OR Reed surfacing a second
status-vs-reality UI mismatch."*

Trigger met by Atlas's production scan: two more silent drops surfaced in
dump #18 (tags `leadership` and `team`). With the original mum case
(`person_mention`), total occurrences = 3.

## Hit-list (Vault's pre-flagged silent-None paths)

These four were flagged by Vault during the tag/goal_link fix and form the
audit's working list. The patch must address all four, or document why a
specific item does not apply.

1. **Bare-`except` swallow at the bottom of `_auto_create_item`.** Every
   DB error becomes a silent `None`. At minimum, log type + dump_id +
   `error_class` (structured). Do not let an exception leave the function
   without a record.
2. **`task` / `knowledge` / `goal_new` `data["title"]` access.** A
   missing `title` raises `KeyError`, which falls into the same
   bare-`except`. Pre-validate at the top of each branch; on failure, log
   a structured rejection and return `None` *with the caller informed* (see
   contract below) — or tighten the LLM contract upstream so the field is
   guaranteed. Vault's call which.
3. **Implicit-else fall-through on unknown `itype`.** Today the types are
   an enum so the fall-through is unreachable, but if the extraction enum
   grows and a new branch is forgotten, every item of that type silently
   drops. Defence-in-depth: explicit `else: log + raise UnknownItemType`,
   or equivalent.
4. **`tag` `is_new=True` path's `if tag_row:` guard.** After
   `INSERT OR IGNORE` on a `UNIQUE` column the row exists by construction.
   The guard hides another silent `None`. Either replace with `assert
   tag_row is not None, "tag insert succeeded but row missing"` or remove
   the guard and let an `IndexError` raise (which the new contract will
   catch loudly).

## Revised contract for `_auto_create_item`

The contract update is the spec for the patch. Vault writes both. Either
extend [`app/contracts/background-processing.md`](../../../app/contracts/background-processing.md)
with an `_auto_create_item` section, or split it into a new
`app/contracts/auto-create-item.md`. Vault's call. Don't bloat — one
section, not five.

The contract MUST name explicitly:

1. **Return-vs-status invariant.** *"If `_auto_create_item` returns `None`,
   the item's status MUST NOT be `auto_created`."* The implementation
   choice is Vault's: either
   - set status *after* the call based on the return value, or
   - introduce a new terminal state (e.g. `failed` / `dropped`) and have
     the caller mark it on `None`, or
   - have `_auto_create_item` raise on drop and the caller catch +
     downgrade status.
   Reed is *not* on the hook for a new status enum value unless Vault
   determines one is needed; if so, Vault writes a structured request to
   Reed via stay-in-lane handoffs (practice §7).
2. **Exception discipline.** *"All exceptions caught inside
   `_auto_create_item` are logged with structured fields (`type`,
   `dump_id`, `error_class`, `error_message`); none are silently
   swallowed."* No bare `except: pass`.
3. **Per-branch recovery documented.** Every branch's docstring (or
   inline comment immediately above the branch) names its create-failed
   recovery: *raise*, *log + return None*, or *fall-through to alternative
   create*. A branch with no documented recovery fails review.
4. **Unknown-`itype` defence.** Reaching the end of the dispatch without
   matching a branch is a programming error, not a data error. Raise (or
   log-and-raise) — do not return `None`.
5. **Caller obligations.** `process_brain_dump_for_worker` MUST honour
   the return-vs-status invariant. The caller's behaviour on `None` is
   part of this contract, not a Vault implementation detail.

## Out of scope (explicit)

These are NOT part of this audit. If discovered during the patch, flag
to Cairn; do not expand scope.

- LLM extraction-layer redesign (upstream of `_auto_create_item`).
- Data-model changes — Reed's lane. (Includes any new status enum value;
  see contract item 1 — request via handoff if needed.)
- `apply_to` semantics — separate Reed investigation already in flight.

## Deliverables

| # | Owner | Deliverable |
|---|-------|-------------|
| 1 | Vault | Contract update naming the five invariants above. |
| 2 | Vault | Patch in `app/processing.py` bringing `_auto_create_item` and `process_brain_dump_for_worker` into compliance. Addresses all four hit-list items or documents why not. |
| 3 | Probe | Regression test (e2e or new spec) asserting: when `_auto_create_item` returns `None` for any reason, the item's status is NOT `auto_created`. Should also cover at least one each of the four hit-list paths to prevent regression. |

## Sequencing

1. Vault: contract first, patch second, in the same PR.
2. Cairn: review the contract before the patch is written (contract-before-code, practice §1).
3. Probe: regression test after the patch lands.
4. Cairn: marks audit "complete" in `team-practices.md` once all three deliverables are in.

## Provenance

- Trigger: Atlas's prod scan finding tags `leadership` and `team` silently
  dropped in dump #18.
- Original case: brain dump #32 ("i need to pay back mum") produced an
  approved `person_mention` with `person_id=null` and no row in `people`.
- Per-branch fixes: person_mention (2026-04-23); tag/goal_link
  (commit 8c52331).
- Queue entry: `docs/processes/team-practices.md` "Queued audits".
