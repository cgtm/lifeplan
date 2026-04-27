# Contract: tags

**Authors:** Vault (server), Lumen (client)
**Status:** accepted
**Last updated:** 2026-04-23
**Cairn dispatched:** 2026-04-23 — Iris's design `docs/ux-design/2026-04-26-tags-first-class.md`, with data-architecture sign-off in `docs/architecture/tag-merge-review.md`.

Tags become a first-class navigable surface. Every chip in the app gets
clickable, and there is a top-level `view-tags` view + drawer driven by
the six endpoints below. Vault owns the server half (this contract +
handlers + routes); Lumen owns the view, the drawer, the chip
re-renders, and the document-level click delegate.

## Mount story

Standard. Client composes `api/tags…` against the configured mount
prefix (prod `/lifeplan/`, dev `/`). Server routes are registered on
the mount-relative paths below and reached through the existing
mount-stripping in `server.py`. No redirects; no `Location` header.
No mount-awareness work beyond the existing pattern.

## Endpoints

### `GET ${MOUNT}api/tags`

List every tag with its breakdown across the six junction tables.

- **Request body:** none.
- **Response 200:** array, each element shaped:
  ```json
  {
    "id":          <int>,
    "name":        "<string, lowercased>",
    "total_count": <int>,
    "usage_count": <int>,
    "breakdown": {
      "goals":           <int>,
      "tasks":           <int>,
      "people":          <int>,
      "knowledge":       <int>,
      "journal_entries": <int>,
      "brain_dumps":     <int>
    }
  }
  ```
  Sorted by `usage_count DESC, name ASC`. `total_count` is a legacy
  alias preserved for the existing journal filter consumer
  (`app.js:2291`); `usage_count` carries the same value under the
  canonical name. `breakdown` is new — additive only.

Counts are live (`COUNT(*)` per junction) — Reed's call. Single query
with `LEFT JOIN` over six `GROUP BY` sub-selects, no N+1.
Sub-millisecond at current scale; revisit if the tag count climbs into
the thousands.

### `POST ${MOUNT}api/tags`

Create a tag — or focus the existing row on a case-insensitive
duplicate.

- **Request headers:** `Content-Type: application/json`.
- **Request body:**
  ```json
  { "name": "<string, required, non-empty after strip+lowercase>" }
  ```
- **Response 201:** new tag created, body `{ "id": <int>, "name": "<string>" }`.
- **Response 200:** name already exists (case-insensitive) — body is
  the existing row in the same `{id, name}` shape. **Not 409.** Per
  Iris's spec §4 ("Cam typed it because he wanted to find it; help
  him land on it") and Reed's review §5 sign-off, this supersedes the
  dispatch brief's 409-on-duplicate.
- **Response 400:** `{"error": "name is required"}` when `name` is
  missing, not a string, or empty/whitespace-only after `.strip()`.

Storage: the name is `.strip().lower()`-ed before insert. Mirrors the
helper in `set_tags_for` so the dedup check matches the canonical
storage form everywhere else in the app.

### `PUT ${MOUNT}api/tags/<id>`

Rename a tag.

- **Request headers:** `Content-Type: application/json`.
- **Request body:** `{ "name": "<string, required, non-empty>" }`.
- **Response 200:** body is the updated row `{id, name}`. (No-op
  rename — same name as current — also returns 200 with the row,
  no UPDATE issued.)
- **Response 400:** `{"error": "name is required"}` if missing/empty.
- **Response 404:** `{"error": "tag not found"}` if the id doesn't
  exist.
- **Response 409:** name collision with a *different* existing tag
  (case-insensitive). Body:
  ```json
  { "error": "name already in use", "id": <existing-tag-id> }
  ```
  Reed flagged the rename-collision body as "pick your shape" — we
  pick this one so the UI can offer "merge instead?" without a
  second round-trip.

### `POST ${MOUNT}api/tags/<id>/merge`

Re-point all six junctions from source-tag to target-tag, then drop
the source tag.

- **Request headers:** `Content-Type: application/json`.
- **Request body:** `{ "target_id": <int> }`.
- **Response 200:**
  ```json
  { "ok": true, "target": { "id": <int>, "name": "<string>" } }
  ```
  The UI navigates to / refreshes the surviving tag using `target`.
