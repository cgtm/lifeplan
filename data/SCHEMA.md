# lifeplan.db -- Schema Documentation

**Version:** 0.6 (blocker resolution timestamp)
**Created:** 2026-04-20
**Last updated:** 2026-04-23
**Author:** Reed (Knowledge Architect)

## Overview

A personal knowledge management database for Cam's life system. Built around one core principle: **capture first, structure later**. The brain dump zone accepts raw text with zero friction; goals, tasks, people, and knowledge items provide the structure that emerges afterwards.

The system tracks life goals and their dependencies (what blocks what), links people as first-class entities, and references external tools (like the Finance App) without duplicating their data.

### Design Principles

1. **ONE capture point** -- brain dumps accept anything, no categorisation at entry time
2. **Structure after capture** -- the system (and team) helps tag and link afterwards
3. **Track blockers and dependencies** -- what's blocking what, explicitly modelled
4. **People are first-class** -- not just names in text, but entities with relationships
5. **Goals with dependencies** -- life goals link to tasks, to other goals, and to blockers
6. **Don't duplicate external systems** -- reference them, don't replicate their data
7. **Support completed/historical items** -- nothing is deleted, status tracks lifecycle
8. **Enable prompting** -- the schema supports queries like "what haven't I followed up on?"

## Tables

### journal_entries

Daily freeform journal entries. One row per entry. **Pre-existing from v0.1.**

| Column     | Type    | Constraints       | Description                                      |
|------------|---------|-------------------|--------------------------------------------------|
| id         | INTEGER | PK, autoincrement | Unique identifier                                |
| entry_date | TEXT    | NOT NULL          | The date the entry is *about* (ISO 8601: YYYY-MM-DD) |
| content    | TEXT    | NOT NULL          | Freeform text (markdown or plain)                |
| created_at | TEXT    | NOT NULL, default now | When the row was inserted (UTC)              |
| updated_at | TEXT    | NOT NULL, default now | Last modification (UTC)                      |

**Index:** `idx_journal_entry_date` on `entry_date`

---

### brain_dumps

Raw capture zone. Zero-friction input -- just text and a timestamp. No categorisation required. Auto-processing extracts tasks, knowledge, people mentions, and tags. See `PROCESSING_RULES.md` for the full extraction specification.

| Column             | Type    | Constraints       | Description                              |
|--------------------|---------|-------------------|------------------------------------------|
| id                 | INTEGER | PK, autoincrement | Unique identifier                        |
| content            | TEXT    | NOT NULL          | Raw text, no formatting required         |
| captured_at        | TEXT    | NOT NULL, default now | When Cam typed it                    |
| processed          | INTEGER | NOT NULL, default 0  | 0 = unprocessed, 1 = triaged (legacy, kept for backward compat) |
| processed_at       | TEXT    | nullable          | When it was triaged                      |
| processing_status  | TEXT    | NOT NULL, default 'unprocessed', CHECK in (unprocessed, queued, processing, processed, needs_review, failed) | Richer processing state -- denormalised cache of `work_queue.status` |
| processed_items    | TEXT    | nullable (JSON)   | JSON object with all extracted items, confidence scores, and created row IDs. Schema defined in PROCESSING_RULES.md |
| created_at         | TEXT    | NOT NULL, default now | Row insertion timestamp (UTC)        |
| updated_at         | TEXT    | NOT NULL, default now | Last modification (UTC)              |

**Indexes:** `idx_brain_dumps_processed` on `processed`, `idx_brain_dumps_captured` on `captured_at`, `idx_brain_dumps_processing_status` on `processing_status`

**Processing status values:**
- `unprocessed` -- legacy default for pre-migration rows; renders identically to `queued` in the UI
- `queued` -- a `work_queue` row exists with `status='queued'` waiting for the worker
- `processing` -- the worker has claimed the queue row (`work_queue.status='processing'`)
- `processed` -- queue row terminal (`status='done'`); all extracted items were auto-created (high confidence)
- `needs_review` -- queue row terminal (`status='done'`); contains suggested items awaiting Cam's approval
- `failed` -- queue row terminal (`status='failed'`); worker exhausted retries. Cam can re-queue via `POST /api/brain-dumps/<id>/retry`

