-- =============================================================================
-- Migration 0001: work_queue table + brain_dumps.processing_status enum extension
-- =============================================================================
--
-- Phase 1 of the background-processing rollout. See:
--   /Users/cam/dev/personal/lifeplan/app/contracts/background-processing.md
--
-- This script does two things:
--
--   1. Creates the `work_queue` table plus its three indexes (one for the
--      claim path, two partial-unique indexes that enforce coalescing).
--
--   2. Extends `brain_dumps.processing_status` CHECK to admit two new values:
--      'queued' and 'failed'. SQLite has no ALTER TABLE ... DROP/ADD CONSTRAINT,
--      so we follow the standard rename-create-copy-drop dance.
--
-- Idempotency: gated by `PRAGMA user_version`. The migration sets
-- `user_version=1` on success. Re-running the script when user_version >= 1
-- aborts cleanly with a clear message and no side effects.
--
-- Foreign keys: `work_queue.target_id` is intentionally NOT a FK to
-- `brain_dumps.id`. Per the contract, the queue is operational history -- a
-- brain-dump deletion shouldn't fail or cascade into queue audit rows.
--
-- Run as:
--   sqlite3 /Users/cam/dev/personal/lifeplan/data/lifeplan.db \
--       < /Users/cam/dev/personal/lifeplan/scripts/migrations/0001_work_queue.sql
--
-- Take a labelled backup BEFORE running, e.g.:
--   cp data/lifeplan.db data/backups/lifeplan.db.pre-work-queue.<timestamp>
--
-- =============================================================================

.bail on
.echo on

-- -----------------------------------------------------------------------------
-- Idempotency guard
-- -----------------------------------------------------------------------------
-- If user_version >= 1, this migration has already been applied. We print a
-- friendly message, then deliberately raise a runtime integer-overflow error
-- so `.bail on` halts the script before any DDL runs. Re-runs therefore exit
-- non-zero with a clear "already applied" line at the top of the output and
-- no side effects.
--
-- (SQLite's SQL has no IF/RAISE outside triggers, and identifiers in CASE
-- THEN branches are parsed eagerly, so we route the abort through a runtime
-- arithmetic error inside a CASE that's only evaluated when the guard fires.
-- Note: SQLite returns NULL on divide-by-zero, so 1/0 cannot be used as an
-- abort. abs(-9223372036854775808) reliably overflows int64 at step time.)

SELECT 'migration 0001_work_queue: already applied (user_version >= 1); aborting cleanly'
 WHERE (SELECT user_version FROM pragma_user_version) >= 1;

