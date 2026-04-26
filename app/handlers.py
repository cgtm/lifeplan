"""
lifeplan — API handler functions
All API handler functions for journal, brain dumps, goals, tasks, people,
knowledge, dependencies, and dashboard.
"""

import json

from .db import get_db, now_utc, rows_to_dicts, get_tags_for, set_tags_for, get_entry_tags, enrich_entries
from .processing import handle_process_brain_dump, handle_retry_brain_dump, handle_approve_item


# ── Journal entry handlers (v1 -- preserved) ─────────────────────

def handle_get_entries(params):
    conn = get_db()
    try:
        tag = params.get("tag", [None])[0]
        date = params.get("date", [None])[0]
        search = params.get("q", [None])[0]

        if tag:
            rows = conn.execute(
                "SELECT je.* FROM journal_entries je "
                "JOIN entry_tags et ON et.entry_id = je.id "
                "JOIN tags t ON t.id = et.tag_id "
                "WHERE t.name = ? ORDER BY je.entry_date DESC",
                (tag,),
            ).fetchall()
        elif date:
            rows = conn.execute(
                "SELECT * FROM journal_entries WHERE entry_date = ? "
                "ORDER BY created_at DESC",
                (date,),
            ).fetchall()
        elif search:
            rows = conn.execute(
                "SELECT * FROM journal_entries WHERE content LIKE ? "
                "ORDER BY entry_date DESC",
                (f"%{search}%",),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM journal_entries ORDER BY entry_date DESC"
            ).fetchall()

        entries = enrich_entries(conn, rows_to_dicts(rows))
        return 200, entries
    finally:
        conn.close()


def handle_get_entry(entry_id):
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT * FROM journal_entries WHERE id = ?", (entry_id,)
        ).fetchone()
        if not row:
            return 404, {"error": "Entry not found"}
        entry = dict(row)
        entry["tags"] = get_entry_tags(conn, entry["id"])
        return 200, entry
    finally:
        conn.close()


def handle_create_entry(body):
    conn = get_db()
    try:
        entry_date = body.get("entry_date")
        content = body.get("content", "")
        tag_names = body.get("tags", [])

        if not entry_date:
            return 400, {"error": "entry_date is required"}
        if not content.strip():
            return 400, {"error": "content is required"}

        ts = now_utc()
        cur = conn.execute(
            "INSERT INTO journal_entries (entry_date, content, created_at, updated_at) "
            "VALUES (?, ?, ?, ?)",
            (entry_date, content, ts, ts),
        )
        entry_id = cur.lastrowid
        set_tags_for(conn, "entry_tags", "entry_id", entry_id, tag_names)
        conn.commit()

        entry = dict(
            conn.execute("SELECT * FROM journal_entries WHERE id = ?", (entry_id,)).fetchone()
        )
        entry["tags"] = get_entry_tags(conn, entry_id)
        return 201, entry
    finally:
        conn.close()


def handle_update_entry(entry_id, body):
    conn = get_db()
    try:
        existing = conn.execute(
            "SELECT * FROM journal_entries WHERE id = ?", (entry_id,)
        ).fetchone()
        if not existing:
            return 404, {"error": "Entry not found"}

        content = body.get("content", existing["content"])
        entry_date = body.get("entry_date", existing["entry_date"])
        tag_names = body.get("tags")

        conn.execute(
            "UPDATE journal_entries SET content = ?, entry_date = ?, updated_at = ? WHERE id = ?",
            (content, entry_date, now_utc(), entry_id),
        )
        if tag_names is not None:
            set_tags_for(conn, "entry_tags", "entry_id", entry_id, tag_names)
        conn.commit()

        entry = dict(
            conn.execute("SELECT * FROM journal_entries WHERE id = ?", (entry_id,)).fetchone()
        )
        entry["tags"] = get_entry_tags(conn, entry_id)
        return 200, entry
    finally:
        conn.close()


def handle_delete_entry(entry_id):
    conn = get_db()
    try:
        existing = conn.execute(
            "SELECT * FROM journal_entries WHERE id = ?", (entry_id,)
        ).fetchone()
        if not existing:
            return 404, {"error": "Entry not found"}
        conn.execute("DELETE FROM journal_entries WHERE id = ?", (entry_id,))
        conn.commit()
        return 200, {"deleted": entry_id}
    finally:
        conn.close()


