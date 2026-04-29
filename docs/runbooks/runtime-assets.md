---
title: Runtime assets — verifying disk reads are in the deploy path
status: accepted
owner: Cairn
last_reviewed: 2026-04-29
---

# Runtime assets — verifying disk reads are in the deploy path

## Goal
Make sure every file the running server reads from disk at request time is present on prod. The class of bug this prevents: works-on-local, breaks-in-prod, silently — Probe's e2e passes locally because the file is there, the prod hit fails only when a real user clicks.

This is the operational companion to [team practice §14](../processes/team-practices.md#14-runtime-asset-reads-require-a-verified-deploysh-sync).

## When to use this runbook

- **Adding a new endpoint or code path** that reads a file outside `data/` at runtime (markdown, JSON, static template, config, manifest, anything the DB does not own). Use the *Adding a new runtime asset* section.
- **Auditing the existing server** for runtime reads that may have shipped without a sync entry. Use the *Audit pattern* section.
- **Reviewing a cross-persona diff** that touches server-side IO. Use the *Review checklist*.

## Definitions

- **Runtime asset.** A file the server reads on a request path (or on startup, when startup data drives request behaviour). Excludes: the SQLite database file under `data/`, log files, anything written by the app at runtime.
- **Sync set.** The set of paths copied to prod by `deploy.sh`'s `rsync` invocations. Today (2026-04-29) the sync set is:
  - `app/` (full subtree, minus `__pycache__`, `*.pyc`)
  - `scripts/` (full subtree)
  - `ops/` (full subtree)
  - `docs/user-guide.md` (single file)
- **Reachable from the sync set.** A path the server reads at runtime is *reachable* if it lives under one of the synced directories or is named explicitly. `app/templates/foo.html` is reachable; `docs/user-guide.md` is reachable; `docs/architecture/foo.md` is **not** reachable.

## Audit pattern (existing server)

Run this when you suspect a runtime-asset gap, or as a periodic sweep.

### Step 1 — Enumerate runtime reads

From the repo root, search server code for disk-read primitives:

```sh
grep -rn -E "open\(|Path\(|\.read_text\(|\.read_bytes\(|send_from_directory|FileResponse|StaticFiles" \
  app/ \
  --include="*.py" \
  | grep -vE "test_|/tests/|__pycache__"
```

Filter the output by hand. You are looking for:

- File paths the server reads on a request (handler functions, dependency injections, startup hooks).
- Skip: writes (`"w"`, `"wb"`), DB connections, log handlers, anything pointing at `data/`.

Record each runtime read as `(handler, path expression, resolved path under repo root)`.

### Step 2 — Verify each path is reachable from the sync set

For each runtime read, check the resolved path against the sync set listed above. Concretely:

```sh
# Example: the user-guide endpoint reads docs/user-guide.md
grep -nE "user-guide|docs/" deploy.sh
```

If the path is **under** a synced directory (`app/`, `scripts/`, `ops/`), it ships. If the path is **explicitly named** in `deploy.sh` (like `docs/user-guide.md`), it ships. Otherwise: **gap found.**

### Step 3 — For each gap, decide

- **Sync the file** by adding a targeted entry to `deploy.sh` (preferred — see *Adding a new runtime asset* below).
- **Move the file** under an already-synced directory (`app/static/`, `app/templates/`).
- **Embed the file** into the app code (small static content can become a Python string).
- **Remove the runtime read** if the asset is dispensable.

Record the decision; do not park the gap silently (team practice §5, *Triage every observation*).

### Step 4 — Verify on prod

After deploying the fix:

```sh
ssh your-user 'ls -l /opt/lifeplan/<path>'
```

The file must be present, owned by `your-user`, readable. Then exercise the user-facing path that triggers the read (open the modal, hit the endpoint) — confirm it does not fall through to the error path.

## Adding a new runtime asset

When your change adds a server-side read of a file outside `data/`:

### Step 1 — Pick the path with deployability in mind

Default to placing the file under a directory already in the sync set:

- **Templates, partials, static text the UI bundles:** under `app/`.
- **Operator-facing scripts the server shells out to:** under `scripts/`.
- **Systemd / nginx / launchd configs the server reads at runtime:** under `ops/` (rare — usually these are read by the OS, not the app).

If the file genuinely belongs outside the sync set (e.g. user-facing markdown that doubles as engineering documentation, like `docs/user-guide.md`), expect to add a targeted sync entry.

### Step 2 — Add the deploy.sh entry

For a single file (preferred — keeps engineering content out of prod):

```sh
echo "--- syncing <name> ---"
ssh "$SERVER" "mkdir -p $REMOTE_BASE/<parent>"
rsync -az \
    "$LOCAL_DIR/<path>" \
    "$SERVER:$REMOTE_BASE/<path>"
```

For a directory subtree, follow the `app/`/`scripts/`/`ops/` pattern in `deploy.sh`. Do **not** blanket-sync `docs/`; the rest of the docs tree is engineering content (retros, audits, ADRs, runbooks) and has no place on prod.

### Step 3 — Document in the PR / dispatch

The PR description (or dispatch report back to Atlas) must include:

1. The path the server now reads at runtime.
2. The matching `rsync` block in `deploy.sh`, quoted.
3. The post-deploy verification one-liner: `ssh your-user 'ls -l /opt/lifeplan/<path>'`.

### Step 4 — Probe regression coverage

Probe writes the regression spec for the endpoint as usual. Note: the spec passing locally does **not** prove prod is fine (that's the whole shape of the bug this runbook prevents). Until we have an e2e shape that runs against prod or a stripped-down mirror (queued audit in team-practices), the deploy.sh sync entry is the only guarantee.

### Step 5 — Verify on prod after deploy

Run the verification one-liner from Step 3. Then exercise the feature end-to-end against prod.

## Review checklist (Cairn / cross-persona reviewer)

When reviewing a diff that touches server-side IO:

- [ ] Did this diff add a `open(...)`, `Path(...).read_*`, `send_from_directory`, `FileResponse`, or equivalent on a request-handling path?
- [ ] If yes: is the path under `app/`, `scripts/`, or `ops/`, or explicitly named in `deploy.sh`?
- [ ] If neither: where is the matching `deploy.sh` change in this PR? (If it's not in this PR, stop the review.)
- [ ] Is the synced path the file specifically, or a parent directory? Prefer the file unless the whole directory is appropriate for prod.
- [ ] Has the post-deploy verification one-liner been run after the next deploy? (Atlas tracks; Cairn confirms at retro.)

## Failure modes and recovery

- **"Could not load X" or HTTP 500 from a handler that reads a file.** Most likely the file is missing on prod. Check `ssh your-user 'ls -l /opt/lifeplan/<path>'`. If absent: add a targeted `deploy.sh` entry (Step 2 above), commit, deploy, verify.
- **File present but stale.** `deploy.sh` re-syncs on every deploy, so a stale file means the file isn't in the sync set even though something else put it there once. Add the proper sync entry; the next deploy will pick up the current version.
- **Prod reads a file that local doesn't have.** Inverted shape, rare. Usually means a persona placed the file directly on prod out-of-lane. Triage as a process violation (lane discipline), then bring the file into the repo and add a sync entry.

## Provenance

- The user-guide-in-prod gap (2026-04-29). Lumen shipped the endpoint, Probe's regression passed locally, prod broke when Cam opened the Help modal. Atlas patched in commit `abee5c7`.
- Team practice §14, *Runtime asset reads require a verified deploy.sh sync*.
