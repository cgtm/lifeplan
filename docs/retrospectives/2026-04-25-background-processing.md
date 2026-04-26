# Retrospective — Background Processing Rollout

**Date:** 2026-04-25
**Feature:** Background processing for brain dumps and prompt generation
**Personas involved:** Cairn (supervising), Vault, Lumen, Reed, Forge, Probe, Atlas, Cam
**Format:** Timeline retro + 5-Whys per notable bug
**Facilitator:** Cairn
**Status:** accepted

---

## Why this format

Seven phases, four notable bugs, two production incidents (one operator-side,
one already in prod and surfaced by the new gate). A timeline carries the
phase sequence; targeted 5-Whys carry each bug's root cause without bloating
the doc. Lessons map to artefacts at the bottom — practices added or queued
follow-ups, never floating observations.

## One-paragraph summary

Background processing shipped end-to-end across seven phases. The headline
regression — brain-dump POST round-trip from 2–45s down to <1s — held
under Probe's e2e suite and on prod. Phased rollout worked as designed:
each phase landed independently green, parallel dispatch in Phases 3–5
executed without file conflicts, no production downtime, no data loss,
worker SIGTERM drained cleanly on the prod restart. The cost was four
notable bugs, two of which were latent (privacy leak, transaction-nesting
on `_auto_create_item`) and surfaced only because Phase 6 had a contract
to gate against. The other two were rollout artefacts: a SQLite-version
skew in the 0001 migration that local couldn't see, and a deploy/sudo/dirty-
tree tangle in Phase 5 that left prod on old code for ~3 hours. All four
have artefacts. Net: the contract held, the practice held, the team caught
its own latent bugs before users did.

---

## Timeline

| #  | Event | Persona | Outcome |
|----|---|---|---|
|  1 | Phase 0: joint contract drafted (work_queue table, lifecycle, claim SQL, watchdog, retry, polling, error matrix, security properties) | Vault + Lumen + Reed under Cairn | Status `accepted`, three sign-offs in commit |
|  2 | Phase 1: 0001 migration creates `work_queue`, expands `brain_dumps.processing_status` enum. Idempotent via `PRAGMA user_version`. Local verified | Reed | Local green; **prod broken (see Bug A)** |
|  3 | Bug A surfaces on prod: `brain_dump_tags` FK references stale `brain_dumps_old`. 19 FK violations | Reed | 0002 hot-fix migration via canonical 12-step ALTER. Idempotent |
|  4 | Phase 2: worker daemon (`app/worker.py`) lands. Atomic claim, finalisation guard, watchdog, 3-attempt retry, signal-driven drain. Privacy invariant declared in module docstring. Worker dormant pending Phase 5 | Vault | Local verified all four worker scenarios. ~430 lines of worker code (plan estimated 120–180; see Lesson L4) |
|  5 | Phase 3: handlers refactored. `POST /api/brain-dumps` returns 202 + queued; queue-row insertion in same transaction as dump insert. New `/retry` route; coalescing `/process` and `/generate` routes | Vault | Round-trip drops to <100ms locally |
|  6 | Phase 4: status badges, polling helper (3s `setTimeout` recursion, scoped to dump-rendering surfaces, bound to mount), Retry button, optimistic flips. Submit toast updated to "Captured. Processing in background." | Lumen | All paths via `MOUNT`; live transitions verified |
|  7 | Phase 5: launchd plist, systemd service, prompts timer, `lp worker` subcommand, `lp restart-all`, `deploy.sh` worker-restart guard, `server-setup.sh` sudoers extension. Code rsynced to prod | Forge | **Bugs B and C surface on this deploy (see below)** |
|  8 | Bug B: deploy.sh's `systemctl restart lifeplan-worker` silently no-op'd because the worker-restart guard misreported "lifeplan-worker not installed yet" when in fact the unit was installed and running. Sudoers-extension also not applied (see Bug C). Prod ran old code for ~3 hours until Cam manually restarted | Forge / deploy.sh | Triaged for Forge follow-up |
|  9 | Bug C: `server-setup.sh` was updated with sudoers extension for `lifeplan-worker` but the script wasn't re-run on prod after deploy. deploy.sh's restart line had no privilege to call sudo. Compounded with Bug B | Forge / process | Lesson L3 surfaces |
| 10 | Side-effect at Phase 5 deploy: `deploy.sh` rsynced uncommitted Vault/Lumen working-tree changes to prod alongside Forge's committed Phase 5 changes. Discovered post-deploy when local `git status` was non-empty | deploy.sh / Atlas commit cadence | Lesson L5 surfaces |
| 11 | Phase 6: e2e test suite (12 default tests, 2 gated). All green on chromium + webkit. Probe runbook updates (worker-health checks, privacy-grep instruction, mid-job restart, iOS PWA standalone live transitions) | Probe | **Probe finds three latent/new bugs (D1, D2, D3 below)** |
| 12 | Bug D1 (privacy invariant violation, pre-existing): `processing.py` had ~35 `print()` calls between `processing.py`, `generate_prompts.py`, and `db.py.call_mistral_api`, including one that emitted the first 80 chars of brain-dump content. Predates the contract | Probe → Vault | Fixed: all converted to `lifeplan.processing` logger; previews removed |
| 13 | Bug D2 (delete-race): deleting a brain_dump while the worker held it left the queue row stuck `processing` until watchdog reclaim, with `OperationalError` noise in the log | Probe → Vault | Fixed belt-and-braces: sentinel `BrainDumpNotFound` exception + cascade-delete of non-terminal queue rows in `handle_delete_brain_dump` |
| 14 | Bug D3 (transaction-nesting): `finalise_success` issued `BEGIN IMMEDIATE` inside the implicit transaction left by `_auto_create_item`, raising "cannot start a transaction within a transaction" on every dump that auto-created items. Pre-existing latent | Probe → Vault | Fixed: `_begin_immediate_if_needed` no-ops when `conn.in_transaction`; `handle_failure` rolls back partial txn before its own `BEGIN IMMEDIATE` |
| 15 | Vault flagged stale worker processes left after `lp restart` (which only restarts the server) | Vault | Triaged: see Decision 4 below |
| 16 | Phase 7: this retro | Cairn | Lessons codified |