def handle_get_tags():
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT t.id, t.name, "
            "(SELECT COUNT(*) FROM entry_tags WHERE tag_id = t.id) + "
            "(SELECT COUNT(*) FROM goal_tags WHERE tag_id = t.id) + "
            "(SELECT COUNT(*) FROM task_tags WHERE tag_id = t.id) + "
            "(SELECT COUNT(*) FROM person_tags WHERE tag_id = t.id) + "
            "(SELECT COUNT(*) FROM knowledge_tags WHERE tag_id = t.id) + "
            "(SELECT COUNT(*) FROM brain_dump_tags WHERE tag_id = t.id) AS total_count "
            "FROM tags t ORDER BY total_count DESC, t.name ASC"
        ).fetchall()
        return 200, rows_to_dicts(rows)
    finally:
        conn.close()


# ── Brain dump handlers ──────────────────────────────────────────

def handle_get_brain_dumps(params):
    conn = get_db()
    try:
        processed = params.get("processed", [None])[0]
        status_filter = params.get("status", [None])[0]
        q = "SELECT * FROM brain_dumps"
        wheres = []
        args = []
        if processed is not None:
            wheres.append("processed = ?")
            args.append(int(processed))
        if status_filter:
            wheres.append("processing_status = ?")
            args.append(status_filter)
        if wheres:
            q += " WHERE " + " AND ".join(wheres)
        q += " ORDER BY captured_at DESC"
        rows = conn.execute(q, args).fetchall()
        dumps = rows_to_dicts(rows)
        for d in dumps:
            d["tags"] = get_tags_for(conn, "brain_dump_tags", "brain_dump_id", d["id"])
            if d.get("processed_items"):
                try:
                    d["processed_items"] = json.loads(d["processed_items"])
                except (json.JSONDecodeError, TypeError):
                    pass
        return 200, dumps
    finally:
        conn.close()


def handle_create_brain_dump(body):
    """
    Create a brain dump and queue it for background processing.

    Per app/contracts/background-processing.md, this handler does NOT process
    inline. It inserts the brain_dumps row with processing_status='queued' and
    a corresponding work_queue row in a single transaction, then returns 202.
    The worker (app/worker.py) picks the job up on its next tick.
    """
    conn = get_db()
    try:
        content = body.get("content", "").strip()
        if not content:
            return 400, {"error": "content is required"}
        tag_names = body.get("tags", [])
        ts = now_utc()
        cur = conn.execute(
            "INSERT INTO brain_dumps (content, captured_at, processed, processing_status, "
            "created_at, updated_at) VALUES (?, ?, 0, 'queued', ?, ?)",
            (content, ts, ts, ts),
        )
        dump_id = cur.lastrowid
        set_tags_for(conn, "brain_dump_tags", "brain_dump_id", dump_id, tag_names)
        # Same-transaction queue insert. A new dump_id is unique by construction
        # so the partial-unique-index can't reject this row at create-time, but
        # the index would catch any concurrent re-insert if one ever raced.
        conn.execute(
            "INSERT INTO work_queue (job_type, target_id, status) "
            "VALUES ('brain_dump', ?, 'queued')",
            (dump_id,),
        )
        conn.commit()
        dump = dict(conn.execute("SELECT * FROM brain_dumps WHERE id = ?", (dump_id,)).fetchone())
        dump["tags"] = get_tags_for(conn, "brain_dump_tags", "brain_dump_id", dump_id)
        return 202, dump
    finally:
        conn.close()


def handle_update_brain_dump(dump_id, body):
    conn = get_db()
    try:
        existing = conn.execute("SELECT * FROM brain_dumps WHERE id = ?", (dump_id,)).fetchone()
        if not existing:
            return 404, {"error": "Brain dump not found"}
        content = body.get("content", existing["content"])
        processed = body.get("processed", existing["processed"])
        tag_names = body.get("tags")
        processed_at = now_utc() if processed and not existing["processed"] else existing["processed_at"]
        conn.execute(
            "UPDATE brain_dumps SET content = ?, processed = ?, processed_at = ?, updated_at = ? WHERE id = ?",
            (content, processed, processed_at, now_utc(), dump_id),
        )
        if tag_names is not None:
            set_tags_for(conn, "brain_dump_tags", "brain_dump_id", dump_id, tag_names)
        conn.commit()
        dump = dict(conn.execute("SELECT * FROM brain_dumps WHERE id = ?", (dump_id,)).fetchone())
        dump["tags"] = get_tags_for(conn, "brain_dump_tags", "brain_dump_id", dump_id)
        return 200, dump
    finally:
        conn.close()


