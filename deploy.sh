#!/usr/bin/env bash
# deploy.sh -- push lifeplan to the DigitalOcean droplet
# Usage: ./deploy.sh          (deploy app files only -- safe default)
#        ./deploy.sh --with-db (app files + overwrite remote db with local)
#        ./deploy.sh --db     (database only)
#
# Prerequisites: server-setup.sh must have been run once on the droplet.
# Idempotent: safe to re-run at any time.
# NOTE: The droplet database is the source of truth. Use --with-db only if
#       you are certain the local db should replace the remote one.

set -euo pipefail

SERVER="your-user@your-domain.example"
REMOTE_BASE="/opt/lifeplan"
LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"

MODE="${1:-code}"

echo "==> lifeplan deploy"
echo "    server:  $SERVER"
echo "    remote:  $REMOTE_BASE"
echo "    mode:    $MODE"
echo ""

# ── Preflight check ─────────────────────────────────────────────
if ! ssh "$SERVER" "test -d $REMOTE_BASE/app"; then
    echo "ERROR: $REMOTE_BASE/app does not exist on the server."
    echo "Run the one-time setup first:"
    echo "  ssh $SERVER"
    echo "  sudo bash ~/lifeplan-staging/server-setup.sh"
    exit 1
fi

# ── Sync app files ───────────────────────────────────────────────
if [[ "$MODE" != "--db" ]]; then
    echo "--- syncing app files ---"
    rsync -avz --delete \
        --exclude='__pycache__' \
        --exclude='*.pyc' \
        "$LOCAL_DIR/app/" \
        "$SERVER:$REMOTE_BASE/app/"
fi

# ── Sync database (only with explicit flag) ──────────────────────
if [[ "$MODE" == "--with-db" || "$MODE" == "--db" ]]; then
    echo ""
    echo "--- syncing database ---"
    rsync -avz \
        "$LOCAL_DIR/data/lifeplan.db" \
        "$SERVER:$REMOTE_BASE/data/lifeplan.db"
fi

# ── Restart the service ──────────────────────────────────────────
echo ""
echo "--- restarting lifeplan service ---"
ssh "$SERVER" "sudo systemctl restart lifeplan"
sleep 2

# ── Health check ─────────────────────────────────────────────────
echo ""
echo "--- health check ---"
STATUS=$(ssh "$SERVER" "systemctl is-active lifeplan")
if [[ "$STATUS" == "active" ]]; then
    echo "    service: RUNNING"
else
    echo "    service: $STATUS"
    echo "    check: ssh $SERVER journalctl -u lifeplan -n 30"
    exit 1
fi

# Quick HTTP check via localhost on the server
HTTP_CODE=$(ssh "$SERVER" "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3131/")
echo "    http:    $HTTP_CODE"

if [[ "$HTTP_CODE" == "200" ]]; then
    echo ""
    echo "==> deploy complete. App is running at https://your-domain.example/lifeplan (public internet, gated by app-level cookie session auth)"
else
    echo "    WARNING: expected 200, got $HTTP_CODE"
    echo "    check: ssh $SERVER journalctl -u lifeplan -n 30"
fi
