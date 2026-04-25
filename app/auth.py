"""
lifeplan — authentication primitives

Threat model
------------
Attacker: anonymous internet user reaching the public origin (post-deploy via
nginx). Reachable: every HTTP route on this server. Stops them: signed-cookie
session gated on a single scrypt-hashed password, with rate-limited login,
constant-time comparisons, HttpOnly+SameSite=Lax+Secure(prod) cookie flags,
and a Content-Type allowlist on state-changing methods.

What this does NOT protect against
----------------------------------
- A stolen `.env` (anyone with the session secret can mint cookies).
- An attacker who already has the session cookie (XSS-stolen or device-theft).
  HttpOnly mitigates JS theft; SameSite=Lax mitigates cross-site CSRF; we still
  trust whatever bearer presents the cookie.
- Per-IP login throttling is in-process; it resets on restart and is bypassable
  by an attacker with many IPs. Coarser nginx-level rate limiting is Forge's.
- Password strength. Cam picks the password.
"""

from __future__ import annotations

import getpass
import hashlib
import hmac
import os
import secrets
import sys
import time

# ── Public constants ────────────────────────────────────────────

PUBLIC_PATHS = {
    "/login",
    "/manifest.json",
    "/apple-touch-icon.png",
    "/apple-touch-icon-precomposed.png",
    "/icon-192.png",
    "/icon-512.png",
    "/favicon.ico",
}

COOKIE_NAME = "lifeplan_session"
SESSION_LIFETIME = 30 * 24 * 60 * 60  # 30 days, seconds

# Path the app is mounted under, as seen by the *browser* (i.e. before nginx
# strips the prefix). Cookie Path and the redirect Location must use this so
# both stay valid when mounted at e.g. /lifeplan/. Internal route matches
# (e.g. `path == "/login"`) use post-strip paths and are unaffected.
LIFEPLAN_MOUNT_ENV = "LIFEPLAN_COOKIE_PATH"
LOGIN_PATH = "login"  # relative, joined onto the mount

# scrypt parameters — interactive-login work factor.
SCRYPT_N = 16384
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_DKLEN = 64

# Login throttle: 5 attempts per IP per 15 minutes.
RATE_LIMIT_MAX = 5
RATE_LIMIT_WINDOW = 15 * 60


# ── .env loader (mirrors db.py, kept local so auth has no app deps) ──

_ENV_PATH = os.path.join(os.path.dirname(__file__), "..", ".env")


def _load_env():
    env = {}
    try:
        with open(_ENV_PATH, "r") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                env[key.strip()] = value.strip()
    except FileNotFoundError:
        pass
    return env


def _env(key, default=""):
    # Process env wins over .env file, so the droplet (Forge) can override.
    return os.environ.get(key) or _load_env().get(key, default)


# ── Mount + login URL ───────────────────────────────────────────

def mount_path() -> str:
    """Return the browser-visible mount prefix, normalised to end with '/'.

    Reads LIFEPLAN_COOKIE_PATH (the same env var the cookie's `Path` attribute
    uses — by definition the mount and the cookie scope are the same thing).
    Returns "/" when unset or set to "/" (local dev: no mount).

    Examples:
      unset            -> "/"
      "/"              -> "/"
      "/lifeplan"      -> "/lifeplan/"
      "/lifeplan/"     -> "/lifeplan/"
    """
    raw = _env(LIFEPLAN_MOUNT_ENV) or "/"
    raw = raw.strip() or "/"
    if not raw.startswith("/"):
        raw = "/" + raw
    if not raw.endswith("/"):
        raw = raw + "/"
    return raw


def login_url() -> str:
    """Browser-facing login URL: `<mount>login`.

    Locally with no mount this is "/login"; mounted under `/lifeplan` it is
    "/lifeplan/login". Single source of truth for any redirect to the login
    page — never hard-code "/login" elsewhere.
    """
    return mount_path() + LOGIN_PATH


# ── Password hashing ────────────────────────────────────────────

