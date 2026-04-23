#!/usr/bin/env bash
# security-fix.sh -- Fix issues from Sage's security audit (2026-04-23)
# Skips: root SSH login (Cam wants to leave as-is)
# Requires: sudo with password (your-user's NOPASSWD scope is too narrow for these)
set -euo pipefail

echo "=== Lifeplan Security Fixes ==="
echo ""

# ---------------------------------------------------------------
# 1. File permissions: lock down .env and database files
# ---------------------------------------------------------------
echo "[1/5] Fixing file permissions..."

chmod 600 /opt/lifeplan/.env
echo "  .env -> 600"

chmod 600 /opt/lifeplan/data/lifeplan.db
echo "  lifeplan.db -> 600"

# Also lock down WAL/SHM files if they exist
for f in /opt/lifeplan/data/lifeplan.db-wal /opt/lifeplan/data/lifeplan.db-shm; do
    if [ -f "$f" ]; then
        chmod 600 "$f"
        echo "  $(basename "$f") -> 600"
    fi
done

chmod 700 /opt/lifeplan/data/
echo "  data/ -> 700"

chmod 700 /opt/lifeplan/backups/
echo "  backups/ -> 700"

echo "  Done."
echo ""

# ---------------------------------------------------------------
# 2. Backup cron: schedule the existing backup.sh daily at 03:00
# ---------------------------------------------------------------
echo "[2/5] Scheduling daily backup cron..."

# Add to your-user's crontab (avoids duplicates by checking first)
CRON_LINE="0 3 * * * /opt/lifeplan/backup.sh >> /opt/lifeplan/backups/backup.log 2>&1"
if crontab -l 2>/dev/null | grep -qF "/opt/lifeplan/backup.sh"; then
    echo "  Cron job already exists, skipping."
else
    (crontab -l 2>/dev/null; echo "$CRON_LINE") | crontab -
    echo "  Added: $CRON_LINE"
fi

echo "  Verifying:"
crontab -l 2>/dev/null | grep "backup" | sed 's/^/    /'
echo ""

# ---------------------------------------------------------------
# 3. Nginx rate limiting on /lifeplan (Basic Auth brute-force protection)
# ---------------------------------------------------------------
echo "[3/5] Adding nginx rate limiting..."

# Add limit_req_zone to nginx.conf http block (before the include lines)
NGINX_CONF="/etc/nginx/nginx.conf"
if sudo grep -q "limit_req_zone.*zone=authzone" "$NGINX_CONF"; then
    echo "  Rate limit zone already configured in nginx.conf, skipping."
else
    # Insert the limit_req_zone directive just before the Virtual Host Configs section
    sudo sed -i '/##\s*$/{N;/Virtual Host Configs/i\\tlimit_req_zone $binary_remote_addr zone=authzone:10m rate=10r\/s;\n}' "$NGINX_CONF"

    # Verify it was added -- if sed didn't match, use a fallback approach
    if ! sudo grep -q "limit_req_zone.*zone=authzone" "$NGINX_CONF"; then
        # Fallback: insert before the first include in http block
        sudo sed -i '/include \/etc\/nginx\/conf\.d\/\*\.conf;/i\\tlimit_req_zone $binary_remote_addr zone=authzone:10m rate=10r\/s;' "$NGINX_CONF"
    fi
    echo "  Added limit_req_zone to nginx.conf"
fi

# Add limit_req to the /lifeplan location block in site config
SITE_CONF="/etc/nginx/sites-available/your-domain.example"
if sudo grep -q "limit_req zone=authzone" "$SITE_CONF"; then
    echo "  Rate limit directive already in site config, skipping."
else
    # Insert limit_req just after the auth_basic_user_file line
    sudo sed -i '/auth_basic_user_file.*htpasswd-lifeplan;/a\\        limit_req zone=authzone burst=20 nodelay;' "$SITE_CONF"
    echo "  Added limit_req to /lifeplan location block"
fi

echo ""

