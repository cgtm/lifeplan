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
# and re-validates with visudo.

set -euo pipefail

SUDOERS_FILE="/etc/sudoers.d/lifeplan"
APP_USER="your-user"

echo "==> installing $SUDOERS_FILE"

# Write to a temp file first, validate with visudo, then move into place.
# This is the safe pattern: a syntactically broken sudoers can lock you out
# of sudo entirely, so we never write directly to /etc/sudoers.d/.
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

cat > "$TMP" <<'SUDOERS'
# Allow your-user to restart the lifeplan service + worker without a password.
# Installed by scripts/install-sudoers.sh. Keep verbs in sync with deploy.sh.
your-user ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart lifeplan, /usr/bin/systemctl stop lifeplan, /usr/bin/systemctl start lifeplan, /usr/bin/systemctl status lifeplan, /usr/bin/systemctl restart lifeplan-worker, /usr/bin/systemctl stop lifeplan-worker, /usr/bin/systemctl start lifeplan-worker, /usr/bin/systemctl status lifeplan-worker
SUDOERS

# Validate before installing -- visudo -c -f rejects syntactically bad files.
sudo visudo -c -f "$TMP" >/dev/null
echo "    syntax: ok"

sudo install -o root -g root -m 0440 "$TMP" "$SUDOERS_FILE"
echo "    installed: $SUDOERS_FILE (mode 0440, owner root)"

# Verify the kernel-side sudoers cache picks it up by running the exact
# non-interactive check deploy.sh will use. -n makes sudo fail loudly
# instead of prompting if the entry isn't honoured.
echo ""
echo "==> verifying with: sudo -n systemctl status lifeplan-worker"
if sudo -n systemctl status lifeplan-worker --no-pager >/dev/null 2>&1; then
    echo "    OK -- passwordless sudo for lifeplan-worker is working"
else
    echo "    FAIL -- sudo -n still prompts. Inspect $SUDOERS_FILE and re-run."
    exit 1
fi

echo ""
echo "==> done. Future deploys will not prompt for a password."
