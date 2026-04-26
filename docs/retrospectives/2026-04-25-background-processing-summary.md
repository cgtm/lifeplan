# Background Processing — Summary for Cam

**Date:** 2026-04-25
**Status:** accepted
**Author:** Cairn

A short narrative of how background processing was planned, executed, and
learned from. For the engineering deep-dive, see the linked retro at the
bottom.

---

## What was built and why

Brain dumps used to block the UI for 2–45 seconds while the LLM ran inside
the HTTP request. Now they don't. You submit a dump, the page returns in
under a second with a grey "Pending" badge, and a background worker
processes the dump within a few seconds — the badge flips to "Done" (or
"Needs review" or "Failed") live, without you refreshing. Failed dumps get
a Retry button. Prompt regeneration runs the same way. The headline number:
**brain-dump POST round-trip went from 2–45 seconds to under 1 second.**

## How it was planned

Phase 0 was a written contract. Vault (server), Lumen (UI), and Reed
(schema) jointly authored `app/contracts/background-processing.md` under
Cairn's supervision, before any of them wrote code. The contract names
every endpoint, the lifecycle of a queued job, the database shape, the
race-handling strategy, the polling rules, and the privacy invariants. The
mental model is yours: *an explicit queue table that brain-dumps and
prompt requests get placed onto, processed one by one by a worker.*

The decisions settled before code:

- **Long-running daemon, 2-second poll.** Not a cron timer — you wanted
  near-real-time, and a per-fire Python startup tax wastes it.
- **Explicit `work_queue` table** (your steer). One queue, one place to
  look. Future job types drop in without schema change.
- **Atomic claim** so multiple workers couldn't ever pick the same job
  (we run one worker, but the shape supports more).
- **Watchdog** every ~60s reclaims any job stuck in "processing" for more
  than 5 minutes — covers worker crashes mid-job.
- **Three retries, then `failed`.** Crash mid-job consumes an attempt
  (poison-pill defence; otherwise a bad job loops forever).
- **3-second UI polling** via `setTimeout` recursion (no overlapping
  requests), scoped to pages that actually show dump status, and torn
  down on navigation.

What changed during planning vs. what shipped: **almost nothing.** Five
small ambiguities were resolved in the contract draft itself (where to
increment the retry counter, whether to FK the queue to brain_dumps,
poll-cadence ratios, etc.). No surprises forced a contract amendment
during implementation.

## How it was executed

Seven phases, each landing as one commit (or a tight series). Phases 3, 4,
and 5 ran in parallel — three personas working concurrently with no file
collisions because the contract pre-aligned the seams.

- **Phase 1 — Schema (Reed).** Migration 0001 created `work_queue` and
  expanded the brain-dump status enum. Local came up green. Prod broke:
  the migration's "rename parent table" step depends on a SQLite version
  newer than what's on the droplet, and an FK on `brain_dump_tags` ended
  up dangling. Reed shipped 0002 as a hot-fix, using the canonical 12-step
  ALTER pattern that doesn't depend on the SQLite version. Lesson learned;
  see "What was learned."
- **Phase 2 — Worker (Vault).** New `app/worker.py` daemon. The plan
  estimated 120–180 lines; it came in at ~430. Boring-and-explicit beat
  clever-abstraction — the extra lines are separate functions for claim,
  finalise, fail, watchdog, signal handling, and the prompt-marker tick.
  Easy to read at 6am when something's wrong.
- **Phase 3 — Handlers (Vault).** `POST /api/brain-dumps` flipped from
  "process inline, return 201" to "queue and return 202." New `/retry`
  route. Coalescing on `/process` and `/generate` so rapid-fire clicks
  don't pile up duplicate jobs.
- **Phase 4 — UI (Lumen).** Five status badges (Pending, Processing,
  Done, Needs review, Failed), live polling, Retry button, optimistic
  flips. Submit toast updated to "Captured. Processing in background."
- **Phase 5 — Ops (Forge).** launchd plist for local, systemd unit for
  prod, prompts timer for prod parity (you'd had a daily-9am prompts job
  locally for a while; prod never did). New `lp worker` subcommand and
  `lp restart-all` to bounce both server and worker.