def handle_delete_brain_dump(dump_id):
    conn = get_db()
    try:
        existing = conn.execute("SELECT * FROM brain_dumps WHERE id = ?", (dump_id,)).fetchone()
        if not existing:
            return 404, {"error": "Brain dump not found"}
        conn.execute("DELETE FROM brain_dump_tags WHERE brain_dump_id = ?", (dump_id,))
        conn.execute("DELETE FROM brain_dumps WHERE id = ?", (dump_id,))
        # Cascade: drop any non-terminal work_queue rows targeting this
        # brain_dump so the worker doesn't pick up a job whose target is
        # gone. Doesn't help if the worker already claimed the row (it
        # has the dump in memory) -- BrainDumpNotFound + finalise_skipped
        # in worker.py handles that race. Belt-and-braces.
        conn.execute(
            "DELETE FROM work_queue "
            "WHERE job_type = 'brain_dump' AND target_id = ? "
            "  AND status IN ('queued','processing')",
            (dump_id,),
        )
        conn.commit()
        return 200, {"deleted": dump_id}
    finally:
        conn.close()


# ── Goal handlers ────────────────────────────────────────────────

def enrich_goal(conn, goal):
    goal["tags"] = get_tags_for(conn, "goal_tags", "goal_id", goal["id"])
    # linked people
    rows = conn.execute(
        "SELECT p.id, p.name, p.relationship, gp.role FROM people p "
        "JOIN goal_people gp ON gp.person_id = p.id WHERE gp.goal_id = ?",
        (goal["id"],),
    ).fetchall()
    goal["people"] = rows_to_dicts(rows)
    # task counts
    row = conn.execute(
        "SELECT COUNT(*) as total, "
        "SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed "
        "FROM tasks WHERE goal_id = ?",
        (goal["id"],),
    ).fetchone()
    goal["task_total"] = row["total"]
    goal["task_completed"] = row["completed"]
    # blockers (what blocks this goal)
    blocker_rows = conn.execute(
        "SELECT d.id, d.blocker_type, d.blocker_id, d.notes, d.resolved, "
        "CASE d.blocker_type "
        "  WHEN 'goal' THEN (SELECT title FROM goals WHERE id = d.blocker_id) "
        "  WHEN 'task' THEN (SELECT title FROM tasks WHERE id = d.blocker_id) "
        "  WHEN 'external_system' THEN (SELECT name FROM external_systems WHERE id = d.blocker_id) "
        "END AS blocker_name, "
        "CASE d.blocker_type "
        "  WHEN 'goal' THEN (SELECT status FROM goals WHERE id = d.blocker_id) "
        "  WHEN 'task' THEN (SELECT status FROM tasks WHERE id = d.blocker_id) "
        "  ELSE NULL "
        "END AS blocker_status "
        "FROM dependencies d WHERE d.blocked_type = 'goal' AND d.blocked_id = ?",
        (goal["id"],),
    ).fetchall()
    goal["blockers"] = rows_to_dicts(blocker_rows)
    return goal


def handle_get_goals(params):
    conn = get_db()
    try:
        status = params.get("status", [None])[0]
        q = "SELECT * FROM goals"
        args = []
        if status:
            q += " WHERE status = ?"
            args.append(status)
        q += " ORDER BY id ASC"
        rows = conn.execute(q, args).fetchall()
        goals = [enrich_goal(conn, dict(r)) for r in rows]
        return 200, goals
    finally:
        conn.close()


def handle_get_goal(goal_id):
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM goals WHERE id = ?", (goal_id,)).fetchone()
        if not row:
            return 404, {"error": "Goal not found"}
        goal = enrich_goal(conn, dict(row))
        # also include tasks
        task_rows = conn.execute(
            "SELECT * FROM tasks WHERE goal_id = ? ORDER BY status, id", (goal_id,)
        ).fetchall()
        tasks = rows_to_dicts(task_rows)
        for t in tasks:
            t["tags"] = get_tags_for(conn, "task_tags", "task_id", t["id"])
        goal["tasks"] = tasks
        return 200, goal
    finally:
        conn.close()


def handle_create_goal(body):
    """
    Create a new goals row.

    Contract: app/contracts/create-goal.md.

    - 400 {"error": "title is required"} if title missing/empty after strip.
    - 201 {full enriched row} on success; matches the row shape from
      GET /api/goals (enrich_goal output).
    - Duplicate titles are accepted (deliberate divergence from POST
      /api/people, which 409s). Pattern: People dedupe; everything
      else doesn't.
    - Default status is 'active' (matches the goals.status column
      default and CHECK enum). completed_at is always NULL on create
      even if status='completed' is sent — lifecycle changes go
      through PUT.
    - tags optional; when provided, applied via set_tags_for on the
      goal_tags junction. Omitting means no tags applied.

    Privacy: never logs title, description, or tag names.
    """
    title = (body.get("title") or "").strip()
    if not title:
        return 400, {"error": "title is required"}

    description = body.get("description", "")
    status = body.get("status", "active")
    target_date = body.get("target_date")
    tag_names = body.get("tags")

    conn = get_db()
    try:
        ts = now_utc()
        cur = conn.execute(
            "INSERT INTO goals (title, description, status, target_date, "
            "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (title, description, status, target_date, ts, ts),
        )
        goal_id = cur.lastrowid

        if tag_names is not None:
            set_tags_for(conn, "goal_tags", "goal_id", goal_id, tag_names)

        conn.commit()
        goal = dict(
            conn.execute("SELECT * FROM goals WHERE id = ?", (goal_id,)).fetchone()
        )
        return 201, enrich_goal(conn, goal)
    finally:
        conn.close()


