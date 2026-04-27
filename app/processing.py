"""
lifeplan — brain dump processing engine
All regex functions, LLM functions, and the main process_brain_dump pipeline.

Privacy invariant (CONTRACT, NON-NEGOTIABLE):
  The `lifeplan.processing` logger MUST NOT receive brain-dump content,
  prompt text, person names, tag names extracted from content, or any
  other user-authored text. Only IDs, counts, type-strings, durations,
  status values, and exception type-and-message strings. This invariant
  is mirrored from app/contracts/background-processing.md "Security
  properties".
"""

import json
import logging
import re
import sqlite3
import time
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime, timezone, timedelta

from .db import get_db, now_utc, rows_to_dicts, get_tags_for, call_mistral_api, _load_env

logger = logging.getLogger("lifeplan.processing")

# Hard cap on `sqlite3.Error` message length for log lines. The contract notes
# constraint-violation messages occasionally cite the offending parameter
# value; we truncate as a best-effort hedge against user content leaking via
# error text. NOT a guarantee -- the privacy story stays "log only IDs and
# enum-shaped fields where possible."
_ERROR_MSG_TRUNCATE_LEN = 500


def _truncate_error_message(msg: str) -> str:
    """Truncate an error message to `_ERROR_MSG_TRUNCATE_LEN` chars."""
    if msg is None:
        return ""
    if len(msg) <= _ERROR_MSG_TRUNCATE_LEN:
        return msg
    return msg[:_ERROR_MSG_TRUNCATE_LEN] + "...[truncated]"


class BrainDumpNotFound(Exception):
    """Raised by process_brain_dump_for_worker when the target brain_dump row
    is gone (e.g. user deleted it after the job was queued/claimed). The
    worker treats this as a clean no-op rather than a retryable failure.
    """


class MalformedItemData(Exception):
    """LLM produced an item dict missing a required key for its branch.

    Carries `branch` (the dispatch enum value, e.g. "task") and `missing_key`
    (the absent dict key, e.g. "title"). Both fields are static enum-shaped
    strings -- safe to log per the privacy invariant.
    """

    def __init__(self, branch: str, missing_key: str):
        self.branch = branch
        self.missing_key = missing_key
        super().__init__(f"{branch}: missing required key '{missing_key}'")


class UnknownItemType(Exception):
    """`_auto_create_item` reached its dispatcher's else with no matching branch.

    Programming bug, not a data bug -- propagates to the caller.
    `itype` is LLM-supplied; the `!r` repr in the message is bounded by the
    truncation cap upstream when the worker logs it.
    """

    def __init__(self, itype: str):
        self.itype = itype
        super().__init__(f"unknown itype: {itype!r}")

_env = _load_env()
OLLAMA_URL = _env.get("OLLAMA_URL", "http://localhost:11434") + "/api/generate"
OLLAMA_MODEL = "mistral"
OLLAMA_TIMEOUT = 2  # seconds


# ── Goal keyword index (Rule 4) ─────────────────────────────────

GOAL_KEYWORDS = {
    "Move to Seoul": {
        "title_words": {"seoul", "move"},
        "keywords": {"korea", "korean", "relocate", "apartment", "housing", "visa", "immigration", "itaewon"},
    },
    "Finalise Property Settlement": {
        "title_words": {"settlement", "finalise"},
        "keywords": {"settlement", "lawyer", "solicitor", "legal", "custody", "separation", "priya", "court", "financial"},
    },
    "Move House": {
        "title_words": {"house", "move"},
        "keywords": {"packing", "lease", "rent", "landlord", "moving", "boxes", "rental"},
    },
    "Nadia's Visit (26 Sept - 8 Oct 2025)": {
        "title_words": {"nadia", "visit"},
        "keywords": {"september", "october"},
    },
    "Learn Korean": {
        "title_words": {"korean", "learn"},
        "keywords": {"language", "study", "vocabulary", "grammar", "hangul", "topik", "speaking", "phrases"},
    },
    "Attend Korean Language School in Seoul": {
        "title_words": {"language", "school"},
        "keywords": {"enrolment", "enrollment", "semester", "tuition", "student", "d-4", "d4"},
    },
    "Achieve Debt Freedom": {
        "title_words": {"debt", "freedom"},
        "keywords": {"money", "payment", "loan", "finance", "budget", "savings", "pay"},
    },
    "Work Transition": {
        "title_words": {"work", "transition"},
        "keywords": {"job", "career", "remote", "contract", "employer", "freelance"},
    },
    "Achieve Korean Proficiency": {
        "title_words": {"korean", "proficiency"},
        "keywords": {"fluency", "topik", "level", "exam"},
    },
}

# Common words that should never be detected as person names
COMMON_WORDS = {
    "the", "a", "an", "i", "we", "he", "she", "it", "they", "my", "our",
    "his", "her", "its", "their", "this", "that", "these", "those", "today",
    "tomorrow", "yesterday", "monday", "tuesday", "wednesday", "thursday",
    "friday", "saturday", "sunday", "january", "february", "march", "april",
    "may", "june", "july", "august", "september", "october", "november",
    "december", "seoul", "london", "korea", "scottish", "itaewon",
    "basingstoke", "also", "maybe", "really", "just", "still", "already",
    "finally", "important", "actually", "basically", "currently", "however",
    "new", "old", "big", "all", "some", "any", "every", "each", "first",
    "last", "next", "need", "must", "should", "would", "could", "will",
    "shall", "might", "going", "about", "after", "before", "into", "from",
    "with", "been", "have", "had", "has", "was", "were", "did", "does",
    "not", "but", "and", "for", "yet", "nor", "because", "since", "until",
    "while", "during", "through", "found", "said", "told", "met", "talked",
    "spoke", "called", "emailed", "texted", "turns", "learned", "decided",
    "chose", "agreed", "realised", "realized", "remember", "note", "task",
    "todo", "reminder", "fyi", "til", "lesson", "important", "deadline",
    "due", "target", "start", "stop", "check", "send", "call", "email",
    "text", "ask", "find", "look", "follow", "set", "sort", "book", "buy",
    "schedule", "organise", "organize", "active", "completed", "stalled",
    "waiting", "cancelled",
}

IMPERATIVE_VERBS = {
    "call", "email", "book", "buy", "send", "check", "schedule", "ask",
    "find", "look", "follow", "set", "organise", "organize", "sort",
    "arrange", "confirm", "contact", "submit", "register", "apply",
    "cancel", "renew", "update", "review", "prepare", "write", "finish",
    "complete", "pay", "transfer", "sign", "collect", "pick", "drop",
    "print", "scan", "upload", "download", "research", "investigate",
    "text", "message", "visit", "meet", "attend", "plan", "start",
    "begin", "get", "make", "take", "give",
}

# Stemming helpers (very basic)
STEM_MAP = {
    "settling": "settlement", "settled": "settlement",
    "moving": "move", "moved": "move",
    "finances": "finance", "financial": "finance",
    "korean": "korean",
    "working": "work", "worked": "work",
    "packing": "move-house",
    "legal": "legal",
    "studying": "korean",
    "learning": "korean",
    "settlement": "settlement",
    "relocate": "seoul", "relocating": "seoul",
    "budgeting": "finance",
}


def segment_text(content):
    """Split brain dump content into meaningful segments.
    Careful not to split on abbreviations like Dr., Mr., Mrs., etc.
    """
    # Split on newlines first
    lines = content.split("\n")
    segments = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        # Split long lines on sentence boundaries, but keep short ones intact
        if len(line) > 120:
            # Split on sentence-ending punctuation followed by space + capital letter
            # First, protect abbreviations by replacing them temporarily
            protected = line
            for abbr in ("Dr.", "Mr.", "Mrs.", "Ms.", "St.", "Jr.", "Sr.", "Prof.", "Rev.", "etc.", "approx."):
                protected = protected.replace(abbr, abbr.replace(".", "\x00"))
            # Now split on sentence boundaries
            parts = re.split(r'(?<=[.!?])\s+(?=[A-Z])', protected)
            for part in parts:
                part = part.replace("\x00", ".").strip()
                if part:
                    segments.append(part)
        else:
            segments.append(line)
    return segments


def detect_dates(segment, reference_date):
    """
    Rule 6: Detect dates in a text segment.
    Returns list of (date_str_iso, confidence, source_text).
    reference_date is a datetime object.
    """
    results = []
    text = segment.lower()

    # ISO 8601 dates
    for m in re.finditer(r'\b(\d{4}-\d{2}-\d{2})\b', segment):
        results.append((m.group(1), 0.95, m.group(0)))

    # Written dates: "April 25th", "25 April", "Apr 25", "May 15th"
    months_map = {
        "january": 1, "february": 2, "march": 3, "april": 4,
        "may": 5, "june": 6, "july": 7, "august": 8,
        "september": 9, "october": 10, "november": 11, "december": 12,
        "jan": 1, "feb": 2, "mar": 3, "apr": 4,
        "jun": 6, "jul": 7, "aug": 8, "sep": 9, "sept": 9,
        "oct": 10, "nov": 11, "dec": 12,
    }
    month_pattern = "|".join(months_map.keys())

    # "May 15th", "April 25"
    for m in re.finditer(
        rf'\b({month_pattern})\s+(\d{{1,2}})(?:st|nd|rd|th)?\b', text
    ):
        month_name, day = m.group(1), int(m.group(2))
        month_num = months_map.get(month_name)
        if month_num and 1 <= day <= 31:
            year = reference_date.year
            try:
                d = datetime(year, month_num, day)
                # If the date has passed, assume next year
                if d.date() < reference_date.date():
                    d = datetime(year + 1, month_num, day)
                results.append((d.strftime("%Y-%m-%d"), 0.95, m.group(0)))
            except ValueError:
                pass

    # "25 April", "25th April"
    for m in re.finditer(
        rf'\b(\d{{1,2}})(?:st|nd|rd|th)?\s+({month_pattern})\b', text
    ):
        day, month_name = int(m.group(1)), m.group(2)
        month_num = months_map.get(month_name)
        if month_num and 1 <= day <= 31:
            year = reference_date.year
            try:
                d = datetime(year, month_num, day)
                if d.date() < reference_date.date():
                    d = datetime(year + 1, month_num, day)
                results.append((d.strftime("%Y-%m-%d"), 0.95, m.group(0)))
            except ValueError:
                pass

    # Relative: "today", "tomorrow", "day after tomorrow"
    if re.search(r'\btoday\b', text):
        results.append((reference_date.strftime("%Y-%m-%d"), 0.90, "today"))
    if re.search(r'\btomorrow\b', text):
        d = reference_date + timedelta(days=1)
        results.append((d.strftime("%Y-%m-%d"), 0.90, "tomorrow"))
    if re.search(r'\bday after tomorrow\b', text):
        d = reference_date + timedelta(days=2)
        results.append((d.strftime("%Y-%m-%d"), 0.90, "day after tomorrow"))

    # Named days: "Monday", "next Tuesday", "this Friday", "by Friday"
    day_names = {
        "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
        "friday": 4, "saturday": 5, "sunday": 6,
    }
    for m in re.finditer(
        r'\b(?:next|this|by)?\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b',
        text
    ):
        day_name = m.group(1)
        target_dow = day_names[day_name]
        current_dow = reference_date.weekday()
        diff = (target_dow - current_dow) % 7
        if diff == 0:
            diff = 7  # next occurrence
        has_next = "next" in m.group(0).lower()
        if has_next:
            diff += 7 if diff <= 7 else 0
        d = reference_date + timedelta(days=diff)
        conf = 0.90 if has_next or "by" in m.group(0).lower() else 0.70
        results.append((d.strftime("%Y-%m-%d"), conf, m.group(0).strip()))

    # "next week" -> Monday of next week
    if re.search(r'\bnext week\b', text):
        current_dow = reference_date.weekday()
        days_to_monday = (7 - current_dow) % 7 + 7
        d = reference_date + timedelta(days=days_to_monday)
        # actually, next monday
        d = reference_date + timedelta(days=(7 - current_dow))
        results.append((d.strftime("%Y-%m-%d"), 0.80, "next week"))

    # "before next week" -> end of this week (Friday)
    if re.search(r'\bbefore next week\b', text):
        current_dow = reference_date.weekday()
        days_to_friday = (4 - current_dow) % 7
        if days_to_friday == 0 and current_dow > 4:
            days_to_friday = 7
        d = reference_date + timedelta(days=days_to_friday)
        results.append((d.strftime("%Y-%m-%d"), 0.80, "before next week"))

    # "in two weeks", "in 2 weeks"
    for m in re.finditer(r'\bin\s+(\d+|two|three|four)\s+weeks?\b', text):
        num_str = m.group(1)
        num_map = {"two": 2, "three": 3, "four": 4}
        num = num_map.get(num_str, None) or int(num_str)
        d = reference_date + timedelta(weeks=num)
        results.append((d.strftime("%Y-%m-%d"), 0.80, m.group(0)))

    # "next month" -> 1st of next month
    if re.search(r'\bnext month\b', text):
        if reference_date.month == 12:
            d = datetime(reference_date.year + 1, 1, 1)
        else:
            d = datetime(reference_date.year, reference_date.month + 1, 1)
        results.append((d.strftime("%Y-%m-%d"), 0.80, "next month"))

    # "before May", "by May" -> 1st of that month
    for m in re.finditer(rf'\b(?:before|by)\s+({month_pattern})\b', text):
        month_name = m.group(1)
        month_num = months_map.get(month_name)
        if month_num:
            year = reference_date.year
            d = datetime(year, month_num, 1)
            if d.date() < reference_date.date():
                d = datetime(year + 1, month_num, 1)
            results.append((d.strftime("%Y-%m-%d"), 0.80, m.group(0)))

    # "due April 30", "deadline: May 1"
    for m in re.finditer(
        rf'\b(?:due|deadline:?)\s+({month_pattern})\s+(\d{{1,2}})(?:st|nd|rd|th)?\b', text
    ):
        month_name, day = m.group(1), int(m.group(2))
        month_num = months_map.get(month_name)
        if month_num and 1 <= day <= 31:
            year = reference_date.year
            try:
                d = datetime(year, month_num, day)
                if d.date() < reference_date.date():
                    d = datetime(year + 1, month_num, day)
                results.append((d.strftime("%Y-%m-%d"), 0.95, m.group(0)))
            except ValueError:
                pass

    return results


