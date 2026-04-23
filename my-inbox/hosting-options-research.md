# Hosting Lifeplan When Mac Is Offline

**Researcher**: Sage
**Date**: 2026-04-23
**Status**: For Cam's review

---

## What We're Working With

The app is exceptionally lightweight:

- **Pure Python stdlib** -- zero pip dependencies (no Flask, no Django, no requests). Uses `http.server`, `sqlite3`, `urllib`, `json`, `re`, all from the standard library.
- **SQLite database** -- 213KB. Single file.
- **Static frontend** -- one HTML file, one JS file, one CSS file, served by the same Python process.
- **Ollama (Mistral)** -- used for brain dump processing and prompt generation. The app **already has a full regex fallback** when Ollama is unavailable -- it prints `"Falling back to regex processing"` and carries on.

This is one of the simplest possible web apps to deploy. No build step, no package manager, no virtualenv needed.

---

## Option 1: Deploy to Your Existing DigitalOcean Droplet (Recommended)

**What it takes**: Copy the files, run the Python server, set up a systemd service.

### Steps
1. Copy `app/` and `data/` to the droplet (rsync or scp)
2. Create a systemd service file (equivalent of your LaunchAgent plist)
3. Run `python3 server.py` as a background service
4. Access via Tailscale (same as now, just a different Tailscale IP)

### Ollama on the Droplet
- **Mistral (7B)** needs ~4.5GB RAM and ~4GB disk for the model weights
- A **4GB RAM droplet ($24/mo)** can technically run it but will be tight alongside the OS
- An **8GB RAM droplet ($48/mo)** would run it comfortably
- **You likely don't need Ollama on the server at all.** The regex fallback already works. Brain dump processing and prompt generation are the only two features that use the LLM, and they degrade gracefully without it.