---

## What went well

Spelled out, because false humility is its own dishonesty:

- **Headline regression delivered.** Brain-dump POST round-trip 2–45s → <1s on prod. The reason this rollout existed in the first place. Probe's e2e gate `<1s` assertion holds.
- **Phased rollout actually worked.** Each phase landed independently green. No phase blocked on a previous phase's defect; Bug A was caught between Phase 1 and Phase 2 by Forge applying the migration interactively, not by a Phase 2 regression.
- **Multi-persona parallel dispatch in Phases 3–5.** Vault (handlers), Lumen (UI), Forge (ops) ran concurrently with zero file conflicts. The Phase 0 contract pre-aligned the seams; the four-state queue lifecycle and the badge-binding map removed every "wait, what should the response look like" moment.
- **No production downtime, no data loss across the whole rollout.** Including the Bug A migration recovery, which was a 30-second additional migration apply.
- **Worker SIGTERM drained cleanly on prod restart.** Vault's signal-handler design held the first time it mattered. `TimeoutStopSec=60` in the systemd unit was never reached.
- **Probe's Phase 6 gate caught two latent bugs before users hit them** (D1 privacy leak and D3 transaction-nesting), and one rollout-induced bug (D2 delete-race). The contract gave Probe specific invariants to assert against; mere code review would not have surfaced D1, since the offending `print()` calls predated Phase 0.
- **Probe's e2e suite is now reusable and team-runnable.** Cam doesn't run it; Probe does, on demand. 12 default tests, 2 gated. Documented expected flake mode.
- **Forge's atomic backup-swap-test-rollback pattern from prior sessions held up across two migration applies** (0001 and 0002). Both had labelled pre-migration backups; both were re-runnable with the idempotency guard.
- **Contract held under reality.** Five discrepancies were resolved during the Phase 0 draft, none surfaced during implementation. The decisions document at the top of the contract carries the rationale for `attempts`-at-claim, four-state queue, 3s vs 2s poll cadence, no-FK on `target_id`, and `processed`-vs-`needs_review` as worker-side.
- **Worker line count overshoot was the right kind of overshoot.** 430 lines instead of 120–180; boring-and-explicit (separate functions for claim, finalise, fail, watchdog, signal-handler, prompt-marker tick) beat clever-abstraction. The plan's estimate was wrong; the discoverability of the resulting code is more valuable than the missing lines. Lesson L4.

---

## 5-Whys per notable bug

### Bug A — 0001 migration broke `brain_dump_tags` FK on prod

**Failure:** 19 FK violations on prod after applying 0001; new
`brain_dump_tags` INSERTs fail. Local was clean.

