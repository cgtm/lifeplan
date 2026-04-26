# Contract: create-knowledge

**Authors:** Vault (server), Lumen (client)
**Status:** accepted
**Last updated:** 2026-04-23
**Cairn dispatched:** 2026-04-23 — small feature, design settled, no review back-and-forth.

Manual creation of `knowledge_items` rows via the new "Add Knowledge" UI.
Closes the dead-end where users with `knowledge_gap` prompts had no path
to act on them: the prompt now carries a CTA that lands on a form that
POSTs through this endpoint. Vault owns the server half (this contract +
the handler + the route); Lumen owns the form, the CTA, and any URL
pre-fill on the prompt link.

## Mount story

Standard. Client composes `api/knowledge` against the configured mount
prefix (prod `/lifeplan/`, dev `/`). Server route is registered on the
mount-relative path `/api/knowledge` and is reached through the existing
mount-stripping in `server.py`. No redirects; no `Location` header. No
mount-awareness work beyond the existing pattern.

## Endpoints

### `POST ${MOUNT}api/knowledge`

- **Request headers:** `Content-Type: application/json`.
- **Request body:**
  ```json
  {
    "title":     "<string, required, non-empty after strip>",
    "content":   "<string, optional, defaults to ''>",
    "item_type": "<one of: note, fact, decision, learning, reference; defaults to 'note'>",
    "tags":      ["<string>", ...]   // optional; omitted means no tags applied
  }
  ```
- **Response 201:** the full enriched row, same shape as one element of
  the array returned by `GET ${MOUNT}api/knowledge`. Concretely:
  ```json
  {
    "id":         <int>,
    "title":      "<string>",
    "content":    "<string>",
    "item_type":  "<string>",
    "source":     null,
    "created_at": "<ISO8601 UTC>",
    "updated_at": "<ISO8601 UTC>",
    "tags":       [{"id": <int>, "name": "<string>"}, ...]
  }
  ```
  `tags` is always present (empty list when none applied) so the UI can
  render unconditionally.
- **Response 400:** `{"error": "title is required"}` when `title` is
  missing, not a string, or empty after `.strip()`.

(There is no `GET /api/knowledge/<id>` route today. "Matches the row
shape from `GET /api/knowledge`" is the canonical wording — the list
endpoint already enriches each row with `tags`, and this response
mirrors that exactly.)

## Item type default — `note`

Default is `'note'`, **not** `'fact'`. The Add Knowledge UI is the
landing point for `knowledge_gap` prompt CTAs, and the prompt's intent
is "capture a quick note about this gap." `note` is the right semantic
default for a manually-added quick capture; `fact` is for structured
data (addresses, passport details, etc.) and would be the wrong
shape for the typical write.

Other valid values from the existing `CHECK` enum on `knowledge_items.item_type`:
`fact`, `decision`, `learning`, `reference`. The client may send any of
these explicitly. Unknown values are rejected by SQLite's CHECK
constraint and surface as a 500 — the UI is expected to constrain its
own input to the enum, so a 400-validation path on the server is not
warranted for this small endpoint.

## Duplicates — accepted (deliberate divergence from People)

**Duplicate titles are accepted.** The endpoint does NOT 409 on a
case-insensitive title collision the way `POST /api/people` does. Two
`POST /api/knowledge {"title": "meeting notes"}` calls succeed and
produce two distinct rows.

Rationale: knowledge_items, especially `note`-typed quick captures, are
commonly repeat-named ("meeting notes", "ideas", "todo", "shopping").
Treating those as duplicates and refusing the second would force the
user to invent disambiguating titles for what are deliberately separate
captures. People are different — a person is a stable referent, and
two `Cam McVey` rows are almost always a mistake; a knowledge item is
an event-shaped capture, and two `meeting notes` rows are almost always
intended.

**For future-Atlas: do NOT add a 409 path here expecting parity with
People.** It is the wrong call for this resource. If a future feature
needs dedup (e.g. a "facts" resource with stable identity), that's a
separate endpoint or a separate item_type-specific check, not a
retrofit of this one.

## Tags handling

When `tags` is provided as a list of strings, apply them via
`set_tags_for(conn, "knowledge_tags", "knowledge_id", id, tag_names)` —
same helper and same semantics used by brain-dump tag handling in
`handle_create_brain_dump`. The helper lowercases, strips, ignores
empties, and `INSERT OR IGNORE`s the tag rows and the junction rows.

`tags` is optional. If the field is absent or omitted, no tags are
applied (the helper is not invoked). The caller — the Add Knowledge UI
or any prompt CTA pre-fill — is responsible for deciding whether to
send a tag list at all. Sending `"tags": []` is equivalent to omitting
it (no tags applied; no rows in `knowledge_tags`).

## Privacy

- No logging of `title`, `content`, or any tag name at any level.
- No logging of the request body. Standard pattern.
- Errors logged at the framework's existing 500-handler granularity
  only; no per-request body in error paths.

## Caller obligations

- **Add Knowledge UI (Lumen):** POST `application/json` to
  `${MOUNT}api/knowledge`. Render the returned row's `tags[]` directly
  for the success state. On 400, surface the `error` field verbatim
  (only documented 400 is "title is required"). On 5xx, the existing
  generic UI error handler applies.
- **Prompt CTA (Lumen):** the `knowledge_gap` prompt's CTA may
  pre-fill the form via URL params (e.g. `?title=…&tags=…`) — purely a
  client concern. The server has no awareness of this and accepts the
  same JSON body regardless of how the form was populated.

## Error matrix

| Status | Meaning                              | Client behaviour                         |
|--------|--------------------------------------|------------------------------------------|
| 201    | Created; body is the full row        | Navigate to / render the new item        |
| 400    | `title` missing or empty             | Surface error inline; keep form state    |
| 5xx    | Unexpected server error              | Generic error toast; preserve form state |

## What this does not protect against

- **Garbage `item_type`.** SQLite's CHECK constraint catches it, but
  the failure mode is a 5xx, not a friendly 400. Acceptable here
  because the UI controls the input and there's no documented attacker
  scenario for a single-user app posting a malformed enum on purpose.
- **Title-spam / accidental double-submit.** Duplicates are accepted by
  design; if the UI fires the same POST twice it produces two rows.
  Lumen's form should disable-on-submit; this contract does not.
- **Oversized bodies.** Inherits whatever request-size limit the server
  enforces globally; no endpoint-specific cap.

## Open questions

- ~~Should we 409 on duplicate title?~~ No — see "Duplicates" section.
- ~~Default `item_type`?~~ `note` — see "Item type default" section.