- **Migration apply (interactive).** Forge applied 0001 on prod manually,
  with a labelled backup beforehand; Bug A surfaced; Reed hot-fixed with
  0002, applied the same way. No data loss either way.
- **Phase 6 — Tests (Probe).** 12 default e2e tests covering happy path,
  retry, watchdog, the <1s POST regression, live badge transitions, and
  polling-stops-on-leave. All green on chromium and webkit. 2 gated tests
  behind environment flags for slow paths (poison-job → failed; watchdog
  reclaim).
- **Cleanup commit (Vault).** Probe found three bugs during Phase 6.
  Two were latent (predated the rollout): a privacy leak in `print()`
  statements that emitted the first 80 chars of brain-dump content, and
  a transaction-nesting bug that broke every dump that auto-created
  items. The third was new (delete-race: deleting a dump mid-process
  left the queue row stuck). Vault fixed all three in one cleanup commit.
- **Phase 7 — This retro.**

Honest about what didn't work: the Phase 5 deploy ran prod on old code
for ~3 hours because deploy.sh's worker-restart guard misreported the
unit as "not installed yet" when it was. Cam manually restarted. Two
follow-up tickets from that incident (named below).

## What was learned

Six lessons. Each comes with what we'll change because of it.

1. **SQLite migrations: never rename the parent table.** The 0001 → 0002
   sequence taught us that "rename parent, recreate" works on local and
   breaks on older SQLite. **Change:** new practice §10 in
   `team-practices.md` — all schema rebuilds use the canonical 12-step
   ALTER pattern. Reed will follow it; Cairn checks at review.

2. **Privileged config (sudoers, systemd units) is not deploy.sh's job.**
   The Phase 5 deploy assumed re-running the setup script; that
   assumption lived in Forge's head, not on paper. **Change:** new
   practice §11 — deploy.sh is code-only; sudoers and units are
   operator-applied separately. Documented in the deploy contract.

3. **Deploys must not include uncommitted work.** deploy.sh syncs your
   working tree, not your committed state. The Phase 5 deploy
   accidentally pushed uncommitted Vault and Lumen changes alongside
   Forge's committed changes. **Change:** new practice §12 — deploy.sh
   gets a working-tree-clean check that aborts if `git status
   --porcelain` is non-empty. Forge owns the script change (queued).

4. **Contract-driven testing catches bugs that predate the rollout.** Two
   of the three Phase 6 bugs — the privacy leak and the transaction-
   nesting issue — existed before this work started. They surfaced only
   because Probe had a contract to gate against. **Change:** none — this
   is the practice working. Recorded as a positive observation so the win
   has provenance.

5. **`lp restart` only bounces the server, not the worker.** Vault found
   stale worker processes from prior `lp restart` runs. **Change:** keep
   `lp restart` server-only (changing it would silently kill mid-job work
   for users who only meant to bounce the server). Use `lp restart-all`
   to bounce both. Documentation, not behaviour change.

6. **Plan-time line-count estimates for novel subsystems are noise.** The
   worker came in at 430 lines vs. the plan's 120–180. The overshoot is
   readable code; we'd rather have that than a clever 150-line worker
   nobody understands. **Change:** none yet (one data point isn't a
   pattern). Cairn watches for a second occurrence; if the next plan's
   estimate is also off by 2×+, we'll write up a planning-practice
   change.

## What's next

Three queued follow-ups, all dispatched, none needing your attention:

- **Forge** — make deploy.sh refuse to deploy when the working tree is
  dirty (codifies practice §12).
- **Forge** — re-shape the deploy.sh worker-restart guard so a check
  failure is loud, not silent (the bug behind the 3-hour stale-code
  incident).
- **Reed + Probe** — add a SQLite-version assertion to the e2e gate so
  local–prod skew can never hide a migration bug like 0001 again.

Cairn tracks these in the backlog; they'll land in the next session or
two.

Nothing here needs your product input. The questions are all engineering-
internal.

## Pointer to the engineering retro

For the technical deep-dive — full timeline, 5-Whys per bug, the new
practices' wording — see
[`2026-04-25-background-processing.md`](2026-04-25-background-processing.md).
