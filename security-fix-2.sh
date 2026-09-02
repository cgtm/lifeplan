#!/usr/bin/env bash
# Run on the droplet itself (paths below assume the values from
# deploy.conf -- see deploy.conf.example). If your REMOTE_BASE / SERVER_USER
# / nginx site filename differ from the defaults, adjust below.
set -euo pipefail

APP_DIR="${LIFEPLAN_REMOTE_BASE:-/opt/lifeplan}"
APP_USER="${LIFEPLAN_SERVER_USER:?set LIFEPLAN_SERVER_USER to the SERVER_USER from deploy.conf}"
SITE_CONF="${LIFEPLAN_NGINX_SITE:-/etc/nginx/sites-available/your-domain.example}"

echo "=== Lifeplan Security Fixes (remaining) ==="
echo ""

# 2. Backup cron
echo "[2/5] Scheduling daily backup cron for user $APP_USER..."
CRON_LINE="0 3 * * * $APP_DIR/backup.sh >> $APP_DIR/backups/backup.log 2>&1"
if sudo -u "$APP_USER" crontab -l 2>/dev/null | grep -qF "$APP_DIR/backup.sh"; then
    echo "  Already exists, skipping."
else
    (sudo -u "$APP_USER" crontab -l 2>/dev/null; echo "$CRON_LINE") | sudo -u "$APP_USER" crontab -
    echo "  Added."
fi
echo ""

# 3. Nginx rate limiting
echo "[3/5] Adding nginx rate limiting..."
NGINX_CONF="/etc/nginx/nginx.conf"

if grep -q "limit_req_zone.*zone=authzone" "$NGINX_CONF"; then
    echo "  Rate limit zone already in nginx.conf, skipping."
else
    sed -i '/include \/etc\/nginx\/conf\.d\/\*\.conf;/i \\tlimit_req_zone $binary_remote_addr zone=authzone:10m rate=10r\/s;' "$NGINX_CONF"
    echo "  Added limit_req_zone to nginx.conf"
fi

if grep -q "limit_req zone=authzone" "$SITE_CONF"; then
    echo "  Rate limit already in site config, skipping."
else
    sed -i '/auth_basic_user_file.*htpasswd-lifeplan;/a \\        limit_req zone=authzone burst=20 nodelay;' "$SITE_CONF"
    echo "  Added limit_req to /lifeplan location block"
fi
echo ""

# 4. Nginx security headers
echo "[4/5] Adding nginx security headers..."

if grep -q "^[[:space:]]*# server_tokens off;" "$NGINX_CONF"; then
    sed -i 's/# server_tokens off;/server_tokens off;/' "$NGINX_CONF"
    echo "  Uncommented server_tokens off"
elif grep -q "server_tokens off;" "$NGINX_CONF"; then
    echo "  server_tokens off already active"
else
    sed -i '/http {/a \\tserver_tokens off;' "$NGINX_CONF"
    echo "  Added server_tokens off"
fi

if grep -q "X-Frame-Options" "$SITE_CONF"; then
    echo "  Security headers already present, skipping."
else
    # Find the HTTPS server block and add headers after ssl_dhparam or listen 443
    sed -i '/ssl_dhparam\|ssl_certificate_key/{
        a\
\
    # Security headers\
    add_header X-Frame-Options "DENY" always;\
    add_header X-Content-Type-Options "nosniff" always;\
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;\
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    }' "$SITE_CONF"
    # Deduplicate if both ssl lines matched
    awk '!seen[$0]++ || !/add_header/' "$SITE_CONF" > /tmp/lifeplan-dedup.conf
    mv /tmp/lifeplan-dedup.conf "$SITE_CONF"
    echo "  Added security headers"
fi

echo "  Testing nginx config..."
nginx -t
systemctl reload nginx
echo "  Nginx reloaded."
echo ""

# 5. fail2ban
echo "[5/5] Configuring and starting fail2ban..."

FILTER_FILE="/etc/fail2ban/filter.d/nginx-http-auth.conf"
if [ ! -f "$FILTER_FILE" ]; then
    cat > "$FILTER_FILE" << 'FILTER'
[Definition]
failregex = no user/password was provided for basic authentication.*client: <HOST>
            user .* was not found in .*client: <HOST>
            user .* password mismatch.*client: <HOST>
FILTER
    echo "  Created nginx-http-auth filter"
else
    echo "  Filter already exists"
fi

cat > /etc/fail2ban/jail.local << 'JAIL'
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
echo "  Created jail.local"

systemctl enable fail2ban
systemctl restart fail2ban
echo "  fail2ban started"

sleep 1
fail2ban-client status | sed 's/^/    /'
echo ""

echo "=== All fixes applied ==="
