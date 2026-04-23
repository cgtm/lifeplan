# Securing a Personal App on a Public Domain

**Research by Sage** | 2026-04-23
**Context**: Lifeplan app at `https://your-domain.example/lifeplan` on a DigitalOcean droplet with nginx + HTTPS. Single user (Cam). Must work on iPhone Safari and Mac. Tailscale already installed on all devices.

**The core problem**: DNS resolves `your-domain.example` to the droplet's public IP. The browser connects over the public internet, bypassing Tailscale. So restricting nginx to Tailscale IPs doesn't help.

---

## Option 1: HTTP Basic Auth (nginx)

**How it works**: nginx prompts for username/password before serving the app. Credentials stored in an htpasswd file on the server.

**Setup**:
```
apt install apache2-utils
htpasswd -c /etc/nginx/.htpasswd cam
# Then add to the nginx location block:
#   auth_basic "Lifeplan";
#   auth_basic_user_file /etc/nginx/.htpasswd;
```

**Pros**:
- 5 minutes to set up, zero dependencies
- Works perfectly on iPhone Safari over HTTPS (no issues with valid certs)
- No extra services to run or maintain
- Credentials cached by the browser for the session

**Cons**:
- Password sent with every request (Base64-encoded, safe over HTTPS but no token/session)
- No MFA, no lockout on brute-force (mitigate with fail2ban or rate limiting)
- Ugly browser-native prompt (no custom UI, but who cares for a personal app)
- Logging out requires closing the browser or clearing credentials

**Complexity**: Trivial. 5-10 minutes.

**Verdict**: Strong contender for single-user personal app. Simple, reliable, zero moving parts.

---

## Option 2: OAuth2/SSO Proxy (oauth2-proxy or Authelia)

### 2a: oauth2-proxy with Google Login

**How it works**: A separate service sits in front of nginx. Unauthenticated users are redirected to Google login. Only allowed email addresses pass through.

**Setup**:
- Deploy oauth2-proxy (binary or Docker container)
- Create Google OAuth2 credentials in Google Cloud Console
- Configure nginx `auth_request` directive to check oauth2-proxy
- Set `authenticated-emails-file` to restrict to Cam's email only

**Pros**:
- Login via Google account (no extra password to remember)
- Proper session with cookies (not re-sent on every request)
- Can restrict to a single email address

**Cons**:
- Another service to run and keep updated
- Google OAuth credentials setup is fiddly (consent screen, scopes, etc.)
- If oauth2-proxy crashes, the app is inaccessible
- Session cookies need a secret; secret management adds complexity

**Complexity**: Medium. 30-60 minutes if you've done it before, longer if not.

### 2b: Authelia

**How it works**: Self-hosted auth portal. Supports local users, TOTP 2FA, and SSO. Integrates with nginx via `auth_request`.

**Pros**:
- Supports 2FA (TOTP)
- Full control, no external OAuth dependency
- Nice web UI for login

**Cons**:
- Heavier than oauth2-proxy (needs Redis or file-based sessions, config files)
- Overkill for a single user on a single app
- Another service to run, monitor, update

**Complexity**: Medium-High. 1-2 hours for a clean setup.

**Verdict for Option 2**: Works well but heavyweight for a one-user app. oauth2-proxy is the lighter choice of the two.

---

## Option 3: Tailscale Funnel

**How it works**: Tailscale Funnel exposes a tailnet service to the public internet via a `*.ts.net` domain with automatic HTTPS.

**The problem**: Funnel only works on `*.ts.net` domains. Custom domain support (like `your-domain.example`) is not a standard feature. Some users have requested it from Tailscale support, but it's not generally available. The TLS certificate Funnel provisions is only valid for `*.ts.net`, so a CNAME from `your-domain.example` would cause certificate mismatch errors.

**Verdict**: Not viable for `your-domain.example`. Would require switching to a `*.ts.net` URL, which defeats the purpose.

---

## Option 4: Cloudflare Tunnel + Cloudflare Access

**How it works**: Two components working together:
1. **Cloudflare Tunnel** (`cloudflared`): Creates an outbound-only encrypted connection from the droplet to Cloudflare's edge. DNS for `your-domain.example` points to Cloudflare (proxied). No inbound ports needed on the droplet.
2. **Cloudflare Access**: A zero-trust gateway that intercepts requests and requires authentication (Google login, GitHub login, email OTP, etc.) before forwarding to the tunnel.

**Setup**:
- Move `your-domain.example` DNS to Cloudflare (or use Cloudflare as DNS proxy)
- Install `cloudflared` on the droplet, create a tunnel
- Configure tunnel to forward traffic to `localhost:port` (nginx or directly to the app)
- Create an Access Application with a policy like "allow cam@email.com only"
- Choose an identity provider (Google is easiest, or use one-time email PIN with zero setup)

