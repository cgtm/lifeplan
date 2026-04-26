"""
lifeplan -- background worker

Runs as `python3 -m app.worker`. Long-running daemon. Polls the
`work_queue` table at a 2s cadence, claims one job at a time inside
BEGIN IMMEDIATE, processes it, and finalises the row with the contract's
finalisation guard (so the watchdog cannot race us into corrupt state).

Threat model (3 sentences, per Vault practice 1):
  * Attacker: anything that can drop a row into `work_queue` -- which today
    means anything that can write to the SQLite file, i.e. the same OS
    user as the server. The queue is operational, not a public surface.
  * Reachable: arbitrary `target_id`s (including dangling ones), repeated
    failure-loops, stale `processing` rows from a crashed worker.
  * Stops it: bounded retry (3 attempts then terminal), a 5-minute
    watchdog that reclaims stuck rows, a finalisation guard that
    no-ops after a watchdog reclaim, and the privacy invariant on
    logging (IDs and error types only, never brain-dump content).

Privacy invariant (CONTRACT, NON-NEGOTIABLE):
  This logger MUST NOT receive brain-dump content or prompt content.
  Only IDs, statuses, error type-and-message strings. If you find
  yourself adding `f"content={dump.content}"` to a debug line, stop
  and re-read app/contracts/background-processing.md "Security
  properties" first.

Stdlib only -- `logging`, `sqlite3`, `signal`, `time`, `os`, `traceback`.
"""

from __future__ import annotations

import logging
import os
import signal
import sqlite3
import time
import traceback

from .db import get_db, now_utc
from .processing import process_brain_dump_for_worker, BrainDumpNotFound
from .generate_prompts import maybe_generate_prompts


logger = logging.getLogger("lifeplan.worker")

# Loop cadence and policy.
IDLE_SLEEP_SECONDS = 2
WATCHDOG_TICK_INTERVAL = 30          # ticks between watchdog runs (~60s at 2s sleep)
WATCHDOG_RECLAIM_AGE = "-5 minutes"  # SQLite datetime() modifier
MAX_ATTEMPTS = 3
ERROR_MESSAGE_MAX = 500              # truncate exception strings before storing

_shutdown = False


# -----------------------------------------------------------------------------
# Signal handling
# -----------------------------------------------------------------------------

def _request_shutdown(signum, _frame):
    """Set the cooperative shutdown flag. Loop drains its current iteration."""
    global _shutdown
    _shutdown = True
    logger.info("worker.signal received signal=%s", signum)


def _install_signal_handlers():
    signal.signal(signal.SIGTERM, _request_shutdown)
    signal.signal(signal.SIGINT, _request_shutdown)
    # SIGKILL cannot be caught -- the watchdog reclaim path handles that.


# -----------------------------------------------------------------------------
# Connection setup
# -----------------------------------------------------------------------------

def _open_conn():
    conn = get_db()
    # Brief contention (server + worker writing concurrently) is expected.
    # 5s busy timeout > our 2s poll cadence, so single-row writes don't fail.
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


# -----------------------------------------------------------------------------
# Atomic claim (per contract: state-transitions / atomic claim)
# -----------------------------------------------------------------------------

def claim_one_job(conn):
    """
    Atomically claim the oldest queued job inside BEGIN IMMEDIATE.

    Returns the claimed row as a sqlite3.Row (with id, job_type, target_id,
    attempts, claimed_at) or None if nothing was queued.

    For brain_dump jobs, also flips `brain_dumps.processing_status` to
    'processing' inside the same transaction -- that's the cache sync the
    contract calls for.
    """
    now = now_utc()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            """
            UPDATE work_queue
               SET status     = 'processing',
                   claimed_at = ?,
                   attempts   = attempts + 1
             WHERE id = (
                 SELECT id FROM work_queue
                  WHERE status = 'queued'
                  ORDER BY queued_at ASC
                  LIMIT 1
             )
             RETURNING id, job_type, target_id, attempts, claimed_at
            """,
            (now,),
        ).fetchone()

        if row is None:
            conn.execute("COMMIT")
            return None

        if row["job_type"] == "brain_dump" and row["target_id"] is not None:
            conn.execute(
                "UPDATE brain_dumps SET processing_status = 'processing' WHERE id = ?",
                (row["target_id"],),
            )

        conn.execute("COMMIT")
        return row
    except sqlite3.Error:
        # Best-effort rollback; re-raise so the outer loop's backoff path runs.
        try:
            conn.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        raise