def hash_password(password: str, salt: bytes) -> str:
    """scrypt(password, salt) -> hex digest. Caller supplies the salt."""
    if not isinstance(password, str):
        raise TypeError("password must be str")
    if not isinstance(salt, (bytes, bytearray)) or len(salt) < 8:
        raise ValueError("salt must be >=8 bytes")
    digest = hashlib.scrypt(
        password.encode("utf-8"),
        salt=bytes(salt),
        n=SCRYPT_N,
        r=SCRYPT_R,
        p=SCRYPT_P,
        dklen=SCRYPT_DKLEN,
    )
    return digest.hex()


def verify_password(password: str) -> bool:
    """Constant-time check against LIFEPLAN_PASSWORD_HASH using LIFEPLAN_AUTH_SALT.

    Returns False on any error or missing config (fail closed).
    """
    if not isinstance(password, str) or not password:
        return False
    try:
        stored_hex = _env("LIFEPLAN_PASSWORD_HASH")
        salt_hex = _env("LIFEPLAN_AUTH_SALT")
        if not stored_hex or not salt_hex:
            return False
        salt = bytes.fromhex(salt_hex)
        candidate_hex = hash_password(password, salt)
        return hmac.compare_digest(candidate_hex, stored_hex)
    except Exception:
        # Fail closed — never default-allow on a parsing or crypto error.
        return False


# ── Session cookie ──────────────────────────────────────────────

def _session_secret() -> bytes:
    """Return the HMAC signing key as raw bytes, or b'' if not configured.

    Never auto-generated at runtime — that would invalidate every existing
    cookie on each restart. Cam runs `python3 -m app.auth set-password` once.
    """
    hex_secret = _env("LIFEPLAN_SESSION_SECRET")
    if not hex_secret:
        return b""
    try:
        return bytes.fromhex(hex_secret)
    except ValueError:
        return b""


def _sign(expiry: int, secret: bytes) -> str:
    msg = str(expiry).encode("ascii")
    return hmac.new(secret, msg, hashlib.sha256).hexdigest()


def make_session_cookie_value(now: int) -> str:
    """Build cookie body `<expiry>.<hmac_hex>`. Expiry = now + lifetime.

    Returns "" if no signing secret is configured (caller must treat as failure).
    """
    secret = _session_secret()
    if not secret:
        return ""
    expiry = int(now) + SESSION_LIFETIME
    return f"{expiry}.{_sign(expiry, secret)}"


def verify_session_cookie(value: str, now: int) -> int | None:
    """Return expiry int if signature valid and not expired, else None.

    Constant-time HMAC comparison. Rejects malformed input, missing secret,
    expired cookies, and any parse error — fail closed.
    """
    if not value or not isinstance(value, str):
        return None
    secret = _session_secret()
    if not secret:
        return None
    if "." not in value:
        return None
    expiry_str, _, sig_hex = value.partition(".")
    if not expiry_str or not sig_hex:
        return None
    try:
        expiry = int(expiry_str)
    except ValueError:
        return None
    expected = _sign(expiry, secret)
    # Constant-time compare to avoid timing-leak of valid prefix.
    if not hmac.compare_digest(expected, sig_hex):
        return None
    if expiry <= int(now):
        return None
    return expiry


def classify_cookie_failure(value: str, now: int) -> str:
    """Cheap diagnostic for an invalid cookie — for audit logs only.

    Mirrors the verify_session_cookie checks but returns a short reason
    string. Never used for control flow; never returns secret-derived data.
    Possible values: "missing", "no-secret", "malformed", "bad-hmac",
    "expired".
    """
    if not value or not isinstance(value, str):
        return "missing"
    secret = _session_secret()
    if not secret:
        return "no-secret"
    if "." not in value:
        return "malformed"
    expiry_str, _, sig_hex = value.partition(".")
    if not expiry_str or not sig_hex:
        return "malformed"
    try:
        expiry = int(expiry_str)
    except ValueError:
        return "malformed"
    expected = _sign(expiry, secret)
    if not hmac.compare_digest(expected, sig_hex):
        return "bad-hmac"
    if expiry <= int(now):
        return "expired"
    return "ok"


