# Tag Merge / Rename / Delete — Schema & SQL Review

**Status:** accepted
**Author:** Reed (Knowledge Architect)
**Date:** 2026-04-23
**Triggered by:** Iris's design spec `docs/ux-design/2026-04-26-tags-first-class.md` (section 5).
**Implementer to unblock:** Vault (endpoints).
**Audience:** Vault primarily; Lumen for the chip-render note.

This review signs off the data-architecture aspects of Iris's tags-as-first-class design. It covers (a) the cascade semantics that the new `DELETE` and `merge` endpoints rely on, (b) the shape `get_tags_for()` already returns and what changes for the chip-click flow, (c) the final form of the merge SQL, and (d) the DELETE-semantics call.

---

## 1. Cascade semantics — confirmed

All six tag junction tables declare `ON DELETE CASCADE` on **both** sides — the entity-side FK and the `tag_id` FK. Verified against the local DDL (which is canonical: every junction was created by a tracked migration; the only post-v0.1 change to junction definitions is migration `0002_fix_brain_dump_tags_fk.sql`, which rebuilt `brain_dump_tags` and preserved both cascades).

Local DDL, copied verbatim:

```sql
CREATE TABLE goal_tags (
    goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    tag_id  INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
    PRIMARY KEY (goal_id, tag_id)
);
CREATE TABLE task_tags (
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    tag_id  INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
    PRIMARY KEY (task_id, tag_id)
);
CREATE TABLE person_tags (
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    tag_id    INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
    PRIMARY KEY (person_id, tag_id)
);
CREATE TABLE knowledge_tags (
    knowledge_id INTEGER NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
    tag_id       INTEGER NOT NULL REFERENCES tags(id)            ON DELETE CASCADE,
    PRIMARY KEY (knowledge_id, tag_id)
);
CREATE TABLE "brain_dump_tags" (
    brain_dump_id INTEGER NOT NULL REFERENCES brain_dumps(id) ON DELETE CASCADE,
    tag_id        INTEGER NOT NULL REFERENCES tags(id)        ON DELETE CASCADE,
    PRIMARY KEY (brain_dump_id, tag_id)
);
CREATE TABLE entry_tags (
    entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
    tag_id   INTEGER NOT NULL REFERENCES tags(id)            ON DELETE CASCADE,
    PRIMARY KEY (entry_id, tag_id)
);
```

**Prod-DDL note.** I attempted to read the prod schema directly via `ssh your-user@your-domain.example "sqlite3 …"` per Iris's request and the harness blocked it (production-read sandbox). The prod-vs-local divergence Iris worried about is the v0.5 `brain_dump_tags` FK bug — the post-mortem in `data/SCHEMA.md` confirms that migration 0002 was applied and that the post-migration schema (the DDL above) is identical on local and prod. The migration is gated by `PRAGMA user_version` so re-runs are no-ops. I am therefore signing off on the cascade semantics as **definitely correct on local; transitively correct on prod assuming migration 0002 ran**, which is recorded as applied in the SCHEMA.md changelog. If Vault wants belt-and-braces certainty before he ships the DELETE endpoint, Forge can verify in two seconds with `sqlite3 … "PRAGMA user_version;"` (expect `>= 2`).

**What this confirms operationally:**

- `DELETE FROM tags WHERE id = :id` is **sufficient on its own** to remove the tag and every junction row that references it. No manual `DELETE FROM <junction>` is required, and the manual statement is **harmless** if added (the rows are already gone by the time it runs).
- `PRAGMA foreign_keys=ON` is set in `app/db.py:111` (`get_db`) so cascades are active for every connection the API and worker use.

---

## 2. `get_tags_for()` payload shape

`app/db.py:125`:

```python
def get_tags_for(conn, junction_table, fk_column, entity_id):
    rows = conn.execute(
        f"SELECT t.id, t.name FROM tags t "
        f"JOIN {junction_table} jt ON jt.tag_id = t.id "
        f"WHERE jt.{fk_column} = ?",
        (entity_id,),
    ).fetchall()
    return rows_to_dicts(rows)
```

The helper **already returns `{id, name}`** for every tag. Every API endpoint in `app/handlers.py` that attaches tags (entries, brain dumps, goals, tasks, people, knowledge) goes through this helper or its `get_entry_tags()` wrapper, so the wire payload everywhere is `[{id, name}, …]`.