def handle_update_goal(goal_id, body):
    conn = get_db()
    try:
        existing = conn.execute("SELECT * FROM goals WHERE id = ?", (goal_id,)).fetchone()
        if not existing:
            return 404, {"error": "Goal not found"}
        title = body.get("title", existing["title"])
        description = body.get("description", existing["description"])
        status = body.get("status", existing["status"])
        target_date = body.get("target_date", existing["target_date"])
        completed_at = None
        if status == "completed" and existing["status"] != "completed":
            completed_at = now_utc()
        elif status == "completed" and existing["status"] == "completed":
            completed_at = existing["completed_at"]
        conn.execute(
            "UPDATE goals SET title = ?, description = ?, status = ?, target_date = ?, "
            "completed_at = ?, updated_at = ? WHERE id = ?",
            (title, description, status, target_date, completed_at, now_utc(), goal_id),
        )
        tag_names = body.get("tags")
        if tag_names is not None:
            set_tags_for(conn, "goal_tags", "goal_id", goal_id, tag_names)
        conn.commit()
        goal = dict(conn.execute("SELECT * FROM goals WHERE id = ?", (goal_id,)).fetchone())
        return 200, enrich_goal(conn, goal)
    finally:
        conn.close()


def handle_delete_goal(goal_id):
    conn = get_db()
    try:
        existing = conn.execute("SELECT * FROM goals WHERE id = ?", (goal_id,)).fetchone()
        if not existing:
            return 404, {"error": "Goal not found"}
        # Count linked tasks for info
        row = conn.execute("SELECT COUNT(*) as c FROM tasks WHERE goal_id = ?", (goal_id,)).fetchone()
        task_count = row["c"]
        # Unlink tasks (set goal_id to NULL rather than deleting them)
        conn.execute("UPDATE tasks SET goal_id = NULL, updated_at = ? WHERE goal_id = ?", (now_utc(), goal_id))
        conn.execute("DELETE FROM goal_tags WHERE goal_id = ?", (goal_id,))
        conn.execute("DELETE FROM goal_people WHERE goal_id = ?", (goal_id,))
        conn.execute("DELETE FROM dependencies WHERE (blocker_type = 'goal' AND blocker_id = ?) OR (blocked_type = 'goal' AND blocked_id = ?)", (goal_id, goal_id))
        conn.execute("DELETE FROM goals WHERE id = ?", (goal_id,))
        conn.commit()
        return 200, {"deleted": goal_id, "unlinked_tasks": task_count}
    finally:
        conn.close()


# ── Task handlers ────────────────────────────────────────────────

def enrich_task(conn, task):
    task["tags"] = get_tags_for(conn, "task_tags", "task_id", task["id"])
    # goal name
    if task["goal_id"]:
        g = conn.execute("SELECT title FROM goals WHERE id = ?", (task["goal_id"],)).fetchone()
        task["goal_title"] = g["title"] if g else None
    else:
        task["goal_title"] = None
    # linked people
    rows = conn.execute(
        "SELECT p.id, p.name, p.relationship, tp.role FROM people p "
        "JOIN task_people tp ON tp.person_id = p.id WHERE tp.task_id = ?",
        (task["id"],),
    ).fetchall()
    task["people"] = rows_to_dicts(rows)
    return task


def handle_get_tasks(params):
    conn = get_db()
    try:
        status = params.get("status", [None])[0]
        goal_id = params.get("goal_id", [None])[0]
        person_id = params.get("person_id", [None])[0]

        q = "SELECT t.* FROM tasks t"
        wheres = []
        args = []
        if person_id:
            q += " JOIN task_people tp ON tp.task_id = t.id"
            wheres.append("tp.person_id = ?")
            args.append(int(person_id))
        if status:
            wheres.append("t.status = ?")
            args.append(status)
        if goal_id:
            wheres.append("t.goal_id = ?")
            args.append(int(goal_id))
        if wheres:
            q += " WHERE " + " AND ".join(wheres)
        q += " ORDER BY t.goal_id, t.id"

        rows = conn.execute(q, args).fetchall()
        tasks = [enrich_task(conn, dict(r)) for r in rows]
        return 200, tasks
    finally:
        conn.close()


