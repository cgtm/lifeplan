---
title: e2e Suite Scoping & Pruning Plan
status: proposed
owner: Probe
reviewer: Cairn
date: 2026-04-30
---

# e2e Suite Scoping & Pruning Plan

**Status:** proposed. Cairn reviews next; she flips to accepted or pushes back.
Cam's directive (verbatim):
> "Either they're taking too long or they're failing. It keeps causing the
> team members to fail to complete their tasks. I suggest doing a review of
> the tests and seeing what can be pruned or combined. And/or only running
> the relevant tests that cover the touchpoints of the current work."

This document does not change app code or test code. It proposes the changes
and sets the bar for what comes next.

---

## 1. Current state

Eleven spec files, **129 cases** authored, **2 browser projects** (chromium +
webkit), `fullyParallel: false`, `workers: 1`, retries 1 locally / 2 in CI.
Per-test timeout 30 s; some tests bump it to 45–150 s for queue/watchdog work.

Wall-clock measured on this machine, 2026-04-30, against a healthy local
server:

| Spec | Cases | Wall-clock (default suite) | Stability | Surface |
|---|---:|---:|---|---|
| `add-person.spec.ts` | 7 | **27 s** (measured) | stable | People view, POST /api/people, person_mention approval |
| `add-knowledge.spec.ts` | 8 | ~30–40 s (est) | stable | Knowledge view, POST /api/knowledge, knowledge_gap CTA |
| `auth.spec.ts` | 14 (1 skip default) | **150 s** (measured, retries fired) | **flaky on webkit** when limiter primed; cookie/session cascade | login, logout, cookie flags, Content-Type gate, public assets, tampered cookie |
| `apply-to-fanout.spec.ts` | 6 (describe-skip if no sqlite3) | ~60–80 s (est) | stable when sqlite present | tag fan-out via apply_to (Vault option C) |
| `auto-create-item-truthfulness.spec.ts` | 8 (describe-skip if no sqlite3) | ~60–80 s (est) | stable | _auto_create_item invariants (worker surface, approve surface) |
| `background-processing.spec.ts` | 8 (2 gated) | ~120–180 s (est, polls to 120 s) | flake-prone when LLM tier degraded; documented | work_queue, worker daemon, retry endpoint, UI live transitions |
| `blockers-become-real.spec.ts` | 15 | ~150–200 s (est) | mostly stable | PUT /api/blockers, hero card, blocker rows, prompt CTAs, failed-dump retry |
| `dump-detail-modal.spec.ts` | 16 (1 describe-skip if no sqlite3) | ~150–200 s (est) | **UI 11 intermittently flaky** (per Cam) | brain-dump detail drawer, retry / unreject / approve / edit |
| `goal-detail-growability.spec.ts` | 18 | ~200 s (est) | mostly stable | POST /api/blockers full matrix, + Task / + Blocker UI, picker |
| `guide-and-polishes.spec.ts` | 17 | ~160 s (est) | stable; one test invokes `bash deploy.sh --with-db` | help/user-guide endpoint, tag-chip glyph, undo-resolve chip, prompt buttons, deploy.sh gate |
| `tags-first-class.spec.ts` | 12 | ~120 s (est) | stable | tags CRUD, merge, drawer, chip clicks, rename collision |

**Total default-suite estimate (clean-state, no retries):** ~17–20 minutes
across both projects. With 1 retry on the limiter-cascade auth flake, it
balloons to 25+ minutes — easily past the harness stream-idle and
tool-timeout thresholds team members hit.

Measured calibration: `add-person.spec.ts` ran 14 child runs in 27 s, so
the per-run cost is ~1.9 s when nothing polls. The big specs are big
because the worker / queue / drawer flows poll for terminal state.

---

## 2. Pain points (what's actually breaking team members)

1. **Auth limiter cascade.** When prior local activity (dev login attempts,
   an interrupted prior run) leaves the in-process rate limiter primed, the
   webkit project's two wrong-password tests push it over the threshold
   and every subsequent webkit test fails with "session cookie should be
   present after login: undefined." Reproduced this dispatch — 6 webkit
   failures in a single `auth.spec.ts` run, retries fired, total 2.5 min.
   This is precondition #5 in `probe-go-no-go.md` and it's tripping
   on un-restarted local servers.
2. **Tool timeout / stream-idle.** 17–20 minutes of suite is past most
   harness defaults. Vault hit "tool failed to return"; Lumen hit
   stream-idle; Probe hit usage-limit. None were "the suite was wrong";
   they were "the suite was too long for the tool budget."
