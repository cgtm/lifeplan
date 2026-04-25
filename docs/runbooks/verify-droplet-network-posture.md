---
title: Verify droplet network posture
status: accepted
owner: Cairn
last_reviewed: 2026-04-23
---

# Verify droplet network posture

## Goal
Determine, from first principles, whether `your-domain.example` is publicly reachable, Tailscale-only, firewall-gated, or something else — without trusting any banner, comment, script name, or persona's recollection.

## When to run

Run this **before** making any decision that depends on the answer to "is the site publicly reachable?" Specifically:

- Before removing, weakening, or adding application-level auth.
- Before exposing a new endpoint or subsystem.
- Before designing a security control whose threat model assumes a specific posture.
- After any change to nginx `listen` directives, the deploy script, the DigitalOcean Cloud Firewall, or Tailscale state.
- Whenever a persona quotes the project's posture from memory rather than from a verification this session.

If you are about to type "the site is Tailscale-only, so..." or "the site is public, so..." into chat, run this first.

---

## Steps

Run each step. Each one verifies one layer. **Each layer can lie independently of the others** — the verdict is the combination of all five.

### 1. DNS — what does the public name resolve to?

```sh
dig +short your-domain.example A
```

- A public IPv4 (anything not in `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, or `100.64.0.0/10`) means the name **is publicly resolvable**. This is necessary but not sufficient for "publicly reachable" — DNS resolving says nothing about whether traffic gets through.
- A `100.x.x.x` address means the name resolves to a Tailscale IP. Public clients cannot reach it. (We do not currently do this.)
- No output means there is no A record. Move on; reachability via the public name is impossible.

### 2. Tailscale presence on the droplet

```sh
ssh your-user 'tailscale status 2>&1 || echo not-installed'
ssh your-user 'ip -br a | grep -E "100\.|tailscale0" || echo no-tailscale-iface'
```

- `tailscale status` showing peers and a `tailscale0` interface with a `100.x.x.x` address means Tailscale **is running** on the droplet. This does not mean nginx is bound to it — that's step 3.
- `not-installed` or `no-tailscale-iface` means Tailscale is not in play on this host. Any "Tailscale-only" claim is immediately false.

### 3. Nginx listen — what addresses is the proxy actually bound to?

```sh
ssh your-user 'ss -tln | grep -E ":80|:443"'
```

Read the local-address column carefully:

- `0.0.0.0:443` (or `*:443`, or `[::]:443`) means nginx is listening on **all interfaces, including the public one**. The site is bindable from the public internet — whether anything stops the traffic is up to the firewall layer (step 4).
- `127.0.0.1:443` means **loopback only**. Not reachable from anywhere except the droplet itself.
- `100.x.x.x:443` means bound to the **Tailscale interface only**. Reachable only from tailnet members.
- A specific public IP (the droplet's eth0 address) means public-only — same effective posture as `0.0.0.0` for our purposes.

If you see multiple listen lines, the broadest one wins for reachability assessment.

### 4. Host and cloud firewall

There are two firewall layers and they are not equivalent.

**Host firewall (visible on the droplet):**

```sh
ssh your-user 'sudo ufw status verbose 2>/dev/null || sudo iptables -L -n -v 2>/dev/null | head -50'
```

- (`sudo` here will need Cam interactively per `remote-sudo.md`. For a read-only check, `iptables -L -n` without `-v` may work without sudo on some hosts; if not, hand off to Cam.)
- Look for default-deny on input with explicit allows for 22/80/443, vs default-allow.

**DigitalOcean Cloud Firewall (NOT visible from inside the droplet):**

- This is a known limitation. The DO Cloud Firewall sits in front of the droplet at the hypervisor level. From inside the droplet, you cannot tell whether it is enabled, what rules it has, or whether your traffic is being silently dropped before it ever reaches nginx.
- The only way to verify it from the droplet's CLI is **indirectly**, via step 5 (live reachability) — if the droplet binds `0.0.0.0:443` but step 5 times out from a public client, the cloud firewall is the most likely cause.
- The direct way to verify it is the DigitalOcean web console or `doctl compute firewall list` from a machine with API credentials. If posture decisions hinge on the cloud firewall, check the console — do not infer.

### 5. Live reachability — does an actual public client get through?

This is the load-bearing step. The previous four describe the configuration; this one describes the behaviour.

From a machine **not on the tailnet** (your phone on cellular, or a friend's machine, or a cloud shell that is definitely not tailnet-joined):

```sh
curl -sI -m 5 https://your-domain.example/lifeplan/
```

If you must run from a tailnet-joined host but want to simulate a public client, force the curl to use the public IP without consulting Tailscale's DNS:

```sh
curl -sI -m 5 https://your-domain.example/lifeplan/ --resolve your-domain.example:443:<droplet-public-ip>
```

Interpret:

- A real HTTP status line back (`HTTP/2 200`, `HTTP/2 401`, `HTTP/2 403`, etc.) means the site **is publicly reachable**. The status code itself is irrelevant for posture — even a 401 proves traffic completed the round trip.
- `curl: (28) Connection timed out` means traffic did not complete. Most likely the cloud firewall, possibly the host firewall, possibly a listen-address mismatch.
- `curl: (7) Failed to connect` / connection refused means the TCP handshake was rejected outright — typically nothing listening on that port on that interface.
- TLS errors (cert mismatch, etc.) still count as "publicly reachable" for posture purposes — the connection completed far enough to negotiate TLS.

---

## Interpretation — combining the layers into a verdict

Read the layers together:

| DNS | Tailscale on droplet | Nginx bind | Live curl from off-tailnet | Verdict |
|-----|----------------------|------------|----------------------------|---------|
| Public A | running or not | `0.0.0.0` | real status code | **Public** |
| Public A | running or not | `0.0.0.0` | timeout | **Cloud-firewall-gated** (verify in DO console) |
| Public A | running | `100.x.x.x` only | timeout / refused | **Tailscale-only** |
| Public A | not running | `127.0.0.1` only | refused | **Loopback-only** (broken or local-dev) |
| No A record | — | — | DNS fails | **Not reachable by name** |

Single rule: **if step 5 returns a status code, the site is public**, regardless of what comments, banners, or persona memory say. Conversely, "Tailscale-only" requires nginx bound to the Tailscale interface **and** step 5 timing out from a real off-tailnet client. Both conditions, every time.

---

## What to do if the answer surprises you

Stop. Do not act on the surprise.

1. Re-run step 5 from a second off-tailnet vantage point to rule out a transient.
2. Capture the outputs of all five steps in a single message to Cam: "Posture check ran. Steps 1-5 outputs below. I expected X. Got Y."
3. Wait for Cam to confirm the posture before continuing whatever decision triggered the check.

**Do not** assume the previously-documented posture is current. The whole point of running this is that documented posture and actual posture have drifted before, and will again.

---

## Anti-patterns

- **Never quote a script's banner string as evidence of posture.** A banner that says "Tailscale only" is a string in a file. It tells you what someone once intended to be true. It does not tell you what `ss -tln` shows right now.
- **Never treat a `_only` suffix in a comment, variable name, or filename as a verified fact.** `tailscale_only_deploy.sh` may bind to `0.0.0.0`. Read the listen directive, not the filename.
- **Never reason about defence-in-depth without checking what depth actually exists.** "Cookie auth is fine because we're behind Tailscale" requires a current verification that we are, in fact, behind Tailscale.
- **Never confuse DNS resolving with reachability.** A name resolving to a public IP is not the same as a public client getting a response.
- **Never run only step 5 and call it done.** A 200 from a public client tells you the site is public, but not why — you need the configuration layers to know which knob to turn.
- **Never run only steps 1-4 and call it done.** The configuration can be misread; the live curl is the ground truth.

---

## Provenance

- The cookie-auth session retro: `/Users/cam/dev/personal/lifeplan/docs/retrospectives/2026-04-25-cookie-auth.md`. Atlas quoted the `deploy.sh` banner string ("Tailscale only") as evidence of posture; Cam challenged it; Forge ran the audit that proved the site was fully public. The lesson — never trust banners, always verify — is what this runbook exists to prevent re-learning.
- Per Cam's documented decision, current posture is **public + cookie auth**. Tailscale was tried and shelved; do not assume it is in play unless step 2 and step 3 jointly prove it.