def handle_create_task(body):
    """
    Create a new tasks row.

    Contract: app/contracts/create-task.md.

    - 400 {"error": "title is required"} if title missing/empty after strip.
    - 400 {"error": "goal_id does not exist"} if goal_id is a non-null
      integer that doesn't match any goals row. Avoids dangling FK.
    - 201 {full enriched row} on success; matches the row shape from
      GET /api/tasks (enrich_task output).
    - Duplicate titles are accepted (deliberate divergence from POST
      /api/people, which 409s). Pattern: People dedupe; everything
      else doesn't.
    - Default status is 'active' (matches the tasks.status column
      default and CHECK enum). completed_at is always NULL on create
      even if status='completed' is sent — lifecycle changes go
      through PUT.
    - tags optional; when provided, applied via set_tags_for on the
      task_tags junction. Omitting means no tags applied.

    Privacy: never logs title, description, or tag names.
    """
    title = (body.get("title") or "").strip()
    if not title:
        return 400, {"error": "title is required"}

    description = body.get("description", "")
    status = body.get("status", "active")
    due_date = body.get("due_date")
    goal_id = body.get("goal_id")
    tag_names = body.get("tags")

    conn = get_db()
    try:
        if goal_id is not None:
            row = conn.execute(
                "SELECT id FROM goals WHERE id = ?", (goal_id,)
            ).fetchone()
            if not row:
                return 400, {"error": "goal_id does not exist"}

        ts = now_utc()
        cur = conn.execute(
            "INSERT INTO tasks (title, description, status, due_date, goal_id, "
            "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (title, description, status, due_date, goal_id, ts, ts),
        )
        task_id = cur.lastrowid

        if tag_names is not None:
            set_tags_for(conn, "task_tags", "task_id", task_id, tag_names)

        conn.commit()
        task = dict(
            conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        )
        return 201, enrich_task(conn, task)
    finally:
        conn.close()


def handle_update_task(task_id, body):
    conn = get_db()
    try:
        existing = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if not existing:
            return 404, {"error": "Task not found"}
        title = body.get("title", existing["title"])
        description = body.get("description", existing["description"])
        status = body.get("status", existing["status"])
        due_date = body.get("due_date", existing["due_date"])
        goal_id = body.get("goal_id", existing["goal_id"])
        completed_at = None
        if status == "completed" and existing["status"] != "completed":
            completed_at = now_utc()
        elif status == "completed" and existing["status"] == "completed":
            completed_at = existing["completed_at"]
        conn.execute(
            "UPDATE tasks SET title = ?, description = ?, status = ?, due_date = ?, "
            "goal_id = ?, completed_at = ?, updated_at = ? WHERE id = ?",
            (title, description, status, due_date, goal_id, completed_at, now_utc(), task_id),
        )
        tag_names = body.get("tags")
        if tag_names is not None:
            set_tags_for(conn, "task_tags", "task_id", task_id, tag_names)
        conn.commit()
        task = dict(conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone())
        return 200, enrich_task(conn, task)
    finally:
        conn.close()


def handle_delete_task(task_id):
    conn = get_db()
    try:
        existing = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if not existing:
            return 404, {"error": "Task not found"}
        conn.execute("DELETE FROM task_tags WHERE task_id = ?", (task_id,))
        conn.execute("DELETE FROM task_people WHERE task_id = ?", (task_id,))
        conn.execute("DELETE FROM dependencies WHERE (blocker_type = 'task' AND blocker_id = ?) OR (blocked_type = 'task' AND blocked_id = ?)", (task_id, task_id))
        conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
        conn.commit()
        return 200, {"deleted": task_id}
    finally:
        conn.close()


# ── People handlers ──────────────────────────────────────────────

def enrich_person(conn, person):
    person["tags"] = get_tags_for(conn, "person_tags", "person_id", person["id"])
    # linked goals
    rows = conn.execute(
        "SELECT g.id, g.title, g.status, gp.role FROM goals g "
        "JOIN goal_people gp ON gp.goal_id = g.id WHERE gp.person_id = ?",
        (person["id"],),
    ).fetchall()
    person["goals"] = rows_to_dicts(rows)
    # linked tasks
    rows = conn.execute(
        "SELECT t.id, t.title, t.status, tp.role FROM tasks t "
        "JOIN task_people tp ON tp.task_id = t.id WHERE tp.person_id = ?",
        (person["id"],),
    ).fetchall()
    person["tasks"] = rows_to_dicts(rows)
    return person


