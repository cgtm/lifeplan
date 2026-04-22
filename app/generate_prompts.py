#!/usr/bin/env python3
"""
lifeplan -- prompt generation engine
Analyses the database and generates gentle, Socratic prompts from Reed.
Run standalone or import maybe_generate_prompts() for on-app-open refresh.
"""

import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from app.db import get_db, now_utc, rows_to_dicts

OLLAMA_URL = "http://localhost:11434/api/chat"
OLLAMA_MODEL = "mistral"
OLLAMA_TIMEOUT = 45

MAX_ACTIVE_PROMPTS = 5

COOLDOWNS = {
    "stale_goal": 14,
    "activity_gap": 7,
    "pattern": 30,
    "blocker_awareness": 14,
    "knowledge_gap": 21,
    "elicitation": 21,
    "milestone": 7,
}


def fingerprint(prompt_type, source_key, rule):
    raw = f"{prompt_type}:{source_key}:{rule}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def can_insert(conn, fp, prompt_type):
    cooldown_days = COOLDOWNS.get(prompt_type, 14)
    cutoff = (datetime.now(timezone.utc) - timedelta(days=cooldown_days)).strftime(
        "%Y-%m-%d %H:%M:%S"
    )
    row = conn.execute(
        "SELECT id FROM prompts WHERE fingerprint = ? AND "
        "(status = 'active' OR status = 'seen' OR generated_at > ?)",
        (fp, cutoff),
    ).fetchone()
    return row is None


def active_prompt_count(conn):
    row = conn.execute(
        "SELECT COUNT(*) as c FROM prompts WHERE status IN ('active', 'seen')"
    ).fetchone()
    return row["c"]


def insert_prompt(conn, prompt_type, title, body, priority, source_type, source_id,
                  trigger_rule, fp, expires_days=None):
    if active_prompt_count(conn) >= MAX_ACTIVE_PROMPTS:
        return False
    if not can_insert(conn, fp, prompt_type):
        return False

    ts = now_utc()
    expires_at = None
    if expires_days:
        expires_at = (
            datetime.now(timezone.utc) + timedelta(days=expires_days)
        ).strftime("%Y-%m-%d %H:%M:%S")

    conn.execute(
        "INSERT INTO prompts (prompt_type, title, body, priority, status, "
        "source_type, source_id, trigger_rule, fingerprint, generated_at, expires_at) "
        "VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)",
        (prompt_type, title, body, priority, source_type, source_id,
         trigger_rule, fp, ts, expires_at),
    )
    return True


def is_seoul_blocker(conn, goal_id):
    row = conn.execute(
        "SELECT id FROM dependencies WHERE blocker_type = 'goal' AND blocker_id = ? "
        "AND blocked_type = 'goal' AND blocked_id = 1 AND resolved = 0",
        (goal_id,),
    ).fetchone()
    return row is not None


# ── Rule-based triggers ──────────────────────────────────────

def check_stale_goals(conn):
    rows = conn.execute(
        "SELECT g.id, g.title, g.updated_at, "
        "MAX(COALESCE(t.updated_at, g.updated_at)) as last_activity "
        "FROM goals g "
        "LEFT JOIN tasks t ON t.goal_id = g.id "
        "WHERE g.status = 'active' "
        "GROUP BY g.id "
        "HAVING last_activity < datetime('now', '-14 days')"
    ).fetchall()

    count = 0
    for r in rows:
        goal = dict(r)
        days_ago = (
            datetime.now(timezone.utc)
            - datetime.strptime(goal["last_activity"], "%Y-%m-%d %H:%M:%S").replace(
                tzinfo=timezone.utc
            )
        ).days

        priority = 1 if is_seoul_blocker(conn, goal["id"]) else 2
        fp = fingerprint("stale_goal", str(goal["id"]), "no_task_update_14d")

        title = f"I noticed \"{goal['title']}\" has been quiet"
        body = (
            f"It's been about {days_ago} days since anything moved on this goal. "
            f"That might be perfectly fine -- sometimes goals need breathing room. "
            f"But if it's slipped off your radar, even one small step could help. "
            f"What's the smallest thing you could do this week to nudge it forward?"
        )

        if insert_prompt(conn, "stale_goal", title, body, priority,
                         "goal", goal["id"], "no_task_update_14d", fp, expires_days=14):
            count += 1
    return count