# -----------------------------------------------------------------------------
# Job execution
# -----------------------------------------------------------------------------

def run_brain_dump_job(conn, job):
    """
    Execute a brain_dump job. Returns the result dict from
    process_brain_dump_for_worker, which the caller uses to finalise.

    Does not commit -- finalise_success owns the transactional close.
    """
    return process_brain_dump_for_worker(conn, job["target_id"])


def run_prompt_generation_job(conn, job):
    """
    Execute a prompt_generation job. Cooldown logic lives in
    `maybe_generate_prompts`; if the cooldown rejects, we still consider
    the job done (the request was honoured by being considered).

    Returns None -- prompt jobs have no per-job result payload.
    """
    # maybe_generate_prompts opens its own connection and commits internally.
    # That's fine: it's not under our finalisation guard transaction.
    maybe_generate_prompts()
    return None


# -----------------------------------------------------------------------------
# Finalisation (per contract: finalisation guard)
# -----------------------------------------------------------------------------

def _begin_immediate_if_needed(conn):
    """
    Start a writer transaction unless the connection already has an
    implicit one open from prior DML (sqlite3 default isolation level
    auto-begins on first INSERT/UPDATE/DELETE).

    Returns True if WE opened the transaction (caller's
    rollback-on-error must run); False if we're piggybacking on an
    implicit transaction that the caller already started writes inside
    (rollback still safe -- it discards the whole txn).

    This matters for brain_dump jobs: `_auto_create_item` issues
    INSERTs into the worker's connection during processing, which leaves
    `conn.in_transaction = True`. Without this guard, the explicit
    `BEGIN IMMEDIATE` here raises OperationalError ("cannot start a
    transaction within a transaction"), the queue row stays in
    `processing` until watchdog reclaim, then bounces through retries.
    Per contract, the auto-created rows and the queue finalisation
    must commit atomically -- so we DON'T want a separate transaction.
    """
    if conn.in_transaction:
        return False
    conn.execute("BEGIN IMMEDIATE")
    return True


def finalise_success(conn, job, brain_dump_result=None):
    """
    Mark the queue row done, guarded by (id, status='processing', original
    claimed_at). If the watchdog reclaimed mid-run, this is a no-op and the
    next claim will reprocess the row -- which is exactly what we want.

    For brain_dump jobs, sync `brain_dumps.processing_status` to the
    extraction outcome (`processed` or `needs_review`) and persist the
    processed_items JSON. Done in the same transaction as the queue update
    AND the same transaction as any auto-created rows from
    `_auto_create_item` (per contract).
    """
    now = now_utc()
    try:
        _begin_immediate_if_needed(conn)
        cur = conn.execute(
            """
            UPDATE work_queue
               SET status       = 'done',
                   completed_at = ?,
                   error        = NULL
             WHERE id           = ?
               AND status       = 'processing'
               AND claimed_at   = ?
            """,
            (now, job["id"], job["claimed_at"]),
        )
        if cur.rowcount == 0:
            # Watchdog won the race. No double-write to brain_dumps.
            conn.execute("ROLLBACK")
            logger.warning(
                "worker.finalise.superseded job_id=%s job_type=%s target_id=%s",
                job["id"], job["job_type"], job["target_id"],
            )
            return False

        if job["job_type"] == "brain_dump" and brain_dump_result is not None:
            ts = brain_dump_result["processed_at"]
            new_status = brain_dump_result["processing_status"]
            conn.execute(
                """
                UPDATE brain_dumps
                   SET processing_status = ?,
                       processed_items   = ?,
                       processed_at      = ?,
                       processed         = ?,
                       updated_at        = ?
                 WHERE id = ?
                """,
                (
                    new_status,
                    brain_dump_result["processed_items_json"],
                    ts,
                    1 if new_status == "processed" else 0,
                    ts,
                    job["target_id"],
                ),
            )

        conn.execute("COMMIT")
        return True
    except sqlite3.Error:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        raise