**Cache relationship.** `processing_status` is a denormalised display cache of the corresponding `work_queue` row's `status`. The worker writes both inside the same transaction so the UI can render badges from a single row read without joining. `work_queue` is the source of truth (e.g. for watchdog math on `claimed_at`); `brain_dumps.processing_status` exists purely to keep list views fast. See [`app/contracts/background-processing.md`](../app/contracts/background-processing.md) for the full state machine and sync rules.

**Retrieval scenarios:** "Show me everything I dumped this week that hasn't been processed yet." / "What did I capture on Tuesday?" / "What brain dumps need my review?" / "Which dumps are waiting on the worker right now?"

---

### work_queue

Operational queue for background jobs. The async worker (`python3 -m app.worker`) polls this table at 2-second intervals, claims one job at a time, runs it, and writes the outcome back here. Two job types today: brain-dump processing and prompt-set regeneration. **Source of truth** for job state; `brain_dumps.processing_status` is a denormalised cache. See [`app/contracts/background-processing.md`](../app/contracts/background-processing.md) for the full lifecycle.

| Column       | Type    | Constraints | Description |
|--------------|---------|-------------|-------------|
| id           | INTEGER | PK, autoincrement | Unique identifier |
| job_type     | TEXT    | NOT NULL, CHECK in (brain_dump, prompt_generation) | What kind of work |
| target_id    | INTEGER | nullable | When `job_type='brain_dump'`, the `brain_dumps.id` this job is for. NULL for `prompt_generation` (one canonical prompt-set; no id needed). **Intentionally not a foreign key** -- the queue is operational history, and a brain-dump deletion shouldn't fail or cascade into queue audit rows. |
| status       | TEXT    | NOT NULL, default 'queued', CHECK in (queued, processing, done, failed) | Job lifecycle state |
| attempts     | INTEGER | NOT NULL, default 0 | Incremented at claim time, not at finalisation. A crash mid-job consumes an attempt -- deliberate poison-pill defence. Max 3 before terminal `failed`. |
| error        | TEXT    | nullable | Last exception's `f"{type(exc).__name__}: {exc}"`. No tracebacks (those go to the worker log). NULL on the `done` path. |
| queued_at    | TEXT    | NOT NULL, default now | When the row was inserted (UTC) |
| claimed_at   | TEXT    | nullable | When the worker most recently claimed the row. Used by the watchdog: any `processing` row older than 5 minutes is reclaimed back to `queued`. |
| completed_at | TEXT    | nullable | When the row reached a terminal state (`done` or `failed`) |

**Indexes:**

| Name | Definition | Purpose |
|------|------------|---------|
| `idx_work_queue_claim` | `(status, queued_at) WHERE status='queued'` | Covers the worker's claim query: pick the oldest queued row. Partial -- only indexes work waiting to be done. |
| `idx_work_queue_one_active_per_dump` | UNIQUE `(job_type, target_id) WHERE job_type='brain_dump' AND status IN ('queued','processing')` | Enforces "at most one non-terminal queue entry per brain_dump." Terminal `failed` rows stay in place as audit; a retry inserts a new row. |
| `idx_work_queue_one_active_prompt` | UNIQUE `(job_type) WHERE job_type='prompt_generation' AND status IN ('queued','processing')` | Coalescing: rapid `POST /api/prompts/generate` calls collapse into the in-flight job. |

**Status values:**
- `queued` -- waiting for the worker
- `processing` -- claimed by the worker, currently being run
- `done` -- terminal, completed successfully (kept as audit trail; no auto-prune)
- `failed` -- terminal, ran out of retries (`attempts >= 3`). Re-queue via `POST /api/brain-dumps/<id>/retry`, which inserts a new row and leaves the failed one in place.

