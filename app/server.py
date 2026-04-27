#!/usr/bin/env python3
"""
lifeplan — local server
Serves the frontend and provides a REST API to the SQLite database.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sys
import time
from http.cookies import SimpleCookie
from http.server import HTTPServer, SimpleHTTPRequestHandler
from socketserver import ThreadingMixIn
from urllib.parse import urlparse, parse_qs

# Allow running as both `python -m app.server` (package) and `python app/server.py` (script)
if __package__ is None or __package__ == "":
    sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
    from app import auth
    from app.db import get_db, now_utc, rows_to_dicts, get_tags_for, set_tags_for, get_entry_tags, enrich_entries
    from app.processing import (
        process_brain_dump, handle_process_brain_dump, handle_retry_brain_dump,
        handle_approve_item,
        GOAL_KEYWORDS, COMMON_WORDS, IMPERATIVE_VERBS, STEM_MAP,
        segment_text, detect_dates, detect_people, detect_tasks, match_goal,
        detect_knowledge, detect_tags, match_goal_links,
    )
    from app.handlers import (
        handle_get_entries, handle_get_entry, handle_create_entry,
        handle_update_entry, handle_delete_entry, handle_get_tags,
        handle_create_tag, handle_rename_tag, handle_merge_tag,
        handle_delete_tag, handle_get_tag_usages,
        handle_get_brain_dumps, handle_create_brain_dump,
        handle_update_brain_dump, handle_delete_brain_dump,
        handle_get_goals, handle_get_goal, handle_create_goal,
        handle_update_goal, handle_delete_goal,
        handle_get_tasks, handle_create_task, handle_update_task, handle_delete_task,
        handle_get_people, handle_get_person, handle_create_person,
        handle_update_person, handle_delete_person,
        handle_get_knowledge, handle_create_knowledge,
        handle_update_knowledge, handle_delete_knowledge,
        handle_get_dependencies, handle_get_dashboard,
        handle_get_prompts, handle_update_prompt, handle_get_prompt_count,
        handle_generate_prompts,
        enrich_goal, enrich_task, enrich_person,
    )
else:
    from . import auth
    from .db import get_db, now_utc, rows_to_dicts, get_tags_for, set_tags_for, get_entry_tags, enrich_entries
    from .processing import (
        process_brain_dump, handle_process_brain_dump, handle_retry_brain_dump,
        handle_approve_item,
        GOAL_KEYWORDS, COMMON_WORDS, IMPERATIVE_VERBS, STEM_MAP,
        segment_text, detect_dates, detect_people, detect_tasks, match_goal,
        detect_knowledge, detect_tags, match_goal_links,
    )
    from .handlers import (
        handle_get_entries, handle_get_entry, handle_create_entry,
        handle_update_entry, handle_delete_entry, handle_get_tags,
        handle_create_tag, handle_rename_tag, handle_merge_tag,
        handle_delete_tag, handle_get_tag_usages,
        handle_get_brain_dumps, handle_create_brain_dump,
        handle_update_brain_dump, handle_delete_brain_dump,
        handle_get_goals, handle_get_goal, handle_create_goal,
        handle_update_goal, handle_delete_goal,
        handle_get_tasks, handle_create_task, handle_update_task, handle_delete_task,
        handle_get_people, handle_get_person, handle_create_person,
        handle_update_person, handle_delete_person,
        handle_get_knowledge, handle_create_knowledge,
        handle_update_knowledge, handle_delete_knowledge,
        handle_get_dependencies, handle_get_dashboard,
        handle_get_prompts, handle_update_prompt, handle_get_prompt_count,
        handle_generate_prompts,
        enrich_goal, enrich_task, enrich_person,
    )

PORT = 3131

# Process-wide login throttle. State resets on restart by design.
_RATE_LIMITER = auth.RateLimiter()

# Auth event logger — writes to stderr by default (journald captures it on
# the droplet via the systemd service). No log file, no rotation: keep it
# simple. Never log passwords, hashes, salts, secrets, or full cookies.
_auth_log = logging.getLogger("lifeplan.auth")
if not logging.getLogger().handlers:
    # Configure root once if no handler is attached (idempotent for tests
    # that import this module).
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stderr,
    )

# Cap request bodies. The frontend only ever posts small JSON.
MAX_BODY_BYTES = 1 * 1024 * 1024  # 1 MiB


# ── Request handler ─────────────────────────────────────────────────

class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.json': 'application/json',
        '.png': 'image/png',
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=os.path.dirname(__file__), **kwargs)

    def end_headers(self):
        # Attach a refreshed session cookie to whatever response is in flight,
        # if _authenticate() flagged one. Cleared after use so it doesn't leak
        # into a subsequent response on the same connection.
        pending = getattr(self, "_pending_refresh_cookie", None)
        if pending:
            self.send_header("Set-Cookie", pending)
            self._pending_refresh_cookie = None
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

    def send_json(self, status, data, set_cookie: str | None = None):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", len(body))
        if set_cookie:
            self.send_header("Set-Cookie", set_cookie)
        self.end_headers()
        # RFC 7231 §4.3.2: HEAD response = GET response minus the body.
        # Same status, same headers (including Content-Length), no body.
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_no_content(self):
        """Send a 204 No Content response with no body. RFC 7231 §6.3.5:
        a 204 MUST NOT include a message body; Content-Length must be 0
        (or absent). Used by DELETE endpoints that have nothing to return."""
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def read_body(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length > MAX_BODY_BYTES:
            # Refuse oversized bodies — protects the server from a trivial DoS
            # and avoids reading megabytes into memory.
            raise ValueError("request body too large")
        raw = self.rfile.read(length)
        return json.loads(raw) if raw else {}

    # ── Auth helpers ────────────────────────────────────────────

    def _client_ip(self) -> str:
        """Best-effort client IP. Trust X-Forwarded-For only on the rightmost
        proxy hop; nginx always sets this for the real client."""
        xff = self.headers.get("X-Forwarded-For", "")
        if xff:
            # The last entry is whatever spoke to nginx; take the first as
            # the original client (nginx convention) but only as a label, not
            # for security decisions outside in-process throttling.
            return xff.split(",")[0].strip()
        return self.client_address[0] if self.client_address else ""

    def _is_https(self) -> bool:
        # Honour the proxy header. Absent (local) -> not HTTPS, no Secure flag.
        return self.headers.get("X-Forwarded-Proto", "").lower() == "https"

    def _accepts_html(self) -> bool:
        accept = self.headers.get("Accept", "")
        return "text/html" in accept

    def _get_session_cookie(self) -> str:
        raw = self.headers.get("Cookie", "")
        if not raw:
            return ""
        try:
            jar = SimpleCookie()
            jar.load(raw)
            morsel = jar.get(auth.COOKIE_NAME)
            return morsel.value if morsel else ""
        except Exception:
            return ""

    def _issue_session_cookie(self, response_headers_extra: list) -> None:
        cookie_value = auth.make_session_cookie_value(int(time.time()))
        if cookie_value:
            response_headers_extra.append(
                ("Set-Cookie", auth.set_cookie_header(cookie_value, secure=self._is_https(), path=auth.mount_path()))
            )

    def _deny(self, want_html_redirect: bool):
        """Send the right kind of denial: redirect for HTML, JSON 401 for API."""
        if want_html_redirect:
            self.send_response(302)
            # Mount-aware: auth.login_url() reads LIFEPLAN_COOKIE_PATH so the
            # redirect target tracks the cookie's Path (same env var, same
            # source of truth). Locally "/login"; mounted "/lifeplan/login".
            self.send_header("Location", auth.login_url())
            self.send_header("Content-Length", "0")
            self.end_headers()
        else:
            self.send_json(401, {"error": "unauthorized"})

    def _authenticate(self) -> bool:
        """Return True if the request may proceed. Side-effect: may write the
        denial response or refresh the session cookie."""
        parsed = urlparse(self.path)
        path = parsed.path

        # HEAD is treated as GET for auth-policy purposes (public-path match,
        # redirect vs 401 branch). RFC 7231 §4.3.2: HEAD must return the same
        # status and headers as GET. So the auth decision must be identical.
        method = "GET" if self.command == "HEAD" else self.command

        # Public paths bypass auth entirely. Login POST is also public — we
        # check method+path explicitly so a path-only check can't be tricked.
        if path in auth.PUBLIC_PATHS:
            return True
        if method == "POST" and path == "/login":
            return True

        cookie_value = self._get_session_cookie()
        now = int(time.time())
        expiry = auth.verify_session_cookie(cookie_value, now)
        if expiry is None:
            # Only log when a cookie was actually presented — anonymous
            # un-authed requests (no cookie at all) would flood the log.
            if cookie_value:
                reason = auth.classify_cookie_failure(cookie_value, now)
                _auth_log.warning(
                    "auth.cookie_invalid ip=%s reason=%s path=%s",
                    self._client_ip(), reason, path,
                )
            self._deny(want_html_redirect=self._accepts_html() and method == "GET")
            return False

        # Sliding refresh: re-issue when past half-life. The new cookie is
        # attached to whatever response the route handler ultimately writes,
        # via self._pending_refresh_cookie which send_json/send_response read.
        if auth.should_refresh(expiry, now):
            new_value = auth.make_session_cookie_value(now)
            if new_value:
                self._pending_refresh_cookie = auth.set_cookie_header(
                    new_value, secure=self._is_https(), path=auth.mount_path()
                )
        return True

    def parse_id(self, path):
        """Extract trailing integer ID from path."""
        m = re.search(r'/(\d+)$', path)
        return int(m.group(1)) if m else None

    def route(self, method):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        params = parse_qs(parsed.query)

        # ── Auth ──

        if method == "GET" and path == "/login":
            self._serve_login_page()
            return True

        if method == "POST" and path == "/login":
            self._handle_login()
            return True

        if method == "POST" and path == "/logout":
            self._handle_logout()
            return True

        # ── Journal entries (v1 API -- preserved) ──

        if method == "GET" and path == "/api/entries":
            status, data = handle_get_entries(params)
            self.send_json(status, data)
            return True

        if method == "GET" and path.startswith("/api/entries/"):
            eid = self.parse_id(path)
            if eid is None:
                self.send_json(400, {"error": "Invalid entry ID"})
                return True
            status, data = handle_get_entry(eid)
            self.send_json(status, data)
            return True

        if method == "POST" and path == "/api/entries":
            body = self.read_body()
            status, data = handle_create_entry(body)
            self.send_json(status, data)
            return True

        if method == "PUT" and path.startswith("/api/entries/"):
            eid = self.parse_id(path)
            if eid is None:
                self.send_json(400, {"error": "Invalid entry ID"})
                return True
            body = self.read_body()
            status, data = handle_update_entry(eid, body)
            self.send_json(status, data)
            return True

        if method == "DELETE" and path.startswith("/api/entries/"):
            eid = self.parse_id(path)
            if eid is None:
                self.send_json(400, {"error": "Invalid entry ID"})
                return True
            status, data = handle_delete_entry(eid)
            self.send_json(status, data)
            return True

        # ── Tags ──

        if method == "GET" and path == "/api/tags":
            status, data = handle_get_tags()
            self.send_json(status, data)
            return True

        if method == "POST" and path == "/api/tags":
            body = self.read_body()
            status, data = handle_create_tag(body)
            self.send_json(status, data)
            return True

        # /api/tags/<id>/merge — must precede the bare /api/tags/<id>
        # branches (PUT/DELETE/GET-usages) below so the regex match wins.
        if method == "POST" and re.match(r'/api/tags/\d+/merge$', path):
            tid = int(re.search(r'/api/tags/(\d+)/merge', path).group(1))
            body = self.read_body()
            status, data = handle_merge_tag(tid, body)
            self.send_json(status, data)
            return True

        if method == "GET" and re.match(r'/api/tags/\d+/usages$', path):
            tid = int(re.search(r'/api/tags/(\d+)/usages', path).group(1))
            status, data = handle_get_tag_usages(tid)
            self.send_json(status, data)
            return True

        if method == "PUT" and path.startswith("/api/tags/"):
            tid = self.parse_id(path)
            if tid is None:
                self.send_json(400, {"error": "Invalid tag ID"})
                return True
            body = self.read_body()
            status, data = handle_rename_tag(tid, body)
            self.send_json(status, data)
            return True

        if method == "DELETE" and path.startswith("/api/tags/"):
            tid = self.parse_id(path)
            if tid is None:
                self.send_json(400, {"error": "Invalid tag ID"})
                return True
            status, data = handle_delete_tag(tid)
            if status == 204:
                # 204 has no body — RFC 7231 §6.3.5.
                self.send_no_content()
            else:
                self.send_json(status, data)
            return True

        # ── Dashboard ──

        if method == "GET" and path == "/api/dashboard":
            status, data = handle_get_dashboard()
            self.send_json(status, data)
            return True

        # ── Brain dumps ──

        if method == "GET" and path == "/api/brain-dumps":
            status, data = handle_get_brain_dumps(params)
            self.send_json(status, data)
            return True

        if method == "POST" and path == "/api/brain-dumps":
            body = self.read_body()
            status, data = handle_create_brain_dump(body)
            self.send_json(status, data)
            return True

        if method == "POST" and re.match(r'/api/brain-dumps/\d+/process$', path):
            did = int(re.search(r'/api/brain-dumps/(\d+)/process', path).group(1))
            status, data = handle_process_brain_dump(did)
            self.send_json(status, data)
            return True

        if method == "POST" and re.match(r'/api/brain-dumps/\d+/retry$', path):
            did = int(re.search(r'/api/brain-dumps/(\d+)/retry', path).group(1))
            status, data = handle_retry_brain_dump(did)
            self.send_json(status, data)
            return True

        if method == "POST" and re.match(r'/api/brain-dumps/\d+/approve-item$', path):
            did = int(re.search(r'/api/brain-dumps/(\d+)/approve-item', path).group(1))
            body = self.read_body()
            status, data = handle_approve_item(did, body)
            self.send_json(status, data)
            return True

        if method == "PUT" and path.startswith("/api/brain-dumps/"):
            did = self.parse_id(path)
            if did is None:
                self.send_json(400, {"error": "Invalid ID"})
                return True
            body = self.read_body()
            status, data = handle_update_brain_dump(did, body)
            self.send_json(status, data)
            return True

        if method == "DELETE" and path.startswith("/api/brain-dumps/"):
            did = self.parse_id(path)
            if did is None:
                self.send_json(400, {"error": "Invalid ID"})
                return True
            status, data = handle_delete_brain_dump(did)
            self.send_json(status, data)
            return True

        # ── Goals ──

        if method == "GET" and path == "/api/goals":
            status, data = handle_get_goals(params)
            self.send_json(status, data)
            return True

        if method == "POST" and path == "/api/goals":
            body = self.read_body()
            status, data = handle_create_goal(body)
            self.send_json(status, data)
            return True

        if method == "GET" and path.startswith("/api/goals/"):
            gid = self.parse_id(path)
            if gid is None:
                self.send_json(400, {"error": "Invalid goal ID"})
                return True
            status, data = handle_get_goal(gid)
            self.send_json(status, data)
            return True

        if method == "PUT" and path.startswith("/api/goals/"):
            gid = self.parse_id(path)
            if gid is None:
                self.send_json(400, {"error": "Invalid goal ID"})
                return True
            body = self.read_body()
            status, data = handle_update_goal(gid, body)
            self.send_json(status, data)
            return True

        if method == "DELETE" and path.startswith("/api/goals/"):
            gid = self.parse_id(path)
            if gid is None:
                self.send_json(400, {"error": "Invalid goal ID"})
                return True
            status, data = handle_delete_goal(gid)
            self.send_json(status, data)
            return True

        # ── Tasks ──

        if method == "GET" and path == "/api/tasks":
            status, data = handle_get_tasks(params)
            self.send_json(status, data)
            return True

        if method == "POST" and path == "/api/tasks":
            body = self.read_body()
            status, data = handle_create_task(body)
            self.send_json(status, data)
            return True

        if method == "PUT" and path.startswith("/api/tasks/"):
            tid = self.parse_id(path)
            if tid is None:
                self.send_json(400, {"error": "Invalid task ID"})
                return True
            body = self.read_body()
            status, data = handle_update_task(tid, body)
            self.send_json(status, data)
            return True

        if method == "DELETE" and path.startswith("/api/tasks/"):
            tid = self.parse_id(path)
            if tid is None:
                self.send_json(400, {"error": "Invalid task ID"})
                return True
            status, data = handle_delete_task(tid)
            self.send_json(status, data)
            return True

        # ── People ──

        if method == "GET" and path == "/api/people":
            status, data = handle_get_people()
            self.send_json(status, data)
            return True

        if method == "POST" and path == "/api/people":
            body = self.read_body()
            status, data = handle_create_person(body)
            self.send_json(status, data)
            return True

        if method == "GET" and path.startswith("/api/people/"):
            pid = self.parse_id(path)
            if pid is None:
                self.send_json(400, {"error": "Invalid person ID"})
                return True
            status, data = handle_get_person(pid)
            self.send_json(status, data)
            return True

        if method == "PUT" and path.startswith("/api/people/"):
            pid = self.parse_id(path)
            if pid is None:
                self.send_json(400, {"error": "Invalid person ID"})
                return True
            body = self.read_body()
            status, data = handle_update_person(pid, body)
            self.send_json(status, data)
            return True

        if method == "DELETE" and path.startswith("/api/people/"):
            pid = self.parse_id(path)
            if pid is None:
                self.send_json(400, {"error": "Invalid person ID"})
                return True
            status, data = handle_delete_person(pid)
            self.send_json(status, data)
            return True

        # ── Knowledge ──

        if method == "GET" and path == "/api/knowledge":
            status, data = handle_get_knowledge(params)
            self.send_json(status, data)
            return True

        if method == "POST" and path == "/api/knowledge":
            body = self.read_body()
            status, data = handle_create_knowledge(body)
            self.send_json(status, data)
            return True

        if method == "PUT" and path.startswith("/api/knowledge/"):
            kid = self.parse_id(path)
            if kid is None:
                self.send_json(400, {"error": "Invalid knowledge ID"})
                return True
            body = self.read_body()
            status, data = handle_update_knowledge(kid, body)
            self.send_json(status, data)
            return True

        if method == "DELETE" and path.startswith("/api/knowledge/"):
            kid = self.parse_id(path)
            if kid is None:
                self.send_json(400, {"error": "Invalid knowledge ID"})
                return True
            status, data = handle_delete_knowledge(kid)
            self.send_json(status, data)
            return True

        # ── Dependencies ──

        if method == "GET" and path == "/api/dependencies":
            status, data = handle_get_dependencies(params)
            self.send_json(status, data)
            return True

        # ── Prompts ──

        if method == "GET" and path == "/api/prompts":
            status, data = handle_get_prompts()
            self.send_json(status, data)
            return True

        if method == "GET" and path == "/api/prompts/count":
            status, data = handle_get_prompt_count()
            self.send_json(status, data)
            return True

        if method == "POST" and path == "/api/prompts/generate":
            status, data = handle_generate_prompts()
            self.send_json(status, data)
            return True

        if method == "PUT" and path.startswith("/api/prompts/"):
            pid = self.parse_id(path)
            if pid is None:
                self.send_json(400, {"error": "Invalid prompt ID"})
                return True
            body = self.read_body()
            status, data = handle_update_prompt(pid, body)
            self.send_json(status, data)
            return True

        return False

    # ── Login / logout handlers ──────────────────────────────────

    def _serve_login_page(self):
        """GET /login. Public. Serves the login HTML directly so the path
        doesn't fall through to SimpleHTTPRequestHandler (which would look
        for a file literally named 'login' and 404)."""
        try:
            path = os.path.join(os.path.dirname(__file__), "login.html")
            with open(path, "rb") as f:
                body = f.read()
        except OSError:
            self.send_json(500, {"error": "login page missing"})
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        # HEAD: same status/headers, no body (RFC 7231 §4.3.2).
        if self.command != "HEAD":
            self.wfile.write(body)

    def _handle_login(self):
        """POST /login. Public. Rate-limited per IP. Constant-time password
        check. Sets the session cookie on success.

        No user-enumeration concern (no usernames). Equal status/body shape
        on wrong-password vs other auth failure to avoid info leak."""
        ip = self._client_ip()
        if not _RATE_LIMITER.check(ip):
            # Note: attempts-in-window is not directly tracked; the limiter
            # exposes only check/record. Logging the cap is enough for audit.
            _auth_log.warning(
                "auth.rate_limit ip=%s window_seconds=%d max=%d",
                ip, auth.RATE_LIMIT_WINDOW, auth.RATE_LIMIT_MAX,
            )
            self.send_json(429, {"error": "too many attempts"})
            return

        try:
            body = self.read_body()
        except (ValueError, json.JSONDecodeError):
            # Bad JSON still costs a rate-limit slot — treat as a failed
            # attempt so attackers can't probe with garbage indefinitely.
            _RATE_LIMITER.record(ip)
            _auth_log.warning("auth.login_failed ip=%s reason=invalid-request", ip)
            self.send_json(400, {"error": "invalid request"})
            return

        password = body.get("password") if isinstance(body, dict) else None
        if not isinstance(password, str) or not auth.verify_password(password):
            _RATE_LIMITER.record(ip)
            _auth_log.warning("auth.login_failed ip=%s reason=wrong-password", ip)
            self.send_json(401, {"ok": False})
            return

        cookie_value = auth.make_session_cookie_value(int(time.time()))
        if not cookie_value:
            # Misconfiguration: no signing secret. Fail closed; do not 200
            # without setting a cookie.
            _auth_log.error("auth.login_misconfigured ip=%s reason=no-secret", ip)
            self.send_json(500, {"error": "auth not configured"})
            return
        cookie_header = auth.set_cookie_header(
            cookie_value, secure=self._is_https(), path=auth.mount_path()
        )
        _auth_log.info("auth.login_success ip=%s", ip)
        self.send_json(200, {"ok": True}, set_cookie=cookie_header)

    def _handle_logout(self):
        """POST /logout. Auth required (caller already verified). Clears the
        cookie in the browser; statelessness means there's nothing server-side
        to revoke until LIFEPLAN_SESSION_SECRET is rotated."""
        clear = auth.clear_cookie_header(path=auth.mount_path())
        _auth_log.info("auth.logout ip=%s", self._client_ip())
        self.send_json(200, {"ok": True}, set_cookie=clear)

    # ── Method dispatch with auth + content-type gates ─────────────

    def _enforce_content_type(self) -> bool:
        """State-changing methods must declare JSON. Defence in depth against
        cross-site form posts (which default to form-urlencoded). Returns
        False after sending a 415."""
        ct = self.headers.get("Content-Type", "")
        # Allow `application/json` with optional charset parameter.
        if ct.split(";", 1)[0].strip().lower() != "application/json":
            self.send_json(415, {"error": "unsupported media type"})
            return False
        return True

    def do_GET(self):
        if not self._authenticate():
            return
        if not self.route("GET"):
            super().do_GET()

    def do_HEAD(self):
        # Practice §9: HEAD must mirror GET on every overridden route.
        # Same auth policy, same routing, same status/headers — body
        # suppression handled at the body-write sites (send_json,
        # _serve_login_page) gated on self.command == "HEAD". For static
        # files we delegate to the stdlib's do_HEAD, which correctly emits
        # headers without a body for files that exist on disk.
        if not self._authenticate():
            return
        if not self.route("GET"):
            super().do_HEAD()

    def do_POST(self):
        if not self._authenticate():
            return
        if not self._enforce_content_type():
            return
        if not self.route("POST"):
            self.send_json(404, {"error": "Not found"})

    def do_PUT(self):
        if not self._authenticate():
            return
        if not self._enforce_content_type():
            return
        if not self.route("PUT"):
            self.send_json(404, {"error": "Not found"})

    def do_DELETE(self):
        if not self._authenticate():
            return
        if not self._enforce_content_type():
            return
        if not self.route("DELETE"):
            self.send_json(404, {"error": "Not found"})

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
        daemon_threads = True
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"\n  lifeplan")
    print(f"  ────────")
    print(f"  http://localhost:{PORT}\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  stopped.\n")
        server.server_close()
