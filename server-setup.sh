#!/usr/bin/env bash
# server-setup.sh -- configure lifeplan on a droplet that already has nginx + TLS in place.
#
# This is NOT from-scratch droplet provisioning. It assumes the surrounding
# infrastructure already exists and only wires lifeplan into it.
#
# Preconditions (must be true before this script runs):
#   - Ubuntu droplet with sudo access for the running user
#   - nginx installed, with /etc/nginx/sites-available/your-domain.example present and
#     already TLS-configured (certbot/Let's Encrypt cert issued and renewing)
#   - Python 3.10+ available as /usr/bin/python3
#   - The your-user:your-user system user exists
#   - App files already rsynced to /home/your-user/lifeplan-staging/
#
# Usage: sudo bash /home/your-user/lifeplan-staging/server-setup.sh
#
# What this script does (idempotent where it can be):
#   1. Moves the app to /opt/lifeplan/ (owned by your-user)
#   2. Creates the systemd service
#   3. Installs the canonical your-domain.example nginx vhost + authzone fragment from ops/nginx/
#   4. Sets up daily SQLite backup cron
#   5. Installs the deploy sudoers rule and verifies cookie-auth env vars

set -euo pipefail

APP_USER="your-user"
APP_DIR="/opt/lifeplan"
STAGING_DIR="/home/$APP_USER/lifeplan-staging"
NGINX_CONF="/etc/nginx/sites-available/your-domain.example"
NGINX_AUTHZONE_CONF="/etc/nginx/conf.d/authzone.conf"
BACKUP_DIR="/opt/lifeplan/backups"

# Resolve the directory this script lives in so we can find sibling ops/ files.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NGINX_SRC_SITE="$SCRIPT_DIR/ops/nginx/your-domain.example.conf"
NGINX_SRC_AUTHZONE="$SCRIPT_DIR/ops/nginx/authzone.conf"

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
cat > /etc/systemd/system/lifeplan.service <<'UNIT'
[Unit]
Description=lifeplan personal knowledge app
After=network.target

[Service]
Type=simple
User=your-user
Group=your-user
WorkingDirectory=/opt/lifeplan
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
ReadWritePaths=/opt/lifeplan/data
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable lifeplan
echo "    service created and enabled"

# ── 3. Nginx vhost + authzone ────────────────────────────────────
# Ship the canonical nginx config from the repo rather than building it inline.
# Source of truth: ops/nginx/your-domain.example.conf and ops/nginx/authzone.conf.
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

# 3b. Site config: drop in the canonical your-domain.example vhost.
# If the existing file is byte-identical, skip. Otherwise back up and overwrite.
if [ -f "$NGINX_CONF" ] && cmp -s "$NGINX_SRC_SITE" "$NGINX_CONF"; then
    echo "    $NGINX_CONF already up to date"
else
    if [ -f "$NGINX_CONF" ]; then
        cp -a "$NGINX_CONF" "$NGINX_CONF.bak.$(date +%Y%m%d-%H%M%S)"
        echo "    backed up existing $NGINX_CONF"
    fi
    cp "$NGINX_SRC_SITE" "$NGINX_CONF"
    chmod 0644 "$NGINX_CONF"
    echo "    installed $NGINX_CONF from $NGINX_SRC_SITE"
fi

# Make sure the site is enabled (idempotent symlink).
if [ ! -L /etc/nginx/sites-enabled/your-domain.example ]; then
    ln -s "$NGINX_CONF" /etc/nginx/sites-enabled/your-domain.example
    echo "    enabled your-domain.example site"
fi

# 3c. Validate and reload.
nginx -t 2>&1
systemctl reload nginx
echo "    nginx reloaded"

# ── 4. Backup cron job ───────────────────────────────────────────
echo ""
echo "--- setting up daily backup cron ---"

BACKUP_SCRIPT="$APP_DIR/backup.sh"
cat > "$BACKUP_SCRIPT" <<'BSCRIPT'
#!/usr/bin/env bash
# Daily SQLite backup for lifeplan
set -euo pipefail