**Retrieval scenarios:** "What's currently queued?" / "Show me anything that's failed in the last week." / "How long has the oldest in-flight job been running?" / "How many times did this dump retry before succeeding?"

```sql
-- Worker's atomic claim (the central query of the system, inside BEGIN IMMEDIATE):
UPDATE work_queue
   SET status='processing', claimed_at = datetime('now'), attempts = attempts + 1
 WHERE id = (SELECT id FROM work_queue WHERE status='queued' ORDER BY queued_at ASC LIMIT 1)
RETURNING id, job_type, target_id, attempts, claimed_at;

-- Watchdog reclaim (every ~60s):
UPDATE work_queue
   SET status='queued', claimed_at = NULL
 WHERE status = 'processing' AND claimed_at < datetime('now','-5 minutes');

-- Anything stuck right now?
SELECT id, job_type, target_id, attempts, claimed_at,
       CAST((julianday('now') - julianday(claimed_at)) * 86400 AS INTEGER) AS age_seconds
FROM work_queue
WHERE status = 'processing'
ORDER BY claimed_at ASC;

-- Failure audit
SELECT id, job_type, target_id, attempts, error, completed_at
FROM work_queue
WHERE status = 'failed'
ORDER BY completed_at DESC;
```

---

### people

First-class person entities. Anyone relevant to Cam's life: family, partners, professionals, contacts.

| Column       | Type    | Constraints       | Description                              |
|--------------|---------|-------------------|------------------------------------------|
| id           | INTEGER | PK, autoincrement | Unique identifier                        |
| name         | TEXT    | NOT NULL          | Person's name                            |
| relationship | TEXT    | nullable          | partner, ex, daughter, son, tutor, etc.  |
| location     | TEXT    | nullable          | Where they are based                     |
| notes        | TEXT    | nullable          | Freeform context                         |
| created_at   | TEXT    | NOT NULL, default now | Row insertion timestamp (UTC)        |
| updated_at   | TEXT    | NOT NULL, default now | Last modification (UTC)              |

**Index:** `idx_people_name` on `name`

**Retrieval scenarios:** "Who is involved in the property settlement?" / "Show me everyone in Seoul."

---

### goals

Top-level life goals. Each has a status and optionally a target date. Goals can block other goals (via `dependencies` table).

| Column       | Type    | Constraints                                              | Description                              |
|--------------|---------|----------------------------------------------------------|------------------------------------------|
| id           | INTEGER | PK, autoincrement                                        | Unique identifier                        |
| title        | TEXT    | NOT NULL                                                 | Short goal name                          |
| description  | TEXT    | nullable                                                 | What this goal means, context            |
| status       | TEXT    | NOT NULL, default 'active', CHECK in (active, completed, stalled, someday, cancelled) | Current state |
| target_date  | TEXT    | nullable                                                 | ISO 8601 date or NULL                    |
| completed_at | TEXT    | nullable                                                 | When it was finished                     |
| created_at   | TEXT    | NOT NULL, default now                                    | Row insertion timestamp (UTC)            |
| updated_at   | TEXT    | NOT NULL, default now                                    | Last modification (UTC)                  |

**Index:** `idx_goals_status` on `status`

**Status values:**
- `active` -- actively being worked on
- `completed` -- done
- `stalled` -- no progress, needs attention
- `someday` -- acknowledged but not actively pursued
- `cancelled` -- deliberately abandoned

**Retrieval scenarios:** "What are my active goals?" / "What's stalled?" / "Show me everything blocking Move to Seoul."

---

### tasks

Actionable items, optionally linked to a goal. Tasks are the concrete steps that move goals forward.

