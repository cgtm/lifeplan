# Contract: background-processing

**Authors:** Vault (server + worker), Lumen (client), Reed (schema), supervised by Cairn
**Status:** accepted
**Last updated:** 2026-04-23

> **Sibling contract:** the per-item create helper called from inside
> the worker (and from the user-approval path) has its own one-page
> contract — see [`auto-create-item.md`](./auto-create-item.md). That
> contract owns the per-item `status` truthfulness invariants
> (return-vs-status, exception discipline, per-branch recovery,
> unknown-itype defence, caller obligations) split out of this document
> so each stays focused.

Phase 0 of the background-processing rollout. Plan:
`/Users/cam/.claude/plans/new-plan-as-a-immutable-unicorn.md`. Written
before any implementation code, per practice 1 ("Contract-before-code") in
[`docs/processes/team-practices.md`](../../docs/processes/team-practices.md);
sign-offs from Vault, Lumen, and Reed under Cairn's supervision. Working
document — update when reality forces a change.

The mental model is Cam's, and is load-bearing: **an explicit queue table
that brain-dumps and prompt requests get placed onto, processed one by one
by a worker, with the UI marking not-yet-processed items as pending.**
Everything below is the engineering shape of that sentence.

## Mount story

The worker is a server-side daemon (`python3 -m app.worker`) with no URL
surface of its own. It reads and writes the same SQLite database the
server uses, at the same path: `data/lifeplan.db` (resolved relative to
the project root in dev; the configured data dir in prod). Same OS user as
the server, same FS permissions, no escalation, same connection knobs
(WAL, busy timeout, FKs on).

The HTTP endpoints introduced or amended by this contract follow the
existing mount-aware convention from
[`app/contracts/cookie-auth.md`](./cookie-auth.md). Every URL the client
emits is composed against `MOUNT` (`app/app.js`); every server-issued
redirect uses an `auth.*_url()`-style helper. No root-absolute paths in
user-reachable code. Practice 2 ("Mount-aware path handling") applies
unchanged.

The worker emits no URLs and issues no redirects, so it is not subject to
practice 2 — but it does emit log lines, see "Operational properties."

## Job lifecycle

Two state machines, kept in sync atomically by the worker:

### `work_queue.status` — source of truth

```
queued ──claim──▶ processing ──ok────▶ done       (terminal)
                            │
                            ├──fail (attempts < 3)──▶ queued (re-try)
                            │
                            └──fail (attempts ≥ 3)──▶ failed (terminal)

processing ──watchdog (claimed_at < now − 5m)──▶ queued
failed     ──POST /retry──▶ queued (attempts reset)
```

Terminal states: `done`, `failed`. `failed` rows are not deleted — they're
the audit trail and the retry source. `done` rows are retained too (see
"Open questions" for prune cadence).

### `brain_dumps.processing_status` — denormalised display cache

The worker keeps this in sync with the queue row in the same transaction
that updates the queue row, so the UI can render badges from a single row
read without joining to `work_queue`.

```
unprocessed (legacy default, pre-migration rows)
queued       (queue row exists, status='queued')
processing   (queue row exists, status='processing')
processed    (queue row terminal, status='done', items extracted)
needs_review (queue row terminal, status='done', items need approval)
failed       (queue row terminal, status='failed', max attempts hit)
```

`processed` vs `needs_review` is a worker-side decision based on the
extraction outcome; both correspond to `work_queue.status='done'`. Item
approval itself stays synchronous (~50–500ms); queueing buys nothing.

### Backward compat

Pre-migration `brain_dumps` rows carry `processing_status='unprocessed'`
and have no queue entry. Two policies:

- **At deploy (one-shot SQL):** for every `brain_dumps` row with
  `processing_status='unprocessed'` and no non-terminal `work_queue` row,
  insert a `work_queue` row (`job_type='brain_dump'`, `status='queued'`,
  `target_id=<dump.id>`) and update the dump's cache to `'queued'`. Idempotent.
