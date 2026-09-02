#!/usr/bin/env bash
# server-setup.sh -- configure lifeplan on a droplet that already has nginx + TLS in place.
#
# This is NOT from-scratch droplet provisioning. It assumes the surrounding
# infrastructure already exists and only wires lifeplan into it.
#
# Preconditions (must be true before this script runs):
#   - Ubuntu droplet with sudo access for the running user
#   - nginx installed, with /etc/nginx/sites-available/<your-domain> present
#     and already TLS-configured (certbot/Let's Encrypt cert issued and
#     renewing)
#   - Python 3.10+ available as /usr/bin/python3
#   - The app system user (matching SERVER_USER in deploy.conf) exists
#   - App files already rsynced to the staging dir, including deploy.conf
#     (copy deploy.conf alongside this script -- see deploy.conf.example)
#
# Usage: sudo bash <staging-dir>/server-setup.sh
#
# What this script does (idempotent where it can be):
#   1. Moves the app to $APP_DIR (owned by the app user)
#   2. Creates the systemd service
#   3. Installs the canonical nginx vhost + authzone fragment from ops/nginx/
#   4. Sets up daily SQLite backup cron
#   5. Installs the deploy sudoers rule and verifies cookie-auth env vars

set -euo pipefail

# Resolve the directory this script lives in so we can find sibling ops/ and
# deploy.conf files.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Load real server details from deploy.conf (gitignored) ───────
DEPLOY_CONF="$SCRIPT_DIR/deploy.conf"
if [[ ! -f "$DEPLOY_CONF" ]]; then
    echo "ERROR: $DEPLOY_CONF not found."
    echo "Copy deploy.conf.example to deploy.conf (with your real server details)"
    echo "onto the droplet alongside this script, then re-run."
    exit 1
fi
# shellcheck source=/dev/null
source "$DEPLOY_CONF"
: "${SERVER_HOST:?SERVER_HOST not set in deploy.conf}"
: "${SERVER_USER:?SERVER_USER not set in deploy.conf}"
: "${REMOTE_BASE:?REMOTE_BASE not set in deploy.conf}"

APP_USER="$SERVER_USER"
APP_DIR="$REMOTE_BASE"
STAGING_DIR="/home/$APP_USER/lifeplan-staging"
NGINX_CONF="/etc/nginx/sites-available/$SERVER_HOST"
NGINX_AUTHZONE_CONF="/etc/nginx/conf.d/authzone.conf"
BACKUP_DIR="$REMOTE_BASE/backups"

NGINX_SRC_SITE="$SCRIPT_DIR/ops/nginx/lifeplan.conf.example"
NGINX_SRC_AUTHZONE="$SCRIPT_DIR/ops/nginx/authzone.conf"
SYSTEMD_SRC_DIR="$SCRIPT_DIR/ops/systemd"

echo "==> lifeplan server setup"
echo ""

# ── 0. Install sqlite3 CLI if needed ────────────────────────────
if ! command -v sqlite3 &>/dev/null; then
    echo "--- installing sqlite3 CLI ---"
    apt-get update -qq && apt-get install -y -qq sqlite3
    echo "    done"
fi

# ── 1. Create /opt/lifeplan and copy files from staging ──────────
echo "--- setting up $APP_DIR ---"
mkdir -p "$APP_DIR/app" "$APP_DIR/data" "$BACKUP_DIR"

# Copy staged files if they exist
if [ -d "$STAGING_DIR/app" ]; then
    cp -a "$STAGING_DIR/app/"* "$APP_DIR/app/"
    echo "    app files copied"
fi
if [ -f "$STAGING_DIR/data/lifeplan.db" ]; then
    cp -a "$STAGING_DIR/data/lifeplan.db" "$APP_DIR/data/"
    echo "    database copied"
fi
if [ -f "$STAGING_DIR/.env" ]; then
    cp -a "$STAGING_DIR/.env" "$APP_DIR/.env"
    echo "    .env copied"
fi

chown -R "$APP_USER:$APP_USER" "$APP_DIR"
echo "    ownership set to $APP_USER"