| Column       | Type    | Constraints                                              | Description                              |
|--------------|---------|----------------------------------------------------------|------------------------------------------|
| id           | INTEGER | PK, autoincrement                                        | Unique identifier                        |
| title        | TEXT    | NOT NULL                                                 | Short task name                          |
| description  | TEXT    | nullable                                                 | Detail, notes, context                   |
| goal_id      | INTEGER | FK to goals(id), ON DELETE SET NULL                      | Which goal this supports (nullable)      |
| status       | TEXT    | NOT NULL, default 'active', CHECK in (active, completed, waiting, someday, cancelled) | Current state |
| due_date     | TEXT    | nullable                                                 | ISO 8601 date or NULL                    |
| completed_at | TEXT    | nullable                                                 | When it was finished                     |
| created_at   | TEXT    | NOT NULL, default now                                    | Row insertion timestamp (UTC)            |
| updated_at   | TEXT    | NOT NULL, default now                                    | Last modification (UTC)                  |

**Indexes:** `idx_tasks_status` on `status`, `idx_tasks_goal` on `goal_id`

**Status values:**
- `active` -- ready to work on
- `completed` -- done
- `waiting` -- blocked or waiting on someone/something
- `someday` -- nice to do, not urgent
- `cancelled` -- deliberately dropped

**Retrieval scenarios:** "What are my active tasks for the property settlement?" / "What have I completed this month?" / "What's overdue?"

---

### dependencies

Models "what blocks what" across the system. Polymorphic: both the blocker and the blocked item can be goals, tasks, or external systems.

| Column       | Type    | Constraints                                              | Description                              |
|--------------|---------|----------------------------------------------------------|------------------------------------------|
| id           | INTEGER | PK, autoincrement                                        | Unique identifier                        |
| blocker_type | TEXT    | NOT NULL, CHECK in (goal, task, external_system)         | Type of the blocking entity              |
| blocker_id   | INTEGER | NOT NULL                                                 | ID in the blocker's table                |
| blocked_type | TEXT    | NOT NULL, CHECK in (goal, task)                          | Type of the blocked entity               |
| blocked_id   | INTEGER | NOT NULL                                                 | ID in the blocked table                  |
| notes        | TEXT    | nullable                                                 | Context about the dependency             |
| resolved     | INTEGER | NOT NULL, default 0                                      | 0 = still blocking, 1 = resolved        |
| resolved_at  | TEXT    | nullable                                                 | When the blocker was marked resolved (UTC); NULL while still blocking |
| created_at   | TEXT    | NOT NULL, default now                                    | Row insertion timestamp (UTC)            |

**Indexes:** `idx_deps_blocked` on `(blocked_type, blocked_id)`, `idx_deps_blocker` on `(blocker_type, blocker_id)`

**Resolution pair.** `(resolved, resolved_at)` mirrors the `(processed, processed_at)` pattern on `brain_dumps` and the `(status='completed', completed_at)` pattern on goals/tasks. The boolean answers "is this still blocking?"; the timestamp answers "when did it clear?". App code marking a dependency resolved should set both in the same UPDATE: `SET resolved = 1, resolved_at = datetime('now')`. A NULL `resolved_at` on a `resolved=1` row indicates a historical resolve where the exact time wasn't recorded (backfilled by migration 0004 with `datetime('now')` at migration time, but consumers should still tolerate NULL defensively).

**Retrieval scenarios:** "What's blocking Move to Seoul?" / "Is anything waiting on the Finance App?" / "What dependencies cleared in the last 30 days?" / "How long was this blocker live?"

---

### knowledge_items

Facts, decisions, learnings, and references -- things Cam wants to remember that aren't tasks or goals.

| Column    | Type    | Constraints                                                          | Description                              |
|-----------|---------|----------------------------------------------------------------------|------------------------------------------|
| id        | INTEGER | PK, autoincrement                                                    | Unique identifier                        |
| title     | TEXT    | NOT NULL                                                             | Short descriptive title                  |
| content   | TEXT    | nullable                                                             | The knowledge itself                     |
| item_type | TEXT    | NOT NULL, default 'fact', CHECK in (fact, decision, learning, reference, note) | Category of knowledge          |
| source    | TEXT    | nullable                                                             | Where this came from                     |
| created_at| TEXT    | NOT NULL, default now                                                | Row insertion timestamp (UTC)            |
| updated_at| TEXT    | NOT NULL, default now                                                | Last modification (UTC)                  |