**What needs to change for Iris's design:** nothing on the backend. The frontend renderers in `app/app.js` currently call `${esc(t.name)}` and discard the id (`tagsHtml` at line 149, the journal entry list at line 2279, and `journalDetailTags` at line 2373). Lumen needs to add `data-tag-id="${t.id}"` (and probably `data-tag-name` for the drawer header) to every chip render path. **No API change, no DB change** — Iris's section 3 ("Backend / data implications: `get_tags_for()` already returns `{id, name}` (verify in `db.py`)") was correct on inspection.

**Coordinated change for Lumen:** when he converts `<span class="tag">` to `<button class="tag tag-chip">`, he must also include the id from the existing payload. There are at least three render sites (`tagsHtml`, journal list, journal detail) — flag the journal sites as well as `tagsHtml`, since they're not centralised.

---

## 3. Merge SQL — final form

Iris's draft was the right shape. One refinement: I prefer `INSERT OR IGNORE … SELECT` (her later phrasing in the spec body, section 5) over `UPDATE OR IGNORE` (the dispatch brief's phrasing). Both produce the correct end state, but `INSERT OR IGNORE … SELECT` is easier to reason about — it leaves the source rows untouched and lets a single `DELETE FROM <junction> WHERE tag_id = :source` clean every source row in one statement, regardless of whether each row collided or not. The `UPDATE OR IGNORE` form hinges on the implicit "skipped rows are left in place," which is correct but a step harder to read.

**Final form (Vault should ship exactly this):**

```sql
BEGIN IMMEDIATE;

-- 1. Repoint every junction. INSERT OR IGNORE handles composite-PK
--    collisions (entity already tagged with the target) by silently
--    skipping the would-be duplicate. The original source-tag-id row
--    stays in place until the DELETE that follows.

INSERT OR IGNORE INTO goal_tags (goal_id, tag_id)
  SELECT goal_id, :target FROM goal_tags WHERE tag_id = :source;
DELETE FROM goal_tags WHERE tag_id = :source;

INSERT OR IGNORE INTO task_tags (task_id, tag_id)
  SELECT task_id, :target FROM task_tags WHERE tag_id = :source;
DELETE FROM task_tags WHERE tag_id = :source;

INSERT OR IGNORE INTO person_tags (person_id, tag_id)
  SELECT person_id, :target FROM person_tags WHERE tag_id = :source;
DELETE FROM person_tags WHERE tag_id = :source;

INSERT OR IGNORE INTO knowledge_tags (knowledge_id, tag_id)
  SELECT knowledge_id, :target FROM knowledge_tags WHERE tag_id = :source;
DELETE FROM knowledge_tags WHERE tag_id = :source;

INSERT OR IGNORE INTO entry_tags (entry_id, tag_id)
  SELECT entry_id, :target FROM entry_tags WHERE tag_id = :source;
DELETE FROM entry_tags WHERE tag_id = :source;

INSERT OR IGNORE INTO brain_dump_tags (brain_dump_id, tag_id)
  SELECT brain_dump_id, :target FROM brain_dump_tags WHERE tag_id = :source;
DELETE FROM brain_dump_tags WHERE tag_id = :source;

-- 2. Drop the now-orphaned source tag. ON DELETE CASCADE on each
--    junction would clean any straggler rows here, but at this point
--    there are none.

DELETE FROM tags WHERE id = :source;

COMMIT;
```

Junction list (six tables) is exhaustive against `data/SCHEMA.md` §"Junction Tables (tagging)". **Don't forget `entry_tags`** — Iris's pseudocode in the spec body mentioned it, but the dispatch brief listed only five tables. Six is correct.

### Notes for Vault