# ── 2. Systemd service ──────────────────────────────────────────
echo ""
echo "--- creating systemd service ---"
cat > /etc/systemd/system/lifeplan.service <<UNIT
[Unit]
Description=lifeplan personal knowledge app
After=network.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/python3 -m app.server
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=lifeplan

# Hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$APP_DIR/data
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable lifeplan
echo "    service created and enabled"

# ── 2b. Background worker + prompt-generation timer ──────────────
# Source of truth: ops/systemd/. We cp -f every time so a re-run picks up
# any edits to the unit files in the repo.
echo ""
echo "--- installing background worker + prompt timer ---"
for unit in lifeplan-worker.service lifeplan-prompts.service lifeplan-prompts.timer; do
    src="$SYSTEMD_SRC_DIR/$unit"
    if [ ! -f "$src" ]; then
        echo "    ERROR: missing $src"
        echo "    Make sure the staging dir has the full repo, including ops/systemd/."
        exit 1
    fi
    cp -f "$src" "/etc/systemd/system/$unit"
    # ops/systemd/*.service ship with placeholder User=/Group=/paths; rewrite
    # to the real values from deploy.conf so the unit runs as the right user.
    sed -i "s/^User=.*/User=$APP_USER/; s/^Group=.*/Group=$APP_USER/; s#/opt/lifeplan#$APP_DIR#g" "/etc/systemd/system/$unit"
    chmod 0644 "/etc/systemd/system/$unit"
    echo "    installed /etc/systemd/system/$unit"
done

systemctl daemon-reload
# Worker is long-running -- enable + start. The prompts timer drives the
# oneshot service, so enable + start the timer (NOT the .service directly).
systemctl enable --now lifeplan-worker.service
systemctl enable --now lifeplan-prompts.timer
echo "    lifeplan-worker enabled + started"
echo "    lifeplan-prompts.timer enabled + started (next run: $(systemctl list-timers lifeplan-prompts.timer --no-pager | awk 'NR==2 {print $1, $2}'))"

# ── 3. Nginx vhost + authzone ────────────────────────────────────
# Ship the canonical nginx config from the repo rather than building it inline.
# Source of truth: ops/nginx/lifeplan.conf.example and ops/nginx/authzone.conf.
echo ""
echo "--- configuring nginx ---"

# Sanity-check the source files are present in this checkout.
for src in "$NGINX_SRC_SITE" "$NGINX_SRC_AUTHZONE"; do
    if [ ! -f "$src" ]; then
        echo "    ERROR: missing $src"
        echo "    Make sure the staging dir has the full repo, including ops/nginx/."
        exit 1
    fi
done

# 3a. http{}-context fragment: limit_req_zone authzone definition.
# /etc/nginx/conf.d/*.conf is auto-included from the http{} block, which is
# exactly where limit_req_zone needs to live. Leave any existing copy alone
# unless the contents differ, in which case overwrite (and back up first).
if [ ! -f "$NGINX_AUTHZONE_CONF" ]; then
    cp "$NGINX_SRC_AUTHZONE" "$NGINX_AUTHZONE_CONF"
    chmod 0644 "$NGINX_AUTHZONE_CONF"
    echo "    installed $NGINX_AUTHZONE_CONF"
elif cmp -s "$NGINX_SRC_AUTHZONE" "$NGINX_AUTHZONE_CONF"; then
    echo "    $NGINX_AUTHZONE_CONF already up to date"
else
    cp -a "$NGINX_AUTHZONE_CONF" "$NGINX_AUTHZONE_CONF.bak.$(date +%Y%m%d-%H%M%S)"
    cp "$NGINX_SRC_AUTHZONE" "$NGINX_AUTHZONE_CONF"
    chmod 0644 "$NGINX_AUTHZONE_CONF"
    echo "    updated $NGINX_AUTHZONE_CONF (previous version backed up)"
fi

# 3b. Site config: drop in the canonical vhost, with the placeholder domain
# in ops/nginx/lifeplan.conf.example substituted for the real SERVER_HOST.
# If the rendered result is byte-identical to what's live, skip. Otherwise
# back up and overwrite.
RENDERED_SITE="$(mktemp)"
trap 'rm -f "$RENDERED_SITE"' EXIT
sed "s/your-domain\.example/$SERVER_HOST/g" "$NGINX_SRC_SITE" > "$RENDERED_SITE"

