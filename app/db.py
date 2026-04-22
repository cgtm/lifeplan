"""
lifeplan — database helpers
Database connection, utility functions, and tag helpers.
"""

import os
import sqlite3
from datetime import datetime, timezone

DB_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "lifeplan.db")


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
