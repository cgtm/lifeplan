# Contract: cookie-auth

**Authors:** Vault (server), Lumen (client)
**Status:** accepted
**Last updated:** 2026-04-23 (HEAD coverage reissue)

Retroactive contract. The cookie-auth feature shipped before this document
existed; three identical root-absolute-path bugs were the cost. This is the
reference for any future auth-touching work, and the canonical record of what
was deployed. Working document — update when reality forces a change.

## Mount story

The app is the same Python server in both environments. What differs is the
URL prefix the *browser* sees.

- **Dev mount:** `/`. `python -m app.server` listens on `127.0.0.1:3131`.
  No nginx, no prefix. `LIFEPLAN_COOKIE_PATH` is unset.
- **Prod mount:** `/lifeplan/`. nginx terminates TLS, strips the `/lifeplan`
  prefix, and proxies to `127.0.0.1:3131`. `LIFEPLAN_COOKIE_PATH=/lifeplan`
  is set in the process env so server-issued URLs and cookie scope match
  what the browser sees.

The invariant is **no root-absolute paths**, not "one mechanism." Two
mount-aware resolvers exist on the client, chosen deliberately by surface:

- **Authed app (`app/app.js:7`):** `const MOUNT = window.location.pathname.replace(/[^/]*$/, '');`
  — derived from `window.location.pathname`, always ends in `/`. All
  `fetch` and `window.location.href` go through `${MOUNT}…`. Needed
  because `app.js` issues URLs from arbitrary documents and runtime
  states (e.g. a 401-triggered redirect from any view), so the API root
  cannot be assumed to equal the current document's directory.
- **Login page (`app/login.html`):** uses *path-relative* URLs
  (`fetch('login', …)`, `window.location.href = './'`). The login
  document is itself served at `<mount>login`, so the browser's own URL
  resolution gives the right answer in both environments without any
  prefix computation. Two URL references total; the relative form is
  smaller, depends on no shared script, and is harder to break than a
  re-derived `MOUNT`. `login.html` is also deliberately decoupled from
  `app.js` and `styles.css` (both are gated content) so it can render
  pre-auth as a self-contained document.

These are different tools for different problems, not a discrepancy to
unify. A comment in `login.html` records the rationale at the call sites.
- **Server (`app/auth.py`):** `auth.login_url()` → `mount_path() + "login"`,
  where `mount_path()` reads `LIFEPLAN_COOKIE_PATH` and normalises to
  always end in `/`. Used for the 302 `Location` header.
- **Server cookie `Path`:** also `auth.mount_path()`. `server.py` calls
  `auth.set_cookie_header(..., path=auth.mount_path())` everywhere a
  cookie is issued or cleared (login, logout, sliding refresh). One
  helper, one source of truth — cookie scope and login URL agree by
  construction. Concretely: with `LIFEPLAN_COOKIE_PATH` unset the cookie
  carries `Path=/`; with `LIFEPLAN_COOKIE_PATH=/lifeplan` (or
  `/lifeplan/`) it carries `Path=/lifeplan/` (trailing slash). RFC 6265
  cookie-path-match: `Path=/lifeplan/` is sent for `/lifeplan/` and any
  sub-path. The bare `/lifeplan` is not in the user-reachable surface —
  every browser-facing URL is composed against the mount, which always
  ends in `/`.

**No root-absolute paths in user-reachable code.** This was the bug we
shipped three times. Allowed forms:

- Client JS: `fetch(MOUNT + …)`, `window.location.href = MOUNT + …`.
- Login HTML: relative `'login'`, `'./'`.
- Server: `auth.login_url()` for the login redirect; any future redirect
  uses an equivalent helper. No literal `'/login'` in `Location` headers.

## Endpoints

All paths below are **post-mount-strip** as the Python server sees them
(nginx strips `/lifeplan` before proxying). Browser-facing URLs prepend the
mount prefix.