if [ -f "$NGINX_CONF" ] && cmp -s "$RENDERED_SITE" "$NGINX_CONF"; then
    echo "    $NGINX_CONF already up to date"
else
    if [ -f "$NGINX_CONF" ]; then
        cp -a "$NGINX_CONF" "$NGINX_CONF.bak.$(date +%Y%m%d-%H%M%S)"
        echo "    backed up existing $NGINX_CONF"
    fi
    cp "$RENDERED_SITE" "$NGINX_CONF"
    chmod 0644 "$NGINX_CONF"
    echo "    installed $NGINX_CONF (rendered from $NGINX_SRC_SITE)"
fi

# Make sure the site is enabled (idempotent symlink).
if [ ! -L "/etc/nginx/sites-enabled/$SERVER_HOST" ]; then
    ln -s "$NGINX_CONF" "/etc/nginx/sites-enabled/$SERVER_HOST"
    echo "    enabled $SERVER_HOST site"
fi

# 3c. Validate and reload.
nginx -t 2>&1
systemctl reload nginx
echo "    nginx reloaded"

# ── 4. Backup cron job ───────────────────────────────────────────
echo ""
echo "--- setting up daily backup cron ---"

BACKUP_SCRIPT="$APP_DIR/backup.sh"
cat > "$BACKUP_SCRIPT" <<BSCRIPT
#!/usr/bin/env bash
# Daily SQLite backup for lifeplan
set -euo pipefail

DB="$APP_DIR/data/lifeplan.db"
BACKUP_DIR="$APP_DIR/backups"
DATE=\$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="\$BACKUP_DIR/lifeplan-\$DATE.db"

# Use SQLite .backup command for a safe, consistent backup
sqlite3 "\$DB" ".backup '\$BACKUP_FILE'"

# Keep only the last 14 backups
ls -t "\$BACKUP_DIR"/lifeplan-*.db 2>/dev/null | tail -n +15 | xargs -r rm --

echo "\$(date): backup complete -> \$BACKUP_FILE"
BSCRIPT

chmod +x "$BACKUP_SCRIPT"
chown "$APP_USER:$APP_USER" "$BACKUP_SCRIPT"

# Install cron job for the app user (daily at 03:00)
CRON_LINE="0 3 * * * $APP_DIR/backup.sh >> $APP_DIR/backups/backup.log 2>&1"
(crontab -u "$APP_USER" -l 2>/dev/null | grep -v "lifeplan/backup.sh"; echo "$CRON_LINE") | crontab -u "$APP_USER" -

echo "    backup cron installed (daily at 03:00 UTC)"

# ── 5. Server README ────────────────────────────────────────────
echo ""
echo "--- writing $APP_DIR/SETUP.md ---"
cat > "$APP_DIR/SETUP.md" <<README
# lifeplan -- server setup notes