def finalise_skipped(conn, job, reason):
    """
    Mark the queue row `done` (terminal, no retry) with an explanatory
    `error` field. Used when the job target is gone (e.g. brain_dump
    deleted before processing finished) -- there's nothing to retry, so
    the row should not bounce back through the queue.

    Uses the same finalisation guard as `finalise_success` so a watchdog
    reclaim that already requeued the row leaves us a no-op. Returns True
    if we won the race; False if the watchdog beat us to it.
    """
    now = now_utc()
    error_text = reason
    if len(error_text) > ERROR_MESSAGE_MAX:
        error_text = error_text[:ERROR_MESSAGE_MAX - 1] + "…"
    try:
        _begin_immediate_if_needed(conn)
        cur = conn.execute(
            """
            UPDATE work_queue
               SET status       = 'done',
                   completed_at = ?,
                   error        = ?
             WHERE id           = ?
               AND status       = 'processing'
               AND claimed_at   = ?
            """,
            (now, error_text, job["id"], job["claimed_at"]),
        )
        if cur.rowcount == 0:
            conn.execute("ROLLBACK")
            logger.warning(
                "worker.skip.superseded job_id=%s job_type=%s target_id=%s",
                job["id"], job["job_type"], job["target_id"],
            )
            return False
        # No brain_dumps cache update -- the row is gone (that's why we're
        # skipping). The cascade-delete in handle_delete_brain_dump will
        # also have removed any other queued rows for this target.
        conn.execute("COMMIT")
        return True
    except sqlite3.Error:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        raise


def handle_failure(conn, job, exc):
    """
    Apply the contract's retry policy.

      * attempts >= MAX_ATTEMPTS -> terminal `failed`, sync brain_dumps cache.
      * else                     -> requeue (status='queued', claimed_at=NULL).

    Both writes use the finalisation guard (claimed_at match) so a watchdog
    reclaim that already requeued the row leaves us a no-op.

    The error column carries `f"{type(exc).__name__}: {exc}"` truncated to
    ERROR_MESSAGE_MAX. NEVER a traceback (those go to the log only) and
    NEVER user content (the exception message itself shouldn't carry
    brain-dump text from any well-behaved code path; if a future LLM wrapper
    starts inlining content into exception messages, this is the choke point
    to sanitise -- privacy invariant).
    """
    now = now_utc()
    error_text = f"{type(exc).__name__}: {exc}"
    if len(error_text) > ERROR_MESSAGE_MAX:
        error_text = error_text[:ERROR_MESSAGE_MAX - 1] + "…"

    terminal = job["attempts"] >= MAX_ATTEMPTS

    # Failure path: discard any partial writes from processing (e.g. an
    # _auto_create_item INSERT that left the connection in an implicit
    # transaction before the exception was raised) so the failure record
    # doesn't accidentally commit half-built rows alongside it.
    if conn.in_transaction:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.Error:
            pass

    try:
        conn.execute("BEGIN IMMEDIATE")
        if terminal:
            cur = conn.execute(
                """
                UPDATE work_queue
                   SET status       = 'failed',
                       error        = ?,
                       completed_at = ?
                 WHERE id           = ?
                   AND status       = 'processing'
                   AND claimed_at   = ?
                """,
                (error_text, now, job["id"], job["claimed_at"]),
            )
            if cur.rowcount and job["job_type"] == "brain_dump" and job["target_id"] is not None:
                conn.execute(
                    "UPDATE brain_dumps SET processing_status = 'failed' WHERE id = ?",
                    (job["target_id"],),
                )
        else:
            cur = conn.execute(
                """
                UPDATE work_queue
                   SET status     = 'queued',
                       error      = ?,
                       claimed_at = NULL
                 WHERE id         = ?
                   AND status     = 'processing'
                   AND claimed_at = ?
                """,
                (error_text, job["id"], job["claimed_at"]),
            )
            if cur.rowcount and job["job_type"] == "brain_dump" and job["target_id"] is not None:
                conn.execute(
                    "UPDATE brain_dumps SET processing_status = 'queued' WHERE id = ?",
                    (job["target_id"],),
                )

        conn.execute("COMMIT")
    except sqlite3.Error:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        raise

    # Privacy invariant: error_type_only fields, no content.
    if terminal:
        logger.warning(
            "worker.failed job_id=%s job_type=%s target_id=%s attempts=%s error_type=%s terminal=true",
            job["id"], job["job_type"], job["target_id"], job["attempts"],
            type(exc).__name__,
        )
    else:
        logger.info(
            "worker.retry job_id=%s job_type=%s target_id=%s attempts=%s error_type=%s",
            job["id"], job["job_type"], job["target_id"], job["attempts"],
            type(exc).__name__,
        )


