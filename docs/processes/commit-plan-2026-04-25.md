# Commit Plan — Cookie-Auth Feature & Supporting Work

**Author:** Cairn
**Date:** 2026-04-25 (refreshed)
**Status:** proposal — awaiting Cam's go-ahead. Atlas executes; Cairn does
not run `git commit`.

This refreshes the prior plan to cover everything currently uncommitted,
including: the Vault+Lumen cookie-auth contract, the practice-8 Probe
addition (and pending practice-2 softening), the docs README "Document
statuses" section, the contract-template status-vocab fix, the
`server-setup.sh` rewrite, the `app/server.py` `COOKIE_PATH` /
logging / stub-cleanup pass, the `auth.classify_cookie_failure` change,
the `login.html` comment sharpen, and the consolidated `ops/nginx/`
canonicalisation (with deletion of the stray `ops/your-domain.example.*` snapshots).

Order is bottom-up: research → personas → product/feature → ops → process.
Each commit is self-contained and does not break the build at that point in
history. No AI attribution in any message
(per `feedback_no_claude_attribution`).

---

## Working tree summary (verified `git status`)

```
modified:   CLAUDE.md
modified:   app/README.md
modified:   app/app.js
modified:   app/apple-touch-icon.png
modified:   app/icon-192.png
modified:   app/icon-512.png
modified:   app/index.html
modified:   app/manifest.json
modified:   app/server.py
modified:   app/styles.css
modified:   deploy.sh
modified:   server-setup.sh
modified:   team/lumen.md
deleted:    team-inbox/Current_Reminders_and_To-Dos.csv
deleted:    team-inbox/gpt-export-2026-04-22.md

untracked:  app/auth.py
untracked:  app/contracts/_template.md
untracked:  app/contracts/cookie-auth.md
untracked:  app/login.html
untracked:  docs/README.md
untracked:  docs/processes/team-practices.md
untracked:  docs/processes/commit-plan-2026-04-25.md
untracked:  docs/retrospectives/2026-04-25-cookie-auth.md
untracked:  docs/{architecture,decisions,onboarding,runbooks}/  (empty scaffolds)
untracked:  my-inbox/backend-engineer-research.md
untracked:  my-inbox/qa-engineer-research.md
untracked:  my-inbox/tech-lead-research.md
untracked:  ops/nginx/your-domain.example.conf
untracked:  ops/nginx/authzone.conf
untracked:  team/cairn.md
untracked:  team/probe.md
untracked:  team/vault.md
```

(`ops/your-domain.example.current`, `ops/your-domain.example.current.fresh`, `ops/your-domain.example.new`,
`ops/your-domain.example.cookieauth` were never committed and are now superseded by
`ops/nginx/your-domain.example.conf` — they are not present in the tree, so no
deletion commit is needed.)

---

## Proposed sequence — eleven commits

### 1. Add hire research briefs

**Files:**
- `my-inbox/backend-engineer-research.md`
- `my-inbox/qa-engineer-research.md`
- `my-inbox/tech-lead-research.md`

**Why first.** The persona files reference these in `hired_based_on:`.
Land them first so the references are valid at every later commit.

**Message:**
```
Add research briefs for backend, QA, and tech-lead hires

Sage's research deliverables that informed Nova's persona design for
Vault (backend security), Probe (ship verifier), and Cairn (engineering
practice owner).
```

---

### 2. Hire Vault, Probe, and Cairn

**Files:**
- `team/vault.md`
- `team/probe.md`
- `team/cairn.md`
- `CLAUDE.md` (roster table + engineering-practice section)

**Why.** Three personas land together with the roster updates that make
them addressable. Persona files in their consolidated form (Vault rule
13 / Lumen rule 11 already point at team-practices, which arrives in
commit 11; this is fine because the pointers are textual references,
not load-bearing imports).

**Message:**
```
Hire Vault, Probe, and Cairn

Vault: backend engineer (application and web security), hired for the
cookie-auth feature.
Probe: ship verifier, owns pre-deploy checks across user-facing flows.
Cairn: tech lead (engineering practice owner), hired after the cookie-auth
retro to own retros, runbooks, ADRs, and team-practices.

Roster table and engineering-practice note added to CLAUDE.md.
```

---

### 3. Replace HTTP Basic Auth with cookie session login

**Files:**
- `app/auth.py` (new)
- `app/server.py`
- `app/login.html` (new)
- `app/app.js`
- `app/index.html`
- `app/styles.css`
- `app/manifest.json`
- `app/apple-touch-icon.png`
- `app/icon-192.png`
- `app/icon-512.png`

**Why one commit.** Server auth, login page, mount-aware client paths,
and the PWA assets re-cut for the cookie-auth icon all ship as a single
working unit. Splitting them produces commits that don't run end-to-end:
the server alone has no login UI; the login UI alone has no backend;
the manifest alone references icons it doesn't have. This is the
feature.