- **Response 400:** `{"error": "target_id is required"}` if missing
  or not an integer; `{"error": "source and target must differ"}` if
  the merge is into itself (Reed's review §3 — same-id merge would
  silently delete the tag).
- **Response 404:** `{"error": "source tag not found"}` /
  `{"error": "target tag not found"}` if either id is missing.
- **Response 503:** `{"error": "database busy, retry"}` if the
  underlying SQLite reports `SQLITE_BUSY` at `BEGIN IMMEDIATE` —
  the worker held the writer lock for the duration. Client should
  retry. Reed's review §3 explicitly maps this case.

Implementation: the canonical six-junction merge SQL from
`docs/architecture/tag-merge-review.md` §3. `BEGIN IMMEDIATE` on a
fresh connection (so we don't fight any long-lived connection for
the writer lock). For each junction:

```sql
INSERT OR IGNORE INTO <junction> (<fk>, tag_id)
  SELECT <fk>, :target FROM <junction> WHERE tag_id = :source;
DELETE FROM <junction> WHERE tag_id = :source;
```

`INSERT OR IGNORE` handles the composite-PK collision case (entity
already tagged with the target) by silently skipping the duplicate.
The `DELETE` then wipes every source-tag-id row regardless. Six
junctions: `goal_tags`, `task_tags`, `person_tags`, `knowledge_tags`,
`entry_tags`, `brain_dump_tags` — `entry_tags` was missing from the
dispatch brief (Reed flagged it).

### `DELETE ${MOUNT}api/tags/<id>`

Silent cascade. Reed's call (review §4): the UI already shows a
confirm dialog with the impact count, so server-side refuse-when-used
would duplicate the prompt for no safety gain.