def detect_people(segment, known_people):
    """
    Rule 2: Detect people mentions.
    known_people: list of dicts with 'id' and 'name'.
    Returns list of extraction items.
    """
    items = []
    text_lower = segment.lower()

    # Step 2a: Known people matching (whole word, case-insensitive)
    for person in known_people:
        name = person["name"]
        pattern = r'\b' + re.escape(name.lower()) + r'\b'
        if re.search(pattern, text_lower):
            items.append({
                "type": "person_mention",
                "confidence": 0.95,
                "status": "auto_created",
                "source_text": segment,
                "data": {
                    "person_id": person["id"],
                    "person_name": person["name"],
                    "context": segment,
                },
                "created_id": None,
            })

    # Step 2b: New person detection
    new_person_patterns = [
        (r'\bmet\s+(?:with\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)', "met"),
        (r'([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+said\b', "said"),
        (r'([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+told\s+me\b', "told"),
        (r'\bcall\s+((?:Dr\.\s+)?[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)', "call"),
        (r'\bemail\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)', "email"),
        (r'\btext\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)', "text"),
        (r'\btalked\s+to\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)', "talked"),
        (r'\bspoke\s+(?:with|to)\s+(?:the\s+\w+\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)', "spoke"),
        (r'([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+from\s+(?:the\s+)?(\w+)', "from"),
    ]

    # Step 2c: Family / child / relationship person patterns
    family_patterns = [
        # "child, Name, born YYYY" or "child, Name (born YYYY)"
        (r'\bchild,?\s+([A-Z][a-z]+)(?:,?\s+(?:\(?born\s+(\d{4})\)?))?', "child"),
        # "daughter/son Name" or "my daughter/son, Name"
        (r'\b(?:my\s+)?(?:daughter|son|child),?\s+([A-Z][a-z]+)(?:,?\s+(?:\(?born\s+(\d{4})\)?))?', "family"),
        # "Name, my daughter/son"
        (r'([A-Z][a-z]+),?\s+(?:my|our)\s+(?:daughter|son|child)', "family"),
        # "Name (daughter)" or "Name (son)"
        (r'([A-Z][a-z]+)\s+\((?:daughter|son|child)\)', "family"),
        # "[Name], born YYYY" — a name followed by birth year is likely a person
        (r'([A-Z][a-z]+),?\s+born\s+(\d{4})', "born"),
    ]

    known_names_lower = {p["name"].lower() for p in known_people}

    for pattern, context_type in new_person_patterns:
        for m in re.finditer(pattern, segment):
            name = m.group(1).strip()
            # Skip if it matches a known person
            if name.lower() in known_names_lower:
                continue
            # Skip common words
            if name.lower() in COMMON_WORDS:
                continue
            # Skip single very short names (likely false positive)
            if len(name) < 3:
                continue

            relationship = "professional" if "Dr." in name else "unknown"
            items.append({
                "type": "person_new",
                "confidence": 0.70,
                "status": "suggested",
                "source_text": segment,
                "data": {
                    "name": name,
                    "inferred_relationship": relationship,
                    "context": segment,
                },
                "created_id": None,
            })

    # Check family patterns (higher confidence — these are explicit)
    for pattern, context_type in family_patterns:
        for m in re.finditer(pattern, segment):
            name = m.group(1).strip()
            if name.lower() in known_names_lower:
                continue
            if name.lower() in COMMON_WORDS:
                continue
            if len(name) < 2:
                continue

            # Infer relationship from context
            seg_lower = segment.lower()
            if "daughter" in seg_lower or "child" in seg_lower:
                relationship = "daughter"
            elif "son" in seg_lower:
                relationship = "son"
            else:
                relationship = "family"

            # Extract birth year if present
            birth_year = None
            if m.lastindex and m.lastindex >= 2 and m.group(2):
                birth_year = m.group(2)

            notes = segment
            if birth_year:
                notes = f"Born {birth_year}. {segment}"

            items.append({
                "type": "person_new",
                "confidence": 0.90,
                "status": "auto_created",
                "source_text": segment,
                "data": {
                    "name": name,
                    "inferred_relationship": relationship,
                    "notes": notes,
                    "context": segment,
                },
                "created_id": None,
            })

    return items


def detect_tasks(segment, goals_data, dates_for_segment):
    """
    Rule 1: Detect tasks in a text segment.
    Returns list of extraction items.
    """
    items = []
    text_lower = segment.lower().strip()

    # Checkbox syntax
    checkbox = re.match(r'^[-*]?\s*\[\s*\]\s*(.*)', text_lower)
    if checkbox:
        title = checkbox.group(1).strip().capitalize()
        if title:
            item = _build_task_item(segment, title, 0.95, goals_data, dates_for_segment)
            items.append(item)
            return items

    # Explicit markers
    explicit_patterns = [
        (r'(?i)\b(?:todo|to-do|task):\s*(.*)', 0.95),
        (r'(?i)\bremind\s+me\s+to\s+(.*)', 0.95),
        (r'(?i)\bdon\'?t\s+forget\s+to\s+(.*)', 0.95),
    ]
    for pattern, confidence in explicit_patterns:
        m = re.search(pattern, segment)  # match against original case
        if m:
            title = m.group(1).strip().rstrip(".")
            title = title[0].upper() + title[1:] if title else title
            if title and len(title) > 3:
                item = _build_task_item(segment, title, confidence, goals_data, dates_for_segment)
                items.append(item)
                return items

    # Modal verbs: "need to", "must", "should", "have to", "gotta"
    modal_patterns = [
        (r'(?i)\b(?:i\s+)?need\s+to\s+(.*)', 0.85),
        (r'(?i)\b(?:i\s+)?must\s+(.*)', 0.85),
        (r'(?i)\b(?:i\s+)?should\s+(?:probably\s+)?(.*)', 0.85),
        (r'(?i)\b(?:i\s+)?have\s+to\s+(.*)', 0.85),
        (r'(?i)\b(?:i\s+)?gotta\s+(.*)', 0.85),
    ]
    for pattern, confidence in modal_patterns:
        m = re.search(pattern, segment)  # match against original case
        if m:
            rest = m.group(1).strip().rstrip(".")
            if rest and len(rest) > 3:
                title = rest[0].upper() + rest[1:]
                item = _build_task_item(segment, title, confidence, goals_data, dates_for_segment)
                items.append(item)
                return items

    # Imperative verbs at line start
    first_word = text_lower.split()[0] if text_lower.split() else ""
    if first_word in IMPERATIVE_VERBS:
        title = segment.strip().rstrip(".")
        if len(title) > 5:
            item = _build_task_item(segment, title, 0.80, goals_data, dates_for_segment)
            items.append(item)
            return items

    # "find out" / "look into" / "follow up" at start
    two_word_imperatives = ["find out", "look into", "follow up", "set up", "sort out"]
    for phrase in two_word_imperatives:
        if text_lower.startswith(phrase):
            title = segment.strip().rstrip(".")
            if len(title) > 5:
                item = _build_task_item(segment, title, 0.80, goals_data, dates_for_segment)
                items.append(item)
                return items

    return items


def _build_task_item(source_text, title, confidence, goals_data, dates_for_segment):
    """Helper to build a task extraction item."""
    goal_match = match_goal(source_text, goals_data)
    due_date = None
    if dates_for_segment:
        # Pick the most confident date
        dates_for_segment.sort(key=lambda x: x[1], reverse=True)
        due_date = dates_for_segment[0][0]

    data = {
        "title": title,
        "description": source_text,
        "due_date": due_date,
        "goal_id": goal_match["goal_id"] if goal_match else None,
        "goal_title": goal_match["goal_title"] if goal_match else None,
        "status": "active",
    }

    status = "auto_created" if confidence >= 0.80 else "suggested"

    return {
        "type": "task",
        "confidence": confidence,
        "status": status,
        "source_text": source_text,
        "data": data,
        "created_id": None,
    }