DB="/opt/lifeplan/data/lifeplan.db"
BACKUP_DIR="/opt/lifeplan/backups"
DATE=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="$BACKUP_DIR/lifeplan-$DATE.db"

# Use SQLite .backup command for a safe, consistent backup
sqlite3 "$DB" ".backup '$BACKUP_FILE'"

# Keep only the last 14 backups
ls -t "$BACKUP_DIR"/lifeplan-*.db 2>/dev/null | tail -n +15 | xargs -r rm --

echo "$(date): backup complete -> $BACKUP_FILE"
BSCRIPT

chmod +x "$BACKUP_SCRIPT"
chown "$APP_USER:$APP_USER" "$BACKUP_SCRIPT"

# Install cron job for your-user user (daily at 03:00)
CRON_LINE="0 3 * * * /opt/lifeplan/backup.sh >> /opt/lifeplan/backups/backup.log 2>&1"
(crontab -u "$APP_USER" -l 2>/dev/null | grep -v "lifeplan/backup.sh"; echo "$CRON_LINE") | crontab -u "$APP_USER" -

echo "    backup cron installed (daily at 03:00 UTC)"

# ── 5. Server README ────────────────────────────────────────────
echo ""
echo "--- writing /opt/lifeplan/SETUP.md ---"
cat > /opt/lifeplan/SETUP.md <<'README'
# lifeplan -- server setup notes

## What's running
- **App**: Python 3 HTTP server on port 3131 (localhost only)
- **Service**: systemd unit `lifeplan.service`
- **Proxy**: nginx reverse proxy at /lifeplan, public internet, rate-limited (limit_req zone=authzone)
- **Auth**: app-level cookie session auth (no nginx auth_basic). Configured via env vars in /opt/lifeplan/.env
- **Backups**: daily SQLite backup at 03:00 UTC, 14-day retention

## File layout
- `/opt/lifeplan/app/`       -- application code
- `/opt/lifeplan/data/`      -- SQLite database
- `/opt/lifeplan/backups/`   -- daily database backups
- `/opt/lifeplan/.env`       -- environment variables (API keys, Ollama URL, cookie auth secrets)
- `/opt/lifeplan/backup.sh`  -- backup script

## Auth env vars (required in /opt/lifeplan/.env, mode 600)
- `LIFEPLAN_PASSWORD_HASH`   -- generated by `python3 -m app.auth set-password`
- `LIFEPLAN_AUTH_SALT`       -- generated by `python3 -m app.auth set-password`
- `LIFEPLAN_SESSION_SECRET`  -- random secret used to sign session cookies
- `LIFEPLAN_COOKIE_PATH=/lifeplan` -- scope cookie to the proxied path

## Common commands
```
sudo systemctl status lifeplan     # check status
sudo systemctl restart lifeplan    # restart after deploy
journalctl -u lifeplan -n 50      # view recent logs
sudo nginx -t && sudo systemctl reload nginx  # test and reload nginx
```

## Redeploy
From Cam's Mac: `./deploy.sh` in the lifeplan directory.

## Access
Public internet, gated by app-level cookie session auth: https://your-domain.example/lifeplan
README

chown "$APP_USER:$APP_USER" /opt/lifeplan/SETUP.md

# ── 6. Sudoers rule for passwordless service restart ─────────────
echo ""
echo "--- setting up sudoers for deploy ---"
cat > /etc/sudoers.d/lifeplan <<'SUDOERS'
# Allow your-user to restart the lifeplan service without a password
your-user ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart lifeplan, /usr/bin/systemctl stop lifeplan, /usr/bin/systemctl start lifeplan, /usr/bin/systemctl status lifeplan
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
    echo "    NOTE: $ENV_FILE does not exist yet -- create it (mode 600, owner your-user)"
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
echo "    App is running at https://your-domain.example/lifeplan (public internet, gated by app-level cookie session auth)"
echo "    Future deploys: run ./deploy.sh from Cam's Mac"
