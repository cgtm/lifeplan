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

## Practice lifecycle

- **proposed:** entered on a single piece of evidence, awaiting a second
  occurrence or explicit Cam acceptance.
- **accepted:** in force. Personas are responsible for following it.
  Violations show up at Cairn's review.
- **deprecated:** kept in the file, marked clearly, with a pointer to the
  superseding practice or a note explaining why it aged out. Never deleted.