def detect_goals(segment, known_people, reference_date):
    """
    Detect new goal creation requests in a text segment.
    Looks for patterns like "create a goal ...", "new goal ...", "goal: ...",
    "my goal is to ...", etc.
    Returns list of extraction items with type "goal_new".
    """
    items = []

    # Months map for target date extraction
    months_map = {
        "january": 1, "february": 2, "march": 3, "april": 4,
        "may": 5, "june": 6, "july": 7, "august": 8,
        "september": 9, "october": 10, "november": 11, "december": 12,
        "jan": 1, "feb": 2, "mar": 3, "apr": 4,
        "jun": 6, "jul": 7, "aug": 8, "sep": 9, "sept": 9,
        "oct": 10, "nov": 11, "dec": 12,
    }

    # Explicit goal patterns -- high confidence (0.95)
    explicit_patterns = [
        # "create a goal 'Title'" or "create a goal: Title"
        r"""(?i)\bcreate\s+(?:a\s+)?(?:new\s+)?goal[:\s]+['"\u2018\u2019\u201c\u201d]?([^'"\u2018\u2019\u201c\u201d\n]+?)['"\u2018\u2019\u201c\u201d]?\s*$""",
        # "new goal 'Title'" or "new goal: Title"
        r"""(?i)\bnew\s+goal[:\s]+['"\u2018\u2019\u201c\u201d]?([^'"\u2018\u2019\u201c\u201d\n]+?)['"\u2018\u2019\u201c\u201d]?\s*$""",
        # "goal: Title"
        r'(?i)^goal:\s*(.+)',
        # "add goal 'Title'"
        r"""(?i)\badd\s+(?:a\s+)?(?:new\s+)?goal[:\s]+['"\u2018\u2019\u201c\u201d]?([^'"\u2018\u2019\u201c\u201d\n]+?)['"\u2018\u2019\u201c\u201d]?\s*$""",
    ]

    # Softer goal patterns -- still high but slightly lower (0.90)
    soft_patterns = [
        # "my goal is to ..."
        r'(?i)\bmy\s+goal\s+is\s+(?:to\s+)?(.+)',
        # "i want to achieve ..."
        r'(?i)\bi\s+want\s+to\s+achieve\s+(.+)',
        # "set a goal to ..."
        r'(?i)\bset\s+(?:a\s+)?goal\s+(?:to\s+)?(.+)',
    ]

    def _extract_target_date(title_text):
        """Try to extract a target date from the goal title text."""
        text_lower = title_text.lower()

        # "June 2026", "May 2025", etc.
        for m in re.finditer(
            r'\b(' + '|'.join(months_map.keys()) + r')\s+(\d{4})\b', text_lower
        ):
            month_name, year_str = m.group(1), m.group(2)
            month_num = months_map.get(month_name)
            if month_num:
                # Use the 1st of that month as target_date
                return f"{year_str}-{month_num:02d}-01"

        # ISO dates in the title
        m = re.search(r'\b(\d{4}-\d{2}-\d{2})\b', title_text)
        if m:
            return m.group(1)

        # "by May", "before June"
        for m in re.finditer(
            r'\b(?:by|before)\s+(' + '|'.join(months_map.keys()) + r')\b', text_lower
        ):
            month_name = m.group(1)
            month_num = months_map.get(month_name)
            if month_num:
                year = reference_date.year
                d = datetime(year, month_num, 1)
                if d.date() < reference_date.date():
                    d = datetime(year + 1, month_num, 1)
                return d.strftime("%Y-%m-%d")

        return None

    def _extract_people_ids(title_text, known_people):
        """Find any known people mentioned in the goal title."""
        text_lower = title_text.lower()
        people_ids = []
        for person in known_people:
            pattern = r'\b' + re.escape(person["name"].lower()) + r'\b'
            if re.search(pattern, text_lower):
                people_ids.append(person["id"])
        return people_ids

    for pattern in explicit_patterns:
        m = re.search(pattern, segment)
        if m:
            title = m.group(1).strip().rstrip(".")
            if title and len(title) > 2:
                target_date = _extract_target_date(title)
                people_ids = _extract_people_ids(title, known_people)
                items.append({
                    "type": "goal_new",
                    "confidence": 0.95,
                    "status": "auto_created",
                    "source_text": segment,
                    "data": {
                        "title": title,
                        "description": segment,
                        "status": "active",
                        "target_date": target_date,
                        "people_ids": people_ids,
                    },
                    "created_id": None,
                })
                return items

    for pattern in soft_patterns:
        m = re.search(pattern, segment)
        if m:
            title = m.group(1).strip().rstrip(".")
            if title and len(title) > 2:
                target_date = _extract_target_date(title)
                people_ids = _extract_people_ids(title, known_people)
                items.append({
                    "type": "goal_new",
                    "confidence": 0.90,
                    "status": "auto_created",
                    "source_text": segment,
                    "data": {
                        "title": title,
                        "description": segment,
                        "status": "active",
                        "target_date": target_date,
                        "people_ids": people_ids,
                    },
                    "created_id": None,
                })
                return items

    return items


def match_goal(text, goals_data):
    """
    Rule 4: Match text against goals.
    goals_data: list of dicts from the goals table.
    Returns best match dict or None.
    """
    text_lower = text.lower()
    words = set(re.findall(r'[a-z0-9]+(?:-[a-z0-9]+)*', text_lower))

    best_match = None
    best_score = 0

    for goal in goals_data:
        title = goal["title"]
        kw_entry = None
        for key, val in GOAL_KEYWORDS.items():
            if key == title:
                kw_entry = val
                break
        if not kw_entry:
            continue

        title_hits = words & kw_entry["title_words"]
        keyword_hits = words & kw_entry["keywords"]
        total_hits = len(title_hits) + len(keyword_hits)

        if total_hits == 0:
            continue

        # Scoring per Rule 4
        if total_hits >= 3 and len(title_hits) >= 1:
            conf = 0.90
        elif total_hits >= 2 and len(title_hits) >= 1:
            conf = 0.80
        elif total_hits >= 2:
            conf = 0.65
        else:
            conf = 0.40

        if conf > best_score:
            best_score = conf
            best_match = {
                "goal_id": goal["id"],
                "goal_title": goal["title"],
                "confidence": conf,
                "matched_keywords": list(title_hits | keyword_hits),
            }

    return best_match if best_match and best_score >= 0.50 else None


def detect_knowledge(segment, dump_id):
    """
    Rule 3: Knowledge extraction.
    Returns list of extraction items.
    """
    items = []
    text_lower = segment.lower()

    # Decision patterns
    decision_patterns = [
        r'\b(?:i\'?ve?\s+)?decided\s+to\b',
        r'\bdecision:\s*',
        r'\bgoing\s+to\s+\w+\s+instead\s+of\b',
        r'\bchose\s+to\b',
        r'\bdecided\s+to\s+go\s+with\b',
        r'\bwe\s+agreed\s+to\b',
    ]
    for p in decision_patterns:
        if re.search(p, text_lower):
            title = _make_knowledge_title(segment, "decision")
            items.append(_build_knowledge_item(
                segment, title, "decision", dump_id, 0.90
            ))
            return items

    # Learning patterns
    learning_patterns = [
        r'\bi\s+learned\b',
        r'\blearned\s+that\b',
        r'\btil\b',
        r'\bturns\s+out\b',
        r'\brealised\s+that\b',
        r'\brealized\s+that\b',
        r'\bnow\s+i\s+know\b',
        r'\blesson:\s*',
        r'\bfound\s+out\b',
    ]
    for p in learning_patterns:
        if re.search(p, text_lower):
            title = _make_knowledge_title(segment, "learning")
            items.append(_build_knowledge_item(
                segment, title, "learning", dump_id, 0.90
            ))
            return items

    # Fact patterns
    fact_patterns = [
        r'\bimportant:\s*',
        r'\bnote:\s*',
        r'\bfyi:\s*',
        r'\bfor\s+the\s+record\b',
        r'\buseful\s+facts?:\s*',
        r'\bfact:\s*',
        r'\bkey\s+info:\s*',
        r'\bgood\s+to\s+know:\s*',
    ]
    for p in fact_patterns:
        if re.search(p, text_lower):
            # For "useful facts:" lines that contain multiple facts separated by ";"
            # split them into separate knowledge items
            prefix_match = re.match(r'(?i)^(?:useful\s+facts?|fact|key\s+info|good\s+to\s+know):\s*', segment)
            if prefix_match and ";" in segment:
                after_prefix = segment[prefix_match.end():]
                parts = [p.strip() for p in after_prefix.split(";") if p.strip()]
                for part in parts:
                    title = _make_knowledge_title(part, "fact")
                    items.append(_build_knowledge_item(
                        part, title, "fact", dump_id, 0.90
                    ))
                return items
            else:
                title = _make_knowledge_title(segment, "fact")
                items.append(_build_knowledge_item(
                    segment, title, "fact", dump_id, 0.90
                ))
                return items

    # Reference patterns (URLs, phone numbers, email, addresses)
    has_url = re.search(r'https?://\S+', segment)
    has_email = re.search(r'\b[\w.+-]+@[\w-]+\.[\w.]+\b', segment)
    has_phone = re.search(r'\b(?:\+?\d[\d\s-]{7,}\d)\b', segment)
    ref_phrases = re.search(
        r'\b(?:the\s+(?:number|address|link|email|url)\s+is)\b', text_lower
    )
    if has_url or has_email or has_phone or ref_phrases:
        title = _make_knowledge_title(segment, "reference")
        items.append(_build_knowledge_item(
            segment, title, "reference", dump_id, 0.85
        ))
        return items

    # Status change patterns ("X is no longer Y", "X changed to Y", "no longer my X")
    status_change_patterns = [
        r'\bis\s+no\s+longer\b',
        r'\bno\s+longer\s+(?:my|our|the)\b',
        r'\bchanged\s+(?:to|from)\b',
        r'\bswitched\s+(?:to|from)\b',
        r'\bused\s+to\s+be\b',
        r'\bno\s+longer\s+(?:works|available|valid|active)\b',
        r'\bhas\s+(?:left|quit|retired|stopped|moved)\b',
    ]
    for p in status_change_patterns:
        if re.search(p, text_lower):
            title = _make_knowledge_title(segment, "fact")
            items.append(_build_knowledge_item(
                segment, title, "fact", dump_id, 0.90
            ))
            return items

    # Personal identity / possession facts
    identity_patterns = [
        r'\bi\s+(?:also\s+)?hold\b',
        r'\bi\s+(?:also\s+)?have\s+(?:a|an|my|dual|two)\b.*(?:passport|citizenship|nationality|visa)',
        r'\bi\s+am\s+(?:a|an)\s+\w+\s+(?:citizen|national|resident)\b',
        r'\b(?:my|i\s+have\s+(?:a|an)?)\s+\w+\s+(?:passport|citizenship)\b',
    ]
    for p in identity_patterns:
        if re.search(p, text_lower):
            title = _make_knowledge_title(segment, "fact")
            items.append(_build_knowledge_item(
                segment, title, "fact", dump_id, 0.90
            ))
            return items

    # Factual equation patterns ("X = Y" used as a factual statement)
    if re.search(r'\w+\s+=\s+\d+', text_lower):
        title = _make_knowledge_title(segment, "fact")
        items.append(_build_knowledge_item(
            segment, title, "fact", dump_id, 0.85
        ))
        return items

    # Note patterns
    note_patterns = [
        r'\bremember:\s*',
        r'\bkeep\s+in\s+mind\b',
        r'\bnote\s+to\s+self\b',
    ]
    for p in note_patterns:
        if re.search(p, text_lower):
            title = _make_knowledge_title(segment, "note")
            items.append(_build_knowledge_item(
                segment, title, "note", dump_id, 0.90
            ))
            return items

    return items


def _make_knowledge_title(text, item_type):
    """Generate a concise title from knowledge text, max 80 chars."""
    # Strip common prefixes
    clean = re.sub(
        r'^(?:i\'?ve?\s+)?(?:decided\s+to|learned\s+that|found\s+out|'
        r'turns\s+out|realised\s+that|realized\s+that|now\s+i\s+know|'
        r'important:\s*|note:\s*|fyi:\s*|for\s+the\s+record,?\s*|'
        r'remember:\s*|keep\s+in\s+mind,?\s*|note\s+to\s+self,?\s*|'
        r'lesson:\s*|decision:\s*|til\s+|'
        r'useful\s+facts?:\s*|fact:\s*|key\s+info:\s*|good\s+to\s+know:\s*)',
        '', text.strip(), flags=re.IGNORECASE
    ).strip()
    # Capitalise first letter
    if clean:
        clean = clean[0].upper() + clean[1:]
    # Truncate
    if len(clean) > 80:
        clean = clean[:77] + "..."
    return clean or text[:80]