Includes the consolidated `app/server.py` work (handler integration,
`COOKIE_PATH` unification, request logging, stub cleanup) and
`auth.classify_cookie_failure` for distinguishing missing-vs-invalid
sessions. `app/login.html` carries sharpened comments documenting why
the page uses browser-native relative URLs rather than the app
bundle's `MOUNT` constant. All client-side URLs in the app bundle are
resolved against `MOUNT`; no root-absolute paths anywhere
user-reachable.

**Message:**
```
Replace HTTP Basic Auth with cookie session login

New auth.py module: scrypt password verification, session-token issue
and validation, CSRF token issuance, mount-aware login URL composition
via auth.login_url(), and classify_cookie_failure() for distinguishing
missing-vs-invalid sessions.

server.py wires the auth check into request handling, issues
mount-aware 302 Location headers, unifies COOKIE_PATH, adds request
logging, and removes pre-auth stub code.

login.html is a self-contained pre-auth page using browser-native
relative URLs against the document base — deliberately decoupled from
the app bundle so the login flow keeps working when the bundle is
broken.

app.js, index.html, styles.css updated for the logout flow and login
affordances. All client URLs in the app bundle resolve against MOUNT.

PWA icons and manifest re-cut for the cookie-auth iOS bookmark.
```

---

### 4. Add cookie-auth contract and contracts template

**Files:**
- `app/contracts/_template.md`
- `app/contracts/cookie-auth.md`

**Why separate.** The contract is a docs artefact, not implementation
code. It's the Vault+Lumen retrospective backfill that establishes the
contract-before-code precedent. Lands after the feature so the
contract reflects what was actually built.

`_template.md` carries the corrected status vocabulary
(`draft / agreed / live / superseded`).

**Message:**
```
Add cross-stack contract template and cookie-auth contract

Template for one-page contracts between server-side and client-side
personas, used by the contract-before-code practice. Status vocabulary:
draft / agreed / live / superseded.

cookie-auth.md is the Vault+Lumen retrospective backfill of the
contract that should have existed before the feature: mount story,
endpoints, redirects, error matrix, cookie semantics, and the
rationale for the two-mechanism mount-aware approach (MOUNT constant
in the app bundle; browser-native relative URLs in the self-contained
login page).
```

---

### 5. Add canonical nginx configs under ops/nginx/

**Files:**
- `ops/nginx/your-domain.example.conf` (new)
- `ops/nginx/authzone.conf` (new)

**Why.** Forge's canonical post-migration nginx state, in a single
namespaced directory. Replaces the unversioned `ops/your-domain.example.*`
snapshots that were never committed.

**Message:**
```
Add canonical nginx configs under ops/nginx/

your-domain.example.conf is the deployed cookie-auth nginx configuration;
authzone.conf carries the auth-zone shared snippets. Replaces the
ad-hoc ops/your-domain.example.* snapshots used during the migration.
```

---

### 6. Rewrite server-setup.sh and refresh deploy.sh banner

**Files:**
- `server-setup.sh`
- `deploy.sh`

**Why grouped.** Both are Forge's first-deploy / per-deploy scripts.
The `server-setup.sh` rewrite (header, `cp`-based nginx install, auth
env-var section) and the `deploy.sh` banner reconciliation (site is
public, not Tailscale-only) belong together — they reconcile the same
false Tailscale premise across both scripts, queued in the cookie-auth
retro.

**Message:**
```
Reconcile server-setup.sh and deploy.sh with reality

server-setup.sh: rewrite the header to drop the false Tailscale-gating
claim, install nginx config via cp from ops/nginx/, and add an auth
environment-variable section covering LIFEPLAN_PASSWORD_HASH and
session-secret provisioning.

deploy.sh: banner now reflects that the site is public, not
Tailscale-gated. Tailscale was never installed; the site has been
public throughout.
```

---

### 7. Update app/README deployment description

**Files:**
- `app/README.md`

**Why separate.** Docs touch, follows the deploy-script reconciliation
so the README and the scripts agree.

**Message:**
```
Update app/README deployment description

Bring the README in line with the rewritten server-setup.sh and the
cookie-auth deployment shape.
```

---

### 8. Remove consumed team-inbox inputs

**Files:**
- `team-inbox/Current_Reminders_and_To-Dos.csv` (deleted)
- `team-inbox/gpt-export-2026-04-22.md` (deleted)

**Why.** Consumed inputs. Keeping team-inbox/ a working queue rather
than an archive is deliberate hygiene.

**Message:**
```
Remove consumed team-inbox inputs

The reminders CSV and the 2026-04-22 GPT export have been processed by
the team. Removing them keeps team-inbox/ a working queue rather than
an archive.
```

---

### 9. Add docs/ tree and README index

