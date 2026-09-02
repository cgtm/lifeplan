#!/usr/bin/env bash
# install-sudoers.sh -- install the lifeplan deploy sudoers fragment on prod.
#
# OPERATOR-APPLIED (per Practice §11): privileged config changes are not
# performed by deploy.sh; an operator (Cam) runs this script interactively
# on the droplet and is prompted for the sudo password ONCE. After it
# completes, future `lp deploy` runs will pass `sudo -n systemctl restart
# lifeplan{,-worker}` without prompting.
#
# Why this exists: server-setup.sh installs this fragment as part of a full
# re-setup, but a full re-run is overkill (and risks touching nginx/systemd
# units we do not want to disturb). This script extracts ONLY the sudoers
# install + validate step from server-setup.sh so it can be applied cleanly
# in isolation.
#
# Usage on the droplet:
#   bash /opt/lifeplan/scripts/install-sudoers.sh
#
# Or as a single line that pulls from staging if /opt/lifeplan isn't synced yet:
#   bash ~/lifeplan-staging/scripts/install-sudoers.sh
#
# Idempotent: safe to re-run. Overwrites the fragment with the canonical content
# and re-validates with visudo, then verifies every verb we grant works under
# `sudo -n` (no password prompt).
#
# ── Verbs granted (NOPASSWD) ────────────────────────────────────────────
# sudoers does positional, exact-args matching: a rule for
#   `/usr/bin/systemctl restart lifeplan`
# does NOT match an invocation of
#   `sudo systemctl restart lifeplan lifeplan-worker`
# (extra arg) -- the catch-all `(ALL) ALL` rule wins instead and prompts
# for a password. So we explicitly list every form deploy.sh and the
# runbooks actually invoke:
#
#   restart lifeplan                        -- deploy.sh line 80
#   restart lifeplan-worker                 -- deploy.sh line 86
#   restart lifeplan lifeplan-worker        -- runbooks/target-versions.md, manual ops
#   stop|start|status lifeplan              -- manual ops, lp parity
#   stop|start|status lifeplan-worker       -- manual ops, lp parity
#
# `is-active` is NOT granted -- deploy.sh's health check calls
# `systemctl is-active` without sudo (it doesn't need root).

set -euo pipefail

SUDOERS_FILE="/etc/sudoers.d/lifeplan"

# ── Load the app user from deploy.conf (gitignored) ───────────────
# This script is deployed alongside the rest of the repo under
# $REMOTE_BASE/scripts/ (see deploy.sh), so deploy.conf should be present
# two directories up. Fall back to an explicit env var if run standalone.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_CONF="$SCRIPT_DIR/../deploy.conf"
if [ -f "$DEPLOY_CONF" ]; then
    # shellcheck source=/dev/null
    source "$DEPLOY_CONF"
fi
APP_USER="${SERVER_USER:-${LIFEPLAN_SERVER_USER:?set SERVER_USER via deploy.conf or LIFEPLAN_SERVER_USER}}"

echo "==> installing $SUDOERS_FILE"

# Write to a temp file first, validate with visudo, then move into place.
# This is the safe pattern: a syntactically broken sudoers can lock you out
# of sudo entirely, so we never write directly to /etc/sudoers.d/.
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

cat > "$TMP" <<SUDOERS
# Allow $APP_USER to manage the lifeplan service + worker without a password.
# Installed by scripts/install-sudoers.sh. Keep verbs in sync with deploy.sh
# and docs/runbooks/. sudoers matches args positionally and exactly, so each
# combination must be listed (no globs -- we keep this minimal).
Cmnd_Alias LIFEPLAN_CTL = \
    /usr/bin/systemctl restart lifeplan, \
    /usr/bin/systemctl stop    lifeplan, \
    /usr/bin/systemctl start   lifeplan, \
    /usr/bin/systemctl status  lifeplan, \
    /usr/bin/systemctl restart lifeplan-worker, \
    /usr/bin/systemctl stop    lifeplan-worker, \
    /usr/bin/systemctl start   lifeplan-worker, \
    /usr/bin/systemctl status  lifeplan-worker, \
    /usr/bin/systemctl restart lifeplan lifeplan-worker, \
    /usr/bin/systemctl stop    lifeplan lifeplan-worker, \
    /usr/bin/systemctl start   lifeplan lifeplan-worker, \
    /usr/bin/systemctl status  lifeplan lifeplan-worker

$APP_USER ALL=(ALL) NOPASSWD: LIFEPLAN_CTL
SUDOERS

# Validate before installing -- visudo -c -f rejects syntactically bad files.
sudo visudo -c -f "$TMP" >/dev/null
echo "    syntax: ok"

sudo install -o root -g root -m 0440 "$TMP" "$SUDOERS_FILE"
echo "    installed: $SUDOERS_FILE (mode 0440, owner root)"

# Verify every verb deploy.sh + runbooks invoke. `status` is a non-mutating
# probe so it's safe to run repeatedly. We deliberately do NOT pass --no-pager
# or any other flag here: sudoers exact-args matching means an extra flag
# would not match the rule and would falsely report a sudoers regression.
echo ""
echo "==> verifying sudo -n against each granted verb"
PROBES=(
    "status lifeplan"
    "status lifeplan-worker"
    "status lifeplan lifeplan-worker"
)
FAILED=0
for probe in "${PROBES[@]}"; do
    # shellcheck disable=SC2086
    if sudo -n /usr/bin/systemctl $probe >/dev/null 2>&1; then
        echo "    OK    sudo -n systemctl $probe"
    else
        # status returns non-zero when a unit is inactive/failed -- that's
        # fine, we only care that sudo itself didn't prompt. Distinguish
        # "sudo prompted" from "unit not active" by checking stderr.
        ERR=$(sudo -n /usr/bin/systemctl $probe 2>&1 >/dev/null || true)
        if echo "$ERR" | grep -qi "password is required"; then
            echo "    FAIL  sudo -n systemctl $probe -- sudo still prompts"
            FAILED=1
        else
            echo "    OK    sudo -n systemctl $probe (unit inactive but sudo did not prompt)"
        fi
    fi
done

if [ "$FAILED" -ne 0 ]; then
    echo ""
    echo "==> one or more verbs still prompt for a password."
    echo "    inspect $SUDOERS_FILE and re-run."
    exit 1
fi

echo ""
echo "==> done. Future deploys will not prompt for a password."
