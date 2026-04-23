#!/usr/bin/env python3
"""
lifeplan — local server
Serves the frontend and provides a REST API to the SQLite database.
"""

import json
import os
import re
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

# Allow running as both `python -m app.server` (package) and `python app/server.py` (script)
if __package__ is None or __package__ == "":
    sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
    from app.db import get_db, now_utc, rows_to_dicts, get_tags_for, set_tags_for, get_entry_tags, enrich_entries
    from app.processing import (
        process_brain_dump, handle_process_brain_dump, handle_approve_item,
        GOAL_KEYWORDS, COMMON_WORDS, IMPERATIVE_VERBS, STEM_MAP,
        segment_text, detect_dates, detect_people, detect_tasks, match_goal,
        detect_knowledge, detect_tags, match_goal_links,
    )
    from app.handlers import (
        handle_get_entries, handle_get_entry, handle_create_entry,
        handle_update_entry, handle_delete_entry, handle_get_tags,
        handle_get_brain_dumps, handle_create_brain_dump,
        handle_update_brain_dump, handle_delete_brain_dump,
        handle_get_goals, handle_get_goal, handle_update_goal, handle_delete_goal,
        handle_get_tasks, handle_update_task, handle_delete_task,
        handle_get_people, handle_get_person, handle_update_person, handle_delete_person,
        handle_get_knowledge, handle_update_knowledge, handle_delete_knowledge,
        handle_get_dependencies, handle_get_dashboard,
        handle_get_prompts, handle_update_prompt, handle_get_prompt_count,
        enrich_goal, enrich_task, enrich_person,
    )
else:
    from .db import get_db, now_utc, rows_to_dicts, get_tags_for, set_tags_for, get_entry_tags, enrich_entries
    from .processing import (
        process_brain_dump, handle_process_brain_dump, handle_approve_item,
        GOAL_KEYWORDS, COMMON_WORDS, IMPERATIVE_VERBS, STEM_MAP,
        segment_text, detect_dates, detect_people, detect_tasks, match_goal,
        detect_knowledge, detect_tags, match_goal_links,
    )
    from .handlers import (
        handle_get_entries, handle_get_entry, handle_create_entry,
        handle_update_entry, handle_delete_entry, handle_get_tags,
        handle_get_brain_dumps, handle_create_brain_dump,
        handle_update_brain_dump, handle_delete_brain_dump,
        handle_get_goals, handle_get_goal, handle_update_goal, handle_delete_goal,
        handle_get_tasks, handle_update_task, handle_delete_task,
        handle_get_people, handle_get_person, handle_update_person, handle_delete_person,
        handle_get_knowledge, handle_update_knowledge, handle_delete_knowledge,
        handle_get_dependencies, handle_get_dashboard,
        handle_get_prompts, handle_update_prompt, handle_get_prompt_count,
        enrich_goal, enrich_task, enrich_person,
    )

PORT = 3131


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

    def send_json(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", len(body))
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        return json.loads(raw) if raw else {}

    def parse_id(self, path):
        """Extract trailing integer ID from path."""
        m = re.search(r'/(\d+)$', path)
        return int(m.group(1)) if m else None

    def route(self, method):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        params = parse_qs(parsed.query)

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

    def do_GET(self):
        if not self.route("GET"):
            super().do_GET()

    def do_POST(self):
        if not self.route("POST"):
            self.send_json(404, {"error": "Not found"})

    def do_PUT(self):
        if not self.route("PUT"):
            self.send_json(404, {"error": "Not found"})

    def do_DELETE(self):
        if not self.route("DELETE"):
            self.send_json(404, {"error": "Not found"})

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    print(f"\n  lifeplan")
    print(f"  ────────")
    print(f"  http://localhost:{PORT}\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  stopped.\n")
        server.server_close()