- **`BEGIN IMMEDIATE` is warranted.** The worker (`app/worker.py`/`app/processing.py`) writes to junction tables when it auto-tags brain-dump extractions. A merge that holds a deferred (`BEGIN`-only) transaction risks `SQLITE_BUSY` mid-merge if the worker grabs a write lock between statements. `BEGIN IMMEDIATE` acquires the reserved lock up front; the merge either starts cleanly or fails fast at the BEGIN. The endpoint should map `sqlite3.OperationalError: database is locked` to a 503 with a "try again" body so the UI can re-issue.
- **Worker safety during a merge.** The worker's writes are individual `INSERT OR IGNORE INTO <junction> (entity_id, tag_id) VALUES (?, ?)` statements inside short transactions (`set_tags_for` is the relevant helper). Two scenarios:
  1. *Worker writes after merge commits.* If the worker had cached `:source` in memory before the merge and inserts `(entity_id, source_tag_id)` after the merge, the FK on `tag_id` fails — `tags.id = source` is gone — and the insert raises `sqlite3.IntegrityError`. That is the correct failure mode: the tag was deliberately destroyed; the worker shouldn't resurrect it. The worker's call sites use `set_tags_for` which re-resolves names to ids inside the same transaction, so in practice this race is vanishingly narrow (the resolution and the insert are adjacent statements on the same connection). Document the failure mode in `app/contracts/background-processing.md` if Vault wants belt-and-braces; not required for ship.
  2. *Worker writes before merge commits.* `BEGIN IMMEDIATE` blocks the worker's write until the merge commits or rolls back. The worker either gets `SQLITE_BUSY` (and retries on its next 2-second poll) or proceeds against the post-merge tag set. Both are safe.
- **`target_id ≠ source_id` validation.** Yes — validate in the endpoint before opening the transaction. Same-id merge would: (a) `INSERT OR IGNORE … SELECT` no-op (every row already exists), (b) `DELETE FROM <junction> WHERE tag_id = :source` wipe every junction for the tag, (c) `DELETE FROM tags WHERE id = :source` destroy the tag. That is a Cam-hostile silent-delete, so reject with 400 `{error: "source and target must differ"}`.
- **Both ids must exist.** Reject 404 if either tag id is missing. Cheap to check inside the endpoint before `BEGIN IMMEDIATE`.

---

## 4. DELETE semantics — my call

**Silent cascade.** No refuse-when-used, no explicit `?confirm=true` query flag.

Reasoning:

1. The UI **already** carries the confirmation. Iris's section 6 specifies a confirm dialog showing the impact: *"This will remove it from 7 items (3 goals, 2 tasks, 2 knowledge). The items themselves will not be deleted."* Cam clicks Delete only after seeing that. Adding a server-side refuse-or-confirm would either duplicate the prompt or be redundant.
2. The cascade is exactly the desired behaviour — junction rows are bookkeeping, not content. Deleting the tag deletes the labelling; the labelled goals/tasks/etc. are untouched. That's the user's mental model (and Iris's copy reinforces it).
3. Recovery cost is low. If Cam regrets it, recreating the tag is one input field; re-attaching to a handful of items is acceptable manual work for a personal-scale system, and we can revisit if it bites (Iris has "no undo for MVP" already pocketed in the iterations section).
4. Refuse-when-used would punish the common case (Cam *knows* the tag is in use; that's why he's deleting it) for no real safety gain.

**Endpoint:** `DELETE /api/tags/:id` → 204 on success; 404 if the tag doesn't exist. No body required. Implementation is one statement: `DELETE FROM tags WHERE id = ?` inside a transaction (cascade does the junction cleanup). `PRAGMA foreign_keys=ON` is already set on every connection — Vault doesn't need to do anything special.

---

## 5. Endpoint contract — sign-off

| Endpoint | Verdict | Notes |
|---|---|---|
| `POST /api/tags` | Accepted | Body `{name}`. Server normalises (lowercase, hyphenate, strip). Idempotent: existing tag returns 200 with the existing row, **not 409** (matches Iris's section 4 — Cam typed it because he wanted to find it). The dispatch brief's "409 on dedup" is superseded by the section-4 spec; flag for Iris if she disagrees. |
| `PUT /api/tags/:id` | Accepted | Body `{name}`. Normalise. Returns 200 with the updated row, or 409 with `{conflicting_tag_id}` if normalisation collides with another existing tag's name (so the UI can offer "merge instead" without a second round-trip). |
| `POST /api/tags/:id/merge` | Accepted | Body `{target_id}`. Validates `target_id != source_id` (400) and that both tags exist (404). Runs the SQL in §3 inside `BEGIN IMMEDIATE`. Returns 200 with the merged target row including the new `total_count` and `breakdown`. |
| `DELETE /api/tags/:id` | Accepted | Silent cascade per §4. 204 on success, 404 if missing. |
| `GET /api/tags/:id/usages` | Accepted | Shape per Iris's section 2: `{tag: {id, name}, usages: {goals: [...], tasks: [...], people: [...], knowledge: [...], journal: [...], dumps: [...]}}`. Items reuse the existing list-summary shape per type (id + title/name + whatever the existing list endpoint returns). One round-trip — six small `SELECT … JOIN` queries per type. |
| `GET /api/tags` extension | Accepted | Add `usage_count` and `breakdown: {goals, tasks, people, knowledge, journal, dumps}` per row. **Live counts**, not denormalised — six `SELECT COUNT(*) FROM <junction> WHERE tag_id = ?` per tag, or (preferable) one query that GROUP-BYs over all junctions via UNION ALL. At ~200 tags and a few thousand rows total, the cost is sub-millisecond and a denormalised counter would be a maintenance burden the dataset doesn't justify. Re-evaluate at 5k+ tags. |

**One sample query for the breakdown** (Vault — feel free to use or replace; this is illustrative, not prescriptive):

```sql
SELECT
  t.id,
  t.name,
  COALESCE(g.n,0)  AS goals,
  COALESCE(tk.n,0) AS tasks,
  COALESCE(p.n,0)  AS people,
  COALESCE(k.n,0)  AS knowledge,
  COALESCE(e.n,0)  AS journal,
  COALESCE(b.n,0)  AS dumps,
  COALESCE(g.n,0)+COALESCE(tk.n,0)+COALESCE(p.n,0)
   +COALESCE(k.n,0)+COALESCE(e.n,0)+COALESCE(b.n,0) AS usage_count
FROM tags t
LEFT JOIN (SELECT tag_id, COUNT(*) n FROM goal_tags      GROUP BY tag_id) g  ON g.tag_id  = t.id
LEFT JOIN (SELECT tag_id, COUNT(*) n FROM task_tags      GROUP BY tag_id) tk ON tk.tag_id = t.id
LEFT JOIN (SELECT tag_id, COUNT(*) n FROM person_tags    GROUP BY tag_id) p  ON p.tag_id  = t.id
LEFT JOIN (SELECT tag_id, COUNT(*) n FROM knowledge_tags GROUP BY tag_id) k  ON k.tag_id  = t.id
LEFT JOIN (SELECT tag_id, COUNT(*) n FROM entry_tags     GROUP BY tag_id) e  ON e.tag_id  = t.id
LEFT JOIN (SELECT tag_id, COUNT(*) n FROM brain_dump_tags GROUP BY tag_id) b ON b.tag_id  = t.id
ORDER BY usage_count DESC, t.name ASC;
```

---

## 6. Open questions for Vault

None blocking. Two minor clarifications:

1. **Status code on `POST /api/tags` for an existing tag.** I've signed off on **200** with the existing row (matches Iris's UX intent). If Vault would rather return 201-on-create and 200-on-existing as a stricter REST shape, that's fine too — the UI will treat both as success. **Either is acceptable; pick one and write a test.**
2. **`PUT /api/tags/:id` collision response shape.** I'm specifying `409 {conflicting_tag_id: <int>}` so the UI can offer "merge instead" without re-fetching. Vault may already have a house style for 409 bodies — defer to that, but the conflicting id needs to be in the response somewhere.

Everything else is fully specified by Iris's doc plus this review. **Vault is unblocked to implement.**

---

## 7. Open questions for Cam

**Zero.** All design questions are settled by Iris's section 5 plus this review. The cascade-semantics question Iris flagged in her "spec ambiguity" §11.4 is answered here (silent cascade, §4); the `get_tags_for()` shape question (§11.2) is answered here (already correct, frontend-only change for Lumen, §2).

---

## Hand-off

- **Vault:** unblocked. Implement the six endpoints / extensions in §5 using the merge SQL in §3 and the cascade behaviour in §1 + §4. Two clarification notes in §6 are pick-your-shape, not blocking.
- **Lumen:** flagged. `get_tags_for` already returns `{id, name}`; the chip render paths (`tagsHtml` line 149 plus the journal sites at `app.js:2279` and `2373`) need to start emitting `data-tag-id`. Pure frontend change.
- **Iris:** one minor flag — the dispatch brief's "POST /api/tags returns 409 on duplicate" was superseded by spec §4 ("focus the existing row, no error"). I've signed off on the §4 behaviour. Confirm if you intended otherwise.