**Index:** `idx_knowledge_type` on `item_type`

**Item types:**
- `fact` -- a piece of information (address, passport details, etc.)
- `decision` -- a choice that was made and why
- `learning` -- something learned from experience
- `reference` -- a phone number, URL, contact detail, etc.
- `note` -- general purpose

**Retrieval scenarios:** "What decisions have I made about Korean study?" / "What facts do I have stored about visas?"

---

### external_systems

References to tools and apps outside the lifeplan database. The system knows these exist and what questions they answer, but doesn't duplicate their data.

| Column      | Type    | Constraints       | Description                              |
|-------------|---------|-------------------|------------------------------------------|
| id          | INTEGER | PK, autoincrement | Unique identifier                        |
| name        | TEXT    | NOT NULL, UNIQUE  | System name                              |
| description | TEXT    | nullable          | What it does                             |
| answers     | TEXT    | nullable          | What questions it answers                |
| url         | TEXT    | nullable          | Access URL if applicable                 |
| notes       | TEXT    | nullable          | Usage notes, warnings                    |
| created_at  | TEXT    | NOT NULL, default now | Row insertion timestamp (UTC)        |
| updated_at  | TEXT    | NOT NULL, default now | Last modification (UTC)              |

**Retrieval scenarios:** "Where do I track debt?" / "What external tools does this system reference?"

---

### tags

Reusable labels shared across ALL content types. Lowercase, hyphenated. **Pre-existing from v0.1, now extended.**

| Column | Type    | Constraints       | Description                              |
|--------|---------|-------------------|------------------------------------------|
| id     | INTEGER | PK, autoincrement | Unique identifier                        |
| name   | TEXT    | NOT NULL, UNIQUE  | Lowercase, hyphenated (e.g. `ai-team`)   |

---

### Junction Tables (tagging)

Each content type has its own junction table linking to `tags`. All follow the same pattern: composite primary key, cascade deletes on both sides.

| Junction Table     | Links                        | PK                          |
|--------------------|------------------------------|-----------------------------|
| entry_tags         | journal_entries <-> tags      | (entry_id, tag_id)          |
| brain_dump_tags    | brain_dumps <-> tags          | (brain_dump_id, tag_id)     |
| goal_tags          | goals <-> tags                | (goal_id, tag_id)           |
| task_tags          | tasks <-> tags                | (task_id, tag_id)           |
| person_tags        | people <-> tags               | (person_id, tag_id)         |
| knowledge_tags     | knowledge_items <-> tags      | (knowledge_id, tag_id)      |

**brain_dump_tags FK note (v0.5, prod-only fix).** Migration 0001 rebuilt the parent `brain_dumps` table using the rename-then-recreate pattern. Modern SQLite (~3.43, local macOS) auto-rewrites FK references in dependent tables when a parent is renamed; older SQLite (the Ubuntu build on the prod droplet) does not. Result: prod's `brain_dump_tags` was left referencing the (subsequently dropped) `brain_dumps_old`, breaking all new tag inserts. Migration 0002 (`scripts/migrations/0002_fix_brain_dump_tags_fk.sql`) repairs the FK using the canonical 12-step ALTER pattern (create-new -> copy -> drop-old -> rename-new), unconditionally rebuilding the table so the same migration script is safe on local (already correct) and prod (broken). See migration 0002's header for the full post-mortem.

---

### Junction Tables (people links)

People can be linked to goals and tasks with a role describing the relationship.

