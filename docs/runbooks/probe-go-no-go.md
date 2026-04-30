# Probe — Go / No-Go Procedure

**Owner:** Probe
**Audience:** Atlas, before any `lp deploy` on a feature in Probe's remit.
**Status:** accepted.
**Format:** Cairn-style — Goal, Preconditions, Steps, Verification,
Failure modes.

This is the gate. Atlas does not run `lp deploy` on a Probe-remit feature
without Probe's "go" recorded against the candidate commit.

## Goal

Produce one of two outputs against a candidate build, with the reason in
one line:

- **Go.** All blockers clear. Paper-cuts (if any) listed and queued.
  Atlas may deploy.
- **No-go.** At least one blocker. Atlas does not deploy. Probe routes
  the bug to the right persona (Vault / Lumen / Forge) per `team/probe.md`.

Probe rule 9: when in doubt, no-go. A bad deploy is reversible at higher
cost than a fix-then-redeploy.

## Preconditions

Probe will not begin a gate run unless **all** of the following are true:

1. There is a written contract for the feature in `app/contracts/`
   (practice 1). No contract = no Probe pass = no deploy. Probe escalates
   to Atlas for the contract before proceeding.
2. The candidate is committed to the working branch (practice 3 — commit
   cadence). Probe does not verify a dirty working tree.
3. The local server (`lp status`) is on the candidate code, or the deploy
   target is the candidate (production runs are post-deploy verification,
   not pre-deploy gate).
4. `tests/e2e/.env` exists locally (Cam ran `./setup.sh` once). The
   suite reads the password from this file automatically. Probe does
   not handle the password directly — there is no "ask Atlas for the
   password" step in the normal pass. If `.env` is missing, Probe
   surfaces the missing-file message from the auth fixture and
   suspends the run; Cam re-runs `./setup.sh` himself in his terminal.
