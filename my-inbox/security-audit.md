# Security Audit: your-domain.example Droplet

**Date:** 2026-04-23
**Auditor:** Sage
**Target:** Ubuntu 24.04.3 LTS on DigitalOcean (your-domain.example)

---

## What's Already Good

These are fine and need no changes:

- **SSH password auth is disabled** via `/etc/ssh/sshd_config.d/*.conf` override. Key-only access.
- **Python app binds to 127.0.0.1:3131** -- not exposed to the internet.
- **HTTPS enforced** -- HTTP 301 redirects to HTTPS. TLS config is the Certbot/Mozilla recommended profile. Good ciphers, TLS 1.2+, session tickets off.
- **Certbot auto-renewal** is active (`certbot.timer` running).
- **Unattended security upgrades** are enabled (`APT::Periodic::Unattended-Upgrade "1"`).
- **systemd service is hardened**: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only`, `PrivateTmp`, `ReadWritePaths` scoped to `/opt/lifeplan/data`. This is well above average.
- **htpasswd file** is properly restricted: `-rw-r----- root:www-data` (only root and nginx can read).
- **Only two users have shell access**: root and your-user. Clean.
- **Backup script uses `sqlite3 .backup`** -- the correct way to get a consistent SQLite copy.

---

## Issues to Fix

### 1. CRITICAL: Root login via SSH is enabled

**Finding:** `/etc/ssh/sshd_config` line 42: `PermitRootLogin yes`

**Risk:** If the root account ever gets an authorized key (or if the sshd_config.d password override is removed), anyone can SSH in as root. There is no reason to allow this.

**Fix:**
```bash
sudo sed -i 's/^PermitRootLogin yes/PermitRootLogin no/' /etc/ssh/sshd_config
sudo systemctl reload sshd
```

---

### 2. HIGH: .env file is world-readable

**Finding:** `-rw-r--r-- your-user your-user /opt/lifeplan/.env` (mode 644)

This file contains `MISTRAL_API_KEY`. Any process or user on the system can read it.

**Fix:**
```bash
chmod 600 /opt/lifeplan/.env
```

---

### 3. HIGH: SQLite database is world-readable

**Finding:** `-rw-r--r-- your-user your-user /opt/lifeplan/data/lifeplan.db` (mode 644)

Your personal knowledge base can be read by any user or process on the box.

**Fix:**
```bash
chmod 600 /opt/lifeplan/data/lifeplan.db
chmod 700 /opt/lifeplan/data/
```

---

### 4. HIGH: Backup cron job is not scheduled

**Finding:** `crontab -l` is empty. There is no systemd timer for backups. The backup script exists at `/opt/lifeplan/backup.sh` but nothing runs it.

**Risk:** If the database gets corrupted or deleted, there is no backup.

**Fix:**
```bash
crontab -e
# Add:
0 3 * * * /opt/lifeplan/backup.sh >> /opt/lifeplan/backups/backup.log 2>&1
```

Also lock down the backup directory:
```bash
chmod 700 /opt/lifeplan/backups/
```

---

### 5. MEDIUM: No firewall rules visible / UFW may be permissive

**Finding:** UFW is installed and the service is active, but I couldn't read the rules without sudo. The port scan shows these ports open on all interfaces:
- **22** (SSH) -- expected
- **80** (HTTP) -- expected (redirects to HTTPS)
- **443** (HTTPS) -- expected

**Action:** Verify UFW rules are set correctly:
```bash
sudo ufw status verbose
```

Expected output should show only 22, 80, 443 allowed. If it shows anything else, or shows "Status: inactive", fix with:
```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

---

### 6. MEDIUM: Nginx leaks server version

**Finding:** Response header shows `Server: nginx/1.24.0 (Ubuntu)`. The `server_tokens off;` line exists in `nginx.conf` but is commented out.

**Risk:** Tells attackers exactly which version to look up CVEs for.