def check_activity_gaps(conn):
    count = 0

    row = conn.execute(
        "SELECT MAX(captured_at) as last_dump FROM brain_dumps"
    ).fetchone()
    if row and row["last_dump"]:
        last_dump = datetime.strptime(row["last_dump"], "%Y-%m-%d %H:%M:%S").replace(
            tzinfo=timezone.utc
        )
        days_since = (datetime.now(timezone.utc) - last_dump).days
        if days_since >= 10:
            fp = fingerprint("activity_gap", "brain_dump", "no_dump_10d")
            title = "I'm curious how things are going"
            body = (
                f"It's been {days_since} days since your last brain dump. "
                f"No pressure at all -- sometimes life just flows and doesn't need capturing. "
                f"But if thoughts have been building up, even a quick sentence or two "
                f"can help clear the mental queue."
            )
            if insert_prompt(conn, "activity_gap", title, body, 2,
                             None, None, "no_dump_10d", fp, expires_days=7):
                count += 1

    row = conn.execute(
        "SELECT MAX(entry_date) as last_entry FROM journal_entries"
    ).fetchone()
    if row and row["last_entry"]:
        try:
            last_entry = datetime.strptime(row["last_entry"], "%Y-%m-%d")
            days_since = (datetime.now(timezone.utc).replace(tzinfo=None) - last_entry).days
            if days_since >= 14:
                fp = fingerprint("activity_gap", "journal", "no_journal_14d")
                title = "Your journal is waiting whenever you're ready"
                body = (
                    f"It's been about {days_since} days since your last journal entry. "
                    f"Journaling works best when it's not a chore. If you've been busy, "
                    f"that's completely valid. But if you've had moments worth capturing, "
                    f"even a few lines can be worth it later."
                )
                if insert_prompt(conn, "activity_gap", title, body, 3,
                                 None, None, "no_journal_14d", fp, expires_days=7):
                    count += 1
        except (ValueError, TypeError):
            pass

    return count


def check_blocker_awareness(conn):
    rows = conn.execute(
        "SELECT g.id, g.title, COUNT(d.id) as stalled_blockers "
        "FROM goals g "
        "JOIN dependencies d ON d.blocked_type = 'goal' AND d.blocked_id = g.id "
        "AND d.resolved = 0 "
        "WHERE g.status = 'active' "
        "GROUP BY g.id "
        "HAVING stalled_blockers >= 2"
    ).fetchall()

    count = 0
    for r in rows:
        goal = dict(r)
        fp = fingerprint("blocker_awareness", str(goal["id"]), "multi_blockers")

        blocker_rows = conn.execute(
            "SELECT "
            "CASE d.blocker_type "
            "  WHEN 'goal' THEN (SELECT title FROM goals WHERE id = d.blocker_id) "
            "  WHEN 'task' THEN (SELECT title FROM tasks WHERE id = d.blocker_id) "
            "  WHEN 'external_system' THEN (SELECT name FROM external_systems WHERE id = d.blocker_id) "
            "END AS blocker_name "
            "FROM dependencies d "
            "WHERE d.blocked_type = 'goal' AND d.blocked_id = ? AND d.resolved = 0",
            (goal["id"],),
        ).fetchall()
        blocker_names = [b["blocker_name"] for b in blocker_rows if b["blocker_name"]]

        title = f"\"{goal['title']}\" has several things in its way"
        body = (
            f"There are {goal['stalled_blockers']} unresolved blockers for this goal: "
            f"{', '.join(blocker_names)}. "
            f"Sometimes when multiple things are blocking progress, it helps to pick "
            f"just one and focus there. Which of these feels most within your control right now?"
        )

        if insert_prompt(conn, "blocker_awareness", title, body, 1,
                         "goal", goal["id"], "multi_blockers", fp, expires_days=14):
            count += 1
    return count