def _build_knowledge_item(source_text, title, item_type, dump_id, confidence):
    """Helper to build a knowledge extraction item."""
    status = "auto_created" if confidence >= 0.80 else "suggested"
    return {
        "type": "knowledge",
        "confidence": confidence,
        "status": status,
        "source_text": source_text,
        "data": {
            "title": title,
            "content": source_text,
            "item_type": item_type,
            "source": f"brain_dump:{dump_id}",
        },
        "created_id": None,
    }


def detect_tags(content, all_items, known_tags):
    """
    Rule 5: Tag generation.
    known_tags: list of dicts with 'id' and 'name'.
    Returns list of tag extraction items.
    """
    items = []
    text_lower = content.lower()
    words = set(re.findall(r'[a-z0-9]+(?:-[a-z0-9]+)*', text_lower))
    matched_tag_names = set()

    for tag in known_tags:
        tag_name = tag["name"]
        # Exact match
        if tag_name in words:
            items.append({
                "type": "tag",
                "confidence": 0.95,
                "status": "auto_created",
                "source_text": tag_name,
                "data": {
                    "tag_name": tag_name,
                    "is_new": False,
                    "matched_existing_id": tag["id"],
                    "apply_to": [],
                },
                "created_id": None,
            })
            matched_tag_names.add(tag_name)
            continue

        # Unhyphenated form: "move-house" -> "move house"
        unhyphenated = tag_name.replace("-", " ")
        if unhyphenated != tag_name and unhyphenated in text_lower:
            items.append({
                "type": "tag",
                "confidence": 0.95,
                "status": "auto_created",
                "source_text": unhyphenated,
                "data": {
                    "tag_name": tag_name,
                    "is_new": False,
                    "matched_existing_id": tag["id"],
                    "apply_to": [],
                },
                "created_id": None,
            })
            matched_tag_names.add(tag_name)
            continue

        # Stem/variant matching
        for word in words:
            stemmed = STEM_MAP.get(word)
            if stemmed and stemmed == tag_name:
                items.append({
                    "type": "tag",
                    "confidence": 0.85,
                    "status": "auto_created",
                    "source_text": word,
                    "data": {
                        "tag_name": tag_name,
                        "is_new": False,
                        "matched_existing_id": tag["id"],
                        "apply_to": [],
                    },
                    "created_id": None,
                })
                matched_tag_names.add(tag_name)
                break

    return items


def match_goal_links(content, dump_id, goals_data):
    """
    Rule 4 standalone: generate goal_link items for the whole dump.
    """
    items = []
    text_lower = content.lower()
    words = set(re.findall(r'[a-z0-9]+(?:-[a-z0-9]+)*', text_lower))

    for goal in goals_data:
        title = goal["title"]
        kw_entry = None
        for key, val in GOAL_KEYWORDS.items():
            if key == title:
                kw_entry = val
                break
        if not kw_entry:
            continue

        title_hits = words & kw_entry["title_words"]
        keyword_hits = words & kw_entry["keywords"]
        total_hits = len(title_hits) + len(keyword_hits)

        if total_hits == 0:
            continue

        if total_hits >= 3 and len(title_hits) >= 1:
            conf = 0.90
        elif total_hits >= 2 and len(title_hits) >= 1:
            conf = 0.80
        elif total_hits >= 2:
            conf = 0.65
        else:
            conf = 0.40

        if conf < 0.50:
            continue

        status = "auto_created" if conf >= 0.80 else "suggested"

        items.append({
            "type": "goal_link",
            "confidence": conf,
            "status": status,
            "source_text": content[:120],
            "data": {
                "goal_id": goal["id"],
                "goal_title": goal["title"],
                "matched_keywords": list(title_hits | keyword_hits),
                "target_type": "brain_dump",
                "target_id": dump_id,
            },
            "created_id": None,
        })

    return items


def _build_llm_prompt(content, dump_id, goals_data, known_people, known_tags, reference_date):
    """Build the extraction prompt for Ollama/Mistral."""
    today_str = reference_date.strftime("%Y-%m-%d")

    goals_list = "\n".join(
        f"  - ID {g['id']}: \"{g['title']}\" (status: {g['status']})"
        for g in goals_data
    )
    people_list = "\n".join(
        f"  - ID {p['id']}: \"{p['name']}\""
        for p in known_people
    )
    tags_list = ", ".join(t["name"] for t in known_tags)

    prompt = f"""You are an extraction engine for a personal knowledge management system. Today's date is {today_str}.

Analyse the following brain dump text and extract structured items from it. Return ONLY valid JSON matching the schema below.

## Brain dump text:
\"\"\"{content}\"\"\"

## Database context

### Existing goals:
{goals_list}

### Existing people:
{people_list}

### Existing tags:
{tags_list}

## Extraction rules

1. **Tasks**: Actionable items. Look for "todo:", "need to", "should", "must", "have to", "remind me to", checkbox syntax, or imperative verbs at line start. Each task needs a title (concise imperative), description (original text), optional due_date (ISO 8601), optional goal_id (from the goals list above), and status "active".

2. **People mentions**: References to known people from the list above. Include person_id and context.

3. **New people**: Names that appear in person-context patterns ("met X", "X said", "call X", "X from Y") but are NOT in the known people list. Include inferred_relationship ("professional", "family", "unknown"). New people should always be suggested, never auto-created (max confidence 0.70).

4. **Knowledge items**: Facts, decisions, learnings, references. Categorise as "fact", "decision", "learning", "reference", or "note". Include a concise title (max 80 chars) and the full original text as content.

5. **Goal links**: Which existing goals does this brain dump relate to? Include goal_id, goal_title, and matched_keywords.

6. **New goals**: Explicit requests to create a new goal. Look for "create a goal", "new goal", "goal:", "my goal is to", "add goal", "set a goal to". Extract the goal title, optional target_date (ISO 8601), and status "active". Only create goal_new items when the user is explicitly asking for a NEW goal to be created -- do NOT confuse this with tasks or goal links.

7. **Tags**: Which existing tags apply? Also suggest new tags (lowercase, hyphenated, max 30 chars) for recurring themes not covered by existing tags. Each tag carries an `apply_to` list naming the OTHER extracted items it should attach to (see "Tag scoping" below).

## Tag scoping (apply_to)

Brain dumps are deliberately multi-topic stream-of-consciousness. A dump containing "call mum about her birthday and read about machine learning" produces a `family` tag that belongs to the call-mum task and a `machine-learning` tag that belongs to the ML knowledge item -- NOT cross-attached.

Each tag has an `apply_to` list of references to other items in the same response. Each reference is `{{"type": "<item_type>", "source_text": "<the source_text of the target item>"}}`, where `type` matches one of: `task`, `knowledge`, `goal_new`, `person_new`, `person_mention`. The `source_text` MUST be the exact `source_text` value you put on the target item -- this is how the pipeline pairs the tag to the right item.

Rules:
- If a tag is dump-level (the whole dump is "about" it), leave `apply_to` as an empty list `[]`. Don't fan it out across unrelated items.
- If a tag belongs to one specific extracted item, list that one item in `apply_to`.
- A tag may apply to multiple items if (and only if) the dump text genuinely associates it with each one.
- Never apply a tag to an item from a different topic in a multi-topic dump.

## Confidence scoring guidelines
- Explicit markers (todo:, remind me to, decided to, I learned): 0.90-0.95
- Clear modal verbs + action (need to, should, must): 0.85
- Imperative verbs with clear object: 0.80
- Known person exact match: 0.95
- New person in strong context: 0.70
- Existing tag match: 0.95
- Explicit new goal request ("create a goal", "new goal"): 0.95
- Softer goal request ("my goal is to"): 0.90
- New tag suggestion: 0.50-0.70
- Ambiguous items: 0.50-0.60

## Date resolution
Resolve relative dates against today ({today_str}):
- "tomorrow" = one day after today
- "next week" = Monday of next week
- Named days ("Friday", "next Tuesday") = next occurrence
- Return all dates as ISO 8601 (YYYY-MM-DD)

## Output schema
Return a JSON object with this exact structure:
{{
  "tasks": [
    {{
      "title": "string (concise imperative)",
      "description": "string (original text)",
      "due_date": "YYYY-MM-DD or null",
      "goal_id": "integer or null",
      "goal_title": "string or null",
      "confidence": 0.0-1.0,
      "source_text": "exact substring from the brain dump"
    }}
  ],
  "people_mentions": [
    {{
      "person_id": "integer",
      "person_name": "string",
      "context": "string",
      "confidence": 0.0-1.0,
      "source_text": "exact substring"
    }}
  ],
  "new_people": [
    {{
      "name": "string",
      "inferred_relationship": "professional|family|unknown",
      "context": "string",
      "confidence": 0.0-1.0,
      "source_text": "exact substring"
    }}
  ],
  "knowledge_items": [
    {{
      "title": "string (max 80 chars)",
      "content": "string (original text)",
      "item_type": "fact|decision|learning|reference|note",
      "confidence": 0.0-1.0,
      "source_text": "exact substring"
    }}
  ],
  "goal_links": [
    {{
      "goal_id": "integer",
      "goal_title": "string",
      "matched_keywords": ["string"],
      "confidence": 0.0-1.0
    }}
  ],
  "new_goals": [
    {{
      "title": "string (concise goal name)",
      "description": "string (original text)",
      "target_date": "YYYY-MM-DD or null",
      "confidence": 0.0-1.0,
      "source_text": "exact substring"
    }}
  ],
  "tags": [
    {{
      "tag_name": "string (lowercase, hyphenated)",
      "is_new": true/false,
      "confidence": 0.0-1.0,
      "source_text": "string",
      "apply_to": [
        {{"type": "task|knowledge|goal_new|person_new|person_mention", "source_text": "exact source_text of the target item"}}
      ]
    }}
  ]
}}

## Examples

### Example input:
"Need to call Priya about the settlement papers. TIL the D-4 visa takes 3-4 weeks. Also should start packing boxes for the house move by Friday."

### Example output:
{{
  "tasks": [
    {{
      "title": "Call Priya about the settlement papers",
      "description": "Need to call Priya about the settlement papers.",
      "due_date": null,
      "goal_id": 2,
      "goal_title": "Finalise Property Settlement",
      "confidence": 0.85,
      "source_text": "Need to call Priya about the settlement papers."
    }},
    {{
      "title": "Start packing boxes for the house move",
      "description": "Also should start packing boxes for the house move by Friday.",
      "due_date": "{(reference_date + timedelta(days=(4 - reference_date.weekday()) % 7 or 7)).strftime('%Y-%m-%d')}",
      "goal_id": 3,
      "goal_title": "Move House",
      "confidence": 0.85,
      "source_text": "Also should start packing boxes for the house move by Friday."
    }}
  ],
  "people_mentions": [
    {{
      "person_id": 2,
      "person_name": "Priya",
      "context": "Need to call Priya about the settlement papers.",
      "confidence": 0.95,
      "source_text": "call Priya about the settlement papers"
    }}
  ],
  "new_people": [],
  "knowledge_items": [
    {{
      "title": "D-4 visa processing takes 3-4 weeks",
      "content": "TIL the D-4 visa takes 3-4 weeks.",
      "item_type": "learning",
      "confidence": 0.90,
      "source_text": "TIL the D-4 visa takes 3-4 weeks."
    }}
  ],
  "goal_links": [
    {{
      "goal_id": 2,
      "goal_title": "Finalise Property Settlement",
      "matched_keywords": ["settlement", "priya", "settlement"],
      "confidence": 0.85
    }},
    {{
      "goal_id": 3,
      "goal_title": "Move House",
      "matched_keywords": ["packing", "house", "move"],
      "confidence": 0.85
    }},
    {{
      "goal_id": 1,
      "goal_title": "Move to Seoul",
      "matched_keywords": ["visa", "d-4"],
      "confidence": 0.80
    }}
  ],
  "tags": [
    {{"tag_name": "settlement", "is_new": false, "confidence": 0.95, "source_text": "settlement papers", "apply_to": [
      {{"type": "task", "source_text": "Need to call Priya about the settlement papers."}}
    ]}},
    {{"tag_name": "visa", "is_new": false, "confidence": 0.95, "source_text": "D-4 visa", "apply_to": [
      {{"type": "knowledge", "source_text": "TIL the D-4 visa takes 3-4 weeks."}}
    ]}},
    {{"tag_name": "move-house", "is_new": false, "confidence": 0.95, "source_text": "house move", "apply_to": [
      {{"type": "task", "source_text": "Also should start packing boxes for the house move by Friday."}}
    ]}}
  ]
}}

### Example 2 (multi-topic dump -- demonstrates apply_to scoping):
Input: "Need to call mum about her birthday next week. Also want to read up on machine learning fundamentals."

Output (relevant fragments):
{{
  "tasks": [
    {{"title": "Call mum about birthday", "description": "Need to call mum about her birthday next week.", "due_date": null, "goal_id": null, "goal_title": null, "confidence": 0.85, "source_text": "Need to call mum about her birthday next week."}}
  ],
  "knowledge_items": [
    {{"title": "Read about machine learning fundamentals", "content": "Also want to read up on machine learning fundamentals.", "item_type": "note", "confidence": 0.80, "source_text": "Also want to read up on machine learning fundamentals."}}
  ],
  "tags": [
    {{"tag_name": "family", "is_new": true, "confidence": 0.85, "source_text": "mum", "apply_to": [
      {{"type": "task", "source_text": "Need to call mum about her birthday next week."}}
    ]}},
    {{"tag_name": "machine-learning", "is_new": true, "confidence": 0.85, "source_text": "machine learning", "apply_to": [
      {{"type": "knowledge", "source_text": "Also want to read up on machine learning fundamentals."}}
    ]}}
  ]
}}

Note how `family` does NOT cross-attach to the ML knowledge item, and `machine-learning` does NOT attach to the call-mum task. The two topics in the dump stay separate. If a tag is dump-level (no specific item it belongs to), use `apply_to: []`.

Now extract items from the brain dump text above. Return ONLY the JSON object, no other text."""

    return prompt


