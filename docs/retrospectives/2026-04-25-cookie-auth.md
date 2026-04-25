# Retrospective — Cookie-Session Auth

**Date:** 2026-04-25
**Feature:** Replace HTTP Basic Auth with cookie-session login
**Personas involved:** Atlas, Plan, Sage, Nova, Vault (new hire), Lumen, Forge, Cam
**Format:** Timeline retro with 5-Whys on the dominant failure
**Facilitator:** Cairn (first artefact)
**Status:** accepted

---

## Why this format

This is incident-shaped: one feature, multiple shipped bugs, one dominant
failure mode (root-absolute path bug, three times). A timeline carries the
sequence; a 5-Whys carries the root cause of the dominant failure. Both, kept
short.

## One-paragraph summary

Cookie-session auth shipped, works end-to-end on desktop and iOS PWA, replaced
Basic Auth in a single-shot deploy with a negligible public window, and
introduced no security regressions. The hire pipeline (Sage research → Nova
persona → Vault on day one) was clean. The cost was iteration count: at least
50% more deploy cycles than necessary, driven almost entirely by anticipation
failures — three identical path bugs, one false premise about Tailscale, and
several flagged-but-parked observations. The feature *worked*; the *process*
leaked.

## Cam's request that produced this retro

Cam asked for the retro. That is itself a finding (see Lesson 8).

---

## Timeline

| # | Event | Persona | Outcome |
|---|---|---|---|
| 1 | Plan agent designs cookie-session feature: threat model, cookie flags, migration order, single-shot deploy | Plan | Shared target held throughout |
| 2 | Atlas asks Sage to research backend security engineer; Nova writes `team/vault.md` from research | Sage, Nova | Clean hire; Vault productive on day one |
| 3 | Phase 1 dispatched in parallel: Vault on server-side auth, Lumen on login UI | Atlas → Vault, Lumen | No collisions; API contract held |
| 4 | Vault edits launchd plist locally to switch Python (Apple system Python lacks `hashlib.scrypt`); flags it explicitly | Vault | Action correct in effect, outside Vault's lane |
| 5 | First deploy: cookie auth + Basic Auth removal in single shot. Public window negligible | Forge | No incident |
| 6 | Bug 1: `login.html` `fetch('/login')` resolves to apex (mount is `/lifeplan/`). Fixed, redeployed | Lumen | One bug-class, first occurrence |
| 7 | Bug 2: `app.js` logout `window.location.href = '/login'` — same class. Fixed, redeployed | Lumen | Same bug-class, second occurrence — Rule of Two violated |
| 8 | Bug 3: `server.py` 302 returns `Location: /login` — same class, server side. Fixed, redeployed | Vault | Same bug-class, third occurrence |
| 9 | Contract rule (Vault r13, Lumen r11) added *after* third occurrence | Atlas → Nova | Reactive, not preventive |
| 10 | Atlas asserts "Tailscale only" from `deploy.sh` banner; Cam challenges; verification shows site fully public | Atlas, Cam, Forge | nginx config change made on a wrong premise |
| 11 | `curl -sI /login` returns 404; Vault's `do_GET` override doesn't cover HEAD | Vault | Debug cycle on a curl artefact, no real-user impact |
| 12 | `deploy.sh` health-check warns four times in one session — probes a now-auth-gated path, gets 401 | Forge / script | Warning correct, script assumption stale; ignored |
| 13 | `server-setup.sh` Tailscale claims flagged once, parked, never reconciled | Atlas/Forge | Observation parked silently |
| 14 | Feature ships end-to-end (cookie login, mount-aware redirects, logout, iOS PWA bookmark with icon) across multiple deploys with **zero commits** | All | Working tree dirty throughout |
| 15 | Cairn hired (Sage → Nova) to own engineering practice; this retro is artefact #1 | Sage, Nova | — |

---

## What went well

- **Hire pipeline.** Sage research → Nova persona → Vault landed real code on
  day one. The pattern is reusable and will be reused.
- **Plan agent.** A single shared target (threat model, cookie design,
  migration order) held across personas for the whole feature.
- **Forge's nginx discipline.** Atomic backup-swap-test-rollback every time.
  No broken nginx state at any point.
- **Parallel dispatch.** Vault and Lumen ran concurrently on Phase 1. Contract
  held at the API boundary; no collisions.
- **Single-shot deploy.** Cookie auth in, Basic Auth out, in one move.
  Public-exposure window negligible. No incident.
- **Vault flagged the launchd edit explicitly** rather than smuggling it
  through. The lane was wrong; the discipline of flagging it was right.
- **End state.** Feature works on desktop and iOS PWA. No security
  regressions. iOS bookmark with icon. Logout on both surfaces.

## What went badly

