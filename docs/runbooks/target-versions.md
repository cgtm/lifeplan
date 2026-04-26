---
title: Target runtime versions (Python, SQLite, OpenSSL)
status: accepted
owner: Forge
last_reviewed: 2026-04-23
---

# Target runtime versions (Python, SQLite, OpenSSL)

## Goal
Keep the local (macOS) and prod (Ubuntu droplet) Python runtimes close enough that "works on my machine" and "works on the droplet" are the same statement, and document the exact install paths the launchd plists and systemd units expect.

## Target versions

| Component | Local install | Prod install | Floor / pin |
|-----------|---------------|--------------|-------------|
| Python    | `brew install python@3.12` → `/opt/homebrew/opt/python@3.12/bin/python3.12` | `apt install python3.12` → `/usr/bin/python3` (Ubuntu 24.04 LTS default, supported until 2029) | exact: 3.12.x |
| SQLite    | shipped with CPython 3.12 | shipped with CPython 3.12 | floor: ≥ 3.45.0 |
| OpenSSL   | linked into Homebrew Python (OpenSSL 3.x) | linked into apt Python (OpenSSL 3.x) | floor: 3.x — must not be LibreSSL |

### Why floor-not-exact for SQLite

SQLite is statically linked into CPython. Pinning an exact SQLite version would mean either vendoring a build of SQLite or using `pysqlite3-binary` from PyPI — and both routes drag in pip dependencies, which violates Forge rule 6 ("zero pip dependencies, stdlib only"). So we accept whatever SQLite the chosen Python ships against, and we set a floor instead.

The floor is **3.45.0**. That is comfortably above **3.25.0**, which is the version where `ALTER TABLE RENAME` started rewriting foreign-key references inside other tables' DDL. The bug class that bit migration `0001` (FK refs left pointing at the old table name after a rename) is gone above 3.25, and 3.45 gives plenty of headroom. Both Python 3.12 install routes (brew and Ubuntu 24.04 apt) currently ship SQLite well above 3.45.

### Why call out OpenSSL

