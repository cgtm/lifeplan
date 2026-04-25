# Lifeplan Engineering Docs

This is the canonical home for engineering practice, architecture, and
operational knowledge. Every persona who opens the docs tree should land
here first.

**Owner:** Cairn (Tech Lead).
**Principle:** if it's not written down, it didn't happen.

---

## Sections

### [Architecture](architecture/)
Subsystem primers — one per subsystem, one page each. Answer first,
rationale second, appendix last.

*Sparse for now. Grows as subsystems stabilise.*

### [Runbooks](runbooks/)
Operational how-to. Goal · preconditions · numbered steps · verification ·
failure modes and recovery. Written for the next person.

*Queued (from the cookie-auth retro):*
- `verify-droplet-network-posture.md` — replace banner-reading with real
  checks.
- `remote-sudo.md` — how to do privileged operations on the droplet.
- `deploy-sh-health-check.md` — fix the 401 warning under cookie auth.

### [Decisions](decisions/)
ADRs in Nygard format. Numbered, never edited after acceptance, only
superseded.

*Queued:*
- `0001-http-method-coverage-on-handler-overrides.md` — handler overrides
  must cover GET *and* HEAD.

### [Onboarding](onboarding/)
Per-role primers for new personas joining the team. What to read, in what
order, before taking the first task.

*Sparse. Add as new roles are hired.*

### [Processes](processes/)
Lifecycle and ceremony definitions.

- **[team-practices.md](processes/team-practices.md)** — the canonical
  living document of cross-persona engineering practices. One rule, one
  home. Read this before writing code that crosses persona boundaries.

### [Retrospectives](retrospectives/)
Dated, per-feature. Every feature touching more than one persona ends here.

- **[2026-04-25-cookie-auth.md](retrospectives/2026-04-25-cookie-auth.md)** —
  cookie-session auth, replacing HTTP Basic Auth. Three identical path bugs,
  one false premise, ten lessons mapped to artefacts. First retro under the
  new practice.

---

## Document statuses

Every document in this tree (and in `app/contracts/`) carries a `Status:`
field drawn from a single canonical vocabulary: **`draft | accepted |
deprecated | superseded`**. `draft` means in-progress and not yet binding;
`accepted` means current and authoritative; `deprecated` means kept for
historical reference but no longer to be followed; `superseded` is reserved
for ADRs replaced by a later ADR (which must link back). ADRs may
additionally use `proposed` between draft and accepted, per the Nygard
format. Living indexes (this README, `team-practices.md`) may use
`living document`. Don't invent new values — if the four above don't fit,
raise it with Cairn before adding a fifth.

## How to use this tree

- **Reading order for a new persona:** `processes/team-practices.md` →
  the most recent retrospective → any architecture primer relevant to
  your lane → `onboarding/<your-role>.md` if it exists.
- **When you learn something:** find the right home for it (practice,
  runbook, ADR, retro lesson). Don't leave it in chat.
- **When you find stale material:** flag it. Cairn prunes quarterly, but
  the team flags continuously.

## How this tree grows

Cairn writes most of the material, but every persona contributes:

- Vault and Lumen co-author contracts under `app/contracts/`.
- Forge writes infra runbooks under `runbooks/`.
- Reed writes schema documentation under `architecture/`.
- Probe writes verification checklists under `runbooks/`.
- Cairn owns indexing, consolidation, and retro facilitation.

Provenance matters. Every accepted rule links back to the retro that
produced it.
