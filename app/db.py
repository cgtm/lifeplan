"""
lifeplan — database helpers
Database connection, utility functions, tag helpers, and shared LLM utilities.
"""

import json
import os
import sqlite3
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

DB_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "lifeplan.db")
ENV_PATH = os.path.join(os.path.dirname(__file__), "..", ".env")

# ── Mistral cloud API config ────────────────────────────────────
MISTRAL_API_URL = "https://api.mistral.ai/v1/chat/completions"
MISTRAL_MODEL = "mistral-small-latest"
MISTRAL_TIMEOUT = 45  # seconds
_mistral_api_key = None


def _load_env():
    """Load key=value pairs from the project .env file (stdlib only)."""
    env = {}
    try:
        with open(ENV_PATH, "r") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                env[key.strip()] = value.strip()
    except FileNotFoundError:
        pass
    return env


def get_mistral_api_key():
    """Return the Mistral API key, loading from .env on first call."""
    global _mistral_api_key
    if _mistral_api_key is None:
        env = _load_env()
        _mistral_api_key = env.get("MISTRAL_API_KEY", "")
    return _mistral_api_key


def call_mistral_api(messages):
    """Call the Mistral cloud API (OpenAI-compatible chat/completions).

    messages: list of {"role": ..., "content": ...} dicts.
    Returns the parsed JSON content on success, or None on failure.
    """
    api_key = get_mistral_api_key()
    if not api_key:
        print("  [mistral] No MISTRAL_API_KEY found in .env")
        return None

    print(f"  [mistral] Calling {MISTRAL_API_URL} model={MISTRAL_MODEL}")
    payload = json.dumps({
        "model": MISTRAL_MODEL,
        "messages": messages,
        "response_format": {"type": "json_object"},
    }).encode("utf-8")

    req = urllib.request.Request(
        MISTRAL_API_URL,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )

    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=MISTRAL_TIMEOUT) as resp:
            elapsed = time.time() - t0
            body = resp.read().decode("utf-8")
            result = json.loads(body)
            content = result["choices"][0]["message"]["content"]
            parsed = json.loads(content)
            print(f"  [mistral] API success in {elapsed:.1f}s")
            return parsed
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError,
            OSError, TimeoutError, ValueError, KeyError, IndexError) as e:
        elapsed = time.time() - t0
        print(f"  [mistral] API failed in {elapsed:.1f}s: {type(e).__name__}: {e}")
        return None


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def now_utc():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def rows_to_dicts(rows):
    return [dict(r) for r in rows]


# ── Tag helpers ──────────────────────────────────────────────────

def get_tags_for(conn, junction_table, fk_column, entity_id):
    rows = conn.execute(
        f"SELECT t.id, t.name FROM tags t "
        f"JOIN {junction_table} jt ON jt.tag_id = t.id "
        f"WHERE jt.{fk_column} = ?",
        (entity_id,),
    ).fetchall()
    return rows_to_dicts(rows)


def set_tags_for(conn, junction_table, fk_column, entity_id, tag_names):
    conn.execute(f"DELETE FROM {junction_table} WHERE {fk_column} = ?", (entity_id,))
    for tag_name in tag_names:
        tag_name = tag_name.strip().lower()
        if not tag_name:
            continue
        conn.execute("INSERT OR IGNORE INTO tags (name) VALUES (?)", (tag_name,))
        tag_row = conn.execute("SELECT id FROM tags WHERE name = ?", (tag_name,)).fetchone()
        conn.execute(
            f"INSERT OR IGNORE INTO {junction_table} ({fk_column}, tag_id) VALUES (?, ?)",
            (entity_id, tag_row["id"]),
        )


def get_entry_tags(conn, entry_id):
    return get_tags_for(conn, "entry_tags", "entry_id", entry_id)


def enrich_entries(conn, entries):
    for entry in entries:
        entry["tags"] = get_entry_tags(conn, entry["id"])
    return entries
