-- =============================================================================
-- Migration 0003: backfill items dropped by silent-None bugs in _auto_create_item
-- =============================================================================
--
-- Why this migration exists
-- -------------------------
-- Two bug classes in `app/processing.py::_auto_create_item` allowed items
-- flagged as `auto_created` upstream to silently return None instead of
-- inserting their underlying record:
--
--   1. The `tag` branch returned None when the LLM said is_new=False but
--      didn't supply a matched_existing_id. (Fixed in this commit by falling
--      through to the create-new path.)
--
--   2. The `person_mention` branch returned None when given an unmatched
--      person_name. (Fixed in a prior commit by mapping the mention into the
--      same INSERT path as person_new.)
--
-- The processed_items JSON for the affected dumps was written with
-- status='auto_created' and created_id=null, so the UI shows the items as
-- created but no `tags` / `people` row actually exists.
--
-- Three rows on prod are affected:
--
--   * brain_dump #18, item[5]: tag "leadership"
--   * brain_dump #18, item[6]: tag "team"
--   * brain_dump #32, item[1]: person_mention "mum"
--
-- This migration:
--   1. Inserts the missing `tags` rows ("leadership", "team") if absent.
--   2. Inserts the missing `people` row ("mum") if absent.
--   3. Inserts the `brain_dump_tags` junction rows linking #18 to the two
--      new tags, ONLY IF brain_dump #18 exists in this DB.
--   4. Does NOT update the historical processed_items JSON for dumps #18
--      and #32. See "Why we don't backfill processed_items JSON" below.
--   5. Stamps PRAGMA user_version = 3.
--
-- Why we don't backfill processed_items JSON
-- ------------------------------------------
-- The user-visible signal that matters is the records existing in the
-- People and Tags views. Backfilling created_id inside the JSON for those
-- two dumps would require sqlite3 JSON1 surgery (json_set on a path inside
-- json_each), is fragile, and yields no UX win -- the dumps' "approved
-- items" panels are already rendered; nobody re-opens an old dump to look
-- at created_id values. Engineering vanity, deliberately skipped.
--
-- Local vs prod
-- -------------
-- Local DB has different brain dump IDs than prod. On local, brain_dumps
-- with id 18 and 32 likely don't exist, so:
--   * The `tags` and `people` inserts run unconditionally with INSERT OR
--     IGNORE -- safe to apply even if those names already exist.
--   * The `brain_dump_tags` inserts are guarded by `WHERE EXISTS (SELECT
--     1 FROM brain_dumps WHERE id = 18)` so they no-op cleanly when the
--     parent dump is absent.
-- The user_version stamp succeeds either way; re-running the script after
-- this aborts cleanly via the standard guard.
--
-- Idempotency: gated by `PRAGMA user_version`. Sets `user_version=3` on
-- success. Re-running when user_version >= 3 aborts cleanly via the same
-- abs(MIN_INT64) overflow trick used by 0001 and 0002.
--
-- Run as:
--   sqlite3 /Users/cam/dev/personal/lifeplan/data/lifeplan.db \
--       < /Users/cam/dev/personal/lifeplan/scripts/migrations/0003_backfill_dropped_items.sql
--
-- Take a labelled backup BEFORE running, e.g.:
--   cp data/lifeplan.db data/backups/lifeplan.db.pre-0003.<timestamp>
--
-- =============================================================================

.bail on
.echo on

-- -----------------------------------------------------------------------------
-- Idempotency guard
-- -----------------------------------------------------------------------------
-- Same pattern as 0001/0002: friendly line if already applied, then trip a
-- runtime int64 overflow inside a lazily-evaluated CASE so `.bail on` halts
-- before any DML runs.

SELECT 'migration 0003_backfill_dropped_items: already applied (user_version >= 3); aborting cleanly'
 WHERE (SELECT user_version FROM pragma_user_version) >= 3;

SELECT CASE
    WHEN (SELECT user_version FROM pragma_user_version) >= 3
    THEN abs(-9223372036854775808)  -- runtime integer overflow -> abort
    ELSE 0
END;

-- -----------------------------------------------------------------------------
-- Step 1: insert the missing tags and person rows
-- -----------------------------------------------------------------------------

BEGIN;

-- Tags: schema is (id INTEGER PK AUTOINC, name TEXT UNIQUE).
-- INSERT OR IGNORE on UNIQUE(name) means if these tags already exist
-- (e.g. user added them manually before backfill), the insert no-ops and
-- the existing id stands. Either way, after this block the row exists.
INSERT OR IGNORE INTO tags (name) VALUES ('leadership');
INSERT OR IGNORE INTO tags (name) VALUES ('team');

-- People: schema has no UNIQUE on name (people can share names), so
-- INSERT OR IGNORE alone won't dedupe. Guard with NOT EXISTS so we
-- don't create a second "mum" row on re-runs that bypass the version
-- guard somehow (defensive belt-and-braces; the version guard is the
-- primary protection).
INSERT INTO people (name, relationship, notes, created_at, updated_at)
SELECT 'mum', 'unknown', '', datetime('now'), datetime('now')
 WHERE NOT EXISTS (SELECT 1 FROM people WHERE name = 'mum');

-- -----------------------------------------------------------------------------
-- Step 2: link the new tags to brain_dump #18 (prod-only; no-op on local)
-- -----------------------------------------------------------------------------
-- The WHERE EXISTS guards ensure these inserts only fire on the prod DB
-- where brain_dump 18 actually exists. On local (where dump 18 doesn't
-- exist) these are no-ops -- we still stamp user_version cleanly so the
-- migration registers as applied.

INSERT OR IGNORE INTO brain_dump_tags (brain_dump_id, tag_id)
SELECT 18, t.id
  FROM tags t
 WHERE t.name = 'leadership'
   AND EXISTS (SELECT 1 FROM brain_dumps WHERE id = 18);

INSERT OR IGNORE INTO brain_dump_tags (brain_dump_id, tag_id)
SELECT 18, t.id
  FROM tags t
 WHERE t.name = 'team'
   AND EXISTS (SELECT 1 FROM brain_dumps WHERE id = 18);

-- Note: there is no people <-> brain_dump junction table to populate for
-- dump #32's "mum" mention. The person_mention path historically inserts
-- only into `people`; the link to the dump lives in the processed_items
-- JSON, which we deliberately do not rewrite here. Creating the people
-- row is the user-visible repair.

COMMIT;

-- -----------------------------------------------------------------------------
-- Step 3: stamp user_version so re-runs detect "already applied".
-- -----------------------------------------------------------------------------

PRAGMA user_version = 3;

.echo off
SELECT 'migration 0003_backfill_dropped_items applied OK; user_version=' || user_version
FROM pragma_user_version;
