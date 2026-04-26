# Contract: create-task

**Authors:** Vault (server), Lumen (client)
**Status:** accepted
**Last updated:** 2026-04-23
**Cairn dispatched:** 2026-04-23 — small feature, mirrors the
create-person and create-knowledge precedents; design settled, no
review back-and-forth expected.

Manual creation of `tasks` rows via the new "+ New task" button on the
tasks list view. Closes the dead-end where the only way to create a
task was via brain-dump auto-extraction or a direct DB write — there
was no front-door UI write path. Vault owns the server half (this
contract + the handler + the route); Lumen owns the form, the button,
and the post-create navigation.

## Mount story

Standard. Client composes `api/tasks` against the configured mount
prefix (prod `/lifeplan/`, dev `/`). Server route is registered on the
mount-relative path `/api/tasks` and is reached through the existing
mount-stripping in `server.py`. No redirects; no `Location` header.
No mount-awareness work beyond the existing pattern.

## Endpoints

### `POST ${MOUNT}api/tasks`

- **Request headers:** `Content-Type: application/json`.
- **Request body:**
  ```json
  {
    "title":       "<string, required, non-empty after strip>",
    "description": "<string, optional, defaults to ''>",
    "status":      "<one of: active, completed, waiting, someday, cancelled; defaults to 'active'>",
    "due_date":    "<ISO 8601 date string or null, optional>",
    "goal_id":     "<int or null, optional>",
    "tags":        ["<string>", ...]   // optional; omitted means no tags applied
  }
  ```
- **Response 201:** the full enriched row, same shape as one element of
  the array returned by `GET ${MOUNT}api/tasks`. Concretely:
  ```json
  {
    "id":           <int>,
    "title":        "<string>",
    "description":  "<string|null>",
    "goal_id":      <int|null>,
    "goal_title":   "<string|null>",
    "status":       "<string>",
    "due_date":     "<string|null>",
    "completed_at": null,
    "created_at":   "<ISO8601 UTC>",
    "updated_at":   "<ISO8601 UTC>",
    "tags":         [{"id": <int>, "name": "<string>"}, ...],
    "people":       []
  }
  ```
  `tags`, `people` are always present (empty list when none applied)
  so the UI can render unconditionally — same enrichment as
  `GET /api/tasks` returns via `enrich_task`. `goal_title` is `null`
  if `goal_id` is `null`, otherwise the linked goal's title.

  (There is no `GET /api/tasks/<id>` route today. "Matches the row
  shape from `GET /api/tasks`" is the canonical wording — the list
  endpoint already enriches each row, and this response mirrors that
  exactly.)
- **Response 400:** `{"error": "title is required"}` when `title` is
  missing, not a string, or empty after `.strip()`.
- **Response 400:** `{"error": "goal_id does not exist"}` when
  `goal_id` is provided as a non-null integer that does not match any
  row in `goals`. See "goal_id validation" below.

## Status default — `active`

Default is `'active'`, matching the `tasks.status` column default in
the schema. The CHECK enum permits `active`, `completed`, `waiting`,
`someday`, `cancelled`. The client may send any of these explicitly.
Unknown values are rejected by SQLite's CHECK constraint and surface
as a 500 — the UI is expected to constrain its own input to the enum,
so a 400-validation path on the server is not warranted for this
small endpoint.

`completed_at` is **always `NULL`** on creation, even if the caller
sends `status: "completed"`. Tasks are created in-progress; if a task
is later marked completed via `PUT`, the existing `handle_update_task`
sets `completed_at` correctly. Same pattern as create-goal.

## goal_id validation — explicit 400 (divergence from CHECK-only enums)

`goal_id` is optional. `null`, missing, or omitted are all equivalent
and produce a task with no goal link (`goal_id = NULL`).

When `goal_id` is provided as a non-null integer, the server checks
that a `goals` row with that id exists. If it does not, the server
returns `400 {"error": "goal_id does not exist"}` instead of inserting
a dangling reference.