1. **Why did the FK break on prod?**
   Because 0001 renamed `brain_dumps` to `brain_dumps_old` before recreating
   it, and the prod SQLite version did not auto-rewrite the FK reference in
   the dependent `brain_dump_tags` table. When step 4 dropped
   `brain_dumps_old`, the FK became dangling.
2. **Why didn't local catch this?**
   Because local SQLite is modern enough (~3.25+) to auto-update FK references
   on parent rename. The migration was correct on local, broken on prod, and
   the difference was invisible without exercising the prod SQLite version.
3. **Why was the migration shape "rename parent, recreate"?**
   Because that pattern was the team's default for "alter a table with
   children." It conflates two operations — schema change and FK rebind —
   and depends on the engine doing the rebind silently. Modern SQLite does;
   not all SQLites do.
4. **Why was that pattern ever the default?**
   Because it's terser than the canonical 12-step ALTER (drop FKs first, then
   rebuild). Reed used the cleaner-looking pattern; nothing in the team's
   written record warned that it was version-dependent.
5. **Why did the team have no written record?**
   Because schema migrations had never been tested against a foreign-key-bearing
   child table before this rollout. The cookie-auth migration was childless.
   This was the first one that exercised the rebind path; the lesson did not
   exist as an artefact yet.

**Root cause:** unguarded use of a SQLite-version-dependent migration shape
in the absence of cross-version testing.

**Lessons:** L1 (canonical 12-step ALTER), L2 (cross-version SQLite check
in the e2e gate).

### Bug B — deploy.sh worker-restart guard misreported "not installed yet"

**Failure:** deploy.sh's worker-restart line printed "lifeplan-worker not
installed yet — skipping" on a host where the unit was installed and
running. Combined with Bug C, prod stayed on old code for ~3 hours.

1. **Why did the guard misreport?**
   Forge's check used `systemctl list-unit-files lifeplan-worker.service`
   piped to `>/dev/null 2>&1`. That command only succeeds when an exit code
   of 0 comes back; on this host it apparently returned non-zero despite the
   unit being present. (Suspected: missing newline at end of unit file, or
   a one-off systemctl quirk on this distro version. Not yet root-caused.)
2. **Why wasn't the false negative noticed?**
   Because the guard was designed to be quiet — "no-op silently when the
   unit isn't yet installed (so the first deploy that lands ops/ doesn't
   fail before server-setup.sh runs)." The quietness was deliberate; the
   fallthrough to "skipping" looked like the expected first-deploy path.
3. **Why was a quiet guard the right shape there?**
   It wasn't, in retrospect. The first deploy needs the quietness; every
   subsequent deploy needs the loudness. A guard that can't tell those
   cases apart is a one-time band-aid masquerading as a permanent check.
4. **Why was a one-time band-aid permitted to ship?**
   Because the cost of the false negative wasn't visible at design time —
   "worst case the worker restart fails and Cam restarts manually." That
   cost showed up as 3 hours of stale code on prod.
5. **Why didn't anyone notice the stale code earlier?**
   Because the new code's user-visible behaviour change (the headline
   regression: <1s POST) was the same as the old code in steady state for
   already-processed dumps. The regression only surfaces on a freshly
   submitted dump. Cam noticed when he submitted one.

**Root cause:** a guard whose two failure modes ("not installed yet" vs
"installed but check failed") collapse into the same silent skip.

**Lessons:** L6 (Forge follow-up: re-shape the guard so a false negative
on an installed unit is loud, not silent).

### Bug C — server-setup.sh sudoers extension not re-run on prod

**Failure:** server-setup.sh was updated with NOPASSWD entries for
`lifeplan-worker` so deploy.sh's restart line wouldn't prompt; the script
wasn't re-applied on prod, so deploy.sh had no privilege to restart the
worker. Compounded with Bug B.

1. **Why wasn't server-setup.sh re-run?**
   Because deploy.sh doesn't run server-setup.sh; the two scripts have
   distinct contracts (deploy = code, setup = privileged config). No
   trigger said "your sudoers diff needs an apply step."
2. **Why was the contract split that way?**
   Because privileged config — sudoers, systemd unit installs, package
   installs — needs an operator with elevated rights. deploy.sh runs
   unprivileged; bundling sudoers changes into deploy.sh would either
   require deploy.sh to escalate (security regression) or fail noisily on
   every deploy (operator fatigue).