def handle_get_people():
    conn = get_db()
    try:
        rows = conn.execute("SELECT * FROM people ORDER BY id").fetchall()
        people = [enrich_person(conn, dict(r)) for r in rows]
        return 200, people
    finally:
        conn.close()


def handle_get_person(person_id):
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM people WHERE id = ?", (person_id,)).fetchone()
        if not row:
            return 404, {"error": "Person not found"}
        return 200, enrich_person(conn, dict(row))
    finally:
        conn.close()


def handle_create_person(body):
    """
    Create a new person row.

    Contract:
      - 400 {"error": "name is required"} if name missing/empty after strip.
      - 409 {"error": "person already exists", "id": <id>} on case-insensitive
        name collision; returns the existing id so callers can navigate to it.
      - 201 {full row} on success, same shape as GET /api/people/<id>.

    Privacy: never logs the submitted name or notes.
    """
    name = (body.get("name") or "").strip()
    if not name:
        return 400, {"error": "name is required"}

    relationship = body.get("relationship", "unknown")
    notes = body.get("notes", "")
    location = body.get("location")
    tag_names = body.get("tags")

    conn = get_db()
    try:
        existing = conn.execute(
            "SELECT id FROM people WHERE name = ? COLLATE NOCASE",
            (name,),
        ).fetchone()
        if existing:
            return 409, {"error": "person already exists", "id": existing["id"]}

        ts = now_utc()
        cur = conn.execute(
            "INSERT INTO people (name, relationship, notes, location, "
            "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (name, relationship, notes, location, ts, ts),
        )
        person_id = cur.lastrowid

        if tag_names is not None:
            set_tags_for(conn, "person_tags", "person_id", person_id, tag_names)

        conn.commit()
        person = dict(
            conn.execute("SELECT * FROM people WHERE id = ?", (person_id,)).fetchone()
        )
        return 201, enrich_person(conn, person)
    finally:
        conn.close()


def handle_update_person(person_id, body):
    conn = get_db()
    try:
        existing = conn.execute("SELECT * FROM people WHERE id = ?", (person_id,)).fetchone()
        if not existing:
            return 404, {"error": "Person not found"}
        name = body.get("name", existing["name"])
        relationship = body.get("relationship", existing["relationship"])
        notes = body.get("notes", existing["notes"])
        location = body.get("location", existing["location"])
        conn.execute(
            "UPDATE people SET name = ?, relationship = ?, notes = ?, location = ?, updated_at = ? WHERE id = ?",
            (name, relationship, notes, location, now_utc(), person_id),
        )
        tag_names = body.get("tags")
        if tag_names is not None:
            set_tags_for(conn, "person_tags", "person_id", person_id, tag_names)
        conn.commit()
        person = dict(conn.execute("SELECT * FROM people WHERE id = ?", (person_id,)).fetchone())
        return 200, enrich_person(conn, person)
    finally:
        conn.close()


def handle_delete_person(person_id):
    conn = get_db()
    try:
        existing = conn.execute("SELECT * FROM people WHERE id = ?", (person_id,)).fetchone()
        if not existing:
            return 404, {"error": "Person not found"}
        conn.execute("DELETE FROM person_tags WHERE person_id = ?", (person_id,))
        conn.execute("DELETE FROM goal_people WHERE person_id = ?", (person_id,))
        conn.execute("DELETE FROM task_people WHERE person_id = ?", (person_id,))
        conn.execute("DELETE FROM people WHERE id = ?", (person_id,))
        conn.commit()
        return 200, {"deleted": person_id}
    finally:
        conn.close()


# ── Knowledge handlers ───────────────────────────────────────────

def handle_get_knowledge(params):
    conn = get_db()
    try:
        item_type = params.get("type", [None])[0]
        q_search = params.get("q", [None])[0]

        q = "SELECT * FROM knowledge_items"
        wheres = []
        args = []
        if item_type:
            wheres.append("item_type = ?")
            args.append(item_type)
        if q_search:
            wheres.append("(title LIKE ? OR content LIKE ?)")
            args.extend([f"%{q_search}%", f"%{q_search}%"])
        if wheres:
            q += " WHERE " + " AND ".join(wheres)
        q += " ORDER BY id"

        rows = conn.execute(q, args).fetchall()
        items = rows_to_dicts(rows)
        for item in items:
            item["tags"] = get_tags_for(conn, "knowledge_tags", "knowledge_id", item["id"])
        return 200, items
    finally:
        conn.close()


