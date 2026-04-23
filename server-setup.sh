#!/usr/bin/env bash
# server-setup.sh -- one-time server setup (run ON the droplet with sudo)
#
# Usage: sudo bash /home/your-user/lifeplan-staging/server-setup.sh
#
# Prerequisites: app files already rsynced to /home/your-user/lifeplan-staging/
# This script:
#   1. Moves the app to /opt/lifeplan/ (owned by your-user)
#   2. Creates the systemd service
#   3. Adds nginx location block for /lifeplan
#   4. Sets up daily SQLite backup cron

set -euo pipefail

APP_USER="your-user"
APP_DIR="/opt/lifeplan"
STAGING_DIR="/home/$APP_USER/lifeplan-staging"
NGINX_CONF="/etc/nginx/sites-available/your-domain.example"
BACKUP_DIR="/opt/lifeplan/backups"

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

# ── 3. Nginx location block ─────────────────────────────────────
echo ""
echo "--- configuring nginx ---"

# Check if the lifeplan location block already exists
if grep -q "location /lifeplan" "$NGINX_CONF"; then
    echo "    /lifeplan location block already exists in nginx config, skipping"
else
    # Insert the location block before the closing } of the HTTPS server block
    # We find the last "location / {" block and add our block before it,
    # or we insert before the final closing brace of the server block.

    # Create a temp file with the new config
    python3 - "$NGINX_CONF" <<'PYEOF'
import sys

conf_path = sys.argv[1]
with open(conf_path, "r") as f:
    content = f.read()

lifeplan_block = """
    # lifeplan -- Tailscale-only reverse proxy
    location /lifeplan/ {
        # Allow Tailscale CGNAT range only
        allow 100.64.0.0/10;
        deny all;

        # Strip /lifeplan prefix before proxying
        proxy_pass http://127.0.0.1:3131/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
"""

# Insert before the last closing brace of the HTTPS server block
lines = content.rstrip().rsplit("}", 1)
if len(lines) == 2:
    new_content = lines[0] + lifeplan_block + "\n}"
    with open(conf_path, "w") as f:
        f.write(new_content)
    print("    location block added")
else:
    print("    ERROR: could not find insertion point in nginx config")
    sys.exit(1)
PYEOF
fi

# Test nginx config
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
- **Proxy**: nginx reverse proxy at /lifeplan, Tailscale IPs only
- **Backups**: daily SQLite backup at 03:00 UTC, 14-day retention

## File layout
- `/opt/lifeplan/app/`       -- application code
- `/opt/lifeplan/data/`      -- SQLite database
- `/opt/lifeplan/backups/`   -- daily database backups
- `/opt/lifeplan/.env`       -- environment variables (API keys, Ollama URL)
- `/opt/lifeplan/backup.sh`  -- backup script

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
Tailscale only: https://your-domain.example/lifeplan
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

# ── 7. Start the service ─────────────────────────────────────────
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
echo "    App is running at https://your-domain.example/lifeplan (Tailscale only)"
echo "    Future deploys: run ./deploy.sh from Cam's Mac"