- **At runtime (defensive):** the UI continues to render `'unprocessed'`
  as a grey "Pending" badge identical to `'queued'` (see "Visual
  states") so a missed cut-over row degrades gracefully rather than
  appearing terminal.

`claimed_at` lives on `work_queue` only. The queue row is the source of
truth; `brain_dumps.processing_status` is a cache. Single source of truth.

## Schema

### `work_queue` (new)

```sql
CREATE TABLE work_queue (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    job_type     TEXT    NOT NULL
                         CHECK (job_type IN ('brain_dump','prompt_generation')),
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
CREATE INDEX idx_work_queue_claim
    ON work_queue(status, queued_at)
    WHERE status = 'queued';

-- At most one non-terminal queue entry per brain_dump.
CREATE UNIQUE INDEX idx_work_queue_one_active_per_dump
    ON work_queue(job_type, target_id)
    WHERE job_type = 'brain_dump'
      AND status IN ('queued','processing');

-- At most one non-terminal prompt_generation row at a time.
-- (Coalescing is the desired behaviour: see Endpoints / `POST /api/prompts/generate`.)
CREATE UNIQUE INDEX idx_work_queue_one_active_prompt
    ON work_queue(job_type)
    WHERE job_type = 'prompt_generation'
      AND status IN ('queued','processing');
```

Notes:
- `target_id` references `brain_dumps.id` when `job_type='brain_dump'`.
  No FK constraint declared — the queue is operational, not relational
  ground truth, and we don't want a brain-dump deletion to fail or cascade
  into queue history. It is `NULL` for `prompt_generation` (one canonical
  prompt-set; no id needed).
- `error TEXT` carries the last exception's `type: message`. No tracebacks
  in the column. Stack traces go to the worker log, not the database.
- All timestamps are `datetime('now')` UTC strings — consistent with the
  existing schema convention.

### `brain_dumps` (amended)

Extend the existing CHECK constraint on `processing_status` to admit two
new values, `'queued'` and `'failed'`. Concretely (Reed will land this as
a migration that copies the table per SQLite's CHECK-altering convention):

```sql
-- New permissible values. Existing values unchanged.
processing_status TEXT NOT NULL DEFAULT 'unprocessed'
    CHECK (processing_status IN (
        'unprocessed','queued','processing',
        'processed','needs_review','failed'
    ))
```

No new columns on `brain_dumps`. `claimed_at`, `attempts`, `error` live on
`work_queue` only.

## Endpoints

All paths below are **post-mount-strip** as the Python server sees them
(nginx strips `/lifeplan` before proxying in prod). Browser-facing URLs
prepend the mount, per practice 2.

All endpoints are auth-required (existing cookie-auth middleware,
[`cookie-auth.md`](./cookie-auth.md)). All state-changing methods require
`Content-Type: application/json` (415 otherwise, same as cookie-auth's
existing gate). HEAD coverage applies to the `GET` route per practice 9.

### `POST /api/brain-dumps`

Submit a brain dump. Handler does **not** call processing inline.

- **Request headers:** `Content-Type: application/json`. Auth cookie.
- **Request body:** `{"text": "<string>", …existing fields}`.
- **Response 202:** `{"id": <int>, "processing_status": "queued", …<rest of dump row>}`.
  `Content-Type: application/json; charset=utf-8`.
- **Post-condition:** one `brain_dumps` row inserted with
  `processing_status='queued'`; one `work_queue` row inserted with
  `(job_type='brain_dump', target_id=<dump.id>, status='queued', attempts=0)`.
  Both writes happen in a single transaction.
- **Response 4xx:** existing input-validation errors (400 on malformed
  body, 415 on wrong Content-Type) per the cookie-auth gate.
- **Response 500:** `{"error": "storage error"}` — DB write failed. No
  internal exception text leaks. Body shape mirrors cookie-auth.

### `GET /api/brain-dumps`, `GET /api/brain-dumps/<id>`

Existing endpoints. Response shape **must include** `processing_status`
(it already does in the row dict). No other change.

- **Response 200:** `{…, "processing_status": "<one of the lifecycle states>", …}`.
- HEAD coverage: same status and headers as GET, empty body.

### `POST /api/brain-dumps/<id>/process`

Re-queue a brain dump for processing. Idempotent if already non-terminal.

- **Request headers:** `Content-Type: application/json`. Auth cookie.
- **Request body:** `{}`.
- **Response 202:** `{"id": <int>, "processing_status": "queued"}`.
  Inserts a `work_queue` row only if no non-terminal one exists for this
  dump (the partial unique index would reject a duplicate anyway; the
  handler checks first and returns 202 without insert if one exists,
  treating coalescing as success).
- **Response 404:** `{"error": "not found"}` — no such dump.
- **Response 409:** `{"error": "already processing"}` — there is a
  non-terminal queue row in `status='processing'`. Distinct from the
  idempotent `queued`-already case (which returns 202).
- **Post-condition:** at most one non-terminal `work_queue` row for the
  dump; `brain_dumps.processing_status='queued'`.

### `POST /api/brain-dumps/<id>/retry` (new)

Re-queue a **failed** dump, resetting attempts.

- **Request headers:** `Content-Type: application/json`. Auth cookie.
- **Request body:** `{}`.
- **Response 202:** `{"id": <int>, "processing_status": "queued"}`.
- **Response 404:** `{"error": "not found"}`.
- **Response 409:** `{"error": "not in failed state"}` — dump's
  `processing_status` is anything other than `'failed'`. Use `/process`
  for non-failed re-queues.
- **Post-condition:** previous `failed` queue row is **left in place** as
  audit trail; a **new** `work_queue` row is inserted with
  `(status='queued', attempts=0, error=NULL)`. `brain_dumps.processing_status`
  set to `'queued'`. The partial unique index is satisfied because the
  prior `failed` row is terminal.

### `POST /api/prompts/generate`

Trigger prompt-set regeneration. Coalesced — multiple rapid calls do not
queue multiple jobs.

- **Request headers:** `Content-Type: application/json`. Auth cookie.
- **Request body:** `{}`.
- **Response 202:** `{"queued": true}`. If a non-terminal
  `prompt_generation` row already exists, returns 202 without insert
  (coalescing is the desired behaviour, enforced by
  `idx_work_queue_one_active_prompt`). The client cannot tell the two
  cases apart and shouldn't need to.
- **Post-condition:** exactly one non-terminal `work_queue` row with
  `(job_type='prompt_generation', target_id=NULL)`.

## State transitions (worker SQL)

The worker runs a 2-second poll loop. ≤5s SLA on brain-dump turnaround
follows directly from "≤2s to claim + processing time."

### Atomic claim

Inside `BEGIN IMMEDIATE` (writer lock; SQLite serialises writers):

```sql
UPDATE work_queue
   SET status='processing',
       claimed_at = :now,
       attempts   = attempts + 1
 WHERE id = (
     SELECT id FROM work_queue
      WHERE status = 'queued'
      ORDER BY queued_at ASC
      LIMIT 1
 )
RETURNING id, job_type, target_id, attempts, claimed_at;
```

`attempts` is incremented **at claim time**, not at finalisation. This
means a crash mid-job still consumes an attempt — deliberate; otherwise a
poison job loops forever.

For `job_type='brain_dump'`, the worker also performs, in the same
transaction:

```sql
UPDATE brain_dumps
   SET processing_status = 'processing'
 WHERE id = :target_id;
```

### Watchdog (every ~30 ticks ≈ 60s)

Reclaims stuck rows whose worker died mid-job:

```sql
UPDATE work_queue
   SET status     = 'queued',
       claimed_at = NULL
 WHERE status     = 'processing'
   AND claimed_at < datetime('now','-5 minutes');
```

For each reclaimed brain-dump row, sync the cache:

```sql
UPDATE brain_dumps
   SET processing_status = 'queued'
 WHERE processing_status = 'processing'
   AND id IN (
       SELECT target_id FROM work_queue
        WHERE status   = 'queued'
          AND job_type = 'brain_dump'
          AND target_id = brain_dumps.id
   );
```

(Both statements run in one transaction. The watchdog logs an event per
reclaimed row, see "Operational properties.")

### Finalisation guard

The worker captured `claimed_at` from the claim's RETURNING. Every
finalisation `UPDATE` carries that value as a guard:

```sql
UPDATE work_queue
   SET status       = 'done',
       completed_at = :now,
       error        = NULL
 WHERE id           = :id
   AND status       = 'processing'
   AND claimed_at   = :original_claimed_at;
```

If the watchdog reclaimed the row mid-run, `claimed_at` no longer matches
and the write is a no-op. The worker treats `rowcount == 0` as
"superseded by watchdog reclaim" — no error, no double-write to
`brain_dumps`, the next claim will reprocess. This is the only race the
two-table design has to win, and the guard wins it.

### Failure handler

On exception during processing:

```sql
-- attempts already incremented at claim time; check the post-claim value.
-- If attempts >= 3, terminal failure:
UPDATE work_queue
   SET status     = 'failed',
       error      = :exc_type_and_message,
       completed_at = :now
 WHERE id         = :id
   AND status     = 'processing'
   AND claimed_at = :original_claimed_at;
-- For brain_dump: also UPDATE brain_dumps SET processing_status='failed' WHERE id=:target_id.

-- Else (attempts < 3), return to the queue:
UPDATE work_queue
   SET status     = 'queued',
       error      = :exc_type_and_message,
       claimed_at = NULL
 WHERE id         = :id
   AND status     = 'processing'
   AND claimed_at = :original_claimed_at;
-- For brain_dump: also UPDATE brain_dumps SET processing_status='queued' WHERE id=:target_id.
```

Same guard. Same no-op-if-reclaimed semantics.

`error` is the literal string `f"{type(exc).__name__}: {exc}"`. No
traceback, no user content (see "Security properties").

## Polling contract

Frontend uses `setTimeout` recursion (NOT `setInterval`) at **3s
intervals**. The 3s cadence is a deliberate compromise: shorter than the
worker's per-job ceiling so the UI feels live, longer than the 2s worker
poll so we don't race the worker into reporting stale state.

- **Where:** only on pages that render brain-dump status (the dump list
  view, the single-dump view, anywhere a `processing_status` badge is on
  screen). The prompt-generation surface polls likewise when a prompt
  job is in flight.
- **What it polls:** `GET /api/brain-dumps` (or the single-dump variant
  when on a single-dump page).
- **Stop condition:** as soon as **no visible row** has
  `processing_status` in `{queued, unprocessed, processing}`. Terminal
  states (`processed`, `needs_review`, `failed`) plus the absence of any
  in-flight row → cancel the next `setTimeout`.
- **Lifecycle:** the recursive timer is bound to component mount. On
  unmount / page leave, the pending timeout is cleared so no orphan
  timers fire after navigation.
- **Restart:** clicking the Retry button (`POST .../retry`) returns 202
  and the client re-arms the polling loop, since a previously-terminal
  row is now back in flight.
- **No `setInterval`.** Recursion lets each tick await the previous fetch
  completing, which avoids stacked requests when the network is slow.

## Visual states

Lumen owns the look. The contract guarantees the binding from
`brain_dumps.processing_status` to badge:

| `processing_status`         | Badge                                  | Affordance |
|---|---|---|
| `unprocessed` (legacy)      | grey "Pending"                         | none |
| `queued`                    | grey "Pending"                         | none |
| `processing`                | grey + spinner "Processing"            | none (wait) |
| `processed`                 | green "Done"                           | none |
| `needs_review`              | amber "Needs review"                   | row click → review surface |
| `failed`                    | red "Failed"                           | **Retry** button → `POST .../retry` |

`unprocessed` and `queued` render identically — the legacy value
degrades gracefully into the new vocabulary, per "Backward compat."

The Retry button is the **only** UI affordance that issues
`POST /api/brain-dumps/<id>/retry`. There is no "process now" button on
non-failed rows; for those, the dump's existence in the queue is the only
input the worker needs.

## Error matrix

| Status | Where                                | Meaning                                                    | Client behaviour |
|---|---|---|---|
| 202 + `{processing_status:"queued"}`   | `POST /api/brain-dumps`              | Dump accepted, queued                                      | Render with grey "Pending" badge; start polling |
| 202 + `{processing_status:"queued"}`   | `POST .../<id>/process`              | Re-queued (or already queued — idempotent)                 | Re-render badge as "Pending"; ensure polling running |
| 202 + `{processing_status:"queued"}`   | `POST .../<id>/retry`                | Failed dump re-queued                                      | Replace red Failed with "Pending"; restart polling |
| 202 + `{queued:true}`                  | `POST /api/prompts/generate`         | Prompt regen queued (or coalesced)                         | Show "Generating prompts…" indicator; poll for completion |
| 404 `{"error":"not found"}`            | Any `/<id>/*` endpoint               | No such dump                                               | Toast "That dump no longer exists"; remove row from view |
| 409 `{"error":"already processing"}`   | `POST .../<id>/process`              | Non-terminal queue row in `processing`                     | No-op; UI already shows spinner |
| 409 `{"error":"not in failed state"}`  | `POST .../<id>/retry`                | Dump is not currently `failed`                             | Toast "Nothing to retry"; refetch dump to resync state |
| 415 `{"error":"unsupported media type"}` | Any state-changing endpoint        | Wrong `Content-Type`                                       | Should be unreachable — `api()` always sends JSON; fall through to "Something went wrong." |
| 500 `{"error":"storage error"}`        | `POST /api/brain-dumps`              | DB write failed                                            | Toast "Couldn't save dump. Try again."; do not clear the input |
| 500 (other)                            | Any                                  | Unexpected server error; no internal exception text leaked | Toast "Something went wrong. Try again." |
| Network error                          | Any                                  | TCP/TLS/proxy failure                                      | Toast "Network error."; leave row state unchanged; polling will resync |
| Worker LLM total outage (no HTTP)      | Worker                               | Repeated failures hit `attempts >= 3` → `failed`           | Polling next tick reads `failed`; UI swaps to red "Failed" + Retry; no client-side surface beyond that |
| 401 `{"error":"unauthorized"}`         | Any auth-required endpoint           | Cookie missing/invalid                                     | Existing cookie-auth handling: redirect to login |
| 302 `Location: <mount>login`           | HTML GET routes (n/a here)           | n/a — these are JSON endpoints                             | n/a |

500 responses **never** carry the original exception text. The user gets
a generic error; the operator gets the detail in the worker / server log.

## Security properties

What this design **does** guarantee:

- **Auth surface unchanged.** Every new and amended endpoint sits behind
  the existing cookie-auth middleware. No new public paths, no new
  authentication primitives. See [`cookie-auth.md`](./cookie-auth.md).
- **Worker logs contain no user content.** Only IDs, status, and error
  *type-and-message* (e.g. `TimeoutError: ollama did not respond in 30s`).
  Brain-dump text and prompt content are never written to log. Privacy
  invariant; see "Operational properties" for the event list.
- **Logger separation.** Auth events stay on `lifeplan.auth` (per
  cookie-auth.md). Worker events go on `lifeplan.worker`. No cross-write,
  so a log-pipeline filter targeting one cannot accidentally surface the
  other.
- **No privilege escalation.** Worker process runs as the same OS user
  as the server. Same SQLite file permissions (`0600`), same `.env`
  scope. The worker holds no secret the server doesn't already hold.
- **Constant-time and parameterised queries.** All worker SQL uses
  parameter binding. No format-string SQL anywhere near the queue.
- **Fail closed.** Any unhandled worker exception fails the job (or
  retries it), never marks `done`. The finalisation guard prevents
  stale-write races from forging `done` after watchdog reclaim.

What this design **does not** guarantee:

- **Crash-mid-job consumes an attempt.** Deliberate (poison-pill defence).
  A worker that segfaults at attempt 3 will move the row to `failed`
  without ever having completed the work. The user retries via the
  button; no automated recovery beyond that.
- **Queue ordering under concurrent claims.** We deliberately run a
  single worker (see "Operational properties"). The atomic-claim SQL
  *would* support N workers, but we haven't tested for it and don't run
  it.
- **Defence against a malicious local user.** Anyone who can read the
  SQLite file can read every brain-dump and forge any queue row. File
  permissions are Forge's lane; this contract assumes them in place.

## Operational properties

- **Worker process.** Long-running, daemon-managed: launchd locally,
  systemd in prod (Forge's lane to land both unit files). Single
  instance per environment by deliberate choice — the queue logic
  *supports* multiple workers but LLM rate limits and operational
  simplicity argue for one. Restart on crash. SIGTERM drains the
  current job (best-effort, bounded by the LLM call), then exits 0.
- **Poll cadence.** 2s outer loop. ~30 ticks (~60s) between watchdog
  passes. 5-minute reclaim window (`claimed_at < now − 5m`).
- **Logging.** stdlib `logging`, logger `lifeplan.worker`, formatter
  matches the server's. Output to stderr; captured by launchd /
  journald (Forge owns log shipping). Events:
    - `worker.started` — INFO, on boot.
    - `worker.claimed` — INFO, fields: `job_id`, `job_type`, `target_id`, `attempts`.
    - `worker.processed` — INFO, fields: `job_id`, `outcome` (`processed` | `needs_review`), `duration_ms`.
    - `worker.failed` — WARNING, fields: `job_id`, `attempts`, `error_type`, `error_message`. **No** brain-dump text.
    - `worker.retry` — INFO, fields: `job_id`, `attempts`, `error_type`. (Re-queued, will retry.)
    - `worker.watchdog.reclaimed` — WARNING, fields: `job_id`, `claimed_at`, `age_seconds`.
- **Operational invariant.** A healthy environment never has a row with
  `status='processing'` older than 5 minutes. The watchdog enforces it;
  the absence of `worker.watchdog.reclaimed` events in normal operation
  confirms it.

## Open questions

Status: minimal, nothing blocking implementation. Decided in-lane:

- ~~Should the worker batch multiple `prompt_generation` requests into a
  single run?~~ **Resolved.** The partial unique index
  `idx_work_queue_one_active_prompt` already enforces "at most one
  non-terminal at a time"; subsequent `POST /api/prompts/generate` calls
  coalesce into the in-flight job. No batching code needed.
- ~~Should `done` rows be retained or pruned?~~ **Resolved (provisional):
  retain.** Keeps the audit trail; storage cost is trivial. *Cairn to
  add a quarterly prune to the worker runbook follow-ups* (queued
  artefact, per practice 5).
- ~~Should `claimed_at` mirror onto `brain_dumps`?~~ **Resolved: no.**
  `work_queue` is the source of truth; `brain_dumps.processing_status`
  is a denormalised badge cache only. Single source of truth for
  watchdog math.
- **Worker shutdown drain semantics.** SIGTERM should drain the current
  job; LLM calls can be slow. Bound the drain at 30s? At the LLM client's
  own timeout? *Forge for the systemd/launchd unit; Vault for the
  signal handler.* Not blocking — implementation can land with
  "drain best-effort, exit 0" and tighten later.
- **Multi-worker stance — document or remove the index that supports
  it?** We run one. The atomic-claim shape supports N; keeping it costs
  nothing. *Vault: keep, document as deliberate-but-not-exercised.*

Genuine product input needed from Cam: **none.** All decisions in lane.

## Provenance

- Practice 1 ("Contract-before-code"):
  [`docs/processes/team-practices.md#1-contract-before-code`](../../docs/processes/team-practices.md#1-contract-before-code).
- Cookie-auth retro that produced practice 1:
  [`docs/retrospectives/2026-04-25-cookie-auth.md`](../../docs/retrospectives/2026-04-25-cookie-auth.md).
- Sibling exemplar contract: [`app/contracts/cookie-auth.md`](./cookie-auth.md).
- Plan this contract serves: `/Users/cam/.claude/plans/new-plan-as-a-immutable-unicorn.md` (Phase 0).

Sign-offs (status moved from draft → accepted on the date above):

- **Vault** (server + worker): atomic-claim shape, finalisation guard,
  failure handler, security properties, logger separation.
- **Lumen** (client): polling contract (3s `setTimeout` recursion, scoped
  to dump-rendering surfaces, bound to mount), visual states table, error
  matrix UX column.
- **Reed** (schema): `work_queue` table shape, partial unique indexes,
  `brain_dumps.processing_status` CHECK extension, denormalisation
  rationale, single-source-of-truth invariant.
- **Cairn** (supervising): contract structure, practice references,
  triage of follow-ups under practice 5.