def _call_ollama(prompt):
    """Send a prompt to Ollama and return the parsed JSON response.
    Returns the parsed dict on success, or None on failure.
    """
    logger.info("processing.ollama.call model=%s", OLLAMA_MODEL)
    payload = json.dumps({
        "model": OLLAMA_MODEL,
        "prompt": prompt,
        "stream": False,
        "format": "json",
    }).encode("utf-8")

    req = urllib.request.Request(
        OLLAMA_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=OLLAMA_TIMEOUT) as resp:
            elapsed = time.time() - t0
            body = resp.read().decode("utf-8")
            result = json.loads(body)
            response_text = result.get("response", "")
            parsed = json.loads(response_text)
            logger.info("processing.ollama.ok duration_ms=%d", int(elapsed * 1000))
            return parsed
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError,
            OSError, TimeoutError, ValueError, KeyError) as e:
        elapsed = time.time() - t0
        # Privacy invariant: log error TYPE only -- exception messages from
        # urllib/json may quote response bodies which we treat as opaque.
        logger.warning(
            "processing.ollama.failed duration_ms=%d error_type=%s",
            int(elapsed * 1000), type(e).__name__,
        )
        return None


def _call_mistral(prompt):
    """Send a prompt to the Mistral cloud API and return the parsed JSON response.
    Uses the same prompt as Ollama but via OpenAI-compatible chat/completions.
    Returns the parsed dict on success, or None on failure.
    """
    logger.info("processing.mistral.call")
    messages = [
        {
            "role": "system",
            "content": "You are an extraction engine for a personal knowledge management system. Return ONLY valid JSON.",
        },
        {
            "role": "user",
            "content": prompt,
        },
    ]
    t0 = time.time()
    result = call_mistral_api(messages)
    elapsed = time.time() - t0
    if result is not None:
        logger.info("processing.mistral.ok duration_ms=%d", int(elapsed * 1000))
    else:
        logger.warning("processing.mistral.failed duration_ms=%d", int(elapsed * 1000))
    return result


def _llm_response_to_items(llm_data, dump_id, known_tags):
    """Convert the LLM's structured JSON into the standard processed_items format."""
    items = []

    # Map existing tag names to IDs for quick lookup
    tag_id_map = {t["name"]: t["id"] for t in known_tags}

    # Tasks
    for task in llm_data.get("tasks", []):
        conf = _clamp_confidence(task.get("confidence", 0.60))
        status = "auto_created" if conf >= 0.80 else "suggested"
        items.append({
            "type": "task",
            "confidence": conf,
            "status": status,
            "source_text": task.get("source_text", task.get("description", "")),
            "data": {
                "title": task.get("title", "Untitled task"),
                "description": task.get("description", ""),
                "due_date": task.get("due_date"),
                "goal_id": task.get("goal_id"),
                "goal_title": task.get("goal_title"),
                "status": "active",
            },
            "created_id": None,
        })

    # People mentions
    for pm in llm_data.get("people_mentions", []):
        conf = _clamp_confidence(pm.get("confidence", 0.95))
        status = "auto_created" if conf >= 0.80 else "suggested"
        items.append({
            "type": "person_mention",
            "confidence": conf,
            "status": status,
            "source_text": pm.get("source_text", pm.get("context", "")),
            "data": {
                "person_id": pm.get("person_id"),
                "person_name": pm.get("person_name", ""),
                "context": pm.get("context", ""),
            },
            "created_id": None,
        })

    # New people -- always suggested, never auto-created
    for np in llm_data.get("new_people", []):
        conf = min(_clamp_confidence(np.get("confidence", 0.70)), 0.70)
        items.append({
            "type": "person_new",
            "confidence": conf,
            "status": "suggested",
            "source_text": np.get("source_text", np.get("context", "")),
            "data": {
                "name": np.get("name", "Unknown"),
                "inferred_relationship": np.get("inferred_relationship", "unknown"),
                "context": np.get("context", ""),
            },
            "created_id": None,
        })

    # Knowledge items
    for ki in llm_data.get("knowledge_items", []):
        conf = _clamp_confidence(ki.get("confidence", 0.80))
        status = "auto_created" if conf >= 0.80 else "suggested"
        items.append({
            "type": "knowledge",
            "confidence": conf,
            "status": status,
            "source_text": ki.get("source_text", ki.get("content", "")),
            "data": {
                "title": (ki.get("title", "Untitled"))[:80],
                "content": ki.get("content", ""),
                "item_type": ki.get("item_type", "fact"),
                "source": f"brain_dump:{dump_id}",
            },
            "created_id": None,
        })

    # New goals
    for ng in llm_data.get("new_goals", []):
        conf = _clamp_confidence(ng.get("confidence", 0.90))
        status = "auto_created" if conf >= 0.80 else "suggested"
        items.append({
            "type": "goal_new",
            "confidence": conf,
            "status": status,
            "source_text": ng.get("source_text", ng.get("description", "")),
            "data": {
                "title": ng.get("title", "Untitled goal"),
                "description": ng.get("description", ""),
                "status": "active",
                "target_date": ng.get("target_date"),
                "people_ids": [],
            },
            "created_id": None,
        })

    # Goal links
    for gl in llm_data.get("goal_links", []):
        conf = _clamp_confidence(gl.get("confidence", 0.65))
        status = "auto_created" if conf >= 0.80 else "suggested"
        items.append({
            "type": "goal_link",
            "confidence": conf,
            "status": status,
            "source_text": ", ".join(gl.get("matched_keywords", [])),
            "data": {
                "goal_id": gl.get("goal_id"),
                "goal_title": gl.get("goal_title", ""),
                "matched_keywords": gl.get("matched_keywords", []),
                "target_type": "brain_dump",
                "target_id": dump_id,
            },
            "created_id": None,
        })

    # Tags
    for tag in llm_data.get("tags", []):
        conf = _clamp_confidence(tag.get("confidence", 0.70))
        tag_name = tag.get("tag_name", "").lower().strip()
        if not tag_name:
            continue
        is_new = tag.get("is_new", tag_name not in tag_id_map)
        status = "auto_created" if conf >= 0.80 else "suggested"
        # apply_to: list of {type, source_text} references identifying which
        # OTHER extracted items this tag belongs to. Sanitised here -- only
        # well-formed dicts with the required keys survive. Empty/absent ->
        # dump-level tag (existing behaviour preserved). Privacy: these are
        # references the LLM ALREADY emitted as part of the items it produced;
        # source_text is a short fragment we already store on every item.
        apply_to = _sanitise_apply_to(tag.get("apply_to"))
        items.append({
            "type": "tag",
            "confidence": conf,
            "status": status,
            "source_text": tag.get("source_text", tag_name),
            "data": {
                "tag_name": tag_name,
                "is_new": is_new,
                "matched_existing_id": tag_id_map.get(tag_name) if not is_new else None,
                "apply_to": apply_to,
            },
            "created_id": None,
        })

    return items


# Tag-fan-out -> junction table. `goal_link` and `tag` are intentionally
# absent: goal_link does not create a goal row (so there's nothing to tag),
# and self-tagging a tag is meaningless.
_TAG_FANOUT_JUNCTIONS = {
    "task": ("task_tags", "task_id"),
    "knowledge": ("knowledge_tags", "knowledge_id"),
    "goal_new": ("goal_tags", "goal_id"),
    "person_new": ("person_tags", "person_id"),
    "person_mention": ("person_tags", "person_id"),
}


def _sanitise_apply_to(raw):
    """Clamp the LLM-supplied apply_to list to the contract shape.

    Returns a list of {"type": str, "source_text": str} dicts. Drops any
    entry that isn't a dict, lacks both keys, or names an unknown type.
    """
    if not isinstance(raw, list):
        return []
    out = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        etype = entry.get("type")
        esrc = entry.get("source_text")
        if not isinstance(etype, str) or not isinstance(esrc, str):
            continue
        if etype not in _TAG_FANOUT_JUNCTIONS:
            continue
        out.append({"type": etype, "source_text": esrc})
    return out


def _clamp_confidence(val):
    """Ensure confidence is a float between 0.0 and 1.0."""
    try:
        val = float(val)
    except (TypeError, ValueError):
        return 0.50
    return max(0.0, min(1.0, val))