# -----------------------------------------------------------------------------
# Watchdog
# -----------------------------------------------------------------------------

def run_watchdog(conn):
    """
    Reclaim rows in `processing` whose `claimed_at` is older than the
    reclaim window. For each reclaimed brain_dump row, sync the cache.
    Logs `worker.watchdog.reclaimed` with the count when work was done.
    """
    try:
        conn.execute("BEGIN IMMEDIATE")

        # Identify reclaim candidates first so we can sync brain_dumps cache.
        candidates = conn.execute(
            f"""
            SELECT id, job_type, target_id
              FROM work_queue
             WHERE status     = 'processing'
               AND claimed_at < datetime('now','{WATCHDOG_RECLAIM_AGE}')
            """
        ).fetchall()

        if not candidates:
            conn.execute("COMMIT")
            return 0

        ids = [r["id"] for r in candidates]
        placeholders = ",".join("?" for _ in ids)
        conn.execute(
            f"""
            UPDATE work_queue
               SET status     = 'queued',
                   claimed_at = NULL
             WHERE id IN ({placeholders})
            """,
            ids,
        )

        bd_targets = [
            r["target_id"] for r in candidates
            if r["job_type"] == "brain_dump" and r["target_id"] is not None
        ]
        if bd_targets:
            bd_placeholders = ",".join("?" for _ in bd_targets)
            conn.execute(
                f"""
                UPDATE brain_dumps
                   SET processing_status = 'queued'
                 WHERE processing_status = 'processing'
                   AND id IN ({bd_placeholders})
                """,
                bd_targets,
            )

        conn.execute("COMMIT")
    except sqlite3.Error:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        raise

    logger.warning("worker.watchdog.reclaimed count=%s", len(candidates))
    return len(candidates)


# -----------------------------------------------------------------------------
# Main loop
# -----------------------------------------------------------------------------