**Files:**
- `docs/README.md`
- `docs/architecture/` (empty scaffold; `.gitkeep` if needed)
- `docs/decisions/` (empty scaffold)
- `docs/onboarding/` (empty scaffold)
- `docs/runbooks/` (empty scaffold)

**Why separate from team-practices.** The README and scaffolding are
Cairn's information-architecture commit. team-practices and the retro
are content commits that land into this scaffold. Keeping the
scaffold separate makes the IA commit reviewable on its own and gives
later content commits a clean home.

The README includes the Document statuses section
(`draft / accepted / deprecated` for processes, `draft / agreed /
live / superseded` for contracts).

**Message:**
```
Add docs/ tree and README index

New docs/ tree with README index covering architecture, runbooks,
decisions, onboarding, processes, and retrospectives. README includes
a Document statuses section enumerating the status vocabularies used
across the tree.

Empty subdirectories scaffolded so the IA is in place before content
lands.
```

---

### 10. Add team-practices and cookie-auth retrospective

**Files:**
- `docs/processes/team-practices.md`
- `docs/retrospectives/2026-04-25-cookie-auth.md`
- `team/lumen.md` (rule 11 trimmed to a pointer into team-practices)

**Why grouped.** team-practices is the canonical destination; the
retro is the provenance every practice points back to; Lumen's
persona-file pointer edit is the consolidation half of the
one-rule-one-home principle (Vault's pointer landed in commit 2 in
its consolidated form). Lands together so no commit references a
practice file that doesn't yet exist or carries a duplicate rule.

team-practices includes practice 8 (Probe-verification mandatory) and
the softened practice 2 wording allowing multiple mount-aware
mechanisms when the surface justifies it (referencing
`app/contracts/cookie-auth.md` for rationale).

**Message:**
```
Add team-practices, cookie-auth retro, and consolidate Lumen rule 11

docs/processes/team-practices.md is the canonical source for
cross-persona engineering practices. Initial set: contract-before-code,
mount-aware path handling, commit cadence, retrospective default,
triage every observation, Rule of Two, stay-in-lane handoffs
(proposed), and Probe verification mandatory.

Mount-aware path handling preserves the no-root-absolute invariant
while allowing multiple mount-aware mechanisms when the surface
justifies it (MOUNT constant in the app bundle; browser-native
relative URLs in the self-contained login page).

docs/retrospectives/2026-04-25-cookie-auth.md is a timeline + 5-Whys
retro on the cookie-auth feature with twelve lessons mapped to
artefacts and a queued-artefacts backlog.

team/lumen.md rule 11 is now a one-line pointer into team-practices
per the one-rule-one-home principle. Vault's equivalent landed in the
hire commit in consolidated form.
```

---

### 11. Add commit plan to processes/

**Files:**
- `docs/processes/commit-plan-2026-04-25.md` (this file)

**Why last.** A meta-artefact recording the sequence used. Lands at
the end so the recorded plan matches the actual commit history.

**Message:**
```
Add commit plan for the cookie-auth feature landing

Records the sequence used to land the cookie-auth feature, the three
hires, and the supporting docs/ops/process work as eleven commits.
Kept in-tree so the plan is auditable against the resulting git log.
```

---

## Order of operations summary

```
1.  research briefs                    (my-inbox/)
2.  hires + roster                     (team/{vault,probe,cairn}.md, CLAUDE.md)
3.  cookie-auth feature                (app/auth.py, server.py, login.html,
                                        app.js, index.html, styles.css,
                                        manifest.json, *.png)
4.  contracts/template + cookie-auth   (app/contracts/)
5.  nginx configs                      (ops/nginx/)
6.  server-setup.sh + deploy.sh        (root)
7.  app/README                         (app/README.md)
8.  team-inbox cleanup                 (team-inbox/ deletions)
9.  docs/ scaffold + README            (docs/README.md + empty dirs)
10. team-practices + retro + Lumen     (docs/processes/, retrospectives/,
                                        team/lumen.md)
11. commit plan                        (docs/processes/commit-plan-...)
```

---

## Notes for Atlas

- This is a proposal. Cam approves before any `git commit` runs.
- Eleven commits. Each is self-contained; the working tree at every
  intermediate point is consistent (no commit references a file that
  doesn't yet exist; no commit leaves a duplicate rule alive against
  the one-rule-one-home principle).
- Commit 3 is the largest — the entire cookie-auth feature as one
  unit. This is deliberate: splitting it produces commits that don't
  run end-to-end. If Cam prefers a tighter cut, the natural seam is
  server-side (auth.py + server.py) vs client-side (login.html, app.js,
  index.html, styles.css, manifest, icons), but both halves were built
  against the same contract and ship together.
- Cairn does not run `git commit`. Atlas runs them, with Cam's
  go-ahead, one at a time, in the order above.