**HEAD coverage.** Every endpoint that supports `GET` also supports `HEAD`,
returning the same status code and headers as the corresponding `GET` with
**no body** (RFC 7231 §4.3.2). This includes:

- `HEAD /login` (public) — 200, `Content-Type: text/html; charset=utf-8`,
  empty body. Public — same `_authenticate()` bypass as `GET /login`.
- `HEAD /api/*` (auth required) — same status and headers as `GET /api/*`,
  empty body. Auth policy is identical to `GET`: missing/invalid cookie
  produces 401 (no `Accept: text/html`) or 302 to `auth.login_url()` (with
  `Accept: text/html`). 401 carries an empty body; 302 already carries
  `Content-Length: 0`.
- `HEAD /` and other static document paths (auth required) — delegated to
  the stdlib `SimpleHTTPRequestHandler.do_HEAD` after auth and routing
  checks have passed. Returns headers for the resolved file with no body.

The auth middleware (`_authenticate()`) treats `HEAD` identically to `GET`
for public-path matching, redirect logic, and the 401-vs-302 branch.
Body-write sites (`send_json`, `_serve_login_page`) suppress the body when
`self.command == "HEAD"`. Practice ref: `docs/processes/team-practices.md`
§9 ("HTTP method coverage on handler overrides").

### `GET /login` (public)

Serves the static login form. Public — bypasses `_authenticate()` via the
`PUBLIC_PATHS` set (`app/auth.py:35`).

- **Request headers:** none required.
- **Request body:** none.
- **Response 200:** `Content-Type: text/html; charset=utf-8`, body is
  `app/login.html`. `Cache-Control: no-cache, no-store, must-revalidate`
  applied via `end_headers()`.
- **Response 500:** `{"error": "login page missing"}` if the HTML file
  cannot be opened (operational failure, never expected in a healthy
  deploy).

### `POST /login` (public)

Authenticates the password and issues the session cookie. Rate-limited per
client IP. Public — explicitly allowed by `_authenticate()` via a
method+path check, not just path, so a `GET /login` cannot be tricked into
the login flow.

- **Request headers:** `Content-Type: application/json` (required; the
  state-changing-method content-type gate enforces this for any POST/PUT/
  DELETE that survives `_authenticate()`, and `/login` is exempt from
  auth, not from the gate).
  **DISCREPANCY:** in fact `_enforce_content_type()` runs *after*
  `_authenticate()` returns true and *before* `route()`, so it does apply
  to `POST /login`. A wrong/missing `Content-Type` produces 415 before
  the password is ever checked — does not consume a rate-limit slot.
- **Request body:** `{"password": "<string>"}`. Bodies over 1 MiB are
  rejected. Malformed JSON is treated as a failed login attempt and *does*
  consume a rate-limit slot.
- **Response 200:** `{"ok": true}` plus `Set-Cookie: lifeplan_session=…`
  (see Cookie spec). `Content-Type: application/json; charset=utf-8`.
- **Response 401:** `{"ok": false}` — wrong password, missing password
  field, non-string password. Single shape; no user-enumeration vector
  (single-user app, no usernames anyway).
- **Response 415:** `{"error": "unsupported media type"}` — Content-Type
  is not `application/json` (optionally with charset).
- **Response 400:** `{"error": "invalid request"}` — body too large or
  not valid JSON. Consumes a rate-limit slot.
- **Response 429:** `{"error": "too many attempts"}` — IP exceeded 5
  failures in 15 minutes.
- **Response 500:** `{"error": "auth not configured"}` — server has no
  `LIFEPLAN_SESSION_SECRET`. Fail-closed: never issues a 200 without a
  cookie. Operational, not user-facing.

### `POST /logout` (auth required)

Clears the session cookie. Server has no session table — there's nothing
to revoke server-side until `LIFEPLAN_SESSION_SECRET` is rotated.

- **Request headers:** `Content-Type: application/json`. `Cookie:
  lifeplan_session=…` (verified by `_authenticate()`).