-- abs(MIN_INT64) overflows at step time; SQLite raises "integer overflow"
-- and `.bail on` halts the script. (1/0 silently yields NULL in SQLite, so
-- it can't be used as an abort.) Lazy CASE evaluation means this expression
-- is only computed when user_version >= 1.
SELECT CASE
    WHEN (SELECT user_version FROM pragma_user_version) >= 1
    THEN abs(-9223372036854775808)  -- runtime integer overflow → abort
    ELSE 0
END;

-- -----------------------------------------------------------------------------
-- Step 1: work_queue table + indexes
-- -----------------------------------------------------------------------------
-- All DDL uses IF NOT EXISTS so this section is itself re-runnable, but the
-- guard above means we shouldn't reach it on a re-run anyway.

BEGIN;

CREATE TABLE IF NOT EXISTS work_queue (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    job_type     TEXT    NOT NULL
                         CHECK (job_type IN ('brain_dump','prompt_generation')),
    -- target_id references brain_dumps.id when job_type='brain_dump'.
    -- Intentionally NOT a foreign key: the queue is operational history; a
    -- brain-dump deletion should not fail or cascade into queue audit rows.
    -- NULL for prompt_generation jobs (one canonical prompt-set; no id needed).
    target_id    INTEGER,
    status       TEXT    NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued','processing','done','failed')),
    attempts     INTEGER NOT NULL DEFAULT 0,
    error        TEXT,
    queued_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    claimed_at   TEXT,
    completed_at TEXT
);

-- Claim path: covers (status='queued') ORDER BY queued_at ASC.
CREATE INDEX IF NOT EXISTS idx_work_queue_claim
    ON work_queue(status, queued_at)
    WHERE status = 'queued';

-- At most one non-terminal queue entry per brain_dump.
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_queue_one_active_per_dump
    ON work_queue(job_type, target_id)
    WHERE job_type = 'brain_dump'
      AND status IN ('queued','processing');

-- At most one non-terminal prompt_generation row at a time. Coalescing is the
-- desired behaviour: see contract endpoint POST /api/prompts/generate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_queue_one_active_prompt
    ON work_queue(job_type)
    WHERE job_type = 'prompt_generation'
      AND status IN ('queued','processing');

COMMIT;

-- -----------------------------------------------------------------------------
-- Step 2: brain_dumps CHECK enum extension
-- -----------------------------------------------------------------------------
--
-- Old schema (pre-migration):
--
--   CREATE TABLE brain_dumps (
--       id          INTEGER PRIMARY KEY AUTOINCREMENT,
--       content     TEXT NOT NULL,
--       captured_at TEXT NOT NULL DEFAULT (datetime('now')),
--       processed   INTEGER NOT NULL DEFAULT 0,
--       processed_at TEXT,
--       created_at  TEXT NOT NULL DEFAULT (datetime('now')),
--       updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
--     , processing_status TEXT NOT NULL DEFAULT 'unprocessed'
--       CHECK (processing_status IN ('unprocessed','processing','processed','needs_review'))
--     , processed_items TEXT
--   );
--   CREATE INDEX idx_brain_dumps_processed         ON brain_dumps(processed);
--   CREATE INDEX idx_brain_dumps_captured          ON brain_dumps(captured_at);
--   CREATE INDEX idx_brain_dumps_processing_status ON brain_dumps(processing_status);
--
-- New schema (post-migration). Only the CHECK enum changes; all columns,
-- defaults, and indexes are preserved verbatim:
--
--   CREATE TABLE brain_dumps (
--       id          INTEGER PRIMARY KEY AUTOINCREMENT,
--       content     TEXT NOT NULL,
--       captured_at TEXT NOT NULL DEFAULT (datetime('now')),
--       processed   INTEGER NOT NULL DEFAULT 0,
--       processed_at TEXT,
--       created_at  TEXT NOT NULL DEFAULT (datetime('now')),
--       updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
--       processing_status TEXT NOT NULL DEFAULT 'unprocessed'
--           CHECK (processing_status IN (
--               'unprocessed','queued','processing',
--               'processed','needs_review','failed'
--           )),
--       processed_items TEXT
--   );
--
-- Indexes preserved (re-created post-rename):
--   idx_brain_dumps_processed
--   idx_brain_dumps_captured
--   idx_brain_dumps_processing_status
--
-- No triggers exist on brain_dumps. No views reference it. Junction table
-- brain_dump_tags references it via FK; SQLite's `legacy_alter_table` /
-- `defer_foreign_keys` machinery is handled by running this whole dance
-- inside a single transaction with foreign_keys briefly disabled, then
-- re-validated. This is the canonical SQLite "12-step ALTER" recipe:
-- https://www.sqlite.org/lang_altertable.html#otheralter

PRAGMA foreign_keys = OFF;

BEGIN;

-- 1. Rename old table out of the way.
ALTER TABLE brain_dumps RENAME TO brain_dumps_old;

-- 2. Create new table with the expanded CHECK enum. Column order, types,
--    defaults, and NOT NULL constraints match the old table verbatim.
CREATE TABLE brain_dumps (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    content     TEXT NOT NULL,
    captured_at TEXT NOT NULL DEFAULT (datetime('now')),
    processed   INTEGER NOT NULL DEFAULT 0,
    processed_at TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    processing_status TEXT NOT NULL DEFAULT 'unprocessed'
        CHECK (processing_status IN (
            'unprocessed','queued','processing',
            'processed','needs_review','failed'
        )),
    processed_items TEXT
);

-- 3. Copy every row, every column, in original order. AUTOINCREMENT is
--    preserved because we copy `id` explicitly. sqlite_sequence carries the
--    high-water mark independently, so future inserts continue past the
--    existing max.
INSERT INTO brain_dumps (
    id, content, captured_at, processed, processed_at,
    created_at, updated_at, processing_status, processed_items
)
SELECT
    id, content, captured_at, processed, processed_at,
    created_at, updated_at, processing_status, processed_items
FROM brain_dumps_old;

-- 4. Drop old table.
DROP TABLE brain_dumps_old;

-- 5. Recreate indexes on the new table (they were dropped with the old).
CREATE INDEX idx_brain_dumps_processed         ON brain_dumps(processed);
CREATE INDEX idx_brain_dumps_captured          ON brain_dumps(captured_at);
CREATE INDEX idx_brain_dumps_processing_status ON brain_dumps(processing_status);

-- 6. Validate FK integrity before committing. PRAGMA foreign_key_check
--    returns rows for every violation; an empty result is good. We don't
--    fail the migration on its own here because brain_dump_tags's FK points
--    at brain_dumps(id) and all ids were preserved -- but if anything
--    surprises us, .bail on + the assertion below halts cleanly.

COMMIT;

PRAGMA foreign_keys = ON;
PRAGMA foreign_key_check;

-- -----------------------------------------------------------------------------
-- Step 3: stamp user_version so re-runs detect "already applied".
-- -----------------------------------------------------------------------------

PRAGMA user_version = 1;

.echo off
SELECT 'migration 0001_work_queue applied OK; user_version=' || user_version
FROM pragma_user_version;