**Fix:** In `/etc/nginx/nginx.conf`, uncomment:
```nginx
server_tokens off;
```
Then `sudo systemctl reload nginx`.

---

### 7. MEDIUM: No security headers on responses

**Finding:** No `X-Frame-Options`, `X-Content-Type-Options`, `Content-Security-Policy`, or `Strict-Transport-Security` headers.

**Fix:** Add to the HTTPS server block in `/etc/nginx/sites-available/your-domain.example`:
```nginx
# Security headers
add_header X-Frame-Options "DENY" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
```

Then `sudo systemctl reload nginx`.

---

### 8. MEDIUM: No rate limiting on the auth endpoint

**Finding:** No `limit_req` directives in the Nginx config.

**Risk:** An attacker can brute-force the Basic Auth credentials at full speed. HTTP Basic Auth has no lockout mechanism.

**Fix:** Add to `/etc/nginx/nginx.conf` in the `http` block:
```nginx
limit_req_zone $binary_remote_addr zone=auth:10m rate=5r/s;
```

Then in the `/lifeplan/` location block in the site config:
```nginx
limit_req zone=auth burst=10 nodelay;
```

Then `sudo systemctl reload nginx`.

---

### 9. LOW: fail2ban is installed but not running

**Finding:** `systemctl is-active fail2ban` returns `inactive`.

**Why it matters:** fail2ban blocks IPs after repeated failed SSH attempts. Without it, brute-force attempts just fill your logs and waste resources.

**Fix:**
```bash
sudo systemctl enable --now fail2ban
```

Check it's watching SSH:
```bash
sudo fail2ban-client status sshd
```

---

### 10. LOW: Tailscale is installed but stopped

**Finding:** `tailscaled` is inactive.

**Opportunity:** If you brought Tailscale up, you could restrict SSH to only your Tailscale network and close port 22 on the public interface entirely. This would eliminate SSH brute-force as a concern.

**Optional hardening:**
```bash
sudo systemctl enable --now tailscaled
tailscale up
# Then restrict SSH to Tailscale only:
sudo ufw delete allow 22/tcp
sudo ufw allow in on tailscale0 to any port 22 proto tcp
```

Only do this if you have Tailscale running on your local machine too, or you'll lock yourself out.

---

## Quick-Win Script

Here's everything above as a single copy-paste block (except Tailscale, which needs interactive setup):

```bash
# 1. Disable root SSH login
sudo sed -i 's/^PermitRootLogin yes/PermitRootLogin no/' /etc/ssh/sshd_config
sudo systemctl reload sshd

# 2. Lock down .env
chmod 600 /opt/lifeplan/.env

# 3. Lock down database
chmod 600 /opt/lifeplan/data/lifeplan.db
chmod 700 /opt/lifeplan/data/

# 4. Schedule backup cron
(crontab -l 2>/dev/null; echo '0 3 * * * /opt/lifeplan/backup.sh >> /opt/lifeplan/backups/backup.log 2>&1') | crontab -
chmod 700 /opt/lifeplan/backups/

# 5. Verify firewall (review output, then proceed)
sudo ufw status verbose

# 6. Hide Nginx version
sudo sed -i 's/# server_tokens off;/server_tokens off;/' /etc/nginx/nginx.conf

# 7. Add security headers (add manually to the HTTPS server block -- see above)

# 8. Enable fail2ban
sudo systemctl enable --now fail2ban

# 9. Reload Nginx after header changes
sudo systemctl reload nginx
```

---

## Priority Order

If you're doing this in 5 minutes, hit these first:

1. `chmod 600 /opt/lifeplan/.env` -- takes 2 seconds, stops API key exposure
2. `chmod 600 /opt/lifeplan/data/lifeplan.db && chmod 700 /opt/lifeplan/data/` -- protect your data
3. Disable root SSH login -- one sed command
4. Schedule the backup cron -- your data has zero backup protection right now
5. Everything else when you have 10 more minutes