def check_knowledge_gaps(conn):
    rows = conn.execute(
        "SELECT DISTINCT t.name as tag_name, t.id as tag_id "
        "FROM tags t "
        "LEFT JOIN goal_tags gt ON gt.tag_id = t.id "
        "LEFT JOIN goals g ON g.id = gt.goal_id AND g.status = 'active' "
        "LEFT JOIN task_tags tt ON tt.tag_id = t.id "
        "LEFT JOIN tasks tk ON tk.id = tt.task_id AND tk.status = 'active' "
        "WHERE (g.id IS NOT NULL OR tk.id IS NOT NULL) "
        "AND t.id NOT IN ("
        "  SELECT kt.tag_id FROM knowledge_tags kt"
        ")"
    ).fetchall()

    count = 0
    for r in rows:
        tag = dict(r)
        fp = fingerprint("knowledge_gap", tag["tag_name"], "no_knowledge_for_tag")

        title = f"I'm curious about your knowledge on \"{tag['tag_name']}\""
        body = (
            f"You have active goals or tasks tagged with \"{tag['tag_name']}\" "
            f"but no knowledge items stored for this topic yet. "
            f"If you've learned anything useful, making a quick note could help "
            f"future-you when this comes up again."
        )

        if insert_prompt(conn, "knowledge_gap", title, body, 3,
                         None, None, "no_knowledge_for_tag", fp, expires_days=21):
            count += 1
    return count


def check_elicitation(conn):
    count = 0

    rows = conn.execute(
        "SELECT id, title FROM goals "
        "WHERE status = 'active' AND target_date IS NULL"
    ).fetchall()
    for r in rows:
        goal = dict(r)
        fp = fingerprint("elicitation", str(goal["id"]), "no_target_date")

        title = f"When would you like \"{goal['title']}\" to happen?"
        body = (
            f"This goal doesn't have a target date yet. That's fine if it's open-ended, "
            f"but if you have even a rough timeframe in mind, setting one can help "
            f"the team understand your priorities better."
        )

        if insert_prompt(conn, "elicitation", title, body, 3,
                         "goal", goal["id"], "no_target_date", fp, expires_days=21):
            count += 1

    rows = conn.execute(
        "SELECT g.id, g.title "
        "FROM goals g "
        "WHERE g.status = 'active' "
        "AND NOT EXISTS ("
        "  SELECT 1 FROM tasks t WHERE t.goal_id = g.id AND t.status = 'active'"
        ")"
    ).fetchall()
    for r in rows:
        goal = dict(r)
        fp = fingerprint("elicitation", str(goal["id"]), "no_active_tasks")

        title = f"\"{goal['title']}\" has no active next steps"
        body = (
            f"This goal is marked active but there are no active tasks under it. "
            f"What's the very next concrete thing that needs to happen here? "
            f"Even just defining one small task can create forward momentum."
        )

        if insert_prompt(conn, "elicitation", title, body, 2,
                         "goal", goal["id"], "no_active_tasks", fp, expires_days=21):
            count += 1

    return count


def check_milestones(conn):
    count = 0
    now = datetime.now(timezone.utc)

    week_start = (now - timedelta(days=now.weekday())).strftime("%Y-%m-%d 00:00:00")
    row = conn.execute(
        "SELECT COUNT(*) as c FROM tasks WHERE status = 'completed' "
        "AND completed_at >= ?",
        (week_start,),
    ).fetchone()
    if row and row["c"] >= 3:
        fp = fingerprint("milestone", "tasks_week", f"3_tasks_week_{week_start[:10]}")
        title = f"You've completed {row['c']} tasks this week"
        body = (
            f"That's real momentum. Take a moment to appreciate the progress -- "
            f"sometimes it's easy to focus on what's left and miss how much you've actually done."
        )
        if insert_prompt(conn, "milestone", title, body, 3,
                         None, None, "3_tasks_week", fp, expires_days=7):
            count += 1

    month_start = now.replace(day=1).strftime("%Y-%m-%d 00:00:00")
    row = conn.execute(
        "SELECT COUNT(*) as c FROM tasks WHERE status = 'completed' "
        "AND completed_at >= ?",
        (month_start,),
    ).fetchone()
    if row and row["c"] >= 5:
        fp = fingerprint("milestone", "tasks_month", f"5_tasks_month_{month_start[:7]}")
        title = f"You've knocked out {row['c']} tasks this month"
        body = (
            f"That's a solid amount of progress. Worth noting, worth being proud of."
        )
        if insert_prompt(conn, "milestone", title, body, 3,
                         None, None, "5_tasks_month", fp, expires_days=7):
            count += 1

    row = conn.execute(
        "SELECT COUNT(*) as c FROM brain_dumps WHERE captured_at >= ?",
        (week_start,),
    ).fetchone()
    if row and row["c"] >= 3:
        fp = fingerprint("milestone", "dumps_week", f"3_dumps_week_{week_start[:10]}")
        title = f"You've captured {row['c']} brain dumps this week"
        body = (
            f"You're building a consistent capture habit. "
            f"That's one of the hardest parts of a system like this -- the showing-up."
        )
        if insert_prompt(conn, "milestone", title, body, 3,
                         None, None, "3_dumps_week", fp, expires_days=7):
            count += 1

    yesterday = (now - timedelta(days=1)).strftime("%Y-%m-%d %H:%M:%S")
    rows = conn.execute(
        "SELECT id, title FROM goals WHERE status = 'completed' "
        "AND completed_at >= ?",
        (yesterday,),
    ).fetchall()
    for r in rows:
        goal = dict(r)
        fp = fingerprint("milestone", str(goal["id"]), "goal_completed")
        title = f"You completed \"{goal['title']}\""
        body = (
            f"This is worth celebrating. A completed goal isn't just a checkbox -- "
            f"it's the result of many smaller decisions and actions. Well done."
        )
        if insert_prompt(conn, "milestone", title, body, 1,
                         "goal", goal["id"], "goal_completed", fp, expires_days=7):
            count += 1

    return count