def handle_create_knowledge(body):
    """
    Create a new knowledge_items row.

    Contract: app/contracts/create-knowledge.md.

    - 400 {"error": "title is required"} if title missing/empty after strip.
    - 201 {full enriched row, tags []} on success; matches the row shape
      from GET /api/knowledge.
    - Duplicate titles are accepted (deliberate divergence from POST
      /api/people, which 409s). knowledge_items, especially `note`-type
      quick captures, are commonly repeat-named.
    - Default item_type is 'note' (the right default for a manually-added
      quick capture). Other valid values from the CHECK enum: fact,
      decision, learning, reference.
    - tags optional; when provided, applied via set_tags_for on the
      knowledge_tags junction. Omitting means no tags applied.

    Privacy: never logs title, content, or tag names.
    """
    title = (body.get("title") or "").strip()
    if not title:
        return 400, {"error": "title is required"}

    content = body.get("content", "")
    item_type = body.get("item_type", "note")
    tag_names = body.get("tags")

    conn = get_db()
    try:
        ts = now_utc()
        cur = conn.execute(
            "INSERT INTO knowledge_items (title, content, item_type, "
            "created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (title, content, item_type, ts, ts),
        )
        item_id = cur.lastrowid

        if tag_names is not None:
            set_tags_for(conn, "knowledge_tags", "knowledge_id", item_id, tag_names)

        conn.commit()
        item = dict(
            conn.execute("SELECT * FROM knowledge_items WHERE id = ?", (item_id,)).fetchone()
        )
        item["tags"] = get_tags_for(conn, "knowledge_tags", "knowledge_id", item_id)
        return 201, item
    finally:
        conn.close()


def handle_update_knowledge(item_id, body):
    conn = get_db()
    try:
        existing = conn.execute("SELECT * FROM knowledge_items WHERE id = ?", (item_id,)).fetchone()
        if not existing:
            return 404, {"error": "Knowledge item not found"}
        title = body.get("title", existing["title"])
        content = body.get("content", existing["content"])
        item_type = body.get("item_type", existing["item_type"])
        source = body.get("source", existing["source"])
        conn.execute(
            "UPDATE knowledge_items SET title = ?, content = ?, item_type = ?, source = ?, updated_at = ? WHERE id = ?",
            (title, content, item_type, source, now_utc(), item_id),
        )
        tag_names = body.get("tags")
        if tag_names is not None:
            set_tags_for(conn, "knowledge_tags", "knowledge_id", item_id, tag_names)
        conn.commit()
        item = dict(conn.execute("SELECT * FROM knowledge_items WHERE id = ?", (item_id,)).fetchone())
        item["tags"] = get_tags_for(conn, "knowledge_tags", "knowledge_id", item_id)
        return 200, item
    finally:
        conn.close()


def handle_delete_knowledge(item_id):
    conn = get_db()
    try:
        existing = conn.execute("SELECT * FROM knowledge_items WHERE id = ?", (item_id,)).fetchone()
        if not existing:
            return 404, {"error": "Knowledge item not found"}
        conn.execute("DELETE FROM knowledge_tags WHERE knowledge_id = ?", (item_id,))
        conn.execute("DELETE FROM knowledge_items WHERE id = ?", (item_id,))
        conn.commit()
        return 200, {"deleted": item_id}
    finally:
        conn.close()


# ── Dependencies handler ────────────────────────────────────────

def handle_get_dependencies(params):
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT d.*, "
            "CASE d.blocker_type "
            "  WHEN 'goal' THEN (SELECT title FROM goals WHERE id = d.blocker_id) "
            "  WHEN 'task' THEN (SELECT title FROM tasks WHERE id = d.blocker_id) "
            "  WHEN 'external_system' THEN (SELECT name FROM external_systems WHERE id = d.blocker_id) "
            "END AS blocker_name, "
            "CASE d.blocked_type "
            "  WHEN 'goal' THEN (SELECT title FROM goals WHERE id = d.blocked_id) "
            "  WHEN 'task' THEN (SELECT title FROM tasks WHERE id = d.blocked_id) "
            "END AS blocked_name "
            "FROM dependencies d ORDER BY d.id"
        ).fetchall()
        return 200, rows_to_dicts(rows)
    finally:
        conn.close()


# ── Prompt handlers ──────────────────────────────────────────────

def handle_get_prompts():
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT * FROM prompts WHERE status IN ('active', 'seen') "
            "ORDER BY priority ASC, generated_at DESC"
        ).fetchall()
        return 200, rows_to_dicts(rows)
    finally:
        conn.close()


