-- =============================================================================
-- Migration 0004: add resolved_at timestamp to dependencies
-- =============================================================================
--
-- Why this migration exists
-- -------------------------
-- The "Blockers become real" feature exposes a UI control letting Cam mark a
-- blocker as resolved. Today the `dependencies` table tracks resolution as a
-- bare boolean (`resolved INTEGER NOT NULL DEFAULT 0`). That answers "is this
-- still blocking?" but loses the answer to "when did it clear?" -- a
-- retrospection question that pays for itself the moment Cam asks "what cleared
-- last month while goal X stalled?" or "how long was this blocker live?".
--
-- We mirror the established pattern for lifecycle pairs in this schema:
--
--   * brain_dumps: (processed INTEGER, processed_at TEXT)
--   * goals:       (status='completed', completed_at TEXT)
--   * tasks:       (status='completed', completed_at TEXT)
--
-- Dependencies are relational glue rather than first-class objects, so a full
-- status enum (`active|resolved|on_hold|cancelled`) overspecifies -- the
-- nuance lives on the blocked goal/task, not on the dependency edge. A
-- nullable `resolved_at` paired with the existing `resolved` boolean is the
-- minimal viable structure that unlocks the retrospection query.
--
-- Reed rules in play:
--   * Rule 5 (Minimal Viable Structure): one new column, no CHECK churn.
--   * Rule 2 (Think in queries): justified by "what cleared, and when".
--   * Reed rule 11 in CLAUDE.md (Match existing patterns): mirrors
--     processed/processed_at and status/completed_at pairs.
--
-- What this migration does
-- ------------------------
-- 1. Adds `resolved_at TEXT` (nullable) to `dependencies`. No CHECK constraint
--    is added or changed, so the canonical 12-step ALTER pattern is NOT
--    required -- a simple ALTER TABLE ADD COLUMN is safe and atomic in SQLite.
-- 2. Backfills `resolved_at = datetime('now')` for any existing rows with
--    `resolved = 1` and `resolved_at IS NULL` so historical resolved rows
--    aren't left with a NULL timestamp. (Local: 0 rows resolved at write time;
--    prod state unknown but the backfill is a no-op when no such rows exist.)
-- 3. Stamps `PRAGMA user_version = 4`.
--
-- Why ADD COLUMN is sufficient (not the 12-step ALTER)
-- ----------------------------------------------------
-- The 12-step rebuild from migration 0002 is reserved for changes that SQLite
-- cannot do in place: altering CHECK constraints, changing FK targets, dropping
-- columns. Adding a nullable column with no default expression beyond NULL is
-- a single-step operation that SQLite handles natively without rewriting any
-- existing rows. No indexes touch `resolved_at` (none queried by it yet), so
-- there is nothing else to rebuild.
--
-- Idempotency: gated by `PRAGMA user_version`. Sets `user_version=4` on
-- success. Re-running when user_version >= 4 aborts cleanly via the same
-- abs(MIN_INT64) overflow trick used by 0001/0002/0003.
--
-- Run as:
--   sqlite3 /Users/cam/dev/personal/lifeplan/data/lifeplan.db \
--       < /Users/cam/dev/personal/lifeplan/scripts/migrations/0004_blocker_resolution.sql
--
-- Take a labelled backup BEFORE running, e.g.:
--   cp data/lifeplan.db data/backups/lifeplan.db.pre-0004.<timestamp>
--
-- =============================================================================

.bail on
.echo on

-- -----------------------------------------------------------------------------
-- Idempotency guard
-- -----------------------------------------------------------------------------
-- Same pattern as 0001/0002/0003: friendly line if already applied, then trip
-- a runtime int64 overflow inside a lazily-evaluated CASE so `.bail on` halts
-- before any DDL runs.

SELECT 'migration 0004_blocker_resolution: already applied (user_version >= 4); aborting cleanly'
 WHERE (SELECT user_version FROM pragma_user_version) >= 4;

SELECT CASE
    WHEN (SELECT user_version FROM pragma_user_version) >= 4
    THEN abs(-9223372036854775808)  -- runtime integer overflow -> abort
    ELSE 0
END;

-- -----------------------------------------------------------------------------
-- Step 1: add resolved_at column and backfill historical resolved rows
-- -----------------------------------------------------------------------------

BEGIN;

-- Add nullable timestamp column. No DEFAULT -- a NULL resolved_at on an
-- unresolved row is the natural representation, and we don't want to stamp
-- creation time onto unresolved rows.
ALTER TABLE dependencies ADD COLUMN resolved_at TEXT;

-- Backfill: any historical row where resolved=1 but resolved_at is NULL gets
-- a "we don't know exactly when, but it was before now" stamp. This is the
-- honest representation -- the UI can render "(unknown date)" for these if
-- needed, but most consumers just want non-NULL for the boolean equivalence
-- check `resolved_at IS NOT NULL`.
UPDATE dependencies
   SET resolved_at = datetime('now')
 WHERE resolved = 1
   AND resolved_at IS NULL;

COMMIT;

-- -----------------------------------------------------------------------------
-- Step 2: stamp user_version so re-runs detect "already applied".
-- -----------------------------------------------------------------------------

PRAGMA user_version = 4;

.echo off
SELECT 'migration 0004_blocker_resolution applied OK; user_version=' || user_version
FROM pragma_user_version;