def should_refresh(expiry: int, now: int, lifetime: int = SESSION_LIFETIME) -> bool:
    """True if cookie is past half its lifetime (sliding-window refresh)."""
    remaining = expiry - int(now)
    return remaining < (lifetime // 2)


def set_cookie_header(value: str, secure: bool, path: str = "/") -> str:
    """Build a Set-Cookie header value with the right flags.

    HttpOnly (no JS access), SameSite=Lax (CSRF mitigation, allows top-level
    nav links), Secure only on HTTPS, Max-Age matches lifetime.
    """
    parts = [
        f"{COOKIE_NAME}={value}",
        f"Path={path or '/'}",
        f"Max-Age={SESSION_LIFETIME}",
        "HttpOnly",
        "SameSite=Lax",
    ]
    if secure:
        parts.append("Secure")
    return "; ".join(parts)


def clear_cookie_header(path: str = "/") -> str:
    """Set-Cookie value that expires the session cookie immediately."""
    parts = [
        f"{COOKIE_NAME}=",
        f"Path={path or '/'}",
        "Max-Age=0",
        "HttpOnly",
        "SameSite=Lax",
    ]
    return "; ".join(parts)


# ── Rate limiter ────────────────────────────────────────────────

class RateLimiter:
    """In-process per-IP fixed-window throttle for /login.

    State is a `dict[ip] -> list[float]`. Pruned on each access. Resets when
    the process restarts — acceptable for a single-user app; coarser nginx
    rate limiting is Forge's territory.
    """

    def __init__(self, max_attempts: int = RATE_LIMIT_MAX, window: int = RATE_LIMIT_WINDOW):
        self._max = max_attempts
        self._window = window
        self._hits: dict[str, list[float]] = {}

    def _prune(self, ip: str, now: float) -> list[float]:
        cutoff = now - self._window
        bucket = [t for t in self._hits.get(ip, []) if t > cutoff]
        if bucket:
            self._hits[ip] = bucket
        else:
            self._hits.pop(ip, None)
        return bucket

    def check(self, ip: str) -> bool:
        """True if the IP is still under the limit (i.e. allowed to attempt)."""
        if not ip:
            return True
        now = time.time()
        bucket = self._prune(ip, now)
        return len(bucket) < self._max

    def record(self, ip: str) -> None:
        """Record a failed attempt timestamp for this IP."""
        if not ip:
            return
        now = time.time()
        self._prune(ip, now)
        self._hits.setdefault(ip, []).append(now)


# ── CLI: set-password ───────────────────────────────────────────

def _cli_set_password(confirm: bool) -> int:
    try:
        pw = getpass.getpass("New password: ")
    except (EOFError, KeyboardInterrupt):
        print("\nAborted.", file=sys.stderr)
        return 1
    if not pw:
        print("Password cannot be empty.", file=sys.stderr)
        return 1
    if confirm:
        try:
            pw2 = getpass.getpass("Confirm password: ")
        except (EOFError, KeyboardInterrupt):
            print("\nAborted.", file=sys.stderr)
            return 1
        if pw != pw2:
            print("Passwords did not match.", file=sys.stderr)
            return 1

    salt = secrets.token_bytes(16)
    pw_hash = hash_password(pw, salt)
    session_secret = secrets.token_bytes(32).hex()

    print()
    print("# Append these three lines to .env (replace any existing values):")
    print(f"LIFEPLAN_PASSWORD_HASH={pw_hash}")
    print(f"LIFEPLAN_AUTH_SALT={salt.hex()}")
    print(f"LIFEPLAN_SESSION_SECRET={session_secret}")
    print()
    return 0


def _main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] != "set-password":
        print("Usage: python3 -m app.auth set-password [--confirm]", file=sys.stderr)
        return 2
    confirm = "--confirm" in argv[2:]
    return _cli_set_password(confirm=confirm)


if __name__ == "__main__":
    sys.exit(_main(sys.argv))