def process_brain_dump_llm(dump_id, conn, dump, goals_data, known_people, known_tags, ref_date):
    """Try to process a brain dump using LLM (three-tier fallback).
    1. Try local Ollama first
    2. If Ollama fails, try Mistral cloud API
    3. If Mistral fails, return None (caller falls back to regex)
    Returns a list of extracted items on success, or None if all LLMs unavailable.
    """
    content = dump["content"]

    prompt = _build_llm_prompt(content, dump_id, goals_data, known_people, known_tags, ref_date)

    # Tier 1: Local Ollama
    llm_data = _call_ollama(prompt)
    tier_used = "ollama"

    # Tier 2: Mistral cloud API
    if llm_data is None:
        logger.info("processing.llm.fallback from_tier=ollama to_tier=mistral")
        llm_data = _call_mistral(prompt)
        tier_used = "mistral"

    if llm_data is None:
        logger.warning("processing.llm.fallback from_tier=mistral to_tier=regex reason=all_llms_failed")
        return None

    # Validate minimal structure
    if not isinstance(llm_data, dict):
        logger.warning("processing.llm.fallback from_tier=%s to_tier=regex reason=non_dict_response", tier_used)
        return None

    logger.info("processing.llm.ok tier=%s", tier_used)
    items = _llm_response_to_items(llm_data, dump_id, known_tags)

    # Post-processing: Mistral often misclassifies explicit goal requests as tasks.
    # Run regex goal detection and promote any matching tasks to goals.
    has_goal_new = any(i["type"] == "goal_new" for i in items)
    if not has_goal_new:
        segments = segment_text(content)
        for seg in segments:
            goal_items = detect_goals(seg, known_people, ref_date)
            if goal_items:
                items.extend(goal_items)
                has_goal_new = True

    # Remove tasks that duplicate any goal_new items (substring match
    # because the LLM often shortens titles)
    goal_new_titles = [i["data"]["title"].lower() for i in items if i["type"] == "goal_new"]
    if goal_new_titles:
        def _task_overlaps_goal(task_title):
            t = task_title.lower()
            return any(t in gt or gt in t for gt in goal_new_titles)
        items = [
            i for i in items
            if not (i["type"] == "task" and _task_overlaps_goal(i["data"]["title"]))
        ]

    # Summarise what was extracted
    # Counts only -- type names are static enum values, never user content.
    type_counts = Counter(i["type"] for i in items)
    summary = ", ".join(f"{cnt} {t}" for t, cnt in sorted(type_counts.items()))
    logger.info(
        "processing.llm.extracted tier=%s total=%d counts=%s",
        tier_used, len(items), summary,
    )
    return items


def _order_items_tags_last(items):
    """Return a re-ordered shallow copy of `items` with `tag` items moved to
    the end, preserving relative order within each group.

    Required by the tag branch's apply_to fan-out (option (a) per the
    investigation dispatch): siblings must have their `created_id`
    populated before the tag branch reads them.
    """
    non_tags = [i for i in items if i.get("type") != "tag"]
    tags = [i for i in items if i.get("type") == "tag"]
    return non_tags + tags


def _attach_tag_to_siblings(conn, dump_id, tag_id, apply_to, sibling_items):
    """Insert per-item junction rows for a tag's apply_to references.

    `apply_to` entries are {type, source_text} dicts (already sanitised by
    `_sanitise_apply_to`). For each entry, find the matching sibling item
    by (type, source_text); if it has a non-null `created_id`, INSERT OR
    IGNORE into the appropriate junction table.

    Privacy: logs only counts and dump_id; never tag names or source_text.
    """
    attached = 0
    no_match = 0
    no_created_id = 0
    for ref in apply_to:
        ref_type = ref["type"]
        ref_src = ref["source_text"]
        junction = _TAG_FANOUT_JUNCTIONS.get(ref_type)
        if junction is None:
            # Defence in depth -- _sanitise_apply_to already filtered, but
            # if a future code path bypasses it, fail closed (skip).
            no_match += 1
            continue
        table_name, fk_col = junction
        # Find the sibling item by (type, source_text). person_mention and
        # person_new both map to person_tags, so accept either when the ref
        # type is in the person family.
        match = None
        for sib in sibling_items:
            if sib.get("type") != ref_type:
                continue
            if sib.get("source_text") != ref_src:
                continue
            match = sib
            break
        if match is None:
            no_match += 1
            continue
        created_id = match.get("created_id")
        if created_id is None:
            no_created_id += 1
            continue
        try:
            conn.execute(
                f"INSERT OR IGNORE INTO {table_name} ({fk_col}, tag_id) "
                f"VALUES (?, ?)",
                (created_id, tag_id),
            )
            attached += 1
        except sqlite3.Error as exc:
            # FK violation or similar -- log and continue with remaining
            # refs. The tag itself was already created and linked to the
            # brain dump; a junction-table failure must not regress that.
            logger.warning(
                "processing.auto_create.tag.fanout_failed dump_id=%s "
                "junction=%s error_class=%s error_message=%s",
                dump_id, table_name, type(exc).__name__,
                _truncate_error_message(str(exc)),
            )
    if attached or no_match or no_created_id:
        logger.info(
            "processing.auto_create.tag.fanout dump_id=%s "
            "attached=%d no_match=%d no_created_id=%d",
            dump_id, attached, no_match, no_created_id,
        )


def _auto_create_item(conn, item, dump_id, sibling_items=None):
    """Create a database row for an auto-created item.

    Contract: app/contracts/auto-create-item.md.

    `sibling_items` (optional) is the list of other items in the same
    `processed_items.items` array. The `tag` branch uses it to resolve its
    `apply_to` references (each `{type, source_text}` entry) against
    sibling items that have a non-null `created_id`, and writes the
    appropriate junction-table rows (`task_tags`, `knowledge_tags`,
    `goal_tags`, `person_tags`). When `sibling_items` is None or empty, or
    `apply_to` is empty/absent, the tag branch keeps today's behaviour:
    insert into `tags` and link only via `brain_dump_tags`.

    Pass-ordering invariant for the tag branch (option (a) per Cairn's
    dispatch): callers must process all non-tag items BEFORE tag items so
    that `created_id` is populated on sibling items by the time the tag
    branch reads them. See `_order_items_tags_last`.

    Returns the new (or matched) row id on success, or `None` when the caller
    should treat the item as not-created. `None` is a deliberate contract
    signal -- the caller MUST mark the item `failed` and set `created_id`
    to None. Never let `None` reach a status of `auto_created` or `approved`
    (invariant 1).

    Raises:
      * `UnknownItemType` if `itype` doesn't match any branch -- not caught
        here; the caller routes per its own policy (worker retries, approve
        handler returns 500-with-class-name).
      * `BrainDumpNotFound` propagates from upstream; not raised here.
      * `AssertionError` for invariant violations (e.g. `INSERT OR IGNORE`
        on UNIQUE leaving no readable row) -- programming bug, propagate.

    Caught and logged as `processing.auto_create.failed` (returns None):
      * `MalformedItemData` -- LLM omitted a required key for the branch.
      * `sqlite3.Error` -- DB-level failure on a single item. Per Cairn's
        decision (2026-04-23 audit open question): drop the one item, keep
        the dump going. If this fires repeatedly, that's a separate audit
        trigger at the worker / connection layer.
    """
    ts = now_utc()
    itype = item["type"]
    data = item["data"]

    try:
        if itype == "task":
            # Recovery shape: log + None via MalformedItemData.
            if "title" not in data:
                raise MalformedItemData("task", "title")
            cur = conn.execute(
                "INSERT INTO tasks (title, description, goal_id, status, due_date, "
                "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    data["title"],
                    data.get("description"),
                    data.get("goal_id"),
                    "active",
                    data.get("due_date"),
                    ts, ts,
                ),
            )
            return cur.lastrowid

        elif itype == "knowledge":
            # Recovery shape: log + None via MalformedItemData.
            if "title" not in data:
                raise MalformedItemData("knowledge", "title")
            cur = conn.execute(
                "INSERT INTO knowledge_items (title, content, item_type, source, "
                "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                (
                    data["title"],
                    data.get("content"),
                    data.get("item_type", "fact"),
                    data.get("source", f"brain_dump:{dump_id}"),
                    ts, ts,
                ),
            )
            return cur.lastrowid

        elif itype == "tag":
            # Recovery shape: log + None via MalformedItemData if tag_name
            # is absent. Otherwise: fall-through to create-new when LLM said
            # is_new=False but didn't supply matched_existing_id.
            if "tag_name" not in data:
                raise MalformedItemData("tag", "tag_name")
            tag_name = data["tag_name"]
            if not data.get("is_new") and not data.get("matched_existing_id"):
                # Privacy: do not log tag_name; dump_id + reason only.
                logger.info(
                    "processing.auto_create.tag.recover dump_id=%s "
                    "reason=match_failed_create_instead", dump_id,
                )
            create_new = bool(data.get("is_new")) or not data.get("matched_existing_id")
            if create_new:
                conn.execute(
                    "INSERT OR IGNORE INTO tags (name) VALUES (?)", (tag_name,)
                )
                tag_row = conn.execute(
                    "SELECT id FROM tags WHERE name = ?", (tag_name,)
                ).fetchone()
                # Invariant: INSERT OR IGNORE on UNIQUE(name) always leaves
                # a readable row. If this fails, it's a programming /
                # schema-corruption bug, not data bug -- propagate.
                assert tag_row is not None, (
                    f"INSERT OR IGNORE on UNIQUE(name) failed for tag={tag_name!r}"
                )
                # Link to the brain dump
                conn.execute(
                    "INSERT OR IGNORE INTO brain_dump_tags (brain_dump_id, tag_id) "
                    "VALUES (?, ?)",
                    (dump_id, tag_row["id"]),
                )
                resolved_tag_id = tag_row["id"]
            else:
                resolved_tag_id = data["matched_existing_id"]
                conn.execute(
                    "INSERT OR IGNORE INTO brain_dump_tags (brain_dump_id, tag_id) "
                    "VALUES (?, ?)",
                    (dump_id, resolved_tag_id),
                )
            # Per-item fan-out: attach this tag to any sibling items the LLM
            # asked us to via apply_to. Pass-ordering invariant: callers
            # process all non-tag items first, so siblings already have
            # `created_id` populated. Privacy: log only counts and the
            # static junction-table name; never the tag_name or source_text.
            apply_to = data.get("apply_to") or []
            if apply_to and sibling_items:
                _attach_tag_to_siblings(
                    conn, dump_id, resolved_tag_id, apply_to, sibling_items,
                )
            return resolved_tag_id

        elif itype == "goal_new":
            # Recovery shape: log + None via MalformedItemData.
            if "title" not in data:
                raise MalformedItemData("goal_new", "title")
            cur = conn.execute(
                "INSERT INTO goals (title, description, status, target_date, "
                "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                (
                    data["title"],
                    data.get("description"),
                    "active",
                    data.get("target_date"),
                    ts, ts,
                ),
            )
            goal_id = cur.lastrowid

            # Link detected people via goal_people. Per contract: bad person_id
            # FK violation does NOT roll back the goal create; log per-link
            # warning and continue.
            for person_id in data.get("people_ids", []):
                try:
                    conn.execute(
                        "INSERT OR IGNORE INTO goal_people (goal_id, person_id, role) "
                        "VALUES (?, ?, ?)",
                        (goal_id, person_id, "involved"),
                    )
                except sqlite3.Error as link_err:
                    logger.warning(
                        "processing.auto_create.goal_new.link_failed "
                        "dump_id=%s goal_id=%s person_id=%s "
                        "error_class=%s error_message=%s",
                        dump_id, goal_id, person_id,
                        type(link_err).__name__,
                        _truncate_error_message(str(link_err)),
                    )

            return goal_id

        elif itype == "person_new":
            # Recovery shape: log + None via MalformedItemData.
            if "name" not in data:
                raise MalformedItemData("person_new", "name")
            name = data["name"]
            relationship = data.get("inferred_relationship", "unknown")
            notes = data.get("notes", data.get("context", ""))
            cur = conn.execute(
                "INSERT INTO people (name, relationship, notes, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (name, relationship, notes, ts, ts),
            )
            return cur.lastrowid

        elif itype == "person_mention":
            # Per contract: matched person_id -> return it (no insert).
            # Otherwise: fall-through to create-new from person_name.
            # Empty-name guard returns None with a logged drop (no
            # MalformedItemData here -- person_mention is allowed to have
            # neither person_id nor person_name in pathological cases, and
            # we already had a silent-drop path; we just made it loud).
            if data.get("person_id") is not None:
                return data["person_id"]
            name = (data.get("person_name") or "").strip()
            if not name:
                logger.warning(
                    "processing.auto_create.person_mention.drop dump_id=%s "
                    "reason=empty_person_name", dump_id,
                )
                return None
            relationship = data.get("inferred_relationship", "unknown")
            notes = data.get("notes", data.get("context", ""))
            cur = conn.execute(
                "INSERT INTO people (name, relationship, notes, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (name, relationship, notes, ts, ts),
            )
            return cur.lastrowid

        elif itype == "goal_link":
            # No "create new" recovery -- a goal_link by definition refers to
            # an EXISTING goal; we have no title/description to synthesise.
            # Per contract: log + None when goal_id is missing.
            goal_id = data.get("goal_id")
            if goal_id is not None:
                return goal_id
            # Privacy: dump_id + reason only; never log free-text goal text.
            logger.info(
                "processing.auto_create.no_target dump_id=%s item_type=goal_link",
                dump_id,
            )
            logger.warning(
                "processing.auto_create.goal_link.drop dump_id=%s "
                "reason=missing_goal_id", dump_id,
            )
            return None

        else:
            # Explicit dispatcher else (was implicit/silent before). Future
            # branch additions can't accidentally drop a whole class of items.
            # Not caught here -- the caller treats this as a programming bug.
            raise UnknownItemType(itype)

    except MalformedItemData as e:
        # Privacy: branch + missing_key are static enum-shaped strings.
        logger.warning(
            "processing.auto_create.malformed dump_id=%s item_type=%s "
            "branch=%s missing_key=%s",
            dump_id, itype, e.branch, e.missing_key,
        )
        return None
    except sqlite3.Error as e:
        # Per Cairn's decision: drop the one item, keep the dump going.
        # error_message is truncated as a best-effort hedge -- sqlite3 error
        # text occasionally embeds parameter values from constraint violations.
        logger.warning(
            "processing.auto_create.db_error dump_id=%s item_type=%s "
            "error_class=%s error_message=%s",
            dump_id, itype,
            type(e).__name__,
            _truncate_error_message(str(e)),
        )
        return None