# ---------------------------------------------------------------
# 4. Nginx security headers + server_tokens off
# ---------------------------------------------------------------
echo "[4/5] Adding nginx security headers..."

# Uncomment server_tokens off
if sudo grep -q "^[[:space:]]*# server_tokens off;" "$NGINX_CONF"; then
    sudo sed -i 's/# server_tokens off;/server_tokens off;/' "$NGINX_CONF"
    echo "  Uncommented server_tokens off"
elif sudo grep -q "server_tokens off;" "$NGINX_CONF"; then
    echo "  server_tokens off already active"
fi

# Add security headers to the HTTPS server block
if sudo grep -q "X-Frame-Options" "$SITE_CONF"; then
    echo "  Security headers already present, skipping."
else
    # Insert headers right after the ssl_dhparam line
    sudo sed -i '/ssl_dhparam/a\\n    # Security headers\n    add_header X-Frame-Options "DENY" always;\n    add_header X-Content-Type-Options "nosniff" always;\n    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;\n    add_header Referrer-Policy "strict-origin-when-cross-origin" always;' "$SITE_CONF"
    echo "  Added X-Frame-Options, X-Content-Type-Options, HSTS, Referrer-Policy"
fi

# Test nginx config before reloading
echo "  Testing nginx config..."
sudo nginx -t
echo "  Reloading nginx..."
sudo systemctl reload nginx
echo "  Done."
echo ""

# ---------------------------------------------------------------
# 5. fail2ban: enable, start, and configure nginx-http-auth jail
# ---------------------------------------------------------------
echo "[5/5] Configuring and starting fail2ban..."

# Create a filter for nginx basic auth failures
FILTER_FILE="/etc/fail2ban/filter.d/nginx-http-auth.conf"
if [ ! -f "$FILTER_FILE" ] || ! sudo grep -q "failregex" "$FILTER_FILE" 2>/dev/null; then
    sudo tee "$FILTER_FILE" > /dev/null << 'FILTER'
[Definition]
failregex = no user/password was provided for basic authentication.*client: <HOST>
             user .* was not found in .*client: <HOST>
             user .* password mismatch.*client: <HOST>
FILTER
    echo "  Created nginx-http-auth filter"
else
    echo "  nginx-http-auth filter already exists"
fi

# Create jail config for both sshd and nginx-http-auth
JAIL_FILE="/etc/fail2ban/jail.local"
sudo tee "$JAIL_FILE" > /dev/null << 'JAIL'
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5

[sshd]
enabled = true

[nginx-http-auth]
enabled  = true
port     = http,https
filter   = nginx-http-auth
logpath  = /var/log/nginx/error.log
maxretry = 5
JAIL
echo "  Created jail.local with sshd and nginx-http-auth jails"

# Enable and start fail2ban
sudo systemctl enable fail2ban
sudo systemctl restart fail2ban
echo "  fail2ban enabled and started"

# Verify
echo "  Checking jail status..."
sleep 1
sudo fail2ban-client status | sed 's/^/    /'
echo ""

# ---------------------------------------------------------------
# Summary
# ---------------------------------------------------------------
echo "=== All fixes applied ==="
echo ""
echo "What was done:"
echo "  1. chmod 600 on .env, lifeplan.db (and WAL/SHM if present); 700 on data/ and backups/"
echo "  2. Daily backup cron at 03:00 UTC using existing backup.sh"
echo "  3. Nginx rate limiting: 10 req/s per IP, burst 20, on /lifeplan"
echo "  4. Nginx: server_tokens off + security headers (HSTS, X-Frame-Options, etc.)"
echo "  5. fail2ban running with sshd + nginx-http-auth jails"
echo ""
echo "What was NOT changed (per Cam's request):"
echo "  - Root SSH login remains enabled"
echo ""
echo "Verify with:"
echo "  curl -sI https://your-domain.example/lifeplan/ | grep -iE 'server:|x-frame|x-content|strict|referrer'"
echo "  sudo fail2ban-client status"
echo "  crontab -l"