def check_patterns(conn):
    cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).strftime(
        "%Y-%m-%d %H:%M:%S"
    )
    rows = conn.execute(
        "SELECT t.name, COUNT(*) as cnt "
        "FROM brain_dump_tags bdt "
        "JOIN tags t ON t.id = bdt.tag_id "
        "JOIN brain_dumps bd ON bd.id = bdt.brain_dump_id "
        "WHERE bd.captured_at >= ? "
        "GROUP BY t.name "
        "HAVING cnt >= 3 "
        "ORDER BY cnt DESC",
        (cutoff,),
    ).fetchall()

    count = 0
    for r in rows:
        tag = dict(r)
        fp = fingerprint("pattern", tag["name"], "recurring_tag_30d")

        title = f"\"{tag['name']}\" keeps coming up in your captures"
        body = (
            f"This tag has appeared {tag['cnt']} times in your brain dumps over the last 30 days. "
            f"That suggests it's occupying meaningful space in your thinking. "
            f"Is there something about this topic that deserves its own goal or task, "
            f"or is it already well-handled?"
        )

        if insert_prompt(conn, "pattern", title, body, 2,
                         None, None, "recurring_tag_30d", fp, expires_days=30):
            count += 1
    return count


# ── LLM analysis ────────────────────────────────────────────

def build_llm_summary(conn):
    goals = rows_to_dicts(
        conn.execute(
            "SELECT id, title, status, target_date, updated_at FROM goals "
            "ORDER BY status, id"
        ).fetchall()
    )

    recent_dumps = rows_to_dicts(
        conn.execute(
            "SELECT content, captured_at FROM brain_dumps "
            "ORDER BY captured_at DESC LIMIT 10"
        ).fetchall()
    )

    recent_tasks = rows_to_dicts(
        conn.execute(
            "SELECT t.title, t.status, t.updated_at, g.title as goal_title "
            "FROM tasks t LEFT JOIN goals g ON t.goal_id = g.id "
            "ORDER BY t.updated_at DESC LIMIT 15"
        ).fetchall()
    )

    stalled = rows_to_dicts(
        conn.execute(
            "SELECT title FROM goals WHERE status = 'stalled'"
        ).fetchall()
    )

    summary = "SYSTEM SUMMARY FOR ANALYSIS\n\n"
    summary += "Goals:\n"
    for g in goals:
        summary += f"  - {g['title']} [{g['status']}]"
        if g["target_date"]:
            summary += f" target: {g['target_date']}"
        summary += f" (last updated: {g['updated_at']})\n"

    if stalled:
        summary += "\nStalled goals:\n"
        for g in stalled:
            summary += f"  - {g['title']}\n"

    summary += "\nRecent brain dumps (last 10):\n"
    for d in recent_dumps:
        summary += f"  [{d['captured_at']}] {d['content'][:150]}\n"

    summary += "\nRecent task activity:\n"
    for t in recent_tasks:
        summary += f"  - {t['title']} [{t['status']}]"
        if t["goal_title"]:
            summary += f" (goal: {t['goal_title']})"
        summary += f" updated: {t['updated_at']}\n"

    return summary


