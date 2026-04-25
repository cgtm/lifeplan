---
title: Remote sudo on the droplet
status: accepted
owner: Cairn
last_reviewed: 2026-04-23
---

# Remote sudo on the droplet

## Goal
Modify a file on `your-domain.example` safely, whether or not the target path requires `sudo`, without ever depending on a non-interactive `sudo` password prompt.

## Preconditions
- Cam's `your-user` user has key-based SSH to `your-domain.example`.
- `your-user` has `sudo` rights but **with password** — there is no `NOPASSWD` entry, by design. Non-interactive `sudo` will fail with `sudo: a password is required`.
- SSH config aliases (e.g. `ssh your-user`) are set up in `~/.ssh/config`.
- `/opt/lifeplan/` and other `your-user`-owned paths are writable by `your-user` without `sudo`.
- You (the persona) can stage files locally and `scp` them to the droplet. Cam is available to run a single interactive block at the terminal when `sudo` is required.

## Decision tree
Ask one question: **does the target path require `sudo` to write?**

- **Yes** (e.g. `/etc/nginx/...`, `/etc/systemd/...`, anything under `/etc/` or `/usr/`) → use the **staging pattern** (section below). Cam runs the atomic block.
- **No** (e.g. `/opt/lifeplan/.env`, anything under `your-user`'s home, anything `your-user` already owns) → use the **no-sudo pattern**. No human-in-the-loop required.

If unsure, check ownership first:

```sh
ssh your-user 'ls -l <target-path>'
```

If the owner is `your-user` and the mode is writable for the owner, it's no-sudo. Otherwise treat as sudo-required.

---

## Staging pattern (sudo required)

Use this when the live file lives somewhere `your-user` cannot write directly.

### Steps

1. **Produce the new file locally.** Edit, lint, and validate it on your workstation. Do not edit on the droplet.

2. **Copy the staged file to a writable location on the droplet.** `/tmp/` is the canonical staging area:

   ```sh
   scp ./<local-file> your-user:/tmp/<staged-file>
   ```

   Use a name that is unambiguous about what is being staged, e.g. `/tmp/your-domain.example.nginx.new`.

3. **Verify the staged file landed intact.**

   ```sh
   ssh your-user 'ls -l /tmp/<staged-file> && sha256sum /tmp/<staged-file>'
   ```

   Compare the hash against the local file (`shasum -a 256 ./<local-file>` on macOS).

4. **Hand off to Cam.** Send Cam the atomic block below, with placeholders filled in. Cam runs it interactively in their existing `ssh your-user` session so the `sudo` password prompt is satisfied by a real TTY.

### Canonical atomic block

This is the working pattern. It backs up the live file, swaps in the staged file, validates, reloads, and rolls back on failure. Replace `<LIVE_PATH>`, `<STAGED_PATH>`, and the validation/reload commands for the subsystem you are touching (nginx is shown).

```sh
TS=$(date +%Y%m%d-%H%M%S); BAK=<LIVE_PATH>.bak.$TS; \
  sudo cp <LIVE_PATH> "$BAK" \
    && sudo cp <STAGED_PATH> <LIVE_PATH> \
    && sudo nginx -t \
    && sudo systemctl reload nginx \
    && echo "OK -- backup at $BAK" \
    || { echo "FAILED -- rolling back from $BAK"; sudo cp "$BAK" <LIVE_PATH>; sudo nginx -t && sudo systemctl reload nginx; }
```

Placeholders:
- `<LIVE_PATH>` — full path to the file on the droplet, e.g. `/etc/nginx/sites-available/your-domain.example`.
- `<STAGED_PATH>` — full path to the staged copy in `/tmp/`, e.g. `/tmp/your-domain.example.nginx.new`.
- `nginx -t` / `systemctl reload nginx` — replace with the validation and reload commands for whatever subsystem the file belongs to. For systemd unit files, that is `systemd-analyze verify <unit>` and `systemctl daemon-reload && systemctl restart <unit>`. For sshd, `sshd -t` and `systemctl reload ssh`. **Never skip the validation step.**

### What the block guarantees

- Always a backup with a timestamped name before any change.
- Validation runs **before** reload — a syntactically broken config never gets loaded.
- On any failure in the happy path, the original file is restored from the backup and the subsystem is reloaded back to the known-good state.
- The block is one shell statement, so the only way `sudo` is asked for the password is once (or as the policy dictates), in Cam's interactive shell.

5. **Confirm success.** Cam reports back the `OK -- backup at <path>` line. Record the backup path in your notes for this change in case a later rollback is needed.

---

## No-sudo pattern (your-user-owned paths)

Use this when the target file is owned by `your-user` and writable without `sudo`. Example: `/opt/lifeplan/.env`.

### Steps

1. **Produce the new file locally** (same as staging pattern step 1).

2. **`scp` directly to a sibling `.new` file** next to the live file:

   ```sh
   scp ./<local-file> your-user:<LIVE_PATH>.new
   ```

3. **Atomic swap** in a single `ssh` invocation:

   ```sh
   ssh your-user 'mv <LIVE_PATH>.new <LIVE_PATH>'
   ```

   `mv` within the same filesystem is atomic — there is no moment where the file does not exist or is partially written.

4. **Reload the consuming process** if necessary. For `/opt/lifeplan/.env`, that is restarting the lifeplan service. Use the project's existing restart command.

No human-in-the-loop, no `sudo`, no backup file required (the previous version is gone — if you need rollback you must keep the previous copy yourself before running step 3).

---

## Verification

After **either** pattern, verify these in order:

1. **File content.** `ssh your-user 'cat <LIVE_PATH>'` — diff against your local source of truth.
2. **Owner and mode.** `ssh your-user 'ls -l <LIVE_PATH>'` — confirm ownership and permissions match what they were before. The staging pattern preserves them via `cp`; double-check anyway.
3. **Subsystem validation.** Re-run the relevant validator (`nginx -t`, `sshd -t`, `systemd-analyze verify`, etc.) even if the atomic block already did — this protects against a successful swap followed by an unrelated change.
4. **Subsystem health.** `systemctl status <unit>` — `active (running)`, no recent failures.
5. **Live behaviour check.** Curl the affected endpoint, tail the relevant log, or whatever the subsystem-specific smoke check is. The configuration-loaded state and the runtime-behaviour state are not the same thing; check both.

---

## Failure modes and recovery

**`sudo: a password is required`**
Symptom: a non-interactive `ssh your-user 'sudo ...'` invocation prints this and exits non-zero.
Cause: you tried to run `sudo` from outside an interactive shell.
Fix: do not. Stage the change and hand the atomic block to Cam.

**Staged file not present on droplet**
Symptom: atomic block fails at `sudo cp <STAGED_PATH> <LIVE_PATH>` with `No such file or directory`.
Cause: `scp` failed silently, wrong path, or `/tmp/` was cleared.
Fix: re-run step 2 of the staging pattern, then re-verify with the hash check in step 3 before re-running the atomic block. The `&&` chain means the live file has not been touched yet.

**Validation step fails (`nginx -t`, etc.)**
Symptom: atomic block prints `FAILED -- rolling back from <BAK>` and the validator's error.
Cause: the staged file has a syntax or semantic error.
Fix: the rollback already restored the live file and reloaded the subsystem. Read the validator's error message, fix the staged file locally, re-run the staging pattern from step 1.

**Reload fails after a successful validation**
Symptom: `nginx -t` passed but `systemctl reload nginx` returned non-zero.
Cause: usually a runtime issue unrelated to the config (ports in use, permissions, dependent service down).
Fix: the rollback path will restore the file but the reload-of-the-rollback may also fail for the same reason. Investigate `systemctl status` and `journalctl -u <unit>` and resolve the runtime issue before re-attempting.

**Backup file already exists**
Symptom: `sudo cp <LIVE_PATH> "$BAK"` clobbers an existing backup.
Cause: same timestamp from a prior run within the same second (rare) or a prior `BAK` path was hardcoded.
Fix: the timestamp template (`+%Y%m%d-%H%M%S`) makes collisions effectively impossible. If you see this, you have parallel deploys racing — stop, find out why, do not retry blindly.

**Atomic block partially run, terminal closed mid-flight**
Symptom: unclear final state.
Fix: check `ls -l <LIVE_PATH>* | sort` for the most recent `.bak.<timestamp>` and the live file's mtime. Compare hashes against your local file and the backup to determine which version is live. If unclear, restore from the most recent backup explicitly: `sudo cp <BAK> <LIVE_PATH> && sudo nginx -t && sudo systemctl reload nginx`.

---

## Anti-patterns

Do not do any of these.

- **Do not `ssh -t your-user 'sudo ...'`** to try to bypass non-interactive sudo. It is unreliable across SSH configurations and produces inconsistent behaviour for password prompts. The staging pattern is the answer.
- **Do not add `NOPASSWD` entries** in `/etc/sudoers.d/` to make the staging pattern unnecessary. Adopting NOPASSWD is an architectural decision that requires an ADR. The current posture is "passwords for `sudo`, staging pattern for automation" — keep it.
- **Do not `sudoedit`** from a non-interactive context. Same root cause as direct `sudo` over SSH.
- **Do not skip the backup step.** Every change to a sudo-required file produces a timestamped backup. No exceptions, including "this is just a one-character fix."
- **Do not omit `nginx -t` (or the equivalent validator) between `cp` and `reload`.** Reloading an invalid config takes the service down. This has happened on real teams more than once.
- **Do not edit the live file directly on the droplet** with `sudo vim` or `sudoedit`. The whole point of the staging pattern is that the change is reviewed locally and the in-place edit is mechanical.
- **Do not stage multiple changes into one atomic block.** One file, one swap, one validation, one reload. Combining changes hides which one broke.

---

## Provenance

- The cookie-auth session retro: `/Users/cam/dev/personal/lifeplan/docs/retrospectives/2026-04-25-cookie-auth.md`. Forge encountered the non-interactive `sudo` failure mode while staging an nginx config change; the atomic backup-swap-test-rollback block crystallised there.
- Earlier sessions established that `your-user`-owned paths (notably `/opt/lifeplan/.env`) do not require any of this — `scp` + `mv` is enough.
- `NOPASSWD`-for-narrow-commands was discussed in the same session and rejected without an ADR; revisit only via the ADR process if the staging pattern starts costing real time.