3. **`background-processing.spec.ts` + LLM tier flake.** The happy-path
   poll has a 120 s bound and runs serially against a single worker.
   When Mistral cloud is rate-limited or Ollama is dead, the regex
   fallback is slow enough that this test occasionally exceeds 120 s.
   Already documented in the e2e README.
4. **`dump-detail-modal.spec.ts` UI 11 flake.** Approve-suggested-item
   asserts via a `sqliteExec` poll with a 5 s window after a UI click.
   Under contention this races.
5. **4-worker sqlite-lock fear.** Not currently triggered — config
   pins `workers: 1` and `fullyParallel: false`. Nobody is bypassing
   that. The fear is real if anyone ever flips it without per-test DB
   isolation. We should leave the pin in place and document why.
6. **Two browser projects.** WebKit doubles every wall-clock; it's
   non-negotiable for the auth surface (Cam's primary device is iOS),
   but it's not load-bearing for, say, the tag-merge SQL contract.

---

## 3. Pruning recommendations

The principle: a test earns its place by either (a) covering a clause
of a contract that nothing else covers, or (b) being a permanent fixture
for a previously-shipped bug. Cases that just exercise an additional
example of an already-covered behaviour are taking time without buying
coverage.

| Action | Spec / case | Justification |
|---|---|---|
| **Prune** | `auth.spec.ts` → "Public assets" loop (5 paths × 2 verbs in one test) | Currently fine; **keep**. (Listed only to flag we considered it — the 5 paths are deliberately enumerated against the manifest contract.) |
| **Prune** | `goal-detail-growability.spec.ts` → API 5 "bad blocker_<type>_id" runs the same 404 assertion three times for type=goal/task/external_system | Collapse to one parametrised case. Saves ~6 s per project. |
| **Prune** | `dump-detail-modal.spec.ts` → UI 9 "click dump row in home recents strip" | Redundant with UI 8 ("click dump row in dumps list"). Both open the same drawer; the difference is a click target. One can be a sub-assertion in the other, or UI 9 deleted outright. |
| **Prune** | `dump-detail-modal.spec.ts` → UI 15 "reviewOverlay is fully gone from app/" | This is a one-time cleanup assertion from a refactor. If it's been green for two weeks, delete it — the review overlay isn't coming back, and a static-text grep belongs in a one-shot lint, not a per-deploy e2e. |
| **Prune** | `add-person.spec.ts` → both "400 on empty name" and "400 on whitespace-only name" | These verify the same handler branch (`name.strip() == ""`). Merge into one parametrised case. Mirror in `add-knowledge.spec.ts`. |
| **Prune** | `goal-detail-growability.spec.ts` → API 6 "missing fields" enumerates several missing-field shapes | Collapse to one case with two examples (one per required field) instead of full Cartesian. |
| **Prune** | `guide-and-polishes.spec.ts` → "close paths: × / click-outside / Esc" | Already one test with three sub-assertions. **Keep as-is** — listed only to flag we reviewed. |

**Net case-count reduction from pruning: ~8–10 cases** across both
projects (so ~16–20 fewer child runs).

The bigger lever is scoping (§6), not pruning.

---

## 4. Combining recommendations

| Combine | Into | Justification |
|---|---|---|
| `add-person.spec.ts` + `add-knowledge.spec.ts` | `add-entity.spec.ts` | Both are 7–8 cases each, both cover a tiny "type a name + Enter, see new card" flow plus a 201/400 contract handful. They share fixture, share feature surface (small inline-add affordance pattern). One file, ~12 cases after de-dup. |

I am **not** proposing to combine the larger specs. `auth.spec.ts`,
`background-processing.spec.ts`, `blockers-become-real.spec.ts`, and
`tags-first-class.spec.ts` each map cleanly to one contract document; the
file boundary is the documentation boundary. Combining them creates
1000-line specs that are harder to grep and harder to scope per-dispatch.

---

## 5. Gating recommendations (use sparingly)

Existing gates: `RATE_LIMIT_TEST`, `FORCE_FAIL_TEST`, `WATCHDOG_TEST`.
Pattern works. New gates only where the test is genuinely slow or
flake-prone *and* the regression risk of skipping by default is low.

| Add gate | Test | Reason |
|---|---|---|
| `BG_HAPPY_TEST` | `background-processing.spec.ts` → "happy path: 202 + queued → claimed within 30 s → terminal within 120 s" | This is the LLM-tier-dependent flake. Gate it off by default; replace with a much faster sub-assertion that proves only the queue + worker daemon are alive (POST returns 202 + worker claims within 30 s, then **stop polling**). The full happy-path stays available for deploy-gate runs that touch worker code. |
| `BG_LIVE_UI_TEST` | `background-processing.spec.ts` → "UI: submit → Pending within 1 s → terminal badge within 120 s" | Same reason. Same split: keep the "Pending within 1 s" half by default, gate the "terminal badge within 120 s" tail. |
| `DUMP_RETRY_TEST` | `dump-detail-modal.spec.ts` → UI 11 (approve flake), UI 12 (edit + re-process), UI 13 (failed-dump retry) | These three depend on injecting a `needs_review` dump and racing the worker. If we keep them in default, they will keep flaking on contention. Gate them, and let any dispatch touching the dump-detail surface run them explicitly. |

**Do not gate** any of `auth.spec.ts`, `tags-first-class.spec.ts`, the
contract halves of `add-*` / `apply-to-fanout` / `goal-detail-growability` /
`blockers-become-real` / `guide-and-polishes`. They are deterministic,
fast, and they cover surfaces Cam touches in every session.

After gating: **default suite drops from 129 cases to ~120**, but the
slowest five disappear, and the wall-clock effect is much larger than
the case-count effect.

---

## 6. Per-dispatch scoping convention (the main lever)

The biggest win isn't pruning; it's **not running every spec for every
dispatch**. Playwright supports this natively via filename arguments and
grep tags. Proposal:

### 6.1 A "smoke" subset that every dispatch runs by default

Add a new npm script `npm run smoke` that runs a curated set of fast,
deterministic, high-value cases tagged `@smoke`. Target shape:

- `auth.spec.ts` — GET /login, POST /login (correct + wrong), GET / (auth +
  unauth), API auth gate, POST /logout, public assets. **Skip** the rate
  limit, tampered cookie, mobile breakpoint, and content-type-gate by
  default — those are valuable on auth-surface dispatches, not every one.
- `add-entity.spec.ts` — one happy-path 201 + one duplicate path.
- `tags-first-class.spec.ts` — POST /api/tags + GET /api/tags only.
- `blockers-become-real.spec.ts` — PUT /api/blockers happy path
  (resolved=true), hero blocker tap.
- `goal-detail-growability.spec.ts` — UI 8 (chips visible) + API 1a
  (POST /api/blockers happy path, type=goal).
- `dump-detail-modal.spec.ts` — UI 8 (drawer opens from list).
- `guide-and-polishes.spec.ts` — Help endpoint + Help modal opens.

That's roughly **15–20 cases × 2 projects = 30–40 child runs**, target
wall-clock **≤ 60 s**. The bar Cam set in the dispatch.

### 6.2 Tag tests with `@`-prefixed grep tags

Playwright supports `--grep "@smoke"` matching against the test title.
Convention:

- Every test title starts with one or more tags: `@smoke @auth @http`.
- Tags name the **surface**, not the persona. Example tags: `@auth`,
  `@dump`, `@tags`, `@blockers`, `@goal`, `@people`, `@knowledge`,
  `@worker`, `@guide`.
- A test that touches multiple surfaces gets multiple tags.

Run a scoped subset:

```sh
npx playwright test --grep "@auth"          # auth surface only
npx playwright test --grep "@dump|@worker"  # background processing surface
npx playwright test --grep "@smoke"         # the default-everywhere set
```

This is preferred to per-spec file lists because tests grow tags
organically as they're written, and a spec can contribute to multiple
surface scopes without being split.

### 6.3 npm scripts as the documented entry points

Add to `tests/e2e/package.json`:

```json
"smoke":   "playwright test --grep @smoke",
"auth":    "playwright test --grep @auth",
"dump":    "playwright test --grep '@dump|@worker'",
"tags":    "playwright test --grep @tags",
"blocker": "playwright test --grep '@blockers|@goal'",
"add":     "playwright test --grep '@people|@knowledge'",
"full":    "playwright test"
```

`npm test` stays as `playwright test` (the full suite) so the on-demand
deploy gate is unchanged. `npm run smoke` is what dispatchers use.

### 6.4 No file-renaming required

Spec filenames already telegraph surface (`auth.spec.ts`,
`tags-first-class.spec.ts`, `background-processing.spec.ts`, etc.). The
tag layer rides on top. Atlas / dispatchers can also pass file globs to
`npx playwright test` for surgical runs:

```sh
npx playwright test auth.spec.ts blockers-become-real.spec.ts
```

---

## 7. Parallelism / fixture changes

The 4-worker sqlite-lock concern is **not currently triggered** — the
config explicitly pins `workers: 1, fullyParallel: false`. The mention
in the dispatch refers to the consequence if anyone ever lifts that pin.

Recommendation: **keep `workers: 1`.** Lifeplan is a single-user app
against a single dev SQLite file with a global rate limiter and a worker
daemon that processes one job at a time. There is no realistic path to
parallel test execution without per-test DB isolation, and per-test DB
isolation costs more than it saves at this suite size.

Smaller fixture changes that *do* help:

1. **Pre-test limiter reset.** Add a `beforeAll` in `auth.spec.ts` that
   pings `/login` once with a known-good session check; if the limiter
   is already over the threshold (detected by 429 on the first probe),
   skip the suite with a clear "limiter primed — run `lp restart`"
   message instead of a 6-failure cascade. This is the single biggest
   reduction in "tests that look broken but are actually environment."
2. **Cookie-fixture isolation.** `loggedInPage` already creates a fresh
   browser context per test. That's correct. No change.
3. **`test.setTimeout(150_000)` review.** Three tests in
   `background-processing.spec.ts` set this. After the gating in §5,
   only the gated tests should keep it; the default-on tests should
   live within the normal 30 s bound.

Not proposing per-test database isolation in this round. It's a real
refactor with its own bug surface, and the directive is "ship today,
not a six-month refactor."

---

## 8. The team-member-friendly invocation

Replace this in every Vault / Lumen / Reed dispatch:

> `cd tests/e2e && npm test`

With this:

> **Smoke (default for every dispatch, ≤ 60 s target):**
> `cd tests/e2e && npm run smoke`
>
> **Surface-scoped (for dispatches that touch a specific surface):**
> - Auth changes: `npm run auth`
> - Tag changes: `npm run tags`
> - Blocker / goal-detail changes: `npm run blocker`
> - Brain-dump / worker changes: `npm run dump`
> - People / Knowledge inline-add changes: `npm run add`
>
> **Full suite (deploy gate only — Probe runs this before `lp deploy`):**
> `npm test`

Atlas should pick the right one when dispatching. If unsure, smoke. If
the change clearly touches auth, run smoke + auth. The full suite is
Probe's job, not every dispatcher's.

For dispatchers who can't tell what to run: ship the relevant filename.
`npx playwright test <relevant.spec.ts>` always works as a fallback,
and the spec filenames are mnemonic.

---

## 9. Net impact (projected)

| Metric | Before | After (smoke default) | After (full gate) |
|---|---:|---:|---:|
| Default-run cases (per dispatch) | 129 × 2 = 258 child runs | ~30–40 child runs | unchanged when explicitly run |
| Default-run wall-clock | 17–20 min (clean), 25+ with limiter cascade | **target ≤ 60 s** | ~12–15 min (after pruning + gating slow polls) |
| Tool-timeout risk | high — past most stream-idle thresholds | low | medium — Probe runs interactively / in long-budget mode |
| Limiter-cascade flake | hits dispatchers | smoke skips wrong-password tests (≤ 1 wrong-pw probe), so cascade can't form | full suite still runs them; precondition #5 in `probe-go-no-go.md` already gates this |
| Coverage | 100% of contract clauses | smoke ≈ 25% of clauses (the high-leverage ones) | 100% |
| Bar Cam set ("default agent run < 90 s") | not met | **met** | n/a |

The case-count drop is small. The wall-clock drop is huge because the
slow polls (background-processing happy path, dump-detail UI 11/12/13)
move to gated.

---

## 10. Open questions for Cairn

1. **Cadence for the full suite.** The current policy in `probe-go-no-go.md`
   is "on-demand, not scheduled." That stays correct under this proposal
   for the gate. But the smoke suite is now a *per-dispatch* contract,
   not a deploy contract. Worth a one-line update to `probe-go-no-go.md`
   to name the smoke suite as the default and the full suite as the gate?
   I lean yes; flagging because that's a runbook touching your turf.
2. **Tag-comment vs. test-title prefix.** Playwright `--grep` matches
   the test title by default. I propose tags **inside** the title
   (`'@smoke @auth contract: GET /login → 200 + form'`). An alternative
   is `test()`-level metadata via `test.info().annotations`, which is
   cleaner but requires a custom CLI flag wrapper. I think the in-title
   convention is more durable and grep-friendly. Want to push back?
3. **Smoke set membership.** §6.1 lists my proposed smoke cases. You
   have the better lens for "what would Cam regret missing on a default
   run." If you want a different cut, say so before implementation.

---

## Provenance

This document was prompted by Cam's directive after Vault hit a tool-failure
cascade, Lumen hit stream-idle, and Probe hit usage-limit, all in
the same week, all on `npm test`. The proposed changes are bounded to
spec / config / package.json edits and a new convention layer; no app
code changes, no deploy changes.

When this is `accepted`, the implementation phase should land as one
PR-shaped commit: pruning + combine + tags + npm scripts + the
limiter-cascade `beforeAll` + gating env-vars wired in. Probe estimates
half a day's work after Cairn signs off.
