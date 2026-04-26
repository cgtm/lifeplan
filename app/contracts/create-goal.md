# Contract: create-goal

**Authors:** Vault (server), Lumen (client)
**Status:** accepted
**Last updated:** 2026-04-23
**Cairn dispatched:** 2026-04-23 — small feature, mirrors the
create-person and create-knowledge precedents; design settled, no
review back-and-forth expected.

Manual creation of `goals` rows via the new "+ New goal" button on the
goals list view. Closes the dead-end where the only way to create a
goal was via brain-dump auto-extraction or a direct DB write — there
was no front-door UI write path. Vault owns the server half (this
contract + the handler + the route); Lumen owns the form, the button,
and the post-create navigation.

## Mount story

Standard. Client composes `api/goals` against the configured mount
prefix (prod `/lifeplan/`, dev `/`). Server route is registered on the
mount-relative path `/api/goals` and is reached through the existing
mount-stripping in `server.py`. No redirects; no `Location` header.
No mount-awareness work beyond the existing pattern.

## Endpoints

### `POST ${MOUNT}api/goals`

- **Request headers:** `Content-Type: application/json`.
- **Request body:**
  ```json
  {
    "title":       "<string, required, non-empty after strip>",
    "description": "<string, optional, defaults to ''>",
    "status":      "<one of: active, completed, stalled, someday, cancelled; defaults to 'active'>",
    "target_date": "<ISO 8601 date string or null, optional>",
    "tags":        ["<string>", ...]   // optional; omitted means no tags applied
  }
  ```
- **Response 201:** the full enriched row, same shape as one element of
  the array returned by `GET ${MOUNT}api/goals`. Concretely:
  ```json
  {
    "id":           <int>,
    "title":        "<string>",
    "description":  "<string|null>",
    "status":       "<string>",
    "target_date":  "<string|null>",
    "completed_at": null,
    "created_at":   "<ISO8601 UTC>",
    "updated_at":   "<ISO8601 UTC>",
    "tags":           [{"id": <int>, "name": "<string>"}, ...],
    "people":         [],
    "task_total":     0,
    "task_completed": 0,
    "blockers":       []
  }
  ```
  `tags`, `people`, `blockers` are always present (empty list when
  none applied) and `task_total`/`task_completed` are always integers
  (0 on a fresh goal) so the UI can render unconditionally — same
  enrichment as `GET /api/goals` returns via `enrich_goal`.
- **Response 400:** `{"error": "title is required"}` when `title` is
  missing, not a string, or empty after `.strip()`.

(`GET /api/goals/<id>` exists and returns a slightly richer shape that
also includes a `tasks` array. The 201 here matches the **list** shape,
not the single-goal shape — the create response is meant to be slotted
straight into the list view.)

## Status default — `active`

Default is `'active'`, matching the `goals.status` column default in
the schema. The CHECK enum permits `active`, `completed`, `stalled`,
`someday`, `cancelled`. The client may send any of these explicitly.
Unknown values are rejected by SQLite's CHECK constraint and surface as
a 500 — the UI is expected to constrain its own input to the enum, so
a 400-validation path on the server is not warranted for this small
endpoint.

`completed_at` is **always `NULL`** on creation, even if the caller
sends `status: "completed"`. Goals are created in-progress; if a goal
is later marked completed via `PUT`, the existing `handle_update_goal`
sets `completed_at` correctly. This matches the create-knowledge and
create-person pattern of "creates are minimal, lifecycle changes are
updates."

## Duplicates — accepted (deliberate divergence from People)

**Duplicate titles are accepted.** The endpoint does NOT 409 on a
case-insensitive title collision the way `POST /api/people` does. Two
`POST /api/goals {"title": "get fit"}` calls succeed and produce two
distinct rows.

Rationale: identical to the create-knowledge precedent. A goal is an
event-shaped intention, not a stable referent — the same title can
legitimately recur over time ("learn korean", "fix sleep", "plan
holiday"). Treating those as duplicates and refusing the second would
force the user to invent disambiguating titles for what are
deliberately separate goals. People are different — a person is a
stable referent and two `Cam McVey` rows are almost always a mistake.

**For future-Atlas: do NOT add a 409 path here expecting parity with
People.** It is the wrong call for this resource. The pattern is:
People dedupe; everything else doesn't.

## Tags handling

When `tags` is provided as a list of strings, apply them via
`set_tags_for(conn, "goal_tags", "goal_id", id, tag_names)` — same
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

- **+ New goal UI (Lumen):** POST `application/json` to
  `${MOUNT}api/goals`. Render the returned row's `tags[]` directly for
  the success state; insert into the list view without a re-fetch. On
  400, surface the `error` field verbatim (only documented 400 is
  "title is required"). On 5xx, the existing generic UI error handler
  applies.

## Error matrix

| Status | Meaning                              | Client behaviour                         |
|--------|--------------------------------------|------------------------------------------|
| 201    | Created; body is the full row        | Insert into list view; navigate if appropriate |
| 400    | `title` missing or empty             | Surface error inline; keep form state    |
| 5xx    | Unexpected server error              | Generic error toast; preserve form state |

## What this does not protect against

- **Garbage `status`.** SQLite's CHECK constraint catches it, but the
  failure mode is a 5xx, not a friendly 400. Acceptable here because
  the UI controls the input and there's no documented attacker
  scenario for a single-user app posting a malformed enum on purpose.
- **Garbage `target_date`.** No format validation server-side; the
  string goes into TEXT as-is. The UI is expected to use a date
  picker. If a non-ISO string lands in the column, list/sort views
  may render oddly but no crash.
- **Title-spam / accidental double-submit.** Duplicates are accepted
  by design; if the UI fires the same POST twice it produces two
  rows. Lumen's form should disable-on-submit; this contract does
  not.
- **Oversized bodies.** Inherits whatever request-size limit the
  server enforces globally; no endpoint-specific cap.

## Open questions

- ~~Should we 409 on duplicate title?~~ No — see "Duplicates" section.
- ~~Should `status: "completed"` set `completed_at` on create?~~ No —
  see "Status default" section.
