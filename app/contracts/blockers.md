# Contract: blockers (create + partial update)

**Authors:** Vault (server), Lumen (client)
**Status:** accepted
**Last updated:** 2026-04-23

Create + partial-update endpoints for the rows the UI calls "blockers."
Backs the "mark resolved" / "undo" flow Iris asked for, the future
edit-blocker-fields menu, and the +Blocker picker in the goal-detail
modal (Iris's growability dispatch — see
`docs/ux-design/2026-04-29-goal-detail-growability.md`). Single
contract covers the lifecycle: POST to create, PUT to partial-update.

## URL → table mapping (read this once, never wonder again)

The UI word is **blocker**. The table name is **`dependencies`**. They
are the same rows.

The URL path uses `blockers` because:

1. Iris's UX framing is "blockers", not "dependencies edges."
2. The hero, the goal-detail modal, and the prompt CTA all surface
   these rows under the heading "blockers."
3. We want the URL to match the user-facing word, not the schema's
   relational-glue word.

The schema name stays `dependencies` because it's polymorphic glue
(see SCHEMA.md §dependencies, Design Decision #4) — `dependencies` is
the right relational name. We don't rename the table just because one
UI surface picks a different word.

So: `PUT /api/blockers/<id>` updates a row in the `dependencies`
table with `id = <id>`. Future readers: don't grep for a `blockers`
table. There isn't one.

## Mount story

Standard. Client composes `api/blockers/<id>` against the configured
mount prefix (prod `/lifeplan/`, dev `/`). Server route registered on
the mount-relative path `/api/blockers/<id>` and reached through the
existing mount-stripping in `server.py`. No redirects; no `Location`
header.

## Endpoints

### `POST ${MOUNT}api/blockers` — create

Creates a new `dependencies` row with `blocked_type='goal'`. Backs the
+Blocker picker in the goal-detail modal. The picker only ever blocks a
goal (Iris's design); blocking a task is out of scope for this dispatch.

- **Auth:** required (cookie session). Same as every other
  state-changing API endpoint.
- **Request headers:** `Content-Type: application/json`. Enforced by
  `server.py::_enforce_content_type` — non-JSON gets a 415 before the
  handler is called.
- **Request body:** flat shape per Iris's design — the picker emits a
  `blocker_<type>_id` field that matches the chosen `blocker_type`,
  rather than a generic `blocker_id` field. The server maps the flat
  shape onto the `dependencies` polymorphic columns.

  ```json
  {
    "goal_id":                    <int, required>,
    "blocker_type":               "goal" | "task" | "external_system",
    "blocker_goal_id":            <int>,    // required iff blocker_type='goal'
    "blocker_task_id":            <int>,    // required iff blocker_type='task'
    "blocker_external_system_id": <int>,    // required iff blocker_type='external_system'
    "notes":                      "<string, optional>"
  }
  ```

  Exactly one of the three `blocker_<type>_id` fields is consulted —
  whichever matches the chosen `blocker_type`. The other two are
  ignored if present (the picker only emits the matching one; this
  contract does not 400 on extras to leave room for future shape
  evolution without breaking the client).

- **Response 201:** the full enriched row, same shape as one row of
  `GET /api/dependencies` and identical to the response of
  `PUT /api/blockers/<id>`. Concretely:

  ```json
  {
    "id":           <int>,
    "blocker_type": "goal" | "task" | "external_system",
    "blocker_id":   <int>,
    "blocker_name": "<JOIN-derived>",
    "blocked_type": "goal",
    "blocked_id":   <int>,
    "blocked_name": "<JOIN-derived>",
    "notes":        "<string or null>",
    "resolved":     0,
    "resolved_at":  null,
    "created_at":   "<ISO8601 UTC>"
  }
  ```

  `resolved=0`, `resolved_at=null`, and `created_at=now()` are server
  defaults — the client cannot set them. The shape matches the existing
  goal-detail blocker render path so the new row drops in without a
  follow-up GET.

- **Response 400:** missing or malformed input. Body is `{"error":
  "<message>"}`; the message names the field, never the value.
  Specific messages:
  - `goal_id is required` — missing or empty `goal_id`.
  - `goal_id must be an integer` — non-int `goal_id`.
  - `blocker_type is required` — missing/empty.
  - `blocker_type must be one of: goal, task, external_system` —
    unsupported value.
  - `blocker_<type>_id is required for blocker_type='<type>'` — the
    matching id field is missing for the chosen type.
  - `blocker_<type>_id must be an integer` — non-int id.
  - `notes must be a string or null` — wrong type.
  - `body must be a JSON object` — body wasn't an object.

- **Response 404:** referenced entity does not exist.
  - `{"error": "goal not found"}` — `goal_id` doesn't match any
    `goals` row.
  - `{"error": "<blocker_type> not found"}` — the chosen
    `blocker_<type>_id` doesn't match any row in the referenced table
    (e.g. `task not found`, `external_system not found`).

- **Response 409:** duplicate edge. A row with the same
  `(blocked_type='goal', blocked_id, blocker_type, blocker_id)` already
  exists. Resolved-state is **not** part of the dedupe key — re-adding
  an edge that was previously resolved is still a duplicate of the
  existing row.

  ```json
  {"error": "blocker already exists", "id": <existing-row-id>}
  ```

  The `id` lets the picker navigate to (or flash) the existing row
  instead of creating a parallel one.

- **Response 422:** self-block. `blocker_type='goal'` with
  `blocker_goal_id == goal_id`. A goal cannot block itself.

  ```json
  {"error": "a goal cannot block itself"}
  ```

  Distinguished from 400 because the input is well-formed; the failure
  is semantic (the edge would be a self-loop). 422 lets the UI render
  a tailored message.

- **Response 415:** non-JSON `Content-Type`. Issued by
  `_enforce_content_type` before the handler runs.

#### Validation order

The handler validates in this order, bailing on the first failure:

1. Body is a JSON object.
2. `goal_id` present, integer.
3. `blocker_type` present, in the supported set.
4. Matching `blocker_<type>_id` present, integer.
5. `notes` is string-or-null if present.
6. Self-block check (cheap, before any DB hit).
7. `goal_id` exists in `goals` (404).
8. Blocker entity exists in its table (404).
9. Duplicate-edge check (409).
10. Insert and return the enriched row (201).

The order matters for the error matrix: the structural 400s come
before the semantic 422 before the lookup 404s before the conflict
409. Clients can rely on this ordering for error handling.

#### Privacy

- No logging of `notes` content.
- No logging of the enriched row's `blocker_name` or `blocked_name`
  (could leak goal/task titles).
- 400 responses echo only field names, never the offending value.

### `PUT ${MOUNT}api/blockers/<id>` — partial update

Updates one or more mutable fields on a single dependency row.

- **Auth:** required (cookie session). Same as every other
  state-changing API endpoint.
- **Request headers:** `Content-Type: application/json`. Enforced by
  `server.py::_enforce_content_type` — non-JSON content types get a
  415 before the handler is called. This is the architecturally
  correct CSRF defence in depth on state-changing methods that have
  bodies.
- **Request body:** JSON object containing any subset of the mutable
  fields below. Empty `{}` is rejected as a 400 (no-op writes are a
  client bug). Unknown keys are rejected as a 400 (fail-closed; do not
  silently drop).

  ```json
  {
    "resolved": <bool or 0|1, optional>,
    "notes":    "<string or null, optional>"
  }
  ```

  **Mutable fields (verified against the live `dependencies` table):**

  | Body field | Column      | Type                        | Notes |
  |------------|-------------|-----------------------------|-------|
  | `resolved` | `resolved`  | bool / `0` / `1`            | Triggers the dual-write — see below. |
  | `notes`    | `notes`     | string or null              | Freeform; pass `null` to clear. |

  **Not mutable via this endpoint:**

  - `id`, `created_at` — never editable.
  - `blocker_type`, `blocker_id`, `blocked_type`, `blocked_id` — these
    define the *identity* of the dependency edge (which thing blocks
    which). Changing them would be re-pointing the edge, which is a
    delete-and-recreate operation, not a partial update. If a future
    UI needs that, it deletes and re-POSTs.
  - `resolved_at` — derived; the handler writes it as part of the
    `resolved` dual-write. Clients cannot set it directly; sending it
    in the body is a 400 (unknown key).

  **Note on Iris's "name and type":** Iris's brief said the future
  edit menu wants `{resolved, name, type, notes}`. The `dependencies`
  table has neither a `name` nor a `type` column — the "name" the UI
  shows is derived in the GET via a `CASE` over `blocker_type`
  (joining `goals.title` / `tasks.title` / `external_systems.name`),
  and the "type" is the polymorphic `blocker_type` discriminator. The
  display name is therefore not editable on the dependency row itself
  — to rename what shows, edit the underlying goal/task/external
  system. `blocker_type` is part of the edge identity and isn't a
  partial-update field (see above). So "name and type" do not
  appear in this contract's body schema; only `resolved` and `notes`
  do. If a future UI needs to "change what this blocker points at,"
  that is delete + re-create, not PUT.

- **Response 200:** the full updated row, enriched in the same shape
  `GET /api/dependencies` returns each row in. Concretely:

  ```json
  {
    "id":           <int>,
    "blocker_type": "goal" | "task" | "external_system",
    "blocker_id":   <int>,
    "blocker_name": "<string or null>",
    "blocked_type": "goal" | "task",
    "blocked_id":   <int>,
    "blocked_name": "<string or null>",
    "notes":        "<string or null>",
    "resolved":     0 | 1,
    "resolved_at":  "<ISO8601 UTC string or null>",
    "created_at":   "<ISO8601 UTC string>"
  }
  ```

  `blocker_name` and `blocked_name` are the same JOIN-derived display
  strings that `GET /api/dependencies` already returns. Including them
  in the PUT response means the UI does not need a follow-up GET to
  re-render the row's display name.

- **Response 400:**
  - `{"error": "no fields to update"}` if the body is `{}` or has no
    recognised keys.
  - `{"error": "unknown field: <key>"}` if the body contains any key
    not in the mutable set above.
  - `{"error": "resolved must be a boolean"}` if `resolved` is present
    but not `bool`/`0`/`1`/`true`/`false`. (Strings like `"yes"` are
    rejected; the UI sends real JSON booleans.)
  - `{"error": "notes must be a string or null"}` if `notes` is
    present but not `str` or `None`.
  - `{"error": "Invalid blocker ID"}` from the route layer if the URL
    path's `<id>` segment doesn't parse as an integer.

- **Response 404:** `{"error": "Blocker not found"}` if no
  `dependencies` row has the supplied `id`.

- **Response 415:** non-JSON `Content-Type`. Issued by
  `_enforce_content_type` before the handler runs.

### `DELETE ${MOUNT}api/dependencies/<id>` — unchanged (not implemented today)

There is currently **no** server-side DELETE endpoint for
dependencies. Deletes happen indirectly via the parent goal/task DELETE
handlers (`handle_delete_goal` and `handle_delete_task` both clear
related `dependencies` rows). If a future Lumen flow needs a direct
delete-this-blocker action, that is a separate contract and a separate
handler — out of scope here. This contract does not change anything
about the existing cleanup-on-parent-delete behaviour.

### `GET ${MOUNT}api/dependencies` — extended (additive)

Already returns `SELECT d.*, blocker_name, blocked_name FROM
dependencies d`. `d.*` already includes `resolved` and `resolved_at`
since both are real columns on the table. No handler change is
required for this endpoint to satisfy the "blockers list / hero must
read `resolved` and `resolved_at`" need.

### `GET ${MOUNT}api/goals/<id>` — extended (additive)

The goal-detail enrichment in `enrich_goal` builds a `blockers` list
on each goal. Today the SELECT is column-explicit and **does not**
return `resolved_at`. This contract extends that SELECT to include
`resolved_at` (additive — `resolved` was already returned). The
shape becomes:

```json
{
  "id": <int>,
  "blocker_type": "...",
  "blocker_id": <int>,
  "blocker_name": "...",
  "blocker_status": "...",
  "notes": "...",
  "resolved": 0 | 1,
  "resolved_at": "<ISO8601 UTC or null>"
}
```

Lumen needs the timestamp on this surface so the goal-detail modal
can dim resolved blockers (and, optionally, render "(resolved Apr 22)"
labels) without a follow-up fetch.

## Resolve / un-resolve dual-write

The handler enforces the schema rule from SCHEMA.md Design Decision
#14: `resolved` and `resolved_at` always move together, in the same
UPDATE statement. Clients cannot desync them.

| Body                           | SQL written                                                   |
|--------------------------------|---------------------------------------------------------------|
| `{"resolved": true}` / `1`     | `SET resolved = 1, resolved_at = datetime('now')`             |
| `{"resolved": false}` / `0`    | `SET resolved = 0, resolved_at = NULL`                        |
| `{"resolved": true, "notes": "x"}` | both fields above plus `notes = 'x'`                       |
| `{"notes": "x"}` (no `resolved`)   | `notes = 'x'` only; `resolved` and `resolved_at` untouched  |

Toast-undo support comes for free from this: a successful resolve and
a successful un-resolve are two PUTs on the same URL with the same
shape. No separate endpoint, no separate state machine, no separate
contract. Iris's "via a follow-up PUT, no separate endpoint" is
satisfied directly.

The handler ignores any client-supplied `resolved_at` value — even if
present, it is overwritten by the dual-write or rejected as an
unknown key. This is the schema-level invariant.

## Privacy

- No logging of `notes` content at any level.
- No logging of `blocker_name` / `blocked_name` (could leak goal/task
  titles).
- No logging of the request body. Standard pattern.
- 4xx error responses return only the field name, never the offending
  value, when echoing what was wrong (e.g. `"unknown field: foo"` is
  fine; `"unknown field: foo, value=...somecontent..."` is not).

## Caller obligations

- **Hero / goal-detail modal / prompts (Lumen):** PUT
  `application/json` to `${MOUNT}api/blockers/<id>` with the shape
  above. Render the returned row directly — `resolved` /
  `resolved_at` / `notes` / `blocker_name` are all in the response
  and no follow-up GET is required.
- **Toast undo:** within the toast window, fire a follow-up
  `PUT ${MOUNT}api/blockers/<id>` with `{"resolved": false}`. Same
  endpoint, same auth, same response shape.
- **Future edit menu (Lumen):** the same endpoint accepts
  `{"notes": "..."}` for partial-edit of the freeform context. Since
  display name and type are not mutable on the edge, the menu should
  surface those as read-only or route the user to edit the underlying
  goal/task/external system.

## Error matrix

| Status | Meaning                                                  | Client behaviour                                           |
|--------|----------------------------------------------------------|------------------------------------------------------------|
| 200    | Updated; body is the full enriched row                   | Replace local row state from the response                  |
| 400    | Malformed body (empty, unknown key, bad type)            | Surface a generic "couldn't update" error; keep local state |
| 404    | No such blocker id                                       | Refresh the list — likely deleted out from under the UI    |
| 415    | Non-JSON `Content-Type`                                  | Should never happen from the UI; treat as a bug            |
| 5xx    | Unexpected server error                                  | Generic error toast; preserve user's intent in the UI       |

## What this does not protect against

- **Concurrent toggles.** Two PUTs in flight at once (resolve + undo,
  or two browser tabs) race; whichever lands second wins. Acceptable
  for a single-user app; would need an `If-Match`/version field for
  multi-user.
- **Replay of an old PUT body.** No token, no nonce. A leaked session
  cookie can flip `resolved` repeatedly. CSRF is mitigated by the
  JSON content-type gate plus the `SameSite` session cookie; replay
  by an attacker who already has the session is out of scope (the
  threat model is "lost laptop / leaked cookie," and at that point
  blocker toggling is not the worst available action).
- **Schema drift.** The handler hardcodes the mutable-field set. If
  someone adds a column to `dependencies` and expects PUT to write
  it, they have to update both the contract and the handler. This is
  deliberate — fail-closed against unknown keys is the security
  posture, not a bug.

## Open questions

- ~~Should `name` and `type` be mutable as the brief originally
  framed?~~ No — see "Note on Iris's 'name and type'" in the request
  body section. Display name is derived; `blocker_type` is edge
  identity.
- ~~Separate endpoint for resolve vs general edit?~~ No — Iris asked
  for unified endpoint, and the dual-write invariant is easier to
  enforce in one handler.
- ~~Add DELETE here?~~ No — out of scope; deletes still cascade
  through parent goal/task delete handlers as they do today.