## What's running
- **App**: Python 3 HTTP server on port 3131 (localhost only)
- **Service**: systemd unit \`lifeplan.service\`
- **Proxy**: nginx reverse proxy at /lifeplan, public internet, rate-limited (limit_req zone=authzone)
- **Auth**: app-level cookie session auth (no nginx auth_basic). Configured via env vars in $APP_DIR/.env
- **Backups**: daily SQLite backup at 03:00 UTC, 14-day retention

## File layout
- \`$APP_DIR/app/\`       -- application code
- \`$APP_DIR/data/\`      -- SQLite database
- \`$APP_DIR/backups/\`   -- daily database backups
- \`$APP_DIR/.env\`       -- environment variables (API keys, Ollama URL, cookie auth secrets)
- \`$APP_DIR/backup.sh\`  -- backup script

## Auth env vars (required in $APP_DIR/.env, mode 600)
- \`LIFEPLAN_PASSWORD_HASH\`   -- generated by \`python3 -m app.auth set-password\`
- \`LIFEPLAN_AUTH_SALT\`       -- generated by \`python3 -m app.auth set-password\`
- \`LIFEPLAN_SESSION_SECRET\`  -- random secret used to sign session cookies
- \`LIFEPLAN_COOKIE_PATH=/lifeplan\` -- scope cookie to the proxied path

## Common commands
\`\`\`
sudo systemctl status lifeplan     # check status
sudo systemctl restart lifeplan    # restart after deploy
journalctl -u lifeplan -n 50      # view recent logs
sudo nginx -t && sudo systemctl reload nginx  # test and reload nginx
\`\`\`

## Redeploy
From your Mac: \`./deploy.sh\` in the lifeplan directory.

## Access
Public internet, gated by app-level cookie session auth: https://$SERVER_HOST/lifeplan
README

chown "$APP_USER:$APP_USER" "$APP_DIR/SETUP.md"

# ── 6. Sudoers rule for passwordless service restart ─────────────
# Source of truth: scripts/install-sudoers.sh. We inline the same content
# here (server-setup.sh already runs as root via `sudo bash`) to keep this
# script self-contained, but the standalone install-sudoers.sh is the
# operator-applied path for fixing prod without re-running everything.
echo ""
echo "--- setting up sudoers for deploy ---"
cat > /etc/sudoers.d/lifeplan <<SUDOERS
# Allow $APP_USER to manage the lifeplan service + worker without a password.
# Keep verbs in sync with scripts/install-sudoers.sh and deploy.sh.
# sudoers matches args positionally and exactly: each form deploy.sh or
# the runbooks invoke must be listed (no globs -- minimal grant).
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
chmod 0440 /etc/sudoers.d/lifeplan
visudo -c -f /etc/sudoers.d/lifeplan
echo "    sudoers rule installed"

# ── 7. Auth env var check ────────────────────────────────────────
echo ""
echo "--- checking auth env vars in $APP_DIR/.env ---"
ENV_FILE="$APP_DIR/.env"
MISSING_VARS=()
if [ -f "$ENV_FILE" ]; then
    chmod 600 "$ENV_FILE"
    chown "$APP_USER:$APP_USER" "$ENV_FILE"
    for var in LIFEPLAN_PASSWORD_HASH LIFEPLAN_AUTH_SALT LIFEPLAN_SESSION_SECRET LIFEPLAN_COOKIE_PATH; do
        if ! grep -q "^${var}=" "$ENV_FILE"; then
            MISSING_VARS+=("$var")
        fi
    done
else
    echo "    NOTE: $ENV_FILE does not exist yet -- create it (mode 600, owner $APP_USER)"
    MISSING_VARS=(LIFEPLAN_PASSWORD_HASH LIFEPLAN_AUTH_SALT LIFEPLAN_SESSION_SECRET LIFEPLAN_COOKIE_PATH)
fi

if [ ${#MISSING_VARS[@]} -gt 0 ]; then
    echo ""
    echo "    !!! Cookie session auth env vars are missing or incomplete:"
    for v in "${MISSING_VARS[@]}"; do
        echo "        - $v"
    done
    echo ""
    echo "    To set them, from the lifeplan repo on your Mac run:"
    echo "        python3 -m app.auth set-password"
    echo "    That prints LIFEPLAN_PASSWORD_HASH and LIFEPLAN_AUTH_SALT lines."
    echo "    Add those plus a random LIFEPLAN_SESSION_SECRET and"
    echo "    LIFEPLAN_COOKIE_PATH=/lifeplan to $ENV_FILE (chmod 600)."
    echo ""
    echo "    Without these, the app will refuse to authenticate any request."
else
    echo "    auth env vars present"
fi

# ── 8. Start the service ─────────────────────────────────────────
echo ""
echo "--- starting lifeplan service ---"
systemctl start lifeplan
sleep 2

STATUS=$(systemctl is-active lifeplan)
if [ "$STATUS" = "active" ]; then
    echo "    service: RUNNING"
    # Quick health check
    HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3131/ || echo "000")
    echo "    http:    $HTTP_CODE"
else
    echo "    service: $STATUS"
    echo "    check logs: journalctl -u lifeplan -n 30"
fi

echo ""
echo "==> setup complete"
echo ""
echo "    App is running at https://$SERVER_HOST/lifeplan (public internet, gated by app-level cookie session auth)"
echo "    Future deploys: run ./deploy.sh from your Mac"