| Junction Table | Links             | PK                    | Extra Columns |
|----------------|-------------------|-----------------------|---------------|
| goal_people    | goals <-> people  | (goal_id, person_id)  | role TEXT     |
| task_people    | tasks <-> people  | (task_id, person_id)  | role TEXT     |

**Role examples:** `involved`, `blocker`, `beneficiary`, `partner`, `subject`, `former tutor`

## Common Queries

```sql
-- ============================================================
-- BRAIN DUMPS
-- ============================================================

-- In-flight brain dumps (anything not yet at a terminal state)
SELECT * FROM brain_dumps
 WHERE processing_status IN ('unprocessed','queued','processing')
 ORDER BY captured_at DESC;

-- Brain dumps needing Cam's review (have suggested items)
SELECT * FROM brain_dumps WHERE processing_status = 'needs_review' ORDER BY captured_at DESC;

-- Brain dumps that failed processing (retry candidates)
SELECT b.id, b.captured_at, w.attempts, w.error
FROM brain_dumps b
LEFT JOIN work_queue w
       ON w.job_type = 'brain_dump'
      AND w.target_id = b.id
      AND w.status   = 'failed'
WHERE b.processing_status = 'failed'
ORDER BY w.completed_at DESC;

-- Legacy query (still works via backward-compat processed column)
-- SELECT * FROM brain_dumps WHERE processed = 0 ORDER BY captured_at DESC;

-- ============================================================
-- GOALS & TASKS
-- ============================================================

-- All active goals
SELECT * FROM goals WHERE status = 'active';

-- Stalled goals (need attention)
SELECT * FROM goals WHERE status = 'stalled';

-- Active tasks for a specific goal
SELECT t.* FROM tasks t
JOIN goals g ON t.goal_id = g.id
WHERE g.title = 'Finalise Property Settlement' AND t.status = 'active';

-- All active tasks across all goals
SELECT t.id, t.title, g.title AS goal, t.status, t.due_date
FROM tasks t
LEFT JOIN goals g ON t.goal_id = g.id
WHERE t.status = 'active'
ORDER BY g.title, t.id;

-- ============================================================
-- DEPENDENCIES (what blocks what)
-- ============================================================

-- What's blocking Move to Seoul?
SELECT d.blocker_type,
       CASE d.blocker_type
           WHEN 'goal' THEN (SELECT title FROM goals WHERE id = d.blocker_id)
           WHEN 'task' THEN (SELECT title FROM tasks WHERE id = d.blocker_id)
           WHEN 'external_system' THEN (SELECT name FROM external_systems WHERE id = d.blocker_id)
       END AS blocker_name,
       d.notes
FROM dependencies d
WHERE d.blocked_type = 'goal'
  AND d.blocked_id = (SELECT id FROM goals WHERE title = 'Move to Seoul')
  AND d.resolved = 0;

-- Dependencies cleared in the last 30 days (retrospection)
SELECT d.id, d.blocker_type, d.blocked_type, d.notes, d.resolved_at
FROM dependencies d
WHERE d.resolved = 1
  AND d.resolved_at >= datetime('now', '-30 days')
ORDER BY d.resolved_at DESC;

-- All unresolved dependencies
SELECT d.*,
       CASE d.blocker_type
           WHEN 'goal' THEN (SELECT title FROM goals WHERE id = d.blocker_id)
           WHEN 'task' THEN (SELECT title FROM tasks WHERE id = d.blocker_id)
           WHEN 'external_system' THEN (SELECT name FROM external_systems WHERE id = d.blocker_id)
       END AS blocker_name,
       CASE d.blocked_type
           WHEN 'goal' THEN (SELECT title FROM goals WHERE id = d.blocked_id)
           WHEN 'task' THEN (SELECT title FROM tasks WHERE id = d.blocked_id)
       END AS blocked_name
FROM dependencies d
WHERE d.resolved = 0;

-- ============================================================
-- PEOPLE
-- ============================================================

-- Everyone and their involvement
SELECT p.name, p.relationship,
       GROUP_CONCAT(DISTINCT g.title) AS linked_goals
FROM people p
LEFT JOIN goal_people gp ON gp.person_id = p.id
LEFT JOIN goals g ON g.id = gp.goal_id
GROUP BY p.id;

-- ============================================================
-- TAGS (cross-content search)
-- ============================================================

-- All content tagged 'settlement'
SELECT 'goal' AS type, g.title AS item FROM goals g
JOIN goal_tags gt ON gt.goal_id = g.id
JOIN tags t ON t.id = gt.tag_id WHERE t.name = 'settlement'
UNION ALL
SELECT 'task', tk.title FROM tasks tk
JOIN task_tags tt ON tt.task_id = tk.id
JOIN tags t ON t.id = tt.tag_id WHERE t.name = 'settlement'
UNION ALL
SELECT 'person', p.name FROM people p
JOIN person_tags pt ON pt.person_id = p.id
JOIN tags t ON t.id = pt.tag_id WHERE t.name = 'settlement'
UNION ALL
SELECT 'knowledge', ki.title FROM knowledge_items ki
JOIN knowledge_tags kt ON kt.knowledge_id = ki.id
JOIN tags t ON t.id = kt.tag_id WHERE t.name = 'settlement';

-- All tags in use with counts across all content types
SELECT t.name,
       (SELECT COUNT(*) FROM entry_tags WHERE tag_id = t.id) +
       (SELECT COUNT(*) FROM goal_tags WHERE tag_id = t.id) +
       (SELECT COUNT(*) FROM task_tags WHERE tag_id = t.id) +
       (SELECT COUNT(*) FROM person_tags WHERE tag_id = t.id) +
       (SELECT COUNT(*) FROM knowledge_tags WHERE tag_id = t.id) +
       (SELECT COUNT(*) FROM brain_dump_tags WHERE tag_id = t.id) AS total_uses
FROM tags t
ORDER BY total_uses DESC;

-- ============================================================
-- PROMPTING QUERIES
-- ============================================================

-- Tasks not updated in 30+ days (nudge candidates)
SELECT t.title, g.title AS goal, t.updated_at
FROM tasks t
LEFT JOIN goals g ON t.goal_id = g.id
WHERE t.status = 'active'
  AND t.updated_at < datetime('now', '-30 days');

-- Stalled goals with their active task count
SELECT g.title, g.status,
       (SELECT COUNT(*) FROM tasks WHERE goal_id = g.id AND status = 'active') AS active_tasks
FROM goals g
WHERE g.status = 'stalled';
```