3. **Why didn't Forge's Phase 5 commit include a "re-run server-setup.sh
   on prod" step in its message?**
   Because the team didn't have a written rule that privileged-config
   changes require an explicit operator action separate from deploy. The
   rule lived in Forge's head ("I'll re-run it"), not on paper. Forge then
   shipped the deploy without re-running.
4. **Why did the rule live in Forge's head?**
   Because the prior session's deploy contract was implicit: "deploy.sh
   handles everything you need." Phase 5 expanded the surface (added
   privileged config) without expanding the contract.
5. **Why didn't the contract get expanded?**
   Because the Phase 5 commit went straight from "added the units and
   sudoers" to "shipped." No retro-style triage between authoring the
   privileged-config change and the deploy that needed it active.

**Root cause:** missing written rule that privileged-config changes require
explicit operator action; deploy.sh's contract was implicit.

**Lessons:** L3 (deploy.sh contract = code only; sudoers / units operator-
applied; deploy never assumes new privileges are live).

### Bug D1 — privacy invariant violation pre-existed in `processing.py`

**Failure:** Probe's privacy-grep against the worker log surfaced canary
strings drawn from brain-dump content. Source: `processing.py:1679` and
~35 other `print()` calls between `processing.py`, `generate_prompts.py`,
and `db.py.call_mistral_api`.

1. **Why did the contract's privacy invariant get violated?**
   Because the worker reused processing code that predated the contract.
   The contract declared "worker logs contain no user content" but the
   pre-existing `print()` calls were never audited against that clause.
2. **Why weren't they audited?**
   Because the audit step wasn't in any phase's checklist. Phase 0
   (contract) declared the invariant; Phase 2 (worker) inherited the
   processing code as-is; Phase 6 (verification) was the first phase that
   actually exercised the invariant.
3. **Why did Phase 2 inherit the code as-is?**
   Because the worker refactor scope was "extract a callable that the
   worker can drive without owning state." Logging hygiene wasn't in the
   refactor's scope; the function signature changed, the function body
   didn't.
4. **Why wasn't logging hygiene in the refactor's scope?**
   Because the contract's privacy invariant was written about the worker's
   *new* logging surface (the `lifeplan.worker` events), not about the
   reach of every callable the worker invokes. The contract under-specified.
5. **Why did the contract under-specify?**
   Because the authors (Vault, Lumen, Reed) wrote it from the perspective
   of code they were about to write, not code they were about to call.
   The privacy invariant is a *runtime* property of everything the worker
   process emits; the contract treated it as a *design* property of the
   worker's own log lines.

**Root cause:** privacy invariant was specified as a property of the new
code, not as a runtime property of the worker process. The contract was
correct-but-narrow; the existing code violated it without anyone noticing
until the gate ran.