This is a deliberate divergence from how `status` and `item_type`
enums are handled (rely on SQLite's CHECK constraint, accept the 5xx
on bad input). The reason: the FK on `tasks.goal_id` is `ON DELETE
SET NULL` rather than `ON DELETE CASCADE`, which means SQLite **will
not** reject an insert with a non-existent `goal_id` at insert time
unless `PRAGMA foreign_keys = ON` is explicit and the FK is enforced
at insert. Even with FK enforcement on, the failure mode would be
a 5xx with a sqlite IntegrityError. A friendly 400 is cheap to add
and avoids leaving dangling FKs in the worst case.

The validation is a single `SELECT id FROM goals WHERE id = ?`
inside the same connection, before the INSERT. No race condition
worth defending against in a single-user app.

## Duplicates — accepted (deliberate divergence from People)

**Duplicate titles are accepted.** The endpoint does NOT 409 on a
case-insensitive title collision the way `POST /api/people` does.
Two `POST /api/tasks {"title": "reply to nadia"}` calls succeed and
produce two distinct rows.

Rationale: identical to the create-knowledge and create-goal
precedents. A task is an event-shaped action, not a stable referent
— the same title can legitimately recur ("call dentist", "pay
rent", "review prompts"). Treating those as duplicates and refusing
the second would force the user to invent disambiguating titles for
what are deliberately separate tasks. People are different — a
person is a stable referent and two `Cam McVey` rows are almost
always a mistake.

**For future-Atlas: do NOT add a 409 path here expecting parity with
People.** It is the wrong call for this resource. The pattern is:
People dedupe; everything else doesn't.

## Tags handling

When `tags` is provided as a list of strings, apply them via
`set_tags_for(conn, "task_tags", "task_id", id, tag_names)` — same
helper and semantics used by `handle_create_brain_dump`,
`handle_create_knowledge`, and `handle_create_person`. The helper
lowercases, strips, ignores empties, and `INSERT OR IGNORE`s the tag
rows and the junction rows.

`tags` is optional. If the field is absent or omitted, no tags are
applied (the helper is not invoked). Sending `"tags": []` is
equivalent to omitting it.

## Privacy

- No logging of `title`, `description`, or any tag name at any level.
- No logging of the request body. Standard pattern.
- Errors logged at the framework's existing 500-handler granularity
  only; no per-request body in error paths.

## Caller obligations

- **+ New task UI (Lumen):** POST `application/json` to
  `${MOUNT}api/tasks`. Render the returned row's `tags[]` and
  `goal_title` directly for the success state; insert into the list
  view without a re-fetch. On 400, surface the `error` field verbatim
  (documented 400s are "title is required" and "goal_id does not
  exist"). On 5xx, the existing generic UI error handler applies.

## Error matrix

| Status | Meaning                              | Client behaviour                         |
|--------|--------------------------------------|------------------------------------------|
| 201    | Created; body is the full row        | Insert into list view; navigate if appropriate |
| 400    | `title` missing/empty OR bad goal_id | Surface error inline; keep form state    |
| 5xx    | Unexpected server error              | Generic error toast; preserve form state |

## What this does not protect against

- **Garbage `status`.** SQLite's CHECK constraint catches it, but the
  failure mode is a 5xx, not a friendly 400. Acceptable here because
  the UI controls the input.
- **Garbage `due_date`.** No format validation server-side; the
  string goes into TEXT as-is. The UI is expected to use a date
  picker.
- **Title-spam / accidental double-submit.** Duplicates are accepted
  by design; if the UI fires the same POST twice it produces two
  rows. Lumen's form should disable-on-submit; this contract does
  not.
- **`goal_id` race.** A goal could in theory be deleted between the
  validation SELECT and the INSERT. In a single-user app this is not
  a real threat and the FK is `ON DELETE SET NULL` anyway, so the
  worst case is a task that loses its link a moment after being
  linked.
- **Oversized bodies.** Inherits whatever request-size limit the
  server enforces globally; no endpoint-specific cap.

## Open questions

- ~~Should we 409 on duplicate title?~~ No — see "Duplicates" section.
- ~~Should `status: "completed"` set `completed_at` on create?~~ No —
  see "Status default" section.
- ~~Should bad `goal_id` 400 or rely on FK?~~ 400 — see "goal_id
  validation" section.