5. The login rate limiter is **not currently tripped**. The local
   server's in-process limiter is 5 wrong-password attempts per IP per
   15 minutes (`RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW` in `app/auth.py`).
   The default suite fires 2 wrong-password attempts (one per browser
   project), and a previous run that ended mid-retry — or any manual
   poking at `/login` with the wrong password — can leave the limiter
   close to or over the threshold. **Symptom:** the suite fails with a
   cascade of unrelated-looking errors (logout 401s, "session cookie
   should be present after login" — undefined, fixture login failing).
   **Fix:** restart the local app to clear the in-process limiter, then
   re-run:

   ```sh
   /Users/cam/dev/personal/lifeplan/lp restart
   # wait until /login responds 200, then:
   cd tests/e2e && npm test
   ```

   This is **not** a flake — it's deterministic state from the
   limiter. A clean restart before each Probe pass is the safest
   default when the prior state is unknown.
6. Playwright browsers are installed. `npm install` does **not** pull
   the browser binaries; `npx playwright install` does. `./setup.sh`
   runs both. If you set up the suite by some other path and see
   "Executable doesn't exist" or "browserType.launch: ... missing
   dependencies," run `npx playwright install` from `tests/e2e/`.
7. Local and prod target-version alignment per Practice §13. Run the
   equivalence-check one-liner from
   [`docs/runbooks/target-versions.md`](target-versions.md) (owned by
   Forge). If the check reports a mismatch on any pinned dependency
   (Python, SQLite, OpenSSL, or anything else listed there), the gate
   is **suspended** and Probe routes the alignment task to Forge.
   Deploy is blocked until alignment is restored. This catches a class
   of bug the e2e suite cannot see by design — env skew between local
   and prod (see cookie-auth retro Lesson L5; background-processing
   retro Bug A).

If any precondition fails, the gate run is **suspended**, not failed.
Probe writes one line to Atlas naming the missing precondition.

## Steps

### 1. Automated suite

The suite is scoped (Practice §16). Atlas's per-dispatch default is
`npm test` (smoke). Probe's gate runs the **full** suite:

```sh
cd tests/e2e
npm run gate    # full suite — every spec, every project, every clause
```

`npm test` (smoke) is what the team-member dispatches use; `npm run gate`
is what Probe runs for sign-off. Per-surface scripts (`npm run auth /
tags / blocker / dump / add`) are for ad-hoc smoke during a focused
implementation, not for the gate.

`playwright.config.ts` loads `tests/e2e/.env` at startup, so no inline
env vars are needed for a normal Probe pass. For a production-target run
(post-deploy verification), pass overrides inline — they win over `.env`:

```sh
LIFEPLAN_TEST_BASE_URL='https://your-domain.example/lifeplan/' \
LIFEPLAN_TEST_PASSWORD='<prod-password>' \
  npm run gate
```

Both `chromium` and `webkit` projects must run. WebKit is non-negotiable
— Cam's primary device is iOS.

Expected: 100% of tests green. The rate-limit test is **skipped by
default** (it burns the in-process limiter for 15 minutes); that skip is
expected and not a gate failure. Run it on demand when the gated change
touches `/login` or `app/auth.py` rate-limit code:

```sh
RATE_LIMIT_TEST=1 \
LIFEPLAN_RESTART_CMD='/Users/cam/dev/personal/lifeplan/lp restart' \
  npm test
```

For an auth-surface deploy, the rate-limit test must have been run green
at least once against the candidate before sign-off — but not on every
default Probe pass.

### 2. HTTP smoke test

A small `curl` battery — fast and orthogonal to the Playwright suite.
Catches a different class of bug (the `do_GET`-without-`do_HEAD` 404 lives
in Probe's head as the canonical reason).

```sh
BASE='http://localhost:3131'   # or https://your-domain.example/lifeplan
for verb in GET HEAD; do
  for path in / login manifest.json apple-touch-icon.png icon-192.png icon-512.png; do
    code=$(curl -sk -o /dev/null -w "%{http_code}" -X "$verb" "$BASE/$path")
    printf '%-4s %-30s %s\n' "$verb" "/$path" "$code"
  done
done
```

Expected for local (mount = `/`):

| Verb | Path | Expected |
|---|---|---|
| GET / HEAD | `/` | 302 unauthenticated, 200 authed |
| GET / HEAD | `/login` | 200 |
| GET / HEAD | `/manifest.json` | 200 |
| GET / HEAD | `/apple-touch-icon.png` | 200 |
| GET / HEAD | `/icon-192.png` | 200 |
| GET / HEAD | `/icon-512.png` | 200 |

Production: same matrix at `https://your-domain.example/lifeplan/...`.

### 3. Background processing

Phase 6 of the background-processing rollout adds a worker daemon and
queue table. Verification has both an automated layer and a manual
layer; both run on every deploy that touches `app/worker.py`,
`app/processing.py`, the `work_queue` schema, the polling loop in
`app/app.js`, or any of the `/api/brain-dumps/...` endpoints.

#### Pre-deploy automated

The default suite (`cd tests/e2e && npm test`) now includes
`background-processing.spec.ts`. Expected: green on chromium and webkit.
Six tests run by default, four are gated (see below).

Two gated suites that are **not** part of the default Probe pass:

```sh
# Failure detection — injects a poison work_queue row, asserts status
# transitions to 'failed' after 3 attempts. Needs direct SQLite access.
FORCE_FAIL_TEST=1 npm test -- background-processing.spec.ts

# Watchdog reclaim — injects a stale 'processing' row 10 minutes old,
# waits up to ~90s for the watchdog to reclaim and the worker to process.
# Slow on purpose; not for every Probe pass.
WATCHDOG_TEST=1 npm test -- background-processing.spec.ts
```

Run `FORCE_FAIL_TEST=1` on every deploy that touches the worker's
failure handler, the retry endpoint, or the `attempts` counter.
Run `WATCHDOG_TEST=1` on every deploy that touches `_watchdog_pass`,
the 5-minute reclaim window, or the finalisation guard.

#### Pre-deploy manual

1. Visit the Brain Dump page. Submit a new dump with content
   `probe go-no-go <date>`. Observe:
   - Row appears within 1 s with a grey "Pending" badge.
   - Badge transitions through "Processing" (spinner) to "Done" or
     "Needs review" within ~5 s without manual reload.
2. Failure case: hand-set a row to `failed`:
   ```sh
   sqlite3 /Users/cam/dev/personal/lifeplan/data/lifeplan.db \
     "UPDATE brain_dumps SET processing_status='failed' WHERE id=(SELECT MAX(id) FROM brain_dumps);"
   ```
   Reload the dump-list page. Observe the affected row shows a red
   "Failed" badge with a Retry button. Click Retry. Observe the badge
   flips optimistically to "Pending" and a fresh queue cycle starts.
3. Worker daemon health (local):
   ```sh
   /Users/cam/dev/personal/lifeplan/lp worker status
   ```
   Should show the daemon running. On prod:
   ```sh
   ssh prod 'systemctl status lifeplan-worker --no-pager | head -5'
   ```
   Should report `active (running)`.
4. Worker logs (local):
   ```sh
   /Users/cam/dev/personal/lifeplan/lp worker logs
   ```
   On prod:
   ```sh
   ssh prod 'journalctl -u lifeplan-worker -n 20'
   ```
   Both should show `worker.started`, `worker.claimed`, `worker.processed`
   events. They must **never** carry brain-dump content (privacy
   invariant from `app/contracts/background-processing.md` — "Worker
   logs contain no user content. Only IDs, status, and error
   type-and-message"). If you see dump text in the log, file a blocker
   to Vault.

### 4. Manual checklist

Per `docs/runbooks/probe-manual-checklist.md`. Required for deploys
touching auth, layout chrome, service worker, or anything visible on iOS.

### 5. Production smoke (post-deploy only — listed for completeness)

Re-run the automated suite against the production target with
`LIFEPLAN_TEST_BASE_URL=https://your-domain.example/lifeplan/`. Skip the rate-limit
test (don't burn prod slots). Confirm green within 5 minutes of deploy.

## Verification

Probe writes a single block to Atlas in the format below (per
`team/probe.md`). No softening, no hedging.

```
Pre-deploy verification — <date>, commit <sha>

Automated suite: <pass>/<total> passing (<browsers>)
HTTP smoke: <result line>
Manual checklist: <pass>/<total>
  - [FAIL] <one-liner per failure>
Real-device pass: <device + iOS version, or "not required for this change">

Recommendation: <SHIP | DO NOT SHIP>
```

Followed by one of:

> **Go.** All blockers clear. <N paper-cuts queued>. Deploy when ready.

> **No-go.** <One-line root cause>. Reproducible on <browsers / device>.
> Blocker — do not deploy until fixed. Routed to <persona>.

## Failure modes

### What flips the gate to **no-go**

- Any automated test that was green on the previous deploy is now red.
- Any contract clause has no green test (gap → write the test or escalate
  to Atlas before deploying).
- Manual checklist surfaces a blocker (see manual-checklist.md "Failure
  modes" — Basic Auth dialog, apex redirect, broken pull-to-reload).
- Production smoke (post-deploy) goes red — Probe issues an immediate
  rollback recommendation.

### What does **not** flip the gate

- A skipped test with a documented precondition reason (e.g. rate-limit
  test skipped because `RATE_LIMIT_TEST=1` was not set on this default
  run). Note it; do not block on it. The rate-limit test must be run
  green on its own pass before any auth-surface deploy.
- A flake — same test, two consecutive re-runs disagree. **Investigate
  before passing.** A flaky test trains you to ignore failures (Probe
  rule). Either find the cause and fix it, or quarantine the test (and
  log the gap to Atlas) — never re-run-until-green and call it a pass.
- Documentation drift inside `docs/` not touching user behaviour.

### Re-run vs. accept-known-issue

- **Re-run** if: a flake is suspected (test passes on second attempt with
  no code change), or the server was in an inconsistent state during
  the first run. Both runs and the result are recorded in the Probe
  report.
- **Accept-known-issue** if: Cam has explicitly accepted a paper-cut and
  asked to ship. Probe writes the issue + Cam's acceptance into the
  report. Atlas may deploy. The paper-cut becomes a permanent test on
  the next pass (Probe rule 8).

## Cadence (decision: on-demand, not scheduled)

Probe runs the suite **on demand** — when Atlas asks for a gate decision
ahead of a deploy in Probe's remit (practice 8: auth, user-facing,
mobile). There is no recurring schedule.

Why on-demand only:

- The app is single-user, deploys are infrequent, and the auth surface
  is now stable. A nightly cron would mostly tell us the test
  infrastructure still works — that's CI hygiene, not deploy-gate value.
- The standing rule (practice 8) already names the trigger: "Probe
  sign-off mandatory before deploys on user-facing/auth/mobile
  features." That's an event-driven trigger, not a calendar one.
- Scheduled runs do catch silent regressions in third-party deps and OS
  updates — but the third-party surface here is small (Playwright +
  dotenv on the test side; Python stdlib on the server). The marginal
  catch rate doesn't justify the noise budget for a one-person team.
- Flaky-test risk: a scheduled run that fires when no-one is watching is
  the canonical breeding ground for "ignore the red, it always goes
  green on rerun." Probe rule 6 says no.

If this changes — multi-deploy days, multiple test suites, third-party
churn picks up — Cairn or Atlas could later wire a recurring run as a
launchd job, GitHub Action, or scheduled remote agent. Flagging now so
it's not relitigated later: **the cadence policy is Cairn's call when
the conditions warrant it.**

## Provenance

This gate exists because the cookie-auth feature shipped four bugs across
multiple deploys, every one catchable pre-deploy by someone whose job
was to look. See `docs/retrospectives/2026-04-25-cookie-auth.md`. Probe
is the someone; this runbook is the procedure.