**Lessons:** L7 (the *win*: contract-driven testing surfaces latent bugs
that mere code review wouldn't — keep the practice). No new rule; the
existing Practice 1 "contract-before-code" already requires invariants to
be testable, and Probe's gate is the test. The lesson is that the gate
catching it is the system working as designed.

### Bug D2 — delete-race left queue rows stuck

**Failure:** deleting a brain_dump while the worker held it left the
work_queue row in `processing` until watchdog reclaim (~5 min), with
`OperationalError` noise.

Brief 5-Whys: the contract specified `target_id` as deliberately not-FK
(see contract §Schema notes), to keep the queue operational rather than
relational. That choice was right — cascade-delete from `brain_dumps` to
`work_queue` would have lost the audit trail. What was missing was the
*sentinel-exception* path: the worker assumed the brain_dump still existed
when it went to read it. Two-sided fix (sentinel + cascade-delete of
non-terminal queue rows in the delete handler) is overkill on purpose;
either alone would suffice; both together close the race definitively.

**Root cause:** the contract specified the data-model decoupling but not
the delete-time behaviour. Worker code assumed presence.

**Lesson:** captured as the cascade-delete behaviour in
`handle_delete_brain_dump` and the `BrainDumpNotFound` sentinel in
`processing.py`. No new practice; this is feature-specific code.

### Bug D3 — transaction-nesting on `_auto_create_item` finalisation

**Failure:** every dump that auto-created items raised "cannot start a
transaction within a transaction" on finalise.

Brief 5-Whys: `_auto_create_item` left an implicit transaction open
(SQLite's auto-begin-on-write behaviour); the worker's `finalise_success`
called `BEGIN IMMEDIATE` regardless. The fix is the `_begin_immediate_if_needed`
helper that checks `conn.in_transaction`. Pre-existed; the worker just
exercised the path more reliably than the synchronous handler did. Same
class of bug as D1 — pre-existing latent surfaced by the new gate.

**Root cause:** library-call side-effects (auto-begin) layered on top of
explicit transaction management. The worker didn't introduce the
inconsistency; it ran enough volume to expose it.

**Lesson:** captured as the `_begin_immediate_if_needed` pattern in
`processing.py`. No new practice; pattern is library-specific.

---

## Lessons → artefacts

Every lesson maps to a concrete artefact: a new practice, a runbook
update, a queued ticket, or an explicit dated decision-not-to-act. No
floating observations.

| #   | Lesson | Artefact | Status |
|-----|---|---|---|
| L1  | All SQLite schema rebuilds use the canonical 12-step ALTER pattern (drop-then-rename, never rename-then-recreate of a parent table) | **New practice §10** in `docs/processes/team-practices.md` | accepted (this retro) |
| L2  | Local–prod SQLite skew can hide migration bugs that depend on FK-rewrite-on-rename behaviour | ~~**Queued ticket** for joint Reed + Probe follow-up: add `sqlite_version()` assertion to the e2e gate before any schema-touching deploy~~ **CANCELLED 2026-04-23 per Cam** — replaced by direct version alignment, see Practice §13 (Pinned target versions for load-bearing dependencies). Rationale: address local/prod skew at the env layer, not by coding around it in tests | cancelled |
| L3  | Privileged config changes (sudoers, systemd unit installs) require operator action; deploy.sh never assumes the new privileges are live | **New practice §11** in `docs/processes/team-practices.md`. Documents the deploy.sh contract: code-only, sudoers/units operator-applied separately | accepted (this retro) |
| L4  | Plan-time line-count estimates for novel subsystems are noise; discoverability of the resulting code is the load-bearing property | **Explicit decision-not-to-act**, dated. Rationale: a single data point (worker 430 lines vs 120–180 estimate) is not enough to change planning practice. Cairn watches for a second occurrence; if the next plan's estimate is also off by 2×+ on a discoverability-positive overshoot, write it up as a planning practice change. Rule of Two applies to process changes too | won't-act (dated 2026-04-25) |
| L5  | Deploys must not include uncommitted work; deploy.sh syncs working tree, not committed state | **New practice §12** in `docs/processes/team-practices.md`: codified at the deploy.sh layer (refuse to deploy when `git status --porcelain` is non-empty), not at the Atlas-discipline layer. Rationale: a script-level guard is enforceable; an Atlas-discipline rule is a vibe. Forge owns the script change as a queued ticket | accepted as practice; **queued ticket** for Forge to land the script guard |
| L6  | deploy.sh's worker-restart guard misreports "not installed yet" when the unit is installed but the check fails for other reasons | **Queued ticket** for Forge: re-shape the guard so a false negative on an installed unit is loud, not silent. Suggested: probe with `systemctl status` (returns 0 only if active) or check for the unit file at the canonical path, not just `list-unit-files` | queued |
| L7  | Contract-driven testing (Probe gating Phase 6 against contract invariants) surfaces latent bugs that predate the rollout | **No new practice; reaffirmation of existing Practice 8** (Probe verification mandatory). Captured here so the success of the practice has provenance. The lesson is "keep doing this; the win is real" | accepted (existing) |
| L8  | `lp restart` only bounces the server, not the worker; team had a stale-process pile-up | **Decision recorded:** keep `lp restart` server-only; promote `lp restart-all` as the canonical "bounce both." Rationale: changing `lp restart` semantics would surprise muscle memory and silently restart a worker mid-job for users who only meant to bounce the server. The fix is documentation + naming, not a behavioural change | accepted (this retro) |
| L9  | Pre-existing `print()`-based logging in worker-reachable code violates the contract's privacy invariant | **No new practice.** Bug D1's fix is the artefact. Lesson L7's reaffirmation is the systemic answer. The class of bug ("contract invariant violated by inherited code") is what the gate catches, by design | accepted (no further action) |
| L10 | Worker shutdown drain semantics worked the first time on prod; SIGTERM-drain via `TimeoutStopSec=60` is the right shape | **Captured in retro** as a positive observation. No artefact needed; the systemd unit and signal handler are already in version control | accepted (no further action) |

---

## Practices added or modified

Three new practices entered `docs/processes/team-practices.md`:

- **§10 — Canonical 12-step ALTER for SQLite schema rebuilds** (Lesson L1).
- **§11 — Privileged-config changes are operator-applied, not deploy-applied** (Lesson L3).
- **§12 — Deploys do not include uncommitted work** (Lesson L5).

No existing practice modified.

## Follow-ups dispatched

Three queued tickets, named owner per ticket. Cairn's backlog tracks them
between retros.

- **Ticket — Forge:** re-shape `deploy.sh` worker-restart guard so a
  false negative on an installed unit is loud, not silent (Lesson L6).
- **Ticket — Forge:** add a working-tree-clean check at the top of
  `deploy.sh` that aborts with a clear error if `git status --porcelain`
  is non-empty (Lesson L5, codifies Practice §12).
- ~~**Ticket — Reed + Probe (joint):** add a `sqlite_version()` assertion
  to the Probe e2e gate that fails the suite if local–prod SQLite skew
  crosses a known FK-rewrite-behaviour boundary (Lesson L2).~~
  **CANCELLED 2026-04-23 per Cam** — replaced by direct version alignment
  at the env layer. See Practice §13 (Pinned target versions for
  load-bearing dependencies) and `docs/runbooks/target-versions.md`
  (owned by Forge).

## Decisions taken in this retro

1. `lp restart` semantics unchanged. `lp restart-all` is the canonical
   "bounce everything." Documentation update is part of L8's artefact (the
   decision itself is the artefact; no separate file).
2. Practice §12 (deploys do not include uncommitted work) is enforced at
   the script layer, not the persona layer.
3. Worker line-count overshoot is recorded as a one-time observation. No
   planning-practice change pending a second occurrence (Rule of Two).
4. The privacy invariant violation is treated as a successful gate
   detection, not as a process failure. The gate exists because invariants
   like this need a runtime check; the gate worked.

## Open questions

Genuine product input from Cam: **none.**

(Items the team triaged in-lane; if Cam wants to revisit any of them, the
relevant ticket is named above.)

---

## Cairn's self-assessment

Cairn supervised Phase 0, reviewed every cross-persona seam, ran the
contract sign-off, and facilitated this retro. Honest assessment:

**Worked.**

- The Phase 0 contract pre-aligned three personas well enough that Phases
  3–5 ran in parallel without a single file collision. That is the load-
  bearing claim of the contract-before-code practice; this rollout is its
  second piece of evidence (after cookie-auth produced the rule).
- Lessons-as-artefacts held: ten lessons, ten named outcomes, three new
  practices, three queued tickets, two explicit decisions-not-to-act with
  dated rationale.
- The retro happened by default at end-of-feature, not on Cam's request.
  Practice 4 (retrospective default) is in force.

**Could have been better.**

- Cairn did not flag the Phase 0 privacy invariant as a *runtime* property
  needing an audit of all worker-reach code. Probe caught it; Cairn should
  have caught it at contract review time. The contract's wording ("worker
  logs contain no user content") was correct-but-narrow; Cairn read it as
  a design property and didn't push back. Lesson L9 records the systemic
  answer (the gate catches it); the personal lesson is that "invariant"
  in a contract should trigger Cairn to ask "where is this enforced and
  what audits its reach."
- The Bug B / Bug C compound (deploy guard + sudoers re-run) was a
  process gap that Cairn could have anticipated when reviewing the Phase 5
  commit. The deploy.sh contract was implicit before this rollout; making
  it explicit (Practice §11) is a Cairn-shaped lesson. The fact that it
  took a 3-hour prod incident to surface it means the review wasn't deep
  enough.

**Honest score for the retro itself:** good. Ten lessons, ten artefacts,
zero floating observations, three concrete practice additions, three
queued tickets with owners, and zero items needing Cam's product input.
That is the standard.

---

## Provenance

- Plan: `~/.claude/plans/new-plan-as-a-immutable-unicorn.md`.
- Contract: [`app/contracts/background-processing.md`](../../app/contracts/background-processing.md).
- Prior retro that produced the practice baseline: [`2026-04-25-cookie-auth.md`](2026-04-25-cookie-auth.md).
- Sibling summary doc for Cam: [`2026-04-25-background-processing-summary.md`](2026-04-25-background-processing-summary.md).
- Practices added in this retro: §10, §11, §12 in [`docs/processes/team-practices.md`](../processes/team-practices.md).