### Recommended Approach: Split Architecture
- **Droplet runs the app + SQLite** (always available, $6/mo minimum droplet is plenty without Ollama)
- **Ollama stays on your Mac** (when it's online)
- Modify `OLLAMA_URL` to be configurable via environment variable -- when Mac is on, point it at `http://<mac-tailscale-ip>:11434`. When Mac is off, it falls back to regex automatically.

### Cost
- If using your existing droplet: $0 additional
- If new droplet needed: $6/mo (1GB RAM) is sufficient without Ollama; $24-48/mo if you want Ollama on the server

### Trade-offs
- (+) Simplest migration path. You already have the droplet. You already have Tailscale.
- (+) No new services to learn.
- (+) DB stays in one place -- no sync problem.
- (-) You become responsible for keeping the droplet updated (security patches, etc.)
- (-) Need to decide where the "primary" copy of the DB lives

---

## Option 2: Cloud LLM API Instead of Ollama

Rather than running Ollama anywhere, replace the two `_call_ollama` functions with calls to a cloud LLM API (OpenAI, Anthropic, Groq, Mistral API, etc.).

### What Changes
- Swap `urllib.request` calls from `localhost:11434` to a cloud endpoint
- Add an API key (environment variable)
- Total code change: ~20 lines across `processing.py` and `generate_prompts.py`

### Cost
- Mistral API / Groq: essentially free at your usage volume (a few brain dumps per day)
- OpenAI gpt-4o-mini: fractions of a penny per brain dump

### Trade-offs
- (+) Eliminates the heaviest dependency entirely
- (+) Better model quality than local Mistral 7B
- (+) Works from a $6/mo droplet with no RAM concerns
- (-) Requires an API key (minor secret management)
- (-) Introduces an external dependency (API outage = falls back to regex, same as now)

---

## Option 3: Hybrid -- Mac Primary, Droplet Failover

Keep the Mac as your main server. Run a read-only (or full) copy on the droplet as a fallback.

### Sync Mechanism
- SQLite is a single file. A cron job on the Mac could `rsync` or `scp` the DB to the droplet every N minutes.
- Litestream (open-source SQLite replication tool) can continuously stream WAL changes to the droplet or to S3/R2.

### Trade-offs
- (+) Mac remains primary -- no workflow change when it's on
- (-) Complexity: sync conflicts if you write to both copies
- (-) If Mac is offline, the droplet copy is only as fresh as the last sync
- (-) Two-way sync with SQLite is genuinely hard and error-prone

**Verdict**: More complexity than it's worth for a single-user app. Pick one primary location.

---

## Option 4: PaaS (Fly.io, Railway, Render)

These platforms can run a Python process with a persistent volume for the SQLite file.

### Fly.io Specifics
- Free tier: 3 shared VMs, 1GB persistent volume
- Deploy with a simple `fly.toml` + Dockerfile
- Persistent volume for the SQLite file
- Can join your Tailscale network via `flyctl wireguard`

### Trade-offs
- (+) Managed infrastructure, auto-restart, health checks
- (+) Free or near-free at this scale
- (-) Another platform to learn and maintain
- (-) Persistent volumes on PaaS are less straightforward than a simple VPS
- (-) You already have a droplet -- adding another platform is unnecessary

---

## Options I'd Skip

| Option | Why Skip |
|--------|----------|
| **Containerise (Docker)** | The app has zero dependencies. Docker adds complexity with no benefit here. |
| **AWS/GCP/Azure** | Massively over-engineered for a single-user Python script. |
| **Static hosting + serverless functions** | Would require rewriting the entire backend. |
| **Cloudflare Workers + D1** | Would require rewriting everything. Different DB, different runtime. |

---

## Recommendation

**Do this, in order:**

1. **Deploy to your existing DigitalOcean droplet.** Copy the files, create a systemd service, access via Tailscale. This can be done in under an hour. No new accounts, no new services, no new costs.

2. **Make `OLLAMA_URL` an environment variable** with a fallback default. On the droplet, leave it pointed at the Mac's Tailscale IP. When Mac is off, the 30-second timeout fires, regex fallback kicks in, everything works. When Mac is on, you get LLM-powered processing.

3. **Later, if you want better brain dump processing without the Mac**: swap Ollama for a cloud API (Groq is free and fast with Mistral/Llama models). ~20 lines of code change.

### What a DevOps Person Would Set Up

For completeness, here's what a proper setup on the droplet looks like:

- **systemd unit file** to run `python3 server.py` (auto-restart on crash, start on boot)
- **UFW firewall** -- block everything except Tailscale subnet (the app already binds to `127.0.0.1`, so you'd change this to `0.0.0.0` or the Tailscale interface IP)
- **SQLite backups** -- cron job running your existing `backup.sh`, plus periodic `scp` of backups to another location
- **Tailscale** installed on the droplet (one command: `curl -fsSL https://tailscale.com/install.sh | sh`)
- **Log rotation** -- systemd journal handles this automatically
- **DB migration**: one-time `scp` of `data/lifeplan.db` from Mac to droplet

The app binds to `127.0.0.1:3131` currently. On the droplet, you'd either:
- Bind to the Tailscale interface IP (most secure, direct access)
- Bind to `0.0.0.0` with UFW blocking non-Tailscale traffic
- Or keep `127.0.0.1` and add a Caddy/nginx reverse proxy (unnecessary for personal use)

---

## Summary

| Option | Cost | Complexity | Always-on | LLM Quality |
|--------|------|------------|-----------|-------------|
| **Droplet (no Ollama)** | $0-6/mo | Low | Yes | Regex fallback |
| **Droplet + cloud LLM API** | $0-6/mo | Low | Yes | Better than local Mistral |
| **Droplet + Ollama** | $24-48/mo | Medium | Yes | Same as now |
| **Hybrid Mac+Droplet** | $0-6/mo | High | Mostly | Same as now |
| **PaaS (Fly.io etc.)** | $0-5/mo | Medium | Yes | Depends |

The simplest path: **your existing droplet + regex fallback now, cloud LLM API later if you miss the quality.**