- **Request body:** `{}`.
- **Response 200:** `{"ok": true}` plus `Set-Cookie: lifeplan_session=;
  Max-Age=0; …` (clear-cookie form).
- **Response 401:** if the request had no valid session cookie. JSON body
  `{"error": "unauthorized"}` — see "all other routes" below.
- **Response 415:** if Content-Type is wrong.

### All other routes (auth required)

Every route not listed in `PUBLIC_PATHS` and not the `POST /login`
exception requires a valid session cookie.

- **Cookie missing or invalid:**
    - **HTML GET** (request `Accept` contains `text/html` and method is
      `GET`): **302** to `auth.login_url()`. `Content-Length: 0`.
    - **Anything else** (XHR/fetch, non-GET, no `Accept: text/html`):
      **401** `{"error": "unauthorized"}`.
- **Cookie valid:** request proceeds. If past half-life (15 days),
  `_authenticate()` queues a refreshed `Set-Cookie` on the response.
  See Cookie spec.
- **State-changing methods** (POST/PUT) additionally require
  `Content-Type: application/json` (or 415). **DELETE is exempt** —
  every DELETE endpoint in our contracts declares "Request body: none",
  and the gate's purpose is CSRF defence against cross-origin form
  posts. HTML forms can only issue GET or POST (HTML spec), so DELETE
  has no form-based attack surface for the gate to defend. Requiring
  `application/json` on a body-less request would be performative, not
  protective. The exemption lives in `do_DELETE` in `app/server.py`
  with the rationale inline.

## Cookie spec

- **Name:** `lifeplan_session` (`auth.COOKIE_NAME`).
- **Value format:** `<expiry_unix>.<hex(hmac_sha256(secret, str(expiry_unix)))>`
  where `secret` = `bytes.fromhex(LIFEPLAN_SESSION_SECRET)` (32 bytes).
  Built by `auth.make_session_cookie_value(now)`. Verified by
  `auth.verify_session_cookie(value, now)` using `hmac.compare_digest`.
- **Lifetime:** `SESSION_LIFETIME = 30 * 24 * 60 * 60` (30 days). Cookie
  carries `Max-Age=2592000`.
- **Sliding refresh:** `auth.should_refresh(expiry, now)` returns true
  when remaining < lifetime / 2 (i.e. the cookie is past its 15-day mid).
  On a refreshed request, `_authenticate()` queues a new `Set-Cookie` on
  the in-flight response via `self._pending_refresh_cookie`, picked up by
  the overridden `end_headers()`. The pending header is cleared after
  emission so a keep-alive connection cannot leak it onto a later
  response.
- **Flags** (built by `auth.set_cookie_header`):
    - `Path=<auth.mount_path()>` — `/` in dev, `/lifeplan/` in prod.
    - `Max-Age=2592000`.
    - `HttpOnly` — JS cannot read the cookie.
    - `SameSite=Lax` — top-level navigation still carries the cookie;
      cross-site form posts do not.
    - `Secure` — set only when `X-Forwarded-Proto: https` is present.
      Locally (no proxy header) the cookie is not `Secure`, so dev over
      plain HTTP still works.
- **Clear form** (`auth.clear_cookie_header`): `lifeplan_session=;
  Path=<auth.mount_path()>; Max-Age=0; HttpOnly; SameSite=Lax`. No
  `Secure` flag on the clear; not required to expire and would block
  clearing over HTTP in dev.
- **Stateless.** No `sessions` table. Compromise of
  `LIFEPLAN_SESSION_SECRET` mints arbitrary cookies; rotation is a
  manual env-var change followed by `lp restart` and forces every
  client to re-log-in.

## Redirects