It is implied by the Python install — neither Homebrew Python nor Ubuntu apt Python is built against LibreSSL on a sane install. We list it so the equivalence check below catches a drift back to LibreSSL (which would happen if anyone ever pointed the launchd plists at Apple's `/usr/bin/python3`, which links LibreSSL on macOS and silently disables `hashlib.scrypt`).

---

## Local install / re-align (macOS)

Run these as Cam, in a terminal. Each command is idempotent.

```sh
brew install python@3.12
```

```sh
cp /Users/cam/dev/personal/lifeplan/ops/launchd/com.cam.lifeplan.plist ~/Library/LaunchAgents/com.cam.lifeplan.plist
cp /Users/cam/dev/personal/lifeplan/ops/launchd/com.cam.lifeplan-worker.plist ~/Library/LaunchAgents/com.cam.lifeplan-worker.plist
cp /Users/cam/dev/personal/lifeplan/ops/launchd/com.cam.lifeplan-prompts.plist ~/Library/LaunchAgents/com.cam.lifeplan-prompts.plist
```

Reload each agent. `bootout` may print "No such process" the first time for a label that was never bootstrapped — that's fine. Use `gui/$(id -u)` as the target so the agent runs in Cam's user session:

```sh
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.cam.lifeplan.plist 2>/dev/null; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cam.lifeplan.plist
```

```sh
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.cam.lifeplan-worker.plist 2>/dev/null; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cam.lifeplan-worker.plist
```

```sh
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.cam.lifeplan-prompts.plist 2>/dev/null; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cam.lifeplan-prompts.plist
```

---

## Prod install / re-align (droplet)

Almost certainly a no-op today — Ubuntu 24.04's default `python3` is already apt-installed Python 3.12. Documented so future-Cam can verify after an OS upgrade.

```sh
ssh your-user "apt list --installed 2>/dev/null | grep -E '^python3\.12/'"
```

If missing (only after an OS upgrade), the install requires sudo and follows the staging pattern in `docs/runbooks/remote-sudo.md`. The actual command Cam runs interactively:

```sh
sudo apt install python3.12
```

The systemd units invoke `/usr/bin/python3`, which on Ubuntu 24.04 is a symlink managed by the python3 package and points at the apt 3.12 binary. We deliberately do not pin a more specific path — the symlink is the supported integration point.

---

## Equivalence check (one-liner)

Runnable on both local and prod. The same line, the same expected fields:

```sh
python3 -c "import sys, sqlite3, ssl, hashlib; print(f'py={sys.version_info.major}.{sys.version_info.minor}', f'sqlite={sqlite3.sqlite_version}', f'ssl={ssl.OPENSSL_VERSION.split()[0]}', f'scrypt={hasattr(hashlib, \"scrypt\")}')"
```

Expected output on both:

```
py=3.12 sqlite=3.45+ ssl=OpenSSL scrypt=True
```

(`sqlite=3.45+` means the printed version starts with `3.45`, `3.46`, etc. — anything `< 3.45` is a fail.)

On macOS, run the same line via the explicit interpreter to confirm what launchd will actually exec:

```sh
/opt/homebrew/opt/python@3.12/bin/python3.12 -c "import sys, sqlite3, ssl, hashlib; print(f'py={sys.version_info.major}.{sys.version_info.minor}', f'sqlite={sqlite3.sqlite_version}', f'ssl={ssl.OPENSSL_VERSION.split()[0]}', f'scrypt={hasattr(hashlib, \"scrypt\")}')"
```

On prod, run it as the service user against the systemd-invoked path:

```sh
ssh your-user "/usr/bin/python3 -c \"import sys, sqlite3, ssl, hashlib; print(f'py={sys.version_info.major}.{sys.version_info.minor}', f'sqlite={sqlite3.sqlite_version}', f'ssl={ssl.OPENSSL_VERSION.split()[0]}', f'scrypt={hasattr(hashlib, \\\"scrypt\\\")}')\""
```

---

## Verification

After install / re-align, in order:

1. **Equivalence check passes on both environments.** Same major.minor, SQLite ≥ 3.45, OpenSSL (not LibreSSL), scrypt present.
2. **launchd agents are loaded with the new interpreter.** On local:
   ```sh
   launchctl print gui/$(id -u)/com.cam.lifeplan | grep -E 'program ='
   launchctl print gui/$(id -u)/com.cam.lifeplan-worker | grep -E 'program ='
   launchctl print gui/$(id -u)/com.cam.lifeplan-prompts | grep -E 'program ='
   ```
   All three should show `/opt/homebrew/opt/python@3.12/bin/python3.12`.
3. **systemd units are healthy.** On prod:
   ```sh
   ssh your-user "systemctl status lifeplan lifeplan-worker lifeplan-prompts.timer --no-pager"
   ```
   `active (running)` for `lifeplan` and `lifeplan-worker`; `active (waiting)` for the timer.
4. **App-level smoke check.** Hit the local UI (browser to the app) and the droplet UI (over Tailscale). A successful login round-trip exercises scrypt and SQLite both, which is the full test of the version-skew bugs that motivated this runbook.

---

## Failure modes and recovery

**`launchctl bootstrap` fails with `Bootstrap failed: 5: Input/output error` (macOS Sequoia+).**
Cause: malformed plist (typo in XML, wrong key name, missing closing tag).
Fix: `plutil -lint ~/Library/LaunchAgents/com.cam.lifeplan-worker.plist`. It will name the offending line. Fix in the repo copy under `ops/launchd/`, re-`cp`, retry the bootstrap.

**`launchctl bootout` returns `No such process`.**
Not a failure — the label wasn't loaded. The `2>/dev/null` in the install commands swallows it. Continue to bootstrap.

**Equivalence check on local prints `ssl=LibreSSL`.**
Cause: the interpreter being run is Apple's `/usr/bin/python3`, not the Homebrew 3.12. Either the plist still points at `/usr/bin/python3`, or the shell's `python3` resolves to it. Re-check the plist `ProgramArguments[0]` and re-bootstrap.

**Equivalence check on local prints `py=3.9` or anything below 3.12.**
Cause: same as above, or `brew install python@3.12` did not run. Run `which -a python3.12 && /opt/homebrew/opt/python@3.12/bin/python3.12 --version`. If the binary is missing, `brew install python@3.12`.

**Equivalence check prints `sqlite=3.x` where `x < 45`.**
Cause: an old Python install lingering on the path. Cross-check the interpreter's actual location with `python3 -c "import sys; print(sys.executable)"`. Replace the offending Python or update the plist `ProgramArguments[0]` to the explicit Homebrew path.

**Prod `apt install python3.12` upgrade breaks something downstream.**
Cause: a minor version bump shifted SQLite or OpenSSL behaviour.
Fix: roll back via `apt install python3.12=<previous-version>`. Find the previous version with `apt-cache madison python3.12`. Then re-run the equivalence check to confirm the rollback restored the prior values.

**Ubuntu OS upgrade silently moves `/usr/bin/python3` to a different minor.**
Cause: the python3 package on a newer Ubuntu LTS may default to 3.13+ in future.
Fix: the equivalence check catches the drift (it'll print `py=3.13`). Decide whether to upgrade the floor or pin the systemd `ExecStart=` to `/usr/bin/python3.12` explicitly (only after confirming the binary still exists on the upgraded box).

---

## When to run

- The first time, immediately after this runbook lands — to bring local launchd agents to the documented interpreter path.
- Whenever bumping the Python target version (e.g. 3.12 → 3.13).
- Whenever bumping the SQLite floor.
- After any "it works on my machine but not on prod" (or vice versa) bug. The equivalence check is the first diagnostic.
- After an Ubuntu LTS upgrade on the droplet.
- After a macOS major upgrade, in case Homebrew's `python@3.12` formula path or symlink layout shifts.

---

## Provenance

- **Forge — Version Alignment Investigation** (this session) — full survey of where local and prod diverged on Python / SQLite / OpenSSL, plus the recommendation that crystallised into this runbook.
- **Background-processing retro** — `/Users/cam/dev/personal/lifeplan/docs/retrospectives/2026-04-25-background-processing.md`. The worker plist and prompts plist were originally pointed at the wrong interpreter; the symptoms surfaced here.
- **Cookie-auth retro** — `/Users/cam/dev/personal/lifeplan/docs/retrospectives/2026-04-25-cookie-auth.md`. The scrypt / LibreSSL incompatibility on Apple Python was discovered while debugging session-cookie auth; that's the bug class this runbook prevents from recurring.
- **ADR / practice (forthcoming)** — Cairn to add an ADR formalising "stdlib-only, exact Python minor pin, SQLite floor". Placeholder: `docs/adr/NNNN-runtime-version-policy.md` (link to be filled when ADR is merged).
