# Team Practices

**Status:** living document
**Owner:** Cairn (Tech Lead)
**Principle:** one rule, one home. Rules that apply to more than one persona
live here, not duplicated across persona files.

This document is the canonical source for cross-persona engineering practice.
Each practice carries a one-line statement, a *Why* (with provenance), a
*How to apply* with concrete examples, and a *Status*. When a practice
changes, update this file; the persona files only carry pointers to it.

---

## Index

1. [Contract-before-code](#1-contract-before-code) — accepted
2. [Mount-aware path handling](#2-mount-aware-path-handling) — accepted
3. [Commit cadence](#3-commit-cadence) — accepted
4. [Retrospective default](#4-retrospective-default) — accepted
5. [Triage every observation](#5-triage-every-observation) — accepted
6. [Rule of Two](#6-rule-of-two) — accepted
7. [Stay-in-lane handoffs](#7-stay-in-lane-handoffs) — proposed
8. [Probe verification mandatory](#8-probe-verification-mandatory) — accepted
9. [HTTP method coverage on handler overrides](#9-http-method-coverage-on-handler-overrides) — accepted
10. [Canonical 12-step ALTER for SQLite schema rebuilds](#10-canonical-12-step-alter-for-sqlite-schema-rebuilds) — accepted
11. [Privileged-config changes are operator-applied](#11-privileged-config-changes-are-operator-applied) — accepted
12. [Deploys do not include uncommitted work](#12-deploys-do-not-include-uncommitted-work) — accepted
13. [Pinned target versions for load-bearing dependencies](#13-pinned-target-versions-for-load-bearing-dependencies) — accepted

---

## 1. Contract-before-code

**Statement.** Any feature that crosses the front/back boundary starts with a
one-page contract co-authored by the server-side and client-side personas
(today: Vault and Lumen), saved to `app/contracts/<feature>.md`, before
either side writes code.

**Why.** The cookie-auth retro of 2026-04-25 surfaced three identical
root-absolute path bugs across two personas in three commits — one bug class,
caught on the third occurrence rather than designed out. Root cause: no
shared contract naming the mount, redirect targets, URL resolvers, and
status-code semantics. Provenance:
[`docs/retrospectives/2026-04-25-cookie-auth.md`](../retrospectives/2026-04-25-cookie-auth.md),
Lesson L1, root cause from the 5-Whys.

**Scope.** Triggered by features touching: auth, forms, redirects, uploads,
or anywhere client and server must agree on URLs, payloads, status codes,
headers, or cookie behaviour.

**How to apply.**

1. Use the template at [`app/contracts/_template.md`](../../app/contracts/_template.md).
2. Fill in *all* sections. Empty sections fail review.
3. Save as `app/contracts/<feature>.md`. Status starts at `draft`.
4. Both authoring personas sign off (status → `agreed`) before either side
   writes implementation code.
5. When reality forces a change during implementation, update the contract
   in the same commit as the code change. The contract is a working document,
   not a planning artefact.
6. Status moves to `live` when the feature is deployed.

**What the contract must name explicitly.**

- The **mount story**: prod mount, dev mount, the named function or constant
  that resolves paths on each side (e.g. `MOUNT` in `app.js`,
  `auth.login_url()` in `server.py`).
- Every endpoint: method, mount-relative path, request shape, response shape
  including `Set-Cookie`, status codes for happy and unhappy paths.
- Every redirect: trigger, issuer (server 302 vs client navigation), target
  path *relative to mount*, mount-aware composition confirmed.
- Error matrix: every documented non-2xx status mapped to a client behaviour.
- Open questions: tracked inline, struck through when answered.

**Persona pointers.**

- `team/vault.md` rule 13 → points here. Vault owns the server half.
- `team/lumen.md` rule 11 → points here. Lumen owns the client half.

**Status:** accepted (2026-04-25).

---

## 2. Mount-aware path handling

**Statement.** Every URL emitted by client or server code is either
mount-relative or composed against a mount-aware mechanism appropriate to
its surface. No root-absolute hardcoded paths anywhere user-reachable.

**Why.** Same retro, same bug class. `fetch('/login')`,
`window.location.href = '/login'`, and `Location: /login` all assumed mount =
`/`. Production mount is `/lifeplan/`. Three deploys to find it. The
invariant is the absence of root-absolute paths; the *mechanism* that
delivers mount-awareness can vary by surface, and for the cookie-auth feature
the team deliberately settled on two — see Lumen's rationale in
[`app/contracts/cookie-auth.md`](../../app/contracts/cookie-auth.md). A
self-contained pre-auth page (`login.html`) does not import the app bundle
and so cannot share the `MOUNT` constant; it relies on browser-native
relative-URL resolution against the document base. The decoupling is the
point: the login page must remain serviceable even when the app bundle is
broken. Provenance:
[`docs/retrospectives/2026-04-25-cookie-auth.md`](../retrospectives/2026-04-25-cookie-auth.md),
Lesson L2; rationale in
[`app/contracts/cookie-auth.md`](../../app/contracts/cookie-auth.md).

**How to apply.**

- **Client (JS / app bundle).** Resolve every URL against the `MOUNT`
  constant in `app/app.js`. No `'/foo'` literals in `fetch`,
  `window.location`, anchor `href`, or form `action`. Allowed forms:
    - `fetch(MOUNT + 'foo')`
    - `MOUNT + 'foo'` for navigation
- **Client (self-contained HTML, e.g. `login.html`).** Use browser-native
  relative URLs (`action="login"`, `href="app/"`) resolved against the
  document base. Do not import `MOUNT` into pre-auth surfaces; keeping
  them decoupled from the app bundle is deliberate.
- **Server (Python).** Compose every redirect `Location` via the named
  helper (`auth.login_url()` for the login redirect, equivalent helpers
  for any future redirect). No string literals beginning with `/` in
  `self.send_header('Location', ...)`.
- **Review check.** Cairn greps every diff under `app/` for the patterns
  `'/[a-z]`, `"/[a-z]`, and `Location.*/`. Any hit explains itself —
  citing the appropriate mount-aware mechanism for its surface — or fails
  review.

**Examples.**

```js
// no
fetch('/login', { ... })
window.location.href = '/login'

// yes
fetch(MOUNT + 'login', { ... })
window.location.href = MOUNT + 'login'
```

```python
# no
self.send_header('Location', '/login')

# yes
self.send_header('Location', auth.login_url())
```

**Status:** accepted (2026-04-25).

---

## 3. Commit cadence

**Statement.** Commit at every meaningful logical chunk. No feature ships
across multiple deploys with an uncommitted working tree.

**Why.** The cookie-auth feature shipped end-to-end across multiple deploys
with zero commits along the way. A dirty tree across deploys destroys the
ability to bisect, revert, or attribute change. Provenance:
[`docs/retrospectives/2026-04-25-cookie-auth.md`](../retrospectives/2026-04-25-cookie-auth.md),
Lesson L8.

**How to apply.**

- A "logical chunk" is a unit that could plausibly be reverted on its own:
  one persona's slice, one ops change, one config snapshot, one doc batch.
- Commit before deploy. If a deploy is needed before a chunk is committable,
  that's a sign the chunk is too big — break it up.
- Commit messages follow the existing convention (no AI attribution, per
  `feedback_no_claude_attribution`).
- Cairn enforces at review time. A diff with too many unrelated changes is
  sent back for splitting before merge.

**Status:** accepted (2026-04-25).

---

## 4. Retrospective default

**Statement.** Every feature that touches more than one persona ends in a
dated retro in `docs/retrospectives/`. No exceptions for "it went fine."

**Why.** The cookie-auth retro happened only because Cam asked. Retros
that depend on someone remembering to ask do not happen. Provenance:
[`docs/retrospectives/2026-04-25-cookie-auth.md`](../retrospectives/2026-04-25-cookie-auth.md),
Lesson L9.

**How to apply.**

- Filename: `YYYY-MM-DD-<slug>.md`.
- Cairn picks the format per situation: Start/Stop/Continue (default), 4 Ls,
  5-Whys, Timeline, or Mad/Sad/Glad.
- Every retro ends in a *lessons → artefacts* table. No floating
  observations. If a lesson cannot be tied to an artefact (runbook, ADR,
  practice entry, automated check, or queued ticket), it is not yet a
  lesson — it is a complaint.
- Cairn maintains the queued-artefacts backlog across retros.

**Status:** accepted (2026-04-25).

---

## 5. Triage every observation

**Statement.** Every warning, flagged anomaly, or "we should look at this
later" gets one of three outcomes: a queued ticket, a runbook entry, or an
explicit dated decision to ignore. None get parked silently.

**Why.** The `deploy.sh` health-check warning fired four times in one
session. The `server-setup.sh` Tailscale claims were flagged once and
parked. Both were correct observations rotting in chat. Provenance:
[`docs/retrospectives/2026-04-25-cookie-auth.md`](../retrospectives/2026-04-25-cookie-auth.md),
Lesson L7.

**How to apply.**

- When a persona flags something they're not solving in this pass, they
  state which of the three outcomes applies, in the same message.
    - **Ticket:** Cairn adds it to the queued-artefacts backlog.
    - **Runbook entry:** the persona names the runbook path and the section.
    - **Ignore (dated):** the persona writes one line stating the decision
      and the reason. That line goes in the next retro's appendix.
- "I'll look at it later" without one of those three is rejected at review.

**Status:** accepted (2026-04-25).

---

## 6. Rule of Two

**Statement.** The second occurrence of the same problem is the signal.
Write the runbook, ADR, or rule *before* fixing it the second time.

**Why.** The contract rule was added after the *third* root-absolute path
bug, not the second. One deploy cycle was burned that the second occurrence
should have prevented. Provenance:
[`docs/retrospectives/2026-04-25-cookie-auth.md`](../retrospectives/2026-04-25-cookie-auth.md),
Lesson L10.

**How to apply.**

- Cairn watches for repeats across diffs and across personas. Same bug
  class in two different commits, or same observation flagged twice, is the
  trigger.
- On the trigger: stop the next fix until the lesson is written down. The
  written form might be a one-line addition to this file, a runbook, an
  ADR, or a single test that would catch it.
- The third occurrence is a process failure, not a code failure. Cairn
  records it in the next retro as such.

**Status:** accepted (2026-04-25).

---

## 7. Stay-in-lane handoffs

**Statement.** When a persona's work requires a change outside their lane,
they write a structured request to the lane owner rather than performing
the change themselves — even if they know how.

**Why.** Vault edited the launchd plist locally to switch Python (Apple
system Python lacks `hashlib.scrypt`). Vault flagged it explicitly, which
is the correct half. The action half was wrong: launchd is Forge's lane.
Provenance:
[`docs/retrospectives/2026-04-25-cookie-auth.md`](../retrospectives/2026-04-25-cookie-auth.md),
Lesson L5.

**How to apply.**

- Vault → Forge: structured infra request (env vars, file permissions,
  nginx behaviour, ports, cookie paths, runtime).
- Lumen → Vault: API contract via practice 1.
- Any persona → Reed: schema proposal, not direct schema edit.
- Atlas dispatches the lane-owner, then the original persona resumes.

**Status:** proposed. Promoted to *accepted* once a second piece of evidence
arrives (Rule of Two applied to the practice itself). Single-evidence
rules go in as proposed, not accepted.

---

## 8. Probe verification mandatory

**Statement.** Probe verification is mandatory before deploying any feature
in Probe's remit: user-facing flows, auth, mobile/PWA behaviour,
cross-browser/cross-device interactions, and anything where a real user
would notice a regression.

**Why.** The cookie-auth feature shipped with three identical
path-resolution bugs across multiple deploy cycles. A Probe pass would
have caught all three in one cycle. Cam's standing rule (this session)
prevents that recurrence by making Probe non-optional on qualifying
features. Provenance:
[`docs/retrospectives/2026-04-25-cookie-auth.md`](../retrospectives/2026-04-25-cookie-auth.md),
Lessons L1–L2; Cam's standing rule, 2026-04-23: *"Probe should be testing
any feature that falls into their remit."*

**How to apply.**

- Atlas dispatches to Probe before scheduling a deploy for any qualifying
  feature.
- Probe issues a **go** or **no-go**.
- Atlas does **not** run `lp deploy` without Probe's go on qualifying
  features.
- For features clearly outside Probe's remit — pure docs, infra-only
  changes that don't touch user flows, persona authoring — Probe sign-off
  is not required. When in doubt, dispatch to Probe.

**Status:** accepted (2026-04-23).

---

## 9. HTTP method coverage on handler overrides

**Statement.** When a request handler overrides one HTTP method for a route
(e.g. `do_GET`), it must also cover the semantically-paired methods that
clients can reasonably send for the same route. Concretely: any route that
overrides `do_GET` must also handle `HEAD`, returning the same status code
and headers as the corresponding `GET` (with no body). The default fallback
to `SimpleHTTPRequestHandler.do_HEAD` is not acceptable for routes the
handler claims to own, because it will 404 on virtual routes.

**Why.** Vault's `do_GET` override for `/login` did not cover `HEAD`, so
`curl -sI` and the original `deploy.sh` health probe both 404'd against a
route that real users (browsers, on `GET`) reach without issue. Two
occurrences across two surfaces = Rule of Two. Reversal cost is trivial,
so this lives as a practice rather than an ADR.

**How to apply.**

- For each `do_GET` override, add a `do_HEAD` that delegates to the same
  routing logic and suppresses the body. The simplest correct form is
  usually `do_HEAD = do_GET` *if* the handler also routes by method
  internally, otherwise an explicit `do_HEAD` that calls a shared
  `_route(method)` helper.
- Health checks and external monitors should prefer `GET` to `HEAD` unless
  there's a specific reason (bandwidth, idempotence) — but the server-side
  rule above is the load-bearing one.
- Review check: Cairn greps every server-side diff for `def do_GET` and
  flags any route that doesn't have a paired `do_HEAD` (or a documented
  reason it doesn't need one, e.g. POST-only endpoints).

**Status:** accepted (2026-04-23). Provenance: triage entry of 2026-04-23,
HEAD-vs-GET 404 on `/login`. Two occurrences (production curl-check;
`deploy.sh` health probe, since worked-around by switching to GET).

---

## 10. Canonical 12-step ALTER for SQLite schema rebuilds

**Statement.** Every SQLite schema rebuild that touches a parent table
referenced by a foreign key uses the canonical 12-step ALTER pattern
(create new table → copy data → drop old → rename new). Never rename the
parent table out of the way and then recreate under the original name.
The "rename, recreate, copy, drop" shorthand is forbidden for any table
that has child references.

**Why.** Migration 0001 of the background-processing rollout used the
"rename parent, recreate" pattern. Modern SQLite (~3.25+) auto-rewrites
FK references in dependent tables when the parent is renamed; older
SQLite (the prod droplet) does not. Local came up green; prod showed 19
FK violations and broken `brain_dump_tags` INSERTs. Required a 0002
hot-fix migration. Provenance:
[`docs/retrospectives/2026-04-25-background-processing.md`](../retrospectives/2026-04-25-background-processing.md),
Bug A and Lesson L1.

**How to apply.**

1. For any schema rebuild on a table with FK children, follow the
   canonical pattern from the SQLite docs (sqlite.org/lang_altertable.html
   §7 "Making Other Kinds Of Table Schema Changes"):
    - `PRAGMA foreign_keys=OFF;`
    - `BEGIN TRANSACTION;`
    - Create the new table under a temporary name.
    - Copy data from the old table.
    - Drop the old table.
    - Rename the new table to the old name.
    - Recreate indexes, triggers, views.
    - `PRAGMA foreign_key_check;` — must return zero rows before commit.
    - `COMMIT;`
    - `PRAGMA foreign_keys=ON;`
2. Renaming a *child* table is safe across all SQLite versions because
   nothing else holds an FK pointing at it. Renames of childless tables
   are also fine.
3. Every migration script that rebuilds a parent table includes a
   comment naming this practice and the retro that produced it, so the
   pattern is discoverable at the call site.
4. Reed owns schema migrations. Cairn checks at review.

**Status:** accepted (2026-04-25). Provenance: background-processing
retro, Bug A. Single-incident rule (no Rule of Two needed): the cost of
re-learning is a prod migration recovery, which is too expensive to wait
for a second occurrence.

---

## 11. Privileged-config changes are operator-applied

**Statement.** Changes to privileged configuration — sudoers, systemd
unit installs, package installs, anything requiring root on the
target host — are applied by the operator running `server-setup.sh`
(or the equivalent privileged script), never by `deploy.sh`.
`deploy.sh`'s contract is **code only**: rsync the application code
and the unprivileged scripts; restart only services whose new
configuration is already live; never assume new privileges exist.

**Why.** Phase 5 of the background-processing rollout extended
`server-setup.sh` with a sudoers entry granting NOPASSWD systemctl
verbs for `lifeplan-worker`, so that `deploy.sh` could restart the
worker without prompting. The script was not re-run on prod after the
deploy. `deploy.sh`'s restart line had no privilege; it failed silently
(see practice §12 follow-up); prod ran old code for ~3 hours.
Provenance: [`docs/retrospectives/2026-04-25-background-processing.md`](../retrospectives/2026-04-25-background-processing.md),
Bug C and Lesson L3.

**How to apply.**

- **deploy.sh contract:** rsync code, restart application services
  (`lifeplan`), restart unprivileged worker daemons whose units are
  already installed and whose privileges already exist. Never install
  units. Never modify sudoers. Never `apt install`. Never `cp`
  anything into `/etc/`.
- **server-setup.sh contract:** install / update privileged config.
  Idempotent. Re-runnable. Operator runs it explicitly when the diff
  touches privileged surfaces; the runbook for that operation is
  `docs/runbooks/remote-sudo.md`.
- **Diff-time signal:** any commit that modifies `server-setup.sh`
  must include in its commit message the explicit operator instruction
  "re-run `server-setup.sh` on prod after deploy lands." Cairn enforces
  at review.
- **Forge's lane:** Forge owns both scripts and is responsible for
  keeping the contracts honest. If a deploy.sh feature would require
  new privileges, Forge moves the install half into server-setup.sh
  and the apply half into the operator runbook before adding the
  deploy.sh feature.

**Status:** accepted (2026-04-25). Provenance: background-processing
retro, Bug C. Single-incident rule (3-hour prod stale-code window
established the cost).

---

## 12. Deploys do not include uncommitted work

**Statement.** `deploy.sh` refuses to deploy when the working tree is
non-empty. The check is `git status --porcelain`; non-empty output
aborts the deploy with a clear error naming the dirty paths.

**Why.** `deploy.sh` rsyncs the working tree, not the committed state.
Phase 5 of the background-processing rollout accidentally rsynced
uncommitted Vault and Lumen changes to prod alongside Forge's
committed Phase 5 changes. The mismatch between "what's in git" and
"what's on prod" defeated bisect-and-revert. Provenance:
[`docs/retrospectives/2026-04-25-background-processing.md`](../retrospectives/2026-04-25-background-processing.md),
Lesson L5.

**How to apply.**

- The guard lives in `deploy.sh`, not in Atlas's discipline. A
  script-level check is enforceable; a persona-level rule is a vibe.
- Top of `deploy.sh` (after `set -euo pipefail`):

  ```sh
  if [ -n "$(git status --porcelain)" ]; then
    echo "deploy.sh: working tree is dirty; commit or stash before deploying" >&2
    git status --short >&2
    exit 1
  fi
  ```

- Override is permitted only via an explicit `LIFEPLAN_DEPLOY_DIRTY=1`
  environment variable, used **only** during a controlled emergency
  rollback. The override is not muscle memory; using it logs a warning
  to chat at the next review.
- Forge owns the script change as a queued ticket out of the
  background-processing retro. The practice is in force from this
  retro's date; the script-level enforcement lands when the ticket
  closes.

**Status:** accepted (2026-04-25). Provenance: background-processing
retro, Lesson L5. Sister practice to §3 (commit cadence): §3 is "commit
often"; §12 is "the deploy enforces the result."

---

## 13. Pinned target versions for load-bearing dependencies

**Statement.** Every load-bearing runtime dependency the app links
against — Python, SQLite, OpenSSL, and any future addition — has a
documented target version in
[`docs/runbooks/target-versions.md`](../runbooks/target-versions.md)
(Forge is writing this runbook in parallel). Local and prod must both
satisfy the target. The runbook's one-liner equivalence check is the
source of truth. When the equivalence check disagrees between
environments, **deploy is blocked** until alignment is restored. New
runtime dependencies require a documented target in the runbook before
they ship.

**Why.** Two version-skew bugs cost real engineering time and shipped
bugs to prod:

- Cookie-auth: Apple system Python lacked `hashlib.scrypt`, forcing a
  launchd plist edit out-of-lane (cookie-auth retro, Lesson L5).
- Background-processing: Ubuntu's older SQLite handled FK rewrites on
  parent-rename differently than local's modern SQLite, producing 19
  prod FK violations and a hot-fix migration
  ([background-processing retro](../retrospectives/2026-04-25-background-processing.md),
  Bug A).

Cam's directive (this conversation, 2026-04-23): *"if local and server
software versions are out of sync, that's something we should probably
address directly rather than forcing the team to jump through hoops in
code to get around it."* Pinning at the env level beats coding around
skew at the app or test layer. This practice replaces the queued
follow-up from the background-processing retro that would have added a
`sqlite_version()` assertion to the e2e gate (cancelled — see
retro Lesson L2).

**How to apply.**

- **Forge** owns the alignment work and the
  [`docs/runbooks/target-versions.md`](../runbooks/target-versions.md)
  runbook. Forge is responsible for the equivalence-check one-liner and
  for keeping local and prod in sync.
- **Atlas** runs the equivalence check before any deploy if more than
  ~one week has elapsed since the last check. If the check reports a
  mismatch, deploy is blocked and the work is routed to Forge for
  alignment.
- **Probe** treats the equivalence check as a precondition in the
  go/no-go runbook (see
  [`docs/runbooks/probe-go-no-go.md`](../runbooks/probe-go-no-go.md)).
- **New dependencies:** any persona introducing a new runtime
  dependency (a new `apt`/`brew`-installed package the app links
  against, a new system library) writes the target into the runbook
  before the dependency ships. No "we'll document it later."

**Provenance.**

- Cam's directive, this conversation (2026-04-23).
- [Cookie-auth retro](../retrospectives/2026-04-25-cookie-auth.md),
  Lesson L5 (Apple Python missing `scrypt`).
- [Background-processing retro](../retrospectives/2026-04-25-background-processing.md),
  Bug A and Lesson L2 (SQLite FK-rewrite skew).

**Status:** accepted (2026-04-23). Single-directive rule from Cam
(supersedes Rule of Two): a standing directive lands accepted, not
proposed.

---

## Practice lifecycle

- **proposed:** entered on a single piece of evidence, awaiting a second
  occurrence or explicit Cam acceptance.
- **accepted:** in force. Personas are responsible for following it.
  Violations show up at Cairn's review.
- **deprecated:** kept in the file, marked clearly, with a pointer to the
  superseding practice or a note explaining why it aged out. Never deleted.

## Queued audits

Items below are not practices yet — they are flagged questions awaiting a
second occurrence or accumulated evidence before a deeper revisit. Reed owns
when picked up; Cairn owns the queue.

- **Person model audit — should `person_mention` and `person_new` extraction
  types unify?** Today the LLM emits two item types; an unmatched
  `person_mention` was a no-op on approval until the 2026-04-23 fix that
  routes unmatched mentions through the `person_new` create-path. Revisit
  after ~20 production brain dumps reveal the mention/new split in practice.
  Trigger to pull forward: noisy duplicate people from common nouns ("mum",
  "boss"), OR a second case where approval semantics surprise Cam. Source:
  brain dump #32, "i need to pay back mum" produced an approved
  `person_mention` with `person_id: null` and no row in `people`.

- **`_auto_create_item` status-truthfulness audit (Vault + Reed joint).**
  Today `status=auto_created` is set upstream of `_auto_create_item`, so any
  branch that silently returns `None` leaves a row claiming `auto_created`
  with `created_id=null` — a lie by construction. Person_mention (2026-04-23)
  and tag/goal_link (this session) were patched per-branch; the contract
  itself is still wrong. Audit shape: every branch in `_auto_create_item`,
  enforce the invariant "status reflects post-call reality" — either set
  status after return, or have the function raise on drop and the caller
  mark `failed` (or a new `dropped` state). Coordinate with Reed on the
  status enum if a new state is needed. Trigger to pull forward: any third
  occurrence of an auto_create branch silently dropping, OR Reed surfacing
  a second status-vs-reality mismatch in any UI. Source: production scan
  2026-04-23 (3 dropped items across 7 dumps; tag and goal_link branches
  hold the same fall-through hazard person_mention had).