| Trigger | Issuer | Target (relative to mount) | Composed via |
|---|---|---|---|
| Authed user not logged in, HTML GET | Server (302) | `login` | `auth.login_url()` |
| Any client `fetch` returns 401 | Client | `login` | `${MOUNT}login` (`app/app.js:165`) |
| Successful login | Client | `` (mount root) | `'./'` (relative, in `login.html`) |
| User clicks Logout (post-`POST /logout`) | Client | `login` | `${MOUNT}login` (`app/app.js:181`) |
| Logout `fetch` network error | Client | `login` | `${MOUNT}login` — redirect happens regardless |

Every entry is mount-aware. There are zero hardcoded `/login` strings on
either side.

## Error matrix

| Status | Where | Meaning | Client behaviour |
|---|---|---|---|
| 302 + `Location: <mount>login` | Any auth-required HTML GET, no/invalid cookie | Browser redirect to login page | Browser follows; user lands on login form |
| 401 `{"error":"unauthorized"}` | Any auth-required non-HTML request | XHR/fetch with no/invalid cookie | `app.js api()` redirects via `window.location.href = ${MOUNT}login` and returns a never-resolving promise so the caller doesn't error mid-redirect |
| 401 `{"ok":false}` | `POST /login` | Wrong password | `login.html` clears the input, focuses it, shows "Wrong password" |
| 429 `{"error":"too many attempts"}` | `POST /login` | Rate limit hit | `login.html` clears the input, shows "Too many attempts. Try again in a few minutes." |
| 415 `{"error":"unsupported media type"}` | POST/PUT only (DELETE is exempt — see "All other routes") | Content-Type not JSON | `login.html` falls through to "Something went wrong. Try again." (form always sends JSON, so unreachable in practice). `app.js api()` always sends JSON, same fall-through. |
| 400 `{"error":"invalid request"}` | `POST /login` | Body too large / not valid JSON | `login.html` shows "Something went wrong. Try again." |
| 500 `{"error":"auth not configured"}` | `POST /login` | Server missing `LIFEPLAN_SESSION_SECRET` | `login.html` shows "Something went wrong. Try again." Operational fault — surface in logs to Forge. |
| Network error | Any | TCP/TLS/proxy failure | `login.html` shows "Network error. Try again." `app.js api()` lets the rejection propagate to the caller. |
| 200 `{"ok":true}` + `Set-Cookie` | `POST /login` | Success | `login.html` navigates to `'./'` (mount root) |
| 200 `{"ok":true}` + clear cookie | `POST /logout` | Success | `app.js logout()` proceeds to redirect to `${MOUNT}login` |

## Security properties

What this design **does** guarantee:

- **Password compare is constant-time.** `verify_password` uses
  `hmac.compare_digest` against the scrypt hash of the candidate.
- **Cookie verify is constant-time.** Same primitive on the HMAC.
- **Signing key is persistent.** `LIFEPLAN_SESSION_SECRET` is loaded at
  startup, never auto-rotated. A restart does *not* invalidate every
  outstanding cookie. Rotation is an explicit ops act.
- **CSRF defence (partial).** `SameSite=Lax` blocks cross-site form
  posts that would otherwise carry the cookie; `Content-Type:
  application/json` gate on POST/PUT blocks the classic form-post CSRF
  (forms cannot set `Content-Type: application/json` without a
  preflighted CORS request). DELETE is exempt from the content-type
  gate because HTML forms can only issue GET/POST, so DELETE has no
  form-post attack surface — the gate would add no defence and would
  block legitimate body-less DELETE calls. Defence in depth: either
  control alone would be questionable; together they're sufficient for
  single-user scope.
- **Rate-limit on `/login`.** 5 failed attempts per IP per 15 minutes.
  Bad-JSON / oversized-body attempts also consume a slot, so probing
  with garbage costs the same as probing with passwords.
- **Cookie carries no PII.** `<expiry>.<hmac>` — no user ID (single
  user), no name, no email. Reveals only the cookie's expiry timestamp.
- **`HttpOnly`** — XSS that lands in app code cannot read the cookie.
  (XSS that lands in the login page is moot — the password is right
  there in the DOM.)