## Entity-Relationship Summary

```
brain_dumps ----tags----> tags <----tags---- journal_entries
                           ^
                           |
people -----tags-----------+
  |  \                     |
  |   goal_people     goal_tags
  |        \               |
  |         v              v
  +--task_people--> goals <---- dependencies ----> goals
                      ^                              |
                      |                              v
                    tasks ----tags----> tags    external_systems
                      ^
                      |
                 dependencies
                      ^
                      |
                    tasks

knowledge_items ----tags----> tags
```

## Current Data Summary

> Static snapshots go stale quickly. Query the database directly for current counts:
>
> ```sql
> SELECT 'journal_entries' AS tbl, COUNT(*) AS n FROM journal_entries
> UNION ALL SELECT 'brain_dumps', COUNT(*) FROM brain_dumps
> UNION ALL SELECT 'people', COUNT(*) FROM people
> UNION ALL SELECT 'goals', COUNT(*) FROM goals
> UNION ALL SELECT 'tasks', COUNT(*) FROM tasks
> UNION ALL SELECT 'dependencies', COUNT(*) FROM dependencies
> UNION ALL SELECT 'knowledge_items', COUNT(*) FROM knowledge_items
> UNION ALL SELECT 'external_systems', COUNT(*) FROM external_systems
> UNION ALL SELECT 'tags', COUNT(*) FROM tags;
> ```

## Design Decisions

