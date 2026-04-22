# lifeplan.db -- Schema Documentation

**Version:** 0.3 (brain dump auto-processing)
**Created:** 2026-04-20
**Last updated:** 2026-04-20
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
| processing_status  | TEXT    | NOT NULL, default 'unprocessed', CHECK in (unprocessed, processing, processed, needs_review) | Richer processing state |
| processed_items    | TEXT    | nullable (JSON)   | JSON object with all extracted items, confidence scores, and created row IDs. Schema defined in PROCESSING_RULES.md |
| created_at         | TEXT    | NOT NULL, default now | Row insertion timestamp (UTC)        |
| updated_at         | TEXT    | NOT NULL, default now | Last modification (UTC)              |

**Indexes:** `idx_brain_dumps_processed` on `processed`, `idx_brain_dumps_captured` on `captured_at`, `idx_brain_dumps_processing_status` on `processing_status`

**Processing status values:**
- `unprocessed` -- freshly captured, not yet analysed
- `processing` -- currently being analysed (transient state)
- `processed` -- fully processed, all extracted items were auto-created (high confidence)
- `needs_review` -- processed but contains suggested items awaiting Cam's approval

**Retrieval scenarios:** "Show me everything I dumped this week that hasn't been processed yet." / "What did I capture on Tuesday?" / "What brain dumps need my review?"

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

**Retrieval scenarios:** "Who is involved in the settlement?" / "Show me everyone in Seoul."

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

**Retrieval scenarios:** "What are my active tasks for the settlement?" / "What have I completed this month?" / "What's overdue?"

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
| created_at   | TEXT    | NOT NULL, default now                                    | Row insertion timestamp (UTC)            |

**Indexes:** `idx_deps_blocked` on `(blocked_type, blocked_id)`, `idx_deps_blocker` on `(blocker_type, blocker_id)`

**Retrieval scenarios:** "What's blocking Move to Seoul?" / "Is anything waiting on the Finance App?" / "What dependencies have been resolved?"

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

-- Unprocessed brain dumps (triage queue)
SELECT * FROM brain_dumps WHERE processing_status = 'unprocessed' ORDER BY captured_at DESC;

-- Brain dumps needing Cam's review (have suggested items)
SELECT * FROM brain_dumps WHERE processing_status = 'needs_review' ORDER BY captured_at DESC;

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

## Current Data Summary (as of 2026-04-20)

| Table            | Count | Notes                                           |
|------------------|-------|-------------------------------------------------|
| journal_entries  | 1     | Seed entry from day one                         |
| brain_dumps      | 0     | Ready for use                                   |
| people           | 5     | Nadia, Priya, Sam, Jess, Minji            |
| goals            | 9     | 4 active, 2 completed, 1 stalled, 1 someday     |
| tasks            | 35    | 12 active, 22 completed, 1 someday              |
| dependencies     | 8     | 4 blocking Move to Seoul                        |
| knowledge_items  | 7     | 4 facts, 1 decision, 1 learning, 1 reference    |
| external_systems | 1     | Finance App                                     |
| tags             | 24    | Shared across all content types                 |

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
11. **`processing_status` replaces boolean `processed` for brain dumps.** The old column is kept for backward compatibility, but new code should use `processing_status` which supports richer states: `unprocessed`, `processing`, `processed`, `needs_review`.
12. **`processed_items` stores extraction results as JSON.** This keeps the full extraction history (including rejected suggestions) in the brain dump row, enabling audit trails and reprocessing. Schema defined in `PROCESSING_RULES.md`.

## Extension Points

- **Habits / recurring tasks:** Add a `recurrence` column to tasks, or a separate `habits` table
- **File attachments:** A `files` table linking to paths on disk, with junction tables to any content type
- **Reminders / prompts:** A `reminders` table with trigger dates and linked entities
- **Views:** Create SQLite views for common dashboards (e.g. `active_blockers`, `triage_queue`, `monthly_review`)
- **New content types:** Follow the pattern -- create the table, create a junction table to `tags`, done
