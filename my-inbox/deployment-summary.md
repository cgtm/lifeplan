# Lifeplan Deployment Summary

**Date:** 2026-04-23
**Engineer:** Forge

> **Note:** This approach (Tailscale-restricted nginx access) was tried and
> NOT adopted -- the chosen posture is public internet + app-level cookie
> auth. Kept here for reference value only. All domain, hostnames, and
> Tailscale IPs below are placeholders; the real values were redacted before
> this repo went public.

---

## What Was Done

### 1. App code changes (OLLAMA_URL now configurable)

Modified two files to read `OLLAMA_URL` from `.env` instead of hardcoding `localhost`:

- **`app/processing.py`** -- reads `OLLAMA_URL` from `.env`, falls back to `http://localhost:11434`
- **`app/generate_prompts.py`** -- same change

The `.env` format is `OLLAMA_URL=http://100.64.0.2:11434` (base URL, no trailing slash). The app appends `/api/generate` or `/api/chat` as needed.

### 2. Files staged on the server

All app files, database, and `.env` have been rsynced to `~/lifeplan-staging/` on the droplet:

```
~/lifeplan-staging/
  app/           -- all Python + frontend files
  data/          -- lifeplan.db
  .env           -- server-specific (has OLLAMA_URL pointing to Cam's Mac)
  server-setup.sh -- one-time setup script
```

The server `.env` contains:
```
MISTRAL_API_KEY=<redacted -- see .env on the server, rotate if ever exposed>
OLLAMA_URL=http://100.64.0.2:11434
```

### 3. Created `server-setup.sh` (one-time, needs sudo)

This script does everything that requires root:

- Installs `sqlite3` CLI (needed for backups)
- Creates `/opt/lifeplan/` with `app/`, `data/`, `backups/` directories
- Copies staged files from `~/lifeplan-staging/` to `/opt/lifeplan/`
- Creates systemd service (`lifeplan.service`) -- auto-start on boot, restart on failure
- Adds nginx location block for `/lifeplan/` with Tailscale IP restriction
- Sets up daily SQLite backup cron (03:00 UTC, 14-day retention)
- Installs sudoers rule so `your-user` can restart the service without a password
- Starts the service and runs a health check
- Writes `/opt/lifeplan/SETUP.md` as a server-side reference

### 4. Created `deploy.sh` (repeatable, no sudo needed after setup)

Run from the Mac to push updates:

```
./deploy.sh          # sync app files + database, restart
./deploy.sh --code   # app files only (no db overwrite)
./deploy.sh --db     # database only
```

The deploy script does NOT sync `.env` to avoid overwriting the server's Ollama config. If you need to update the server's `.env`, do it manually via SSH.

### 5. Server layout (after setup)

```
/opt/lifeplan/
  app/              -- application code (server.py, handlers.py, etc.)
  data/             -- lifeplan.db (writable by the service)
  backups/          -- daily SQLite backups
  .env              -- MISTRAL_API_KEY + OLLAMA_URL
  backup.sh         -- backup script (runs via cron)
  SETUP.md          -- server-side reference doc
```

### 6. Nginx configuration

The setup script adds this location block to `/etc/nginx/sites-available/your-domain.example`:

```nginx
location /lifeplan/ {
    allow 100.64.0.0/10;
    deny all;
    proxy_pass http://127.0.0.1:3131/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Key details:
- The trailing `/` on `proxy_pass` strips the `/lifeplan/` prefix, so the app sees requests at `/`
- `allow 100.64.0.0/10` permits Tailscale CGNAT IPs only; everything else gets 403
- The app's frontend uses absolute paths (`/api/...`, `/styles.css`) which work correctly after prefix stripping

---

## Manual Steps Required

### Step 1: Run the setup script on the server (one-time)

```bash
ssh your-user@your-domain.example
sudo bash ~/lifeplan-staging/server-setup.sh
```

This requires your sudo password. After it runs, the sudoers rule means `deploy.sh` won't need a password again.

### Step 2: Configure DNS for Tailscale access

For the `allow 100.64.0.0/10` restriction to work, your browser must connect to the droplet via its Tailscale IP. There are two options:

**Option A: /etc/hosts on your Mac (simplest)**

```bash
# Add this line to /etc/hosts
sudo sh -c 'echo "100.64.0.1 your-domain.example" >> /etc/hosts'
```

This makes `your-domain.example` resolve to the Tailscale IP on your Mac. The TLS cert still matches because it's issued for `your-domain.example`. All `your-domain.example` traffic from your Mac will go through Tailscale (harmless -- same server, slightly different route).

**Option B: Tailscale Split DNS (cleaner)**

In the Tailscale admin console (https://login.tailscale.com/admin/dns):
1. Under "Split DNS", add an override for `your-domain.example`
2. Point it to `100.64.0.1`

This applies the DNS override to all your Tailscale devices automatically.

### Step 3: Verify

After setup, open `https://your-domain.example/lifeplan` in your browser (while connected to Tailscale). You should see the app.

From outside Tailscale, the same URL should return 403 Forbidden.

---

## How Future Deploys Work

1. Make changes to the app locally
2. Run `./deploy.sh` (or `./deploy.sh --code` to skip the database)
3. The script rsyncs files, restarts the service, and runs a health check

---

## Tailscale IPs (for reference; redacted -- see note at top of file)

| Device | Tailscale IP |
|--------|-------------|
| Droplet | 100.64.0.1 |
| Laptop | 100.64.0.2 |
| Phone | 100.64.0.3 |
| NAS/home server | 100.64.0.4 |

---

## Rollback

If something goes wrong after the setup:

```bash
# Stop the service
ssh your-user@your-domain.example "sudo systemctl stop lifeplan"

# Remove the nginx location block manually
ssh your-user@your-domain.example
sudo nano /etc/nginx/sites-available/your-domain.example
# Delete the /lifeplan/ location block
sudo nginx -t && sudo systemctl reload nginx

# Remove the hosts entry if you added one
sudo sed -i '' '/100.64.0.1 your-domain.example/d' /etc/hosts
```

---

## Files Created/Modified

**On Mac (local):**
- `app/processing.py` -- OLLAMA_URL now reads from .env
- `app/generate_prompts.py` -- OLLAMA_URL now reads from .env
- `.env` -- added commented OLLAMA_URL example
- `deploy.sh` -- new, repeatable deployment script
- `server-setup.sh` -- new, one-time server configuration script

**On server (after setup runs):**
- `/opt/lifeplan/` -- full app deployment
- `/etc/systemd/system/lifeplan.service` -- systemd unit
- `/etc/nginx/sites-available/your-domain.example` -- location block added
- `/etc/sudoers.d/lifeplan` -- passwordless service restart
- crontab entry for daily backups