1. **`entry_date` is TEXT, not a timestamp.** A journal entry is about a *day*, not a precise moment. ISO 8601 strings sort correctly and are human-readable.
2. **Tags are a separate table, not comma-separated text.** This costs a join but enables: filtering by tag, tag-based counts, and reuse across future content types.
3. **Tags table is shared.** Every content type gets its own junction table pointing to the same `tags` table. One vocabulary, many content types.
4. **Dependencies are polymorphic.** `blocker_type` + `blocker_id` and `blocked_type` + `blocked_id` allow any entity to block any other. This avoids a combinatorial explosion of linking tables.
5. **People have their own junction tables to goals and tasks.** This lets us answer "who is involved in what?" without parsing text.
6. **External systems are referenced, not replicated.** The Finance App tracks debt -- we record *that it exists* and *what it answers*, not the debt figures themselves.
7. **Brain dumps are separate from journal entries.** Journal entries are reflective and dated; brain dumps are raw capture that may or may not be processed into structure. Different intent, different table.
8. **Status fields use CHECK constraints.** Prevents typos and makes valid states explicit. Easy to extend by altering the constraint if new statuses emerge.
9. **completed_at is separate from status.** Knowing *when* something completed enables time-based queries ("what did I finish last month?").
10. **All timestamps default to `datetime('now')`.** Reduces capture friction -- just insert the content, timestamps handle themselves.
11. **`processing_status` replaces boolean `processed` for brain dumps.** The old column is kept for backward compatibility, but new code should use `processing_status` which supports richer states: `unprocessed`, `queued`, `processing`, `processed`, `needs_review`, `failed`.
12. **`processed_items` stores extraction results as JSON.** This keeps the full extraction history (including rejected suggestions) in the brain dump row, enabling audit trails and reprocessing. Schema defined in `PROCESSING_RULES.md`.
13. **`work_queue` is the source of truth; `brain_dumps.processing_status` is a cache.** The worker writes both inside the same transaction. The denormalisation is deliberate: list views render badges from a single `brain_dumps` row read without joining to `work_queue`, and a row-by-row join in a hot list path was the alternative. Watchdog math (`claimed_at < now − 5m`) lives only on the queue, so there's exactly one place that arbitrates state. `work_queue.target_id` deliberately has no FK to `brain_dumps.id` so deletions don't cascade into audit history -- the queue is operational, not relational ground truth.
14. **`dependencies.resolved_at` mirrors the schema's lifecycle-pair pattern.** A bare boolean `resolved` was the v0.1 shape; migration 0004 added a nullable `resolved_at` so the system can answer "when did this clear?" alongside "is it still blocking?". This matches `(processed, processed_at)` on `brain_dumps` and `(status='completed', completed_at)` on goals/tasks. We deliberately did *not* expand `dependencies` into a full status enum (`active|resolved|on_hold|cancelled`) -- nuance like "paused" or "abandoned" lives on the blocked goal or task, not on the dependency edge, and the enum would overspecify a relational glue table.
15. **`work_queue` partial unique indexes encode the coalescing contract.** `idx_work_queue_one_active_per_dump` and `idx_work_queue_one_active_prompt` ensure that re-queueing a brain dump or trigging prompt regeneration is naturally idempotent at the DB layer -- the handler can attempt the insert and treat a UNIQUE-constraint failure as "already queued, no-op." Terminal `done`/`failed` rows are excluded from the index so they don't block legitimate re-queues.

## Extension Points

- **Habits / recurring tasks:** Add a `recurrence` column to tasks, or a separate `habits` table
- **File attachments:** A `files` table linking to paths on disk, with junction tables to any content type
- **Reminders / prompts:** A `reminders` table with trigger dates and linked entities
- **Views:** Create SQLite views for common dashboards (e.g. `active_blockers`, `triage_queue`, `monthly_review`)
- **New content types:** Follow the pattern -- create the table, create a junction table to `tags`, done