def main_loop():
    """
    The actual loop. One DB connection at module scope is fine for a single
    worker process. Idle ticks log nothing -- only meaningful work is logged.

    Wraps the per-job try/except around `run_*_job` so a job failure never
    crashes the loop. Genuinely unexpected errors (e.g. DB unreachable)
    propagate up and are caught by the outer guard with backoff.
    """
    conn = _open_conn()
    tick = 0

    try:
        while not _shutdown:
            tick += 1

            # Watchdog every WATCHDOG_TICK_INTERVAL ticks.
            if tick % WATCHDOG_TICK_INTERVAL == 0:
                try:
                    run_watchdog(conn)
                except sqlite3.Error as e:
                    logger.error("worker.watchdog.error error_type=%s", type(e).__name__)

            # Try to claim a job.
            try:
                job = claim_one_job(conn)
            except sqlite3.Error as e:
                logger.error("worker.claim.error error_type=%s", type(e).__name__)
                time.sleep(IDLE_SLEEP_SECONDS)
                continue

            if job is None:
                time.sleep(IDLE_SLEEP_SECONDS)
                continue

            logger.info(
                "worker.claimed job_id=%s job_type=%s target_id=%s attempts=%s",
                job["id"], job["job_type"], job["target_id"], job["attempts"],
            )

            t_start = time.time()
            result = None
            try:
                if job["job_type"] == "brain_dump":
                    result = run_brain_dump_job(conn, job)
                elif job["job_type"] == "prompt_generation":
                    result = run_prompt_generation_job(conn, job)
                else:
                    # Shouldn't happen -- CHECK constraint guards values --
                    # but fail closed if it does.
                    raise ValueError(f"unknown job_type: {job['job_type']}")
            except BrainDumpNotFound:
                # Race: brain_dump was deleted between claim and processing
                # (or between queue and claim). Mark queue row done with an
                # explanatory error -- no retries, no backoff, no failure
                # noise. The brain_dumps cascade-delete in handle_delete_
                # brain_dump cleans up sibling queued rows; this branch
                # handles the row already in flight.
                logger.info(
                    "worker.job.skipped job_id=%s job_type=%s target_id=%s reason=brain_dump_deleted",
                    job["id"], job["job_type"], job["target_id"],
                )
                try:
                    finalise_skipped(
                        conn, job,
                        "brain_dump deleted before processing completed",
                    )
                except sqlite3.Error as db_err:
                    logger.error(
                        "worker.skip.error job_id=%s error_type=%s",
                        job["id"], type(db_err).__name__,
                    )
                continue
            except Exception as e:
                # Privacy invariant: log error TYPE, not the exception's str()
                # at this layer (the str may carry user content via upstream
                # libs). The DB column gets the truncated `type: message`
                # via handle_failure, which is the documented contract.
                logger.warning(
                    "worker.job.error job_id=%s job_type=%s target_id=%s error_type=%s",
                    job["id"], job["job_type"], job["target_id"], type(e).__name__,
                )
                try:
                    handle_failure(conn, job, e)
                except sqlite3.Error as db_err:
                    # Failure handler itself failed -- log + continue;
                    # watchdog will reclaim eventually.
                    logger.error(
                        "worker.handle_failure.error job_id=%s error_type=%s",
                        job["id"], type(db_err).__name__,
                    )
                continue

            try:
                ok = finalise_success(conn, job, brain_dump_result=result)
            except sqlite3.Error as e:
                logger.error(
                    "worker.finalise.error job_id=%s error_type=%s",
                    job["id"], type(e).__name__,
                )
                continue

            if ok:
                duration_ms = int((time.time() - t_start) * 1000)
                logger.info(
                    "worker.processed job_id=%s job_type=%s target_id=%s duration_ms=%s",
                    job["id"], job["job_type"], job["target_id"], duration_ms,
                )
            # No sleep after success: drain queued work eagerly.
    finally:
        try:
            conn.close()
        except sqlite3.Error:
            pass


def main():
    level_name = os.environ.get("LIFEPLAN_WORKER_LOG_LEVEL", "INFO").upper()
    level = getattr(logging, level_name, logging.INFO)
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    _install_signal_handlers()
    logger.info("worker.started pid=%s", os.getpid())

    backoff = 1.0
    try:
        while not _shutdown:
            try:
                main_loop()
                # Clean exit (shutdown flag set inside the loop).
                break
            except Exception:
                # Genuinely unexpected (e.g. DB file vanished). Log with
                # traceback (NOT into the DB), back off, and try again.
                # The traceback goes to stderr only -- no user content leaks
                # because tracebacks don't carry brain-dump payloads.
                logger.error(
                    "worker.loop.crashed traceback=%s",
                    traceback.format_exc().replace("\n", " | "),
                )
                # Cap backoff at 30s; reset after a clean iteration.
                time.sleep(min(backoff, 30.0))
                backoff = min(backoff * 2.0, 30.0)
    finally:
        logger.info("worker.stopped")


if __name__ == "__main__":
    main()