**Pros**:
- Free tier covers up to 50 users (way more than needed)
- Zero-trust: the droplet doesn't even need port 80/443 open to the internet
- Authentication handled by Cloudflare before traffic hits the server
- Email OTP option means zero IdP setup (Cloudflare sends a code to Cam's email)
- Works seamlessly on iPhone Safari (just a web login page)
- DDOS protection, CDN caching included
- `cloudflared` runs as a systemd service, very reliable

**Cons**:
- Requires DNS for `your-domain.example` to be managed by (or proxied through) Cloudflare
- Adds a dependency on Cloudflare's infrastructure
- Slight added latency (traffic routes through Cloudflare edge)
- Need to keep `cloudflared` updated

**Complexity**: Medium. 30-45 minutes. Mostly dashboard clicking and one install on the server.

**Verdict**: The most elegant solution. Combines authentication and network security. Eliminates the need for open ports entirely. The email OTP option means zero Google/GitHub OAuth setup.

---

## Option 5: Client Certificates (mTLS)

**How it works**: nginx requires a client certificate for TLS handshake. Only devices with the right certificate can connect.

**Setup**:
- Generate a CA, issue a client cert
- Configure nginx `ssl_client_certificate` and `ssl_verify_client on`
- Install the client cert on Mac (Keychain) and iPhone (via profile)

**Pros**:
- Very strong security (possession-based auth)
- No passwords to type
- No extra services to run

**Cons**:
- Installing certs on iPhone is annoying (download .p12, install profile, trust it in Settings)
- Safari on iOS has had bugs with client certs (repeated prompts in some iOS versions)
- Certificate renewal/revocation is manual
- If you lose a device, you need to revoke and reissue
- Debugging TLS issues is painful

**Complexity**: High. 1-2 hours, plus ongoing cert management headaches.

**Verdict**: Overkill and fragile on iOS. Not recommended for this use case.

---

## Option 6: Tailscale Split DNS (Make your-domain.example Resolve to Tailscale IP)

**How it works**: Configure Tailscale's split DNS so that when Cam's devices are on the tailnet, `your-domain.example` resolves to the droplet's Tailscale IP (100.x.x.x) instead of the public IP. Traffic then flows through Tailscale. The existing nginx Tailscale-IP restriction would work.

**Setup**:
- Run a small DNS server (like CoreDNS or dnsmasq) on the droplet, bound to the Tailscale interface, serving a zone that resolves `your-domain.example` to the droplet's Tailscale IP
- In Tailscale admin console, add a restricted nameserver pointing to the droplet's Tailscale IP for the `your-domain.example` domain
- Enable "Override local DNS" in Tailscale settings

**Pros**:
- Traffic stays on the tailnet (encrypted, authenticated)
- No additional auth layer needed (Tailscale IS the auth)
- No extra services exposed to the internet

**Cons**:
- Documented iOS bugs: when Tailscale DNS settings are enabled alongside custom DNS providers on iOS, resolution can break
- If Tailscale is disconnected (battery saver, VPN conflict), the app becomes inaccessible
- HTTPS cert for `your-domain.example` expects the public IP; connecting via Tailscale IP may cause cert validation issues unless the cert covers the domain regardless of IP (Let's Encrypt certs do, so this should be fine)
- Extra DNS infrastructure to maintain (even if small)
- App is ONLY accessible when on the tailnet (no fallback)

**Complexity**: Medium. 30-60 minutes. But iOS DNS quirks may require debugging.

**Verdict**: Clever idea but fragile on iOS. The documented DNS bugs on iPhone make this risky.

---

## Option 7: App-Level Session Auth (Built into the Lifeplan App)

**How it works**: Add a login page to the lifeplan app itself. Username/password (or passkey) stored in the app's database. Session cookie after login.

**Pros**:
- Full control over UX (custom login page, "remember me", etc.)
- No external dependencies
- Can add features later (passkeys, 2FA)

**Cons**:
- Development time to build login, session management, CSRF protection, password hashing
- Security responsibility falls on the app code (easy to get wrong)
- Every app endpoint needs auth middleware
- Yet another password to manage

**Complexity**: Medium-High. Several hours of development, plus ongoing security maintenance.

**Verdict**: Makes sense if the app will eventually need user-scoped data or multi-user support. Overkill for "just lock the door" on a personal app.

---

## Option 8: Other Approaches

### 8a: IP Allowlisting (Cloudflare or nginx)
Restrict to Cam's home IP. Breaks when on mobile or if ISP changes IP. Not viable for iPhone-on-the-go.

### 8b: Wireguard VPN (non-Tailscale)
Same concept as Tailscale but manual setup. More work, no advantage. Tailscale is already installed.

### 8c: SSH Tunnel / Port Forwarding
`ssh -L 8080:localhost:3000 droplet` then access `localhost:8080`. Works on Mac, impossible on iPhone without paid apps. Not viable.

### 8d: Cloudflare Access with Tunnel, keeping nginx
Use Cloudflare Tunnel but still run nginx on the droplet for routing/SSL termination. Cloudflare Access handles auth, nginx handles app routing. This is effectively Option 4 with nginx staying in the picture for internal routing. Perfectly valid.

---

## Recommendation: Ranked by Simplicity and Fitness

| Rank | Option | Why |
|------|--------|-----|
| 1 | **HTTP Basic Auth** | 5-minute setup, zero dependencies, works on iPhone, good enough for a personal app. Start here. |
| 2 | **Cloudflare Tunnel + Access** | Best long-term solution. Zero open ports, proper auth, free tier. Worth the 30-45 min setup if Cam wants it done "right". |
| 3 | **oauth2-proxy + Google** | Good middle ground if Google login is preferred over a password. More moving parts than Basic Auth. |
| 4 | **Tailscale Split DNS** | Elegant in theory, iOS DNS bugs make it unreliable. |
| 5 | **App-level auth** | Save for later if the app needs user features. |
| 6 | **Authelia** | Overkill for one user. |
| 7 | **mTLS** | Too painful on iOS. |
| 8 | **Tailscale Funnel** | Doesn't support custom domains. Dead end. |

### My Actual Recommendation

**Start with HTTP Basic Auth today** (5 minutes, immediate security). If it feels limiting or you want a cleaner experience later, **migrate to Cloudflare Tunnel + Access** (the email OTP option requires zero OAuth setup -- Cloudflare just emails a code to your address, you click it, done).

Both work perfectly on iPhone Safari. Both require zero special apps beyond what's already installed.