def process_brain_dump_for_worker(conn, dump_id):
    """
    Worker-callable form of brain-dump processing.

    Performs the LLM/regex extraction and writes any auto-created items via
    `_auto_create_item`, but does NOT update `brain_dumps.processing_status`
    and does NOT commit. Caller (the worker) owns:
      * the `processing_status` cache transition (queued -> processing -> ...)
      * the transactional boundary (commit / rollback)
      * finalisation guard semantics on `work_queue`

    Returns a dict with the fields the caller needs to finalise:

        {
            "processing_status": "processed" | "needs_review",
            "processed_items_json": "<json string>",
            "processed_at": "<iso ts>",
            "auto_count": int,
            "suggest_count": int,
            "extraction_method": "llm" | "regex",
        }

    Raises on unrecoverable failure -- the worker's failure handler is
    responsible for routing that into the retry / terminal-failure path on
    `work_queue`.

    Privacy invariant: this function may print debug context (counts, ids,
    extraction method); it does NOT log or return brain-dump content. The
    worker's logger never receives raw content from us.
    """
    row = conn.execute(
        "SELECT * FROM brain_dumps WHERE id = ?", (dump_id,)
    ).fetchone()
    if not row:
        # Sentinel: distinct from generic processing failures so the worker
        # can treat a missing target as a clean no-op (user deleted the
        # brain_dump after the job was queued/claimed) instead of retrying.
        raise BrainDumpNotFound(f"brain_dump {dump_id} not found")

    dump = dict(row)
    content = dump["content"]
    # Privacy invariant: NEVER log a content preview here. ID + counts only.
    logger.info("processing.start dump_id=%s content_len=%d", dump_id, len(content))
    t_start = time.time()

    # Load reference data from DB
    goals_data = rows_to_dicts(
        conn.execute("SELECT id, title, description, status FROM goals").fetchall()
    )
    known_people = rows_to_dicts(
        conn.execute("SELECT id, name FROM people").fetchall()
    )
    known_tags = rows_to_dicts(
        conn.execute("SELECT id, name FROM tags").fetchall()
    )
    logger.info(
        "processing.context dump_id=%s goals=%d people=%d tags=%d",
        dump_id, len(goals_data), len(known_people), len(known_tags),
    )

    # Parse reference date from captured_at
    captured_at = dump["captured_at"]
    try:
        ref_date = datetime.strptime(captured_at, "%Y-%m-%d %H:%M:%S")
    except (ValueError, TypeError):
        ref_date = datetime.now(timezone.utc).replace(tzinfo=None)

    # Primary path: LLM extraction via Ollama / Mistral fallback
    llm_items = process_brain_dump_llm(
        dump_id, conn, dump, goals_data, known_people, known_tags, ref_date
    )

    if llm_items is not None:
        all_items = llm_items
        extraction_method = "llm"
    else:
        # Fallback: regex-based extraction
        extraction_method = "regex"
        logger.info("processing.regex.start dump_id=%s", dump_id)

        segments = segment_text(content)
        logger.info("processing.regex.segments dump_id=%s count=%d", dump_id, len(segments))

        all_items = []
        seen_person_ids = set()
        seen_new_names = set()

        for seg in segments:
            seg_dates = detect_dates(seg, ref_date)

            people_items = detect_people(seg, known_people)
            for pi in people_items:
                if pi["type"] == "person_mention":
                    pid = pi["data"]["person_id"]
                    if pid not in seen_person_ids:
                        seen_person_ids.add(pid)
                        all_items.append(pi)
                elif pi["type"] == "person_new":
                    name_key = pi["data"]["name"].lower()
                    if name_key not in seen_new_names:
                        seen_new_names.add(name_key)
                        all_items.append(pi)

            goal_new_items = detect_goals(seg, known_people, ref_date)
            all_items.extend(goal_new_items)

            if not goal_new_items:
                task_items = detect_tasks(seg, goals_data, seg_dates)
                all_items.extend(task_items)

            knowledge_items = detect_knowledge(seg, dump_id)
            all_items.extend(knowledge_items)

        goal_links = match_goal_links(content, dump_id, goals_data)
        all_items.extend(goal_links)

        tag_items = detect_tags(content, all_items, known_tags)
        all_items.extend(tag_items)

        # Counts only -- type names are static enum values, never user content.
        type_counts = Counter(i["type"] for i in all_items)
        summary = ", ".join(f"{cnt} {t}" for t, cnt in sorted(type_counts.items()))
        logger.info(
            "processing.regex.extracted dump_id=%s total=%d counts=%s",
            dump_id, len(all_items), summary,
        )

    # Confidence filtering -- discard items below 0.50
    filtered_items = [
        item for item in all_items if item["confidence"] >= 0.50
    ]

    # Pass-ordering for tag apply_to fan-out (option (a) per the
    # tag-apply-to-investigation dispatch): process all non-tag items first
    # so their `created_id` is populated by the time the tag branch reads
    # them via `sibling_items`. The reordered list drives the loop, but
    # `filtered_items` -- still in extraction order -- is what the worker
    # serialises into `processed_items.items` for the UI / DB. Both views
    # reference the same item dicts, so status / created_id mutations from
    # the loop are visible in the persisted JSON.
    ordered_items = _order_items_tags_last(filtered_items)

    # Auto-create high-confidence items.
    # Status set AFTER the call (invariant 1 from the auto-create contract):
    # `_auto_create_item` returns None to signal "couldn't create"; the
    # status MUST then be `failed`, never `auto_created`. dropped_count
    # tracks the failed branch so operators can reconcile len(items)
    # against reported counts in the processing.done log line.
    auto_count = 0
    suggest_count = 0
    dropped_count = 0
    for item in ordered_items:
        if item["confidence"] >= 0.80:
            created_id = _auto_create_item(
                conn, item, dump_id, sibling_items=filtered_items,
            )
            if created_id is None:
                item["status"] = "failed"
                item["created_id"] = None
                dropped_count += 1
                # item_index is the index into the persisted (extraction-
                # order) list, which is what the UI / audits consult.
                logger.warning(
                    "processing.auto_create.dropped dump_id=%s item_index=%d "
                    "item_type=%s caller=worker",
                    dump_id, filtered_items.index(item), item["type"],
                )
            else:
                item["status"] = "auto_created"
                item["created_id"] = created_id
            auto_count += 1
        else:
            item["status"] = "suggested"
            suggest_count += 1

    has_suggestions = any(
        item["status"] == "suggested" for item in filtered_items
    )
    processing_status = "needs_review" if has_suggestions else "processed"

    elapsed = time.time() - t_start
    logger.info(
        "processing.done dump_id=%s duration_ms=%d method=%s "
        "auto_created=%d suggested=%d dropped=%d status=%s",
        dump_id, int(elapsed * 1000), extraction_method,
        auto_count, suggest_count, dropped_count, processing_status,
    )

    ts = now_utc()
    processed_json = json.dumps({
        "version": 1,
        "processed_at": ts,
        "extraction_method": extraction_method,
        "items": filtered_items,
    }, ensure_ascii=False)

    return {
        "processing_status": processing_status,
        "processed_items_json": processed_json,
        "processed_at": ts,
        "auto_count": auto_count,
        "suggest_count": suggest_count,
        "extraction_method": extraction_method,
    }


def process_brain_dump(dump_id):
    """
    Main processing pipeline for a brain dump (synchronous / HTTP-handler form).

    This is the legacy synchronous entrypoint, kept for backward compat with
    `handle_process_brain_dump`. Phase 3 will swap that handler over to the
    queue, at which point this wrapper can be retired.

    Today's behaviour is preserved: we open a connection, drive
    `process_brain_dump_for_worker`, sync the brain_dumps cache, commit, and
    return an HTTP-shaped tuple.
    """
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT id FROM brain_dumps WHERE id = ?", (dump_id,)
        ).fetchone()
        if not row:
            return 404, {"error": "Brain dump not found"}

        # Mark processing (mirrors prior behaviour for any UI peeking mid-run).
        conn.execute(
            "UPDATE brain_dumps SET processing_status = 'processing' WHERE id = ?",
            (dump_id,),
        )
        conn.commit()

        try:
            result = process_brain_dump_for_worker(conn, dump_id)
        except Exception as e:
            # Mirror legacy reset-to-unprocessed on synchronous failure.
            # Privacy invariant: log error TYPE only -- the message may carry
            # text from upstream libs we don't control.
            logger.warning(
                "processing.sync.error dump_id=%s error_type=%s",
                dump_id, type(e).__name__,
            )
            conn.execute(
                "UPDATE brain_dumps SET processing_status = 'unprocessed' WHERE id = ?",
                (dump_id,),
            )
            conn.commit()
            return 500, {"error": f"Processing failed: {type(e).__name__}"}

        ts = result["processed_at"]
        processing_status = result["processing_status"]
        conn.execute(
            "UPDATE brain_dumps SET "
            "processing_status = ?, processed_items = ?, processed_at = ?, "
            "processed = ?, updated_at = ? "
            "WHERE id = ?",
            (
                processing_status,
                result["processed_items_json"],
                ts,
                1 if processing_status == "processed" else 0,
                ts,
                dump_id,
            ),
        )
        conn.commit()

        updated = dict(
            conn.execute("SELECT * FROM brain_dumps WHERE id = ?", (dump_id,)).fetchone()
        )
        updated["tags"] = get_tags_for(conn, "brain_dump_tags", "brain_dump_id", dump_id)
        if updated.get("processed_items"):
            updated["processed_items"] = json.loads(updated["processed_items"])
        return 200, updated

    finally:
        conn.close()