def call_ollama_for_patterns(summary):
    messages = [
        {
            "role": "system",
            "content": (
                "You are Reed, a knowledge architect helping someone manage their life goals. "
                "Your tone is warm, Socratic, and never nagging. You notice patterns and ask "
                "gentle questions. You say things like 'I noticed...', 'I'm curious about...'. "
                "You offer small steps, not grand plans. You acknowledge valid reasons for inactivity."
            ),
        },
        {
            "role": "user",
            "content": (
                f"Here is a summary of the current lifeplan database state:\n\n{summary}\n\n"
                "Based on this data, identify 0-3 cross-cutting observations that the rule-based "
                "checks might miss. Look for:\n"
                "- Emotional themes across brain dumps\n"
                "- Goals that seem to be competing for attention\n"
                "- Patterns in when/how captures happen\n"
                "- Reframing opportunities (e.g. a 'stalled' goal that's actually waiting on something valid)\n\n"
                "Return ONLY a JSON array of 0-3 objects with this structure:\n"
                '[\n'
                '  {\n'
                '    "title": "short observation title",\n'
                '    "body": "warm, specific observation in Reed\'s voice (2-3 sentences)",\n'
                '    "prompt_type": "pattern",\n'
                '    "priority": 2\n'
                '  }\n'
                ']\n\n'
                "If nothing stands out, return an empty array []. Return ONLY valid JSON."
            ),
        },
    ]

    payload = json.dumps({
        "model": OLLAMA_MODEL,
        "messages": messages,
        "stream": False,
        "format": "json",
    }).encode("utf-8")

    req = urllib.request.Request(
        OLLAMA_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=OLLAMA_TIMEOUT) as resp:
            body = resp.read().decode("utf-8")
            result = json.loads(body)
            content = result.get("message", {}).get("content", "")
            parsed = json.loads(content)
            if isinstance(parsed, dict) and "observations" in parsed:
                parsed = parsed["observations"]
            if isinstance(parsed, list):
                return parsed[:3]
            return []
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError,
            OSError, TimeoutError, ValueError, KeyError) as e:
        print(f"  [ollama] LLM pattern analysis unavailable: {type(e).__name__}: {e}")
        return []


def run_llm_analysis(conn):
    summary = build_llm_summary(conn)
    observations = call_ollama_for_patterns(summary)

    count = 0
    for obs in observations:
        if not isinstance(obs, dict):
            continue
        title = obs.get("title", "").strip()
        body = obs.get("body", "").strip()
        if not title or not body:
            continue

        prompt_type = "pattern"
        priority = min(max(obs.get("priority", 2), 1), 3)
        fp = fingerprint(prompt_type, "llm", title[:40])

        if insert_prompt(conn, prompt_type, title, body, priority,
                         None, None, "llm_analysis", fp, expires_days=14):
            count += 1

    return count


# ── Expiration ──────────────────────────────────────────────

def expire_old_prompts(conn):
    ts = now_utc()
    conn.execute(
        "UPDATE prompts SET status = 'expired', resolved_at = ? "
        "WHERE status IN ('active', 'seen') AND expires_at IS NOT NULL AND expires_at < ?",
        (ts, ts),
    )


# ── Main generation ─────────────────────────────────────────

def generate_prompts():
    conn = get_db()
    try:
        expire_old_prompts(conn)

        total = 0
        total += check_stale_goals(conn)
        total += check_activity_gaps(conn)
        total += check_blocker_awareness(conn)
        total += check_knowledge_gaps(conn)
        total += check_elicitation(conn)
        total += check_milestones(conn)
        total += check_patterns(conn)
        total += run_llm_analysis(conn)

        conn.commit()
        print(f"  [prompts] Generated {total} new prompts")
        return total
    except Exception as e:
        print(f"  [prompts] Error: {e}")
        conn.rollback()
        return 0
    finally:
        conn.close()


def maybe_generate_prompts():
    conn = get_db()
    try:
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=12)).strftime(
            "%Y-%m-%d %H:%M:%S"
        )
        row = conn.execute(
            "SELECT MAX(generated_at) as last_gen FROM prompts"
        ).fetchone()

        if row and row["last_gen"] and row["last_gen"] > cutoff:
            return

    finally:
        conn.close()

    generate_prompts()


if __name__ == "__main__":
    print("  [prompts] Running prompt generation...")
    n = generate_prompts()
    print(f"  [prompts] Done. {n} prompts created.")