- **Request body:** none.
- **Response 204:** no body. Junction rows in all six tables are
  cleaned via `ON DELETE CASCADE` (verified on both sides for every
  junction — see Reed's review §1).
- **Response 404:** `{"error": "tag not found"}` if the id doesn't
  exist.

Implementation is a single statement: `DELETE FROM tags WHERE id = ?`.
`PRAGMA foreign_keys = ON` is set on every connection in `db.py:111`,
so cascades fire reliably.

### `GET ${MOUNT}api/tags/<id>/usages`

Cross-content view for the drawer.

- **Request body:** none.
- **Response 200:**
  ```json
  {
    "tag":    {"id": <int>, "name": "<string>"},
    "usages": {
      "goals":           [ <enriched-goal>, ...   ],
      "tasks":           [ <enriched-task>, ...   ],
      "people":          [ <enriched-person>, ... ],
      "knowledge":       [ <knowledge-with-tags>, ... ],
      "journal_entries": [ <entry-with-tags>, ...  ],
      "brain_dumps":     [
        {
          "id": <int>,
          "captured_at": "<ISO timestamp>",
          "processing_status": "<string>",
          "content_prefix": "<first 200 chars of content>",
          "tags": [{"id": <int>, "name": "<string>"}, ...]
        },
        ...
      ]
    }
  }
  ```
  - `goals`, `tasks`, `people` use the same `enrich_goal`/`enrich_task`/`enrich_person`
    output as `GET /api/goals` / `/api/tasks` / `/api/people` so the UI can re-use
    list-row renderers verbatim.
  - `knowledge` matches the row shape from `GET /api/knowledge` (id, title, content,
    item_type, source, created_at, updated_at, tags).
  - `journal_entries` matches `GET /api/entries` (id, entry_date, content,
    created_at, updated_at, tags).
  - `brain_dumps` use `content_prefix` (first 200 chars) instead of full content —
    the drawer mock shows a one-line teaser, and full content can be hundreds of
    KB. The id is enough for the UI to navigate to the brain-dump detail surface.
- **Response 404:** `{"error": "tag not found"}` if the id doesn't
  exist.

Sorting: goals, tasks, people, knowledge by `id`. Journal entries by
`entry_date DESC, id DESC`. Brain dumps by `captured_at DESC` (matches
the brain-dumps list order). Sections with zero items are still
present in the response (empty list); Iris's design hides them
client-side.

## Privacy

- **No logging of tag names anywhere new.** Same standard as
  `create-knowledge.md` and `create-goal.md`. Tag names are
  user-content; not in stdout, not in stderr, not in error messages.
- **No logging of request bodies.** The standard pattern.
- Errors logged at the framework's existing 500-handler granularity
  only; no per-request body in error paths.
- The merge-busy 503 path does not leak the SQLite error message
  back to the client — the body is a fixed string.

## Caller obligations

- **Tags view (Lumen):** `GET /api/tags` and render the array. Use
  `usage_count` for display and sort key; `total_count` is preserved
  only for the existing journal filter consumer.
- **Tag drawer (Lumen):** `GET /api/tags/<id>/usages`; render each
  section via the same row component already used in the list view
  for that entity type.
- **Chip click (Lumen):** the chip renderers at `app.js:149`,
  `app.js:2279`, `app.js:2373` need `data-tag-id="${t.id}"` so the
  document-level delegated click handler can read the id. (The
  payload already carries it — `get_tags_for` returns `{id, name}`.
  No backend change needed for the chip flow itself.)
- **Create form (Lumen):** `POST /api/tags`. On 200 (focus the
  existing row), pulse-highlight the row. On 201, prepend / insert.
  On 400, surface `error` verbatim.
- **Rename (Lumen):** `PUT /api/tags/<id>`. On 409, present the
  "Did you mean to merge instead?" affordance using the returned
  `id` to seed the merge target.
- **Merge (Lumen):** `POST /api/tags/<id>/merge`. On 200, navigate
  to / refresh the `target` tag; on 503, retry once with a small
  backoff before surfacing an error.
- **Delete (Lumen):** `DELETE /api/tags/<id>`. On 204, remove the
  row from the list and close the drawer if open.

## Error matrix

| Status | Endpoint(s) | Meaning | Client behaviour |
|--------|-------------|---------|------------------|
| 200 | GET /tags, GET /usages, POST /tags (existing), PUT /tags/<id>, POST /merge | Success | Render |
| 201 | POST /tags (new) | Created | Prepend; toast success |
| 204 | DELETE /tags/<id> | Deleted | Remove from list |
| 400 | POST /tags, PUT /tags/<id>, POST /merge | Missing/invalid body | Surface error inline |
| 404 | PUT /tags/<id>, DELETE /tags/<id>, POST /merge, GET /usages | Tag id not found | Toast; refresh list |
| 409 | PUT /tags/<id> | Name collision with another tag | Offer "merge instead?" using returned `id` |
| 503 | POST /merge | Database busy (worker holds writer lock) | Auto-retry once; then toast |
| 5xx | any | Unexpected server error | Generic error toast |

## What this does not protect against

- **Concurrent rename to the same target.** Two simultaneous renames
  to the same new name from two clients would race past the collision
  check; the second insert would fail at the UNIQUE constraint and
  surface as a 5xx. Acceptable: this is a single-user app and there
  is no multi-tab rename UX.
- **Mid-merge worker writes against a vanished source tag.** If the
  worker has cached `:source` in memory before the merge commits and
  inserts a new junction row referencing it after, the FK fails and
  the worker's insert raises `IntegrityError`. Reed's review §3
  notes this is the correct failure mode (the tag was deliberately
  destroyed). The worker's `set_tags_for` re-resolves names to ids
  in the same transaction, so the race is vanishingly narrow.
- **Tag-name spoofing.** Names are user-controlled strings; no length
  limit, no character whitelist beyond what SQLite stores. Acceptable
  for a single-user app — Cam types his own tags. The UI HTML-escapes
  on output (existing `esc()` in `app.js`) so a `<script>` tag in a
  name doesn't execute.
- **Bulk delete / bulk merge.** Iris pocketed these as iterations.
  Each operation is one tag at a time today.
- **Oversized bodies.** Inherits the global 1 MiB request-size limit
  from `server.py` (`MAX_BODY_BYTES`).

## Open questions

- ~~POST /api/tags status on duplicate?~~ 200 with the existing row —
  Iris's UX intent, Reed's sign-off.
- ~~PUT /api/tags/<id> 409 body shape?~~ `{error, id}` — picked one
  and documented it inline above (Reed flagged it as pick-your-shape).
- ~~Manual junction DELETE on tag delete?~~ No — `ON DELETE CASCADE`
  on every junction is the canonical cleanup. See Reed's review §1.
- ~~`entry_tags` in the merge?~~ Yes — six junctions total. The
  dispatch brief listed five and missed `entry_tags`; Reed flagged.