def handle_process_brain_dump(dump_id):
    """
    Re-queue a brain dump for processing.

    Per app/contracts/background-processing.md (POST /api/brain-dumps/<id>/process):

      - 404 if the dump does not exist.
      - 409 if there is a non-terminal queue row in status='processing' (a
        worker has it; re-queueing now would be useless and would race the
        partial-unique-index).
      - 202 + {processing_status: 'queued'} otherwise. Idempotent: if a
        'queued' row already exists for this dump, we return 202 without
        inserting (the partial unique index would reject the duplicate
        anyway, and the existing row is exactly what the caller wanted).

    The brain_dumps.processing_status cache is synced to 'queued' on insert
    so the UI badge reflects the requeue immediately.
    """
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT id FROM brain_dumps WHERE id = ?", (dump_id,)
        ).fetchone()
        if not row:
            return 404, {"error": "not found"}

        # Check for a non-terminal queue row. Two cases:
        #   - status='processing'  → 409 (worker has it; can't usefully re-queue).
        #   - status='queued'      → idempotent success, no insert.
        active = conn.execute(
            "SELECT status FROM work_queue "
            "WHERE job_type = 'brain_dump' "
            "  AND target_id = ? "
            "  AND status IN ('queued','processing') "
            "LIMIT 1",
            (dump_id,),
        ).fetchone()

        if active and active["status"] == "processing":
            return 409, {"error": "already processing"}

        if active and active["status"] == "queued":
            # Already queued — idempotent. Cache should already be 'queued',
            # but sync defensively in case it drifted.
            conn.execute(
                "UPDATE brain_dumps SET processing_status = 'queued' "
                "WHERE id = ? AND processing_status != 'queued'",
                (dump_id,),
            )
            conn.commit()
            return 202, {"id": dump_id, "processing_status": "queued"}

        # No non-terminal row — insert one and sync the cache.
        conn.execute(
            "INSERT INTO work_queue (job_type, target_id, status) "
            "VALUES ('brain_dump', ?, 'queued')",
            (dump_id,),
        )
        conn.execute(
            "UPDATE brain_dumps SET processing_status = 'queued' WHERE id = ?",
            (dump_id,),
        )
        conn.commit()
        return 202, {"id": dump_id, "processing_status": "queued"}
    finally:
        conn.close()


def handle_retry_brain_dump(dump_id):
    """
    Re-queue a previously-failed brain dump, resetting attempts/error.

    Per app/contracts/background-processing.md (POST /api/brain-dumps/<id>/retry):

      - 404 if the dump does not exist.
      - 409 if the dump's current processing_status is not 'failed'. Use
        /process for non-failed re-queues.
      - 409 (defence-in-depth) if a non-terminal queue row already exists.
        Shouldn't happen when status='failed', but the check is cheap and
        prevents a unique-index violation surfacing as a 500.
      - 202 + {processing_status: 'queued'} otherwise.

    Attempts/error reset is implemented by inserting a NEW work_queue row
    (defaults: attempts=0, error=NULL) rather than mutating the failed row.
    The old failed row stays as audit trail. The partial unique index allows
    the new row because the prior failed row is terminal.
    """
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT processing_status FROM brain_dumps WHERE id = ?", (dump_id,)
        ).fetchone()
        if not row:
            return 404, {"error": "not found"}
        if row["processing_status"] != "failed":
            return 409, {"error": "not in failed state"}

        # Defence: shouldn't happen when status='failed', but check anyway.
        active = conn.execute(
            "SELECT 1 FROM work_queue "
            "WHERE job_type = 'brain_dump' "
            "  AND target_id = ? "
            "  AND status IN ('queued','processing') "
            "LIMIT 1",
            (dump_id,),
        ).fetchone()
        if active:
            return 409, {"error": "already queued"}

        conn.execute(
            "INSERT INTO work_queue (job_type, target_id, status) "
            "VALUES ('brain_dump', ?, 'queued')",
            (dump_id,),
        )
        conn.execute(
            "UPDATE brain_dumps SET processing_status = 'queued' WHERE id = ?",
            (dump_id,),
        )
        conn.commit()
        return 202, {"id": dump_id, "processing_status": "queued"}
    finally:
        conn.close()


def handle_approve_item(dump_id, body):
    """Handler for POST /api/brain-dumps/:id/approve-item"""
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT * FROM brain_dumps WHERE id = ?", (dump_id,)
        ).fetchone()
        if not row:
            return 404, {"error": "Brain dump not found"}

        dump = dict(row)
        processed_items = json.loads(dump["processed_items"]) if dump["processed_items"] else None
        if not processed_items:
            return 400, {"error": "No processed items"}

        item_index = body.get("item_index")
        action = body.get("action", "approve")  # approve, reject, edit_approve, retry, unreject
        edit_data = body.get("edit_data")  # optional edited data

        if item_index is None or item_index < 0 or item_index >= len(processed_items["items"]):
            return 400, {"error": "Invalid item index"}

        # Action allow-list. Reject unknown actions with 400 BEFORE any state
        # change so a typo'd payload is a loud no-op, not a silent one. Today's
        # if/elif chain would have silently 200'd on unknown action; that's the
        # status-truthfulness shape we're killing across this handler.
        if action not in ("approve", "edit_approve", "reject", "retry", "unreject"):
            return 400, {"error": f"unknown action: {action!r}"}

        item = processed_items["items"][item_index]

        if action == "reject":
            item["status"] = "rejected"
        elif action == "unreject":
            # Precondition: item MUST currently be `rejected`. 409 otherwise --
            # un-reject is a state transition, not a clobber. Returns the item
            # to the suggestion queue (status=suggested) so the user can re-
            # decide. No `_auto_create_item` call -- creation is the user's
            # next step via approve/edit_approve.
            if item.get("status") != "rejected":
                return 409, {"error": "only rejected items can be un-rejected"}
            item["status"] = "suggested"
            # Clear any prior error text so the row reads cleanly when it
            # returns to the suggestion queue. `created_id` was already None
            # for a rejected item (rejected items never created a row).
            if "error" in item:
                item["error"] = None
        elif action == "retry":
            # Precondition: item MUST currently be `failed`. 409 otherwise --
            # retry is the recovery affordance for system-side drops, not a
            # general re-run button.
            if item.get("status") != "failed":
                return 409, {"error": "only failed items can be retried"}
            # Re-run the create against the item's existing `data` payload.
            # Same exception discipline as the approve path: UnknownItemType
            # is a programming bug -> 500 with class-name only; nothing else
            # is broadened. _auto_create_item still owns its own typed-catch
            # of MalformedItemData / sqlite3.Error -> log + None.
            try:
                created_id = _auto_create_item(
                    conn, item, dump_id,
                    sibling_items=processed_items["items"],
                )
            except UnknownItemType as e:
                return 500, {"error": f"internal error: {type(e).__name__}"}
            if created_id is None:
                # Stays `failed`. Invariant 1 still holds: no created_id, no
                # success status. The structured-logging line was already
                # emitted by _auto_create_item; we add a caller-side line
                # tagged `caller=retry` to match the worker/approve pattern.
                item["status"] = "failed"
                item["created_id"] = None
                logger.warning(
                    "processing.auto_create.dropped dump_id=%s item_index=%d "
                    "item_type=%s caller=retry",
                    dump_id, item_index, item["type"],
                )
            else:
                # Match the approve path's success status (`approved`) -- a
                # user-initiated retry is a user-initiated create, same as
                # approve. The worker-side `auto_created` status is reserved
                # for the high-confidence path that ran without user action.
                item["created_id"] = created_id
                item["status"] = "approved"
                if "error" in item:
                    item["error"] = None
        elif action in ("approve", "edit_approve"):
            # Precondition: approve / edit_approve require `suggested`. The
            # contract is implicit on this today; making it explicit prevents
            # double-approve of an already-created item from clobbering the
            # `created_id` of a real DB row.
            if item.get("status") != "suggested":
                return 409, {"error": "only suggested items can be approved"}
            if edit_data:
                item["data"].update(edit_data)
            # Per auto-create contract: UnknownItemType propagates here as
            # a typed catch -> 500 with class-name only (no exception text
            # leak). Any other unexpected exception bubbles to the framework
            # 500 handler unchanged. We do NOT broaden to `except Exception`
            # -- that would re-introduce the swallow this audit is killing.
            try:
                # sibling_items lets the tag branch fan out apply_to
                # references to any siblings already created on the worker
                # path (e.g. the high-confidence task this tag belongs to).
                # Tag approvals through this handler will only attach to
                # siblings that already have `created_id` set; pending
                # `suggested` siblings are skipped (no_created_id).
                created_id = _auto_create_item(
                    conn, item, dump_id,
                    sibling_items=processed_items["items"],
                )
            except UnknownItemType as e:
                return 500, {"error": f"internal error: {type(e).__name__}"}
            if created_id is None:
                # Invariant 1: status MUST NOT be `approved` when no row was
                # created. Mark `failed`, surface via the returned dump.
                # HTTP shape unchanged -- 200, the approve action was accepted;
                # the underlying create is what failed.
                item["status"] = "failed"
                item["created_id"] = None
                logger.warning(
                    "processing.auto_create.dropped dump_id=%s item_index=%d "
                    "item_type=%s caller=approve",
                    dump_id, item_index, item["type"],
                )
            else:
                item["created_id"] = created_id
                item["status"] = "approved"

        # Update processed_items JSON
        ts = now_utc()
        processed_items["processed_at"] = ts

        # Check if all suggestions are now resolved. `unreject` flips a row
        # back to `suggested`, so a previously-`processed` dump may need to
        # roll back to `needs_review` -- the rollup below catches this.
        has_pending = any(
            i["status"] == "suggested"
            for i in processed_items["items"]
        )
        new_status = dump["processing_status"]
        if not has_pending and dump["processing_status"] == "needs_review":
            new_status = "processed"
        elif has_pending and dump["processing_status"] == "processed":
            # Un-reject can resurrect a pending suggestion in a previously-
            # done dump. Roll back to needs_review and clear the `processed`
            # flag below so the dumps list re-surfaces it for triage.
            new_status = "needs_review"

        conn.execute(
            "UPDATE brain_dumps SET processed_items = ?, processing_status = ?, "
            "processed = ?, updated_at = ? WHERE id = ?",
            (
                json.dumps(processed_items, ensure_ascii=False),
                new_status,
                # `processed` flag mirrors processing_status: 1 only when
                # terminal-done. needs_review (including the unreject roll-
                # back path above) is not terminal -> 0.
                1 if new_status == "processed" else (
                    0 if new_status == "needs_review" else dump["processed"]
                ),
                ts,
                dump_id,
            ),
        )
        conn.commit()

        updated = dict(
            conn.execute("SELECT * FROM brain_dumps WHERE id = ?", (dump_id,)).fetchone()
        )
        updated["tags"] = get_tags_for(conn, "brain_dump_tags", "brain_dump_id", dump_id)
        if updated.get("processed_items"):
            updated["processed_items"] = json.loads(updated["processed_items"])
        return 200, updated

    finally:
        conn.close()
