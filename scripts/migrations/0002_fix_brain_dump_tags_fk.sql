-- =============================================================================
-- Migration 0002: repair brain_dump_tags foreign-key reference
-- =============================================================================
--
-- Why this migration exists
-- -------------------------
-- Migration 0001 rebuilt `brain_dumps` using the rename-then-recreate pattern:
--
--     ALTER TABLE brain_dumps RENAME TO brain_dumps_old;
--     CREATE TABLE brain_dumps (...);
--     INSERT INTO brain_dumps SELECT * FROM brain_dumps_old;
--     DROP TABLE brain_dumps_old;
--
-- Modern SQLite (>= ~3.26 with `legacy_alter_table` OFF, which is the default)
-- automatically rewrites foreign-key references in dependent tables when the
-- parent is renamed -- so `brain_dump_tags.brain_dump_id` was silently
-- repointed from `brain_dumps` to `brain_dumps_old` during step 1, then
-- repointed BACK to `brain_dumps` when the new table appeared. Local macOS
-- SQLite (~3.43) did exactly this. Result: no breakage, no signal.
--
-- Older SQLite (the Ubuntu build on the prod droplet, version unknown but
-- pre-the-auto-rewrite behaviour) did NOT rewrite the FK during the rename.
-- `brain_dump_tags` was left referencing `"brain_dumps_old"`, and step 4's
-- `DROP TABLE brain_dumps_old` then orphaned the FK target. Production now
-- has a junction table whose parent table no longer exists; any INSERT into
-- `brain_dump_tags` fails, and `PRAGMA foreign_key_check` returns 19 rows.
--
-- The lesson, written down so future readers don't reach for the wrong tool:
-- **the rename-then-recreate pattern is version-dependent.** The canonical
-- SQLite "12-step ALTER" recipe (https://www.sqlite.org/lang_altertable.html
-- #otheralter) is the create-new-then-drop-old shape -- never rename the old
-- table out of the way. This migration uses that pattern correctly.
--
-- What this migration does
-- ------------------------
-- Rebuilds `brain_dump_tags` unconditionally with the correct FK pointing at
-- `brain_dumps(id)`. On local (already correct) the rebuild is a no-op-shaped
-- round-trip; on prod (broken) it repairs the FK reference. Idempotency is
-- guarded by `PRAGMA user_version` -- the rebuild runs exactly once per DB.
--
-- We chose unconditional rebuild over "detect the broken FK by sniffing
-- sqlite_master.sql for the substring brain_dumps_old" because:
--   * brain_dump_tags is small (tens of rows at most), so the rebuild cost
--     is trivial.
--   * Less code, fewer version-dependent surfaces, easier to reason about.
--   * The user_version stamp makes single-application certain regardless.
--
-- Idempotency: gated by `PRAGMA user_version`. The migration sets
-- `user_version=2` on success. Re-running when user_version >= 2 aborts
-- cleanly via the same abs(MIN_INT64) overflow trick used in 0001.
--
-- Dangling rows: `PRAGMA foreign_key_check` may still return rows after the
-- rebuild on local -- there are 8 pre-existing dangling brain_dump_tags rows
-- with no matching brain_dumps.id, flagged separately and unrelated to this
-- fix. We surface the check output but do NOT abort the transaction on it.
--
-- Run as:
--   sqlite3 /Users/cam/dev/personal/lifeplan/data/lifeplan.db \
--       < /Users/cam/dev/personal/lifeplan/scripts/migrations/0002_fix_brain_dump_tags_fk.sql
--
-- Take a labelled backup BEFORE running, e.g.:
--   cp data/lifeplan.db data/backups/lifeplan.db.pre-fk-fix.<timestamp>
--
-- =============================================================================

.bail on
.echo on

-- -----------------------------------------------------------------------------
-- Idempotency guard
-- -----------------------------------------------------------------------------
-- Same pattern as 0001: print a friendly line if already applied, then trip
-- a runtime int64 overflow inside a lazily-evaluated CASE so `.bail on`
-- halts before any DDL runs.

SELECT 'migration 0002_fix_brain_dump_tags_fk: already applied (user_version >= 2); aborting cleanly'
 WHERE (SELECT user_version FROM pragma_user_version) >= 2;

-- abs(MIN_INT64) overflows at step time; SQLite raises "integer overflow"
-- and `.bail on` halts the script. Lazy CASE evaluation means this expression
-- is only computed when user_version >= 2.
SELECT CASE
    WHEN (SELECT user_version FROM pragma_user_version) >= 2
    THEN abs(-9223372036854775808)  -- runtime integer overflow → abort
    ELSE 0
END;

-- -----------------------------------------------------------------------------
-- Step 1: rebuild brain_dump_tags with the correct FK
-- -----------------------------------------------------------------------------
--
-- Old schema (post-0001 on prod, where the FK was orphaned):
--
--   CREATE TABLE brain_dump_tags (
--       brain_dump_id INTEGER NOT NULL REFERENCES "brain_dumps_old"(id) ON DELETE CASCADE,
--       tag_id        INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
--       PRIMARY KEY (brain_dump_id, tag_id)
--   );
--
-- Old schema (post-0001 on local, already correct -- the rebuild is a no-op
-- in shape):
--
--   CREATE TABLE brain_dump_tags (
--       brain_dump_id INTEGER NOT NULL REFERENCES brain_dumps(id) ON DELETE CASCADE,
--       tag_id        INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
--       PRIMARY KEY (brain_dump_id, tag_id)
--   );
--
-- New schema (post-this-migration, identical on both):
--
--   CREATE TABLE brain_dump_tags (
--       brain_dump_id INTEGER NOT NULL REFERENCES brain_dumps(id) ON DELETE CASCADE,
--       tag_id        INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
--       PRIMARY KEY (brain_dump_id, tag_id)
--   );
--
-- No explicit indexes exist on brain_dump_tags beyond the implicit composite
-- PK index, which is recreated automatically with the new table. No triggers,
-- no views.
--
-- Pattern: canonical 12-step ALTER per
-- https://www.sqlite.org/lang_altertable.html#otheralter
--   * create_new -> copy -> drop_old -> rename_new
--   * NEVER rename_old_out_of_way -> create_new (the 0001 trap).

PRAGMA foreign_keys = OFF;

BEGIN;

-- 1. Create the new table with the correct FK.
CREATE TABLE brain_dump_tags_new (
    brain_dump_id INTEGER NOT NULL REFERENCES brain_dumps(id) ON DELETE CASCADE,
    tag_id        INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (brain_dump_id, tag_id)
);

-- 2. Copy every row verbatim. Composite PK is preserved by the column order.
INSERT INTO brain_dump_tags_new (brain_dump_id, tag_id)
SELECT brain_dump_id, tag_id FROM brain_dump_tags;

-- 3. Drop the old (possibly-orphaned-FK) table.
DROP TABLE brain_dump_tags;

-- 4. Rename the new table into place. Renaming the CHILD is safe across all
--    SQLite versions -- it's renaming the PARENT (in 0001) that triggered
--    the version-dependent FK-rewrite behaviour.
ALTER TABLE brain_dump_tags_new RENAME TO brain_dump_tags;

COMMIT;

PRAGMA foreign_keys = ON;

-- 5. Surface FK violations for visibility. Expect ~8 pre-existing dangling
--    brain_dump_tags rows on both local and prod (orphans whose parent
--    brain_dump was deleted before the FK was enforced). These are tracked
--    separately and are NOT this migration's concern -- we surface them
--    here only so the post-migration state is honest.
PRAGMA foreign_key_check;

-- -----------------------------------------------------------------------------
-- Step 2: stamp user_version so re-runs detect "already applied".
-- -----------------------------------------------------------------------------

PRAGMA user_version = 2;

.echo off
SELECT 'migration 0002_fix_brain_dump_tags_fk applied OK; user_version=' || user_version
FROM pragma_user_version;