def handle_update_prompt(prompt_id, body):
    conn = get_db()
    try:
        existing = conn.execute(
            "SELECT * FROM prompts WHERE id = ?", (prompt_id,)
        ).fetchone()
        if not existing:
            return 404, {"error": "Prompt not found"}

        new_status = body.get("status")
        if new_status not in ("seen", "dismissed", "acted_on"):
            return 400, {"error": "Invalid status"}

        ts = now_utc()

        if new_status == "seen" and not existing["seen_at"]:
            conn.execute(
                "UPDATE prompts SET status = ?, seen_at = ? WHERE id = ?",
                (new_status, ts, prompt_id),
            )
        elif new_status in ("dismissed", "acted_on"):
            conn.execute(
                "UPDATE prompts SET status = ?, resolved_at = ? WHERE id = ?",
                (new_status, ts, prompt_id),
            )
        else:
            conn.execute(
                "UPDATE prompts SET status = ? WHERE id = ?",
                (new_status, prompt_id),
            )

        conn.commit()
        row = conn.execute("SELECT * FROM prompts WHERE id = ?", (prompt_id,)).fetchone()
        return 200, dict(row)
    finally:
        conn.close()


def handle_get_prompt_count():
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT COUNT(*) as c FROM prompts WHERE status = 'active'"
        ).fetchone()
        return 200, {"count": row["c"]}
    finally:
        conn.close()


# ── Dashboard handler ────────────────────────────────────────────

def handle_generate_prompts():
    """
    Queue a prompt-set regeneration job. Coalesced: if a non-terminal
    prompt_generation row already exists, returns 202 without inserting.

    The 12-hour cooldown logic still lives inside
    generate_prompts.maybe_generate_prompts(), which the worker calls when it
    claims this job. If the cooldown rejects, the worker treats the job as
    done. Per app/contracts/background-processing.md.
    """
    conn = get_db()
    try:
        existing = conn.execute(
            "SELECT EXISTS (SELECT 1 FROM work_queue "
            "WHERE job_type = 'prompt_generation' "
            "AND status IN ('queued','processing')) AS has_active"
        ).fetchone()
        if existing and existing["has_active"]:
            # Coalesced — the in-flight job will satisfy this request.
            return 202, {"queued": True}
        conn.execute(
            "INSERT INTO work_queue (job_type, target_id, status) "
            "VALUES ('prompt_generation', NULL, 'queued')"
        )
        conn.commit()
        return 202, {"queued": True}
    finally:
        conn.close()


def handle_get_dashboard():
    conn = get_db()
    try:
        data = {}

        # Primary goal (Move to Seoul -- id 1)
        row = conn.execute("SELECT * FROM goals WHERE id = 1").fetchone()
        if row:
            data["primary_goal"] = enrich_goal(conn, dict(row))

        # Active goals with progress
        rows = conn.execute("SELECT * FROM goals WHERE status = 'active' ORDER BY id").fetchall()
        data["active_goals"] = [enrich_goal(conn, dict(r)) for r in rows]

        # Stalled goals
        rows = conn.execute("SELECT * FROM goals WHERE status = 'stalled' ORDER BY id").fetchall()
        data["stalled_goals"] = [enrich_goal(conn, dict(r)) for r in rows]

        # Unprocessed brain dumps count
        row = conn.execute("SELECT COUNT(*) as c FROM brain_dumps WHERE processed = 0").fetchone()
        data["unprocessed_dumps"] = row["c"]

        # Brain dumps needing review
        row = conn.execute("SELECT COUNT(*) as c FROM brain_dumps WHERE processing_status = 'needs_review'").fetchone()
        data["needs_review_count"] = row["c"]

        # Active tasks count
        row = conn.execute("SELECT COUNT(*) as c FROM tasks WHERE status = 'active'").fetchone()
        data["active_task_count"] = row["c"]

        # Completed tasks count
        row = conn.execute("SELECT COUNT(*) as c FROM tasks WHERE status = 'completed'").fetchone()
        data["completed_task_count"] = row["c"]

        # Recent brain dumps (last 5)
        rows = conn.execute(
            "SELECT * FROM brain_dumps ORDER BY captured_at DESC LIMIT 5"
        ).fetchall()
        dumps = rows_to_dicts(rows)
        for d in dumps:
            d["tags"] = get_tags_for(conn, "brain_dump_tags", "brain_dump_id", d["id"])
            if d.get("processed_items"):
                try:
                    d["processed_items"] = json.loads(d["processed_items"])
                except (json.JSONDecodeError, TypeError):
                    pass
        data["recent_dumps"] = dumps

        return 200, data
    finally:
        conn.close()