- **Fail-closed everywhere.** `verify_password`, `verify_session_cookie`,
  `make_session_cookie_value` all return falsy on any error or missing
  config; `_handle_login` 500s rather than 200-without-cookie.
- **Auth events logged to stderr / journald.** stdlib `logging` under the
  `lifeplan.auth` logger writes successful login (INFO), failed login
  (WARNING, with reason), logout (INFO), rate-limit trigger (WARNING),
  and invalid-cookie presentation (WARNING, with classified reason —
  `expired` / `bad-hmac` / `malformed` / `no-secret`). Each record carries
  the client IP (X-Forwarded-For first hop, falling back to the socket
  peer). Never logs the password, password hash, salt, signing secret,
  or full cookie value. Captured by systemd journald on the droplet.

What this design **does not** guarantee:

- **Leaked `.env`.** Anyone with `LIFEPLAN_SESSION_SECRET` mints
  arbitrary cookies. Anyone with `LIFEPLAN_PASSWORD_HASH` +
  `LIFEPLAN_AUTH_SALT` can offline-crack the password. File permissions
  (`0600`) are Forge's lane.
- **Stolen cookie.** The server trusts whatever bearer presents a valid
  cookie. No device binding, no IP pinning. `HttpOnly` mitigates JS
  theft; physical device theft and malware are out of scope.
- **In-process rate limiter.** `RateLimiter` state is a process-local
  dict. `lp restart` resets every counter to zero. Multi-IP attackers
  are unbothered. Coarser per-IP nginx throttling is Forge's lane and
  is not currently in place.
  **Triage:** queued ticket — Vault to write an infra request to Forge
  for nginx-level rate limiting. (Per practice 5: triage every
  observation.)
- **Password strength.** Cam picks the password.
- **Logging coverage.** Auth-event logging is now in place (see
  Security properties above); the default per-request access log is
  still suppressed via `log_message: pass`. The auth log records
  outcomes plus IP, not request bodies — anything beyond that (timing,
  correlation IDs, full request audit) is out of scope and would need
  its own design.

## Open questions

- ~~The `COOKIE_PATH` / `auth.mount_path()` divergence noted under
  "Mount story."~~ **Resolved (2026-04-23).** `server.py` now passes
  `auth.mount_path()` directly to `auth.set_cookie_header` /
  `auth.clear_cookie_header` everywhere a cookie is issued or cleared.
  One normaliser, one source of truth. The local `COOKIE_PATH` constant
  is gone.
- ~~The login form's path-relative technique vs `app.js`'s `MOUNT`
  constant.~~ **Resolved (2026-04-23).** Cam decided: keep both as
  deliberate design. See "Mount story" — the invariant is "no
  root-absolute paths," and each surface picks the simpler tool for its
  own URL set. Open follow-up for *Cairn*: update the practice 11 wording
  in `docs/processes/team-practices.md` ("mount-aware `fetch` and
  redirect") so it doesn't read as mandating one mechanism.
- Cookie lifetime is 30 days with sliding refresh past 15. Is that
  right for Cam's threat model (single-user PWA on personal devices)?
  Shorter = more re-logins; longer = larger window if a device is lost.
  *Cam.*
- `LIFEPLAN_SESSION_SECRET` rotation procedure is informal (edit `.env`,
  restart). Should there be a documented runbook entry, or a CLI helper
  alongside `python3 -m app.auth set-password`? *Forge for the runbook;
  Vault for the helper.*
- ~~The `_send_set_cookie` method on `Handler` is a no-op stub left
  over from an earlier refresh design.~~ **Resolved (2026-04-23).**
  Verified unused (no callers); deleted.
- Do we want server-side session revocation (a `sessions` table) for
  "log me out everywhere now" without rotating the signing secret?
  Adds DB complexity and a per-request lookup; current statelessness
  is faster and simpler. *Cam, when there's a reason.*