The ten failures from the brief, written as items the team will refer back to:

1. **Three identical root-absolute path bugs in three commits**
   (`login.html` fetch, `app.js` logout redirect, `server.py` 302 `Location`).
   Same bug class across two personas. Three deploy cycles burned on one
   pattern.
2. **Tailscale false premise.** Atlas treated a `deploy.sh` banner string as
   ground truth; Tailscale was not installed. Cost a deployed nginx change on
   a wrong premise. Cam was the one who challenged it.
3. **HEAD vs GET 404.** `do_GET` override didn't cover HEAD; static-file
   fallback couldn't find a file named `login`. No user impact, but
   anticipatable in design.
4. **Vault edited the launchd plist** — outside lane (Forge's territory).
   Brief should have caught it.
5. **`deploy.sh` health-check warning ignored four times** in a single
   session. The script probes a now-auth-gated path and warns on the 401.
   Correct from the app, wrong assumption in the script.
6. **`server-setup.sh` Tailscale claims** never reconciled with reality.
   Flagged once, parked, no follow-through.
7. **Whole feature shipped without a single commit.** Multiple deploys against
   a dirty working tree.
8. **No retrospective culture before now.** This retro happens because Cam
   asked. Retros should be a default, not on request.
9. **Persona rules added reactively.** The contract rule landed after the
   *third* identical bug, not the second. Rule of Two was violated.
10. **Atlas drifted into too much commentary** in early rounds, against the
    existing "Delegate and be concise" memory.

## Atlas's self-rating

6.5 / 10. Feature shipped, works, no security regression. Iteration count at
least 50% higher than necessary. The bugs were anticipation failures, not
execution failures. Cairn agrees with the rating.

---

## 5-Whys on the dominant failure

**Failure:** three identical root-absolute path bugs (`/login`) shipped to
production across three separate commits and two personas.

1. **Why did the bug ship?**
   Because root-absolute `/login` resolves to apex, not to the `/lifeplan/`
   mount, and nothing in either persona's pre-code checklist forced
   mount-awareness.
2. **Why was nothing in the checklist?**
   Because there was no shared contract for the feature naming the mount, the
   redirect targets, and the resolver function on each side.
3. **Why was there no shared contract?**
   Because the team had no rule requiring one. Vault and Lumen were dispatched
   in parallel against an API-shaped brief, not a contract document. Each
   persona made locally reasonable assumptions; the assumptions disagreed at
   the URL level.
4. **Why was there no rule?**
   Because the team had no practice owner, no canonical practices document,
   and no retrospective default. Lessons lived in chat, not in artefacts.
   Contract-before-code was a thing experienced engineers do; it wasn't a
   thing *this team* had written down.
5. **Why was that allowed to persist past the second occurrence?**
   Because the Rule of Two — *the second occurrence is the signal; codify
   before fixing the second time* — was not yet a stated team rule. The team
   noticed each instance individually and treated each as a code bug, not a
   pattern. Pattern-recognition across diffs had no owner.

**Root cause (named for the artefact):** absence of a written
contract-before-code practice and an owner for cross-persona pattern
recognition. Cairn now exists to be that owner; this retro begins the written
record.

---

## Lessons → artefacts

Every lesson maps to a concrete artefact. No floating observations.

| # | Lesson | Artefact | Status |
|---|---|---|---|
| L1 | Same-bug-class across two personas means a missing shared contract, not three code bugs | **Practice: Contract-before-code** in `docs/processes/team-practices.md`, lifted from Vault r13 / Lumen r11. Pointer left in each persona file | accepted (this retro) |
| L2 | Root-absolute paths are unsafe under a non-`/` mount | **Practice: Mount-aware path handling** in `team-practices.md`. Names `MOUNT` (client) and `auth.login_url()` (server) as the only allowed sources | accepted (this retro) |
| L3 | Banner strings are not ground truth | **Runbook (queued):** `docs/runbooks/verify-droplet-network-posture.md` — what `nginx`, `ufw`, `tailscale status`, and `ss -ltnp` actually say about exposure. Replaces banner-reading | queued |
| L4 | `do_GET` overrides leak a HEAD 404 if not paired | **ADR (queued):** `docs/decisions/0001-http-method-coverage-on-handler-overrides.md`. Decision: any handler override covers GET *and* HEAD, with a one-line test | queued |
| L5 | Persona-lane violations (Vault editing launchd) are a brief problem, not a discipline problem | Add to **Practice: Stay-in-lane handoffs** in `team-practices.md` (proposed for next retro; not enough evidence yet for a full rule) | proposed |
| L6 | Stale automation warnings get ignored on repeat | **Runbook (queued):** `docs/runbooks/deploy-sh-health-check.md` — fix the script to authenticate or probe a public health endpoint | queued |
| L7 | Flagged-and-parked observations rot | **Practice: Triage every observation** in `team-practices.md`. Each flag becomes a ticket, a runbook entry, or an explicit ignore decision with date | accepted (this retro) |
| L8 | Multi-deploy features with a dirty tree are a process bug | **Practice: Commit cadence** in `team-practices.md` | accepted (this retro) |
| L9 | Retros are not optional | **Practice: Retrospective default** in `team-practices.md`. Every feature touching more than one persona ends in a dated retro | accepted (this retro) |
| L10 | Reactive rule-writing is the Rule of Two failing | **Practice: Rule of Two** documented under Cairn's review responsibilities in `team-practices.md` | accepted (this retro) |
| L11 | `server-setup.sh` Tailscale claims drift from reality | **Ticket (queued):** reconcile `server-setup.sh` against actual droplet state; either install Tailscale or remove the claims | queued |
| L12 | Atlas drift into commentary in early rounds | No new artefact. Existing memory `feedback_delegate_and_be_concise` covers it. Cairn will flag at review time if it recurs | accepted (existing) |

## Queued artefacts (Cairn's backlog)

These are not produced in this pass. Cairn will work them down over coming
sessions.

- `docs/runbooks/verify-droplet-network-posture.md` — replace banner-reading.
- `docs/runbooks/remote-sudo.md` — covers a recurring "how do I do this on
  the droplet" gap (raised by Cam separately; queued here).
- `docs/runbooks/deploy-sh-health-check.md` — fix the 401 warning.
- `docs/decisions/0001-http-method-coverage-on-handler-overrides.md`.
- Ticket: reconcile `server-setup.sh` Tailscale claims with reality.
- Ticket: confirm a contract document exists for the cookie-auth feature
  retroactively in `app/contracts/` (the template was produced; the filled
  contract was not). Backfill if missing.

---

## Cairn's self-assessment

Cairn was hired *because* of this incident. The retro is Cairn's first
artefact. Honesty is part of the role.

**What Cairn's presence would have changed:**

- L1 / L2: Cairn would have required a contract before Vault and Lumen
  started Phase 1. Both root-absolute path bugs are pre-empted by a
  one-page document naming the mount, the resolvers, and the redirect
  targets. The contract template exists *because* it was missing.
- L7: The Tailscale banner claim and the `server-setup.sh` Tailscale claims
  would have been triaged on first mention rather than parked.
- L8: Commit-cadence is a review-time enforcement; Cairn would have stopped
  the second deploy-without-commit and asked for a chunked commit.
- L9: This retro happens by default at end-of-feature, not on Cam's request.
- L10: The Rule of Two would have triggered the contract rule after Bug 2,
  not Bug 3 — saving one deploy cycle.

**What Cairn's presence would not have changed:**

- L3 (Tailscale false premise): the banner-vs-reality gap is an Atlas
  scepticism problem and a Forge audit problem. A runbook helps next time;
  it would not have caught it this time. Cam catching it was the correct
  outcome under the process we had.
- L4 (HEAD vs GET): Cairn does not write code. The catch is a Vault
  test-the-unhappy-paths issue plus an ADR for handler overrides.
- L5 (Vault edited launchd): a brief problem from Atlas. Cairn reviews diffs
  across persona boundaries, but the launchd edit would have been caught at
  review time, not at dispatch time. The lane violation already shipped by
  then.
- L11: out of Cairn's lane until enough evidence accumulates to write the
  ticket. Existed pre-Cairn as a parked observation; Cairn now records it.

**Honest score for the retro itself:** adequate, not exemplary. The timeline
is short because the feature was short. The 5-Whys lands on a real root
cause. The lessons-to-artefacts mapping is the load-bearing column —
twelve lessons, twelve named artefacts, no floating observations. That is
the standard Cairn intends to hold to.

---

## Decisions taken in this retro

1. `docs/processes/team-practices.md` becomes the canonical home for
   team-wide rules. Persona files keep one-line pointers, not duplicates.
2. The contract-before-code rule is lifted out of Vault r13 and Lumen r11
   and consolidated.
3. Mount-aware path handling, commit cadence, retrospective default, and
   triage-every-observation are entered as accepted practices.
4. Five queued artefacts (runbooks, ADR, tickets) enter Cairn's backlog.

## Open questions

- Does the cookie-auth feature have a filled-in `app/contracts/cookie-auth.md`,
  or only the `_template.md`? If only the template, Vault and Lumen owe a
  retroactive backfill. — *for Atlas to route*
- Who owns the `server-setup.sh` reconciliation: Forge (because infra) or a
  joint Forge/Vault check? — *for Atlas / Cam*
- Is a Probe verification step now mandatory on auth-touching deploys? — *for
  Cam*
