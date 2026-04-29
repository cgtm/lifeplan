---
title: Runtime assets audit — 2026-04-29
status: accepted
owner: Forge
date: 2026-04-29
runbook: docs/runbooks/runtime-assets.md
---

# Runtime assets audit — 2026-04-29

## Scope

Walk the audit recipe in `docs/runbooks/runtime-assets.md` over `app/` and verify every runtime disk read (outside `data/`) is reachable from `deploy.sh`'s sync set.

Sync set (per `deploy.sh` at HEAD):
- `app/` (subtree, minus `__pycache__`, `*.pyc`)
- `scripts/` (subtree)
- `ops/` (subtree)
- `docs/user-guide.md` (single file)

Grep run (from runbook step 1):

```sh
grep -rn -E "open\(|Path\(|\.read_text\(|\.read_bytes\(|send_from_directory|FileResponse|StaticFiles" \
  app/ --include="*.py" | grep -vE "test_|/tests/|__pycache__"
```

Plus a follow-up pass for path stitching:

```sh
grep -rn -E "__file__|os\.path\.dirname|BASE_DIR|REPO_ROOT" \
  app/ --include="*.py" | grep -vE "test_|/tests/|__pycache__"
```

## Inventory

| # | file:line | Path read (resolved, repo-relative) | Reachable from sync set? |
|---|---|---|---|
| 1 | `app/server.py:117` | `app/` (directory served by `SimpleHTTPRequestHandler` — `index.html`, `app.js`, `styles.css`, `manifest.json`, `icon-*.png`, `apple-touch-icon.png`, `icon.svg`) | tick — `app/` synced |
| 2 | `app/server.py:658-660` (`_serve_user_guide`) | `docs/user-guide.md` | tick — explicitly named in `deploy.sh` |
| 3 | `app/server.py:679-680` (`_serve_login_page`) | `app/login.html` | tick — `app/` synced |
| 4 | `app/auth.py:68,74` (`_load_env`) | `.env` (repo root) | n/a — secrets file, deliberately not in repo; provisioned on the host out-of-band. Not a runtime *asset* in the runbook sense (the runbook's class of bug is "shipped code reads a file the deploy didn't ship"; `.env` is intentionally not shipped). |
| 5 | `app/db.py:23,36` (`_load_env`) | `.env` (repo root) | n/a — same rationale as #4. |

### Exclusions (per runbook)

Excluded from inventory because they are not disk reads of runtime assets:

- `urllib.request.urlopen(...)` in `app/db.py:87`, `app/processing.py:1373`, `app/generate_prompts.py:545` — HTTP, not disk.
- `data/lifeplan.db` reads via sqlite3 — runbook explicitly excludes the DB.
- `sys.path.insert(...)` in `app/server.py:22` and `app/generate_prompts.py:23` — module resolution, not file read.

## Gaps

None.

The single explicit-file sync (`docs/user-guide.md`) covers the only runtime read outside an already-synced subtree. Everything else either lives under `app/` (which `rsync -avz --delete` covers in full) or is `.env`, which is out of scope by design.

### Note on `.env`

`.env` is read at startup by both `app/auth.py` and `app/db.py`. It is **deliberately not in the repo** and **must not be added to the sync set** — secrets stay on the host. If the file ever goes missing on prod, both modules degrade gracefully (`FileNotFoundError` is caught and ignored), but auth and Mistral fallback would silently lose their config. That's a host-provisioning concern, not a deploy.sh concern. Out of scope for this audit; flagging only so it's documented somewhere.

## Coverage summary

| Verdict | Count |
|---|---|
| tick (covered) | 3 |
| cross (gap) | 0 |
| n/a (out of scope: secrets) | 2 |

Total runtime reads inventoried: 5. Genuine gaps: 0.

## Conclusion

Clean. The `docs/user-guide.md` gap that prompted Practice §14 was the only one in flight; no already-shipped code is reading a file the deploy doesn't sync.

No deploy.sh changes made. No follow-up dispatch needed.
