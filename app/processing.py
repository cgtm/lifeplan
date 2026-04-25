"""
lifeplan — brain dump processing engine
All regex functions, LLM functions, and the main process_brain_dump pipeline.
"""

import json
import re
import time
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime, timezone, timedelta

from .db import get_db, now_utc, rows_to_dicts, get_tags_for, call_mistral_api, _load_env

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

7. **Tags**: Which existing tags apply? Also suggest new tags (lowercase, hyphenated, max 30 chars) for recurring themes not covered by existing tags.

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
      "source_text": "string"
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
    {{"tag_name": "settlement", "is_new": false, "confidence": 0.95, "source_text": "settlement papers"}},
    {{"tag_name": "visa", "is_new": false, "confidence": 0.95, "source_text": "D-4 visa"}},
    {{"tag_name": "move-house", "is_new": false, "confidence": 0.95, "source_text": "house move"}}
  ]
}}

Now extract items from the brain dump text above. Return ONLY the JSON object, no other text."""

    return prompt


def _call_ollama(prompt):
    """Send a prompt to Ollama and return the parsed JSON response.
    Returns the parsed dict on success, or None on failure.
    """
    print(f"  [ollama] Calling Ollama at {OLLAMA_URL} model={OLLAMA_MODEL}")
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
            print(f"  [ollama] Success in {elapsed:.1f}s")
            return parsed
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError,
            OSError, TimeoutError, ValueError, KeyError) as e:
        elapsed = time.time() - t0
        print(f"  [ollama] Failed in {elapsed:.1f}s: {type(e).__name__}: {e}")
        return None


def _call_mistral(prompt):
    """Send a prompt to the Mistral cloud API and return the parsed JSON response.
    Uses the same prompt as Ollama but via OpenAI-compatible chat/completions.
    Returns the parsed dict on success, or None on failure.
    """
    print("  [mistral] Calling Mistral cloud API (processing fallback)")
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
        print(f"  [mistral] Success in {elapsed:.1f}s")
    else:
        print(f"  [mistral] Failed in {elapsed:.1f}s")
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
        items.append({
            "type": "tag",
            "confidence": conf,
            "status": status,
            "source_text": tag.get("source_text", tag_name),
            "data": {
                "tag_name": tag_name,
                "is_new": is_new,
                "matched_existing_id": tag_id_map.get(tag_name) if not is_new else None,
                "apply_to": [],
            },
            "created_id": None,
        })

    return items


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
        print("  [processing] Ollama unavailable, falling back to Mistral cloud API")
        llm_data = _call_mistral(prompt)
        tier_used = "mistral"

    if llm_data is None:
        print("  [processing] All LLM backends failed, falling back to regex")
        return None

    # Validate minimal structure
    if not isinstance(llm_data, dict):
        print("  [processing] LLM response is not a dict, falling back to regex")
        return None

    print(f"  [processing] LLM succeeded via {tier_used}")
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
    type_counts = Counter(i["type"] for i in items)
    summary = ", ".join(f"{cnt} {t}" for t, cnt in sorted(type_counts.items()))
    print(f"  [processing] Extracted {len(items)} items via {tier_used}: {summary}")
    return items


def _auto_create_item(conn, item, dump_id):
    """Create a database row for an auto-created item. Returns the new row ID or None."""
    ts = now_utc()
    itype = item["type"]
    data = item["data"]

    try:
        if itype == "task":
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
            tag_name = data["tag_name"]
            if data.get("is_new"):
                conn.execute(
                    "INSERT OR IGNORE INTO tags (name) VALUES (?)", (tag_name,)
                )
                tag_row = conn.execute(
                    "SELECT id FROM tags WHERE name = ?", (tag_name,)
                ).fetchone()
                if tag_row:
                    # Link to the brain dump
                    conn.execute(
                        "INSERT OR IGNORE INTO brain_dump_tags (brain_dump_id, tag_id) "
                        "VALUES (?, ?)",
                        (dump_id, tag_row["id"]),
                    )
                    return tag_row["id"]
            else:
                tag_id = data.get("matched_existing_id")
                if tag_id:
                    conn.execute(
                        "INSERT OR IGNORE INTO brain_dump_tags (brain_dump_id, tag_id) "
                        "VALUES (?, ?)",
                        (dump_id, tag_id),
                    )
                    return tag_id

        elif itype == "goal_new":
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

            # Link detected people via goal_people
            for person_id in data.get("people_ids", []):
                conn.execute(
                    "INSERT OR IGNORE INTO goal_people (goal_id, person_id, role) "
                    "VALUES (?, ?, ?)",
                    (goal_id, person_id, "involved"),
                )

            return goal_id

        elif itype == "person_new":
            # Insert new person into the people table
            cur = conn.execute(
                "INSERT INTO people (name, relationship, notes, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (
                    data["name"],
                    data.get("inferred_relationship", "unknown"),
                    data.get("notes", data.get("context", "")),
                    ts, ts,
                ),
            )
            return cur.lastrowid

        elif itype == "person_mention":
            # No new row to create, just note the mention
            return data.get("person_id")

        elif itype == "goal_link":
            # Only report a created_id when a goal was actually linked
            goal_id = data.get("goal_id")
            if goal_id is not None:
                return goal_id
            return None

    except Exception:
        pass  # Don't fail the whole pipeline for one item

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
        # Caller's handle_failure will route this into retry / terminal.
        raise ValueError(f"brain_dump {dump_id} not found")

    dump = dict(row)
    content = dump["content"]
    preview = content[:80].replace("\n", " ")
    print(f"  [processing] Starting brain dump #{dump_id}: \"{preview}...\"")
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
    print(f"  [processing] Context: {len(goals_data)} goals, {len(known_people)} people, {len(known_tags)} tags")

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
        print("  [regex] Running regex-based extraction")

        segments = segment_text(content)
        print(f"  [regex] Split into {len(segments)} segments")

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

        type_counts = Counter(i["type"] for i in all_items)
        summary = ", ".join(f"{cnt} {t}" for t, cnt in sorted(type_counts.items()))
        print(f"  [regex] Extracted {len(all_items)} items: {summary}")

    # Confidence filtering -- discard items below 0.50
    filtered_items = [
        item for item in all_items if item["confidence"] >= 0.50
    ]

    # Auto-create high-confidence items
    auto_count = 0
    suggest_count = 0
    for item in filtered_items:
        if item["confidence"] >= 0.80:
            item["status"] = "auto_created"
            created_id = _auto_create_item(conn, item, dump_id)
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
    print(f"  [processing] Done #{dump_id} in {elapsed:.1f}s via {extraction_method}: "
          f"{auto_count} auto-created, {suggest_count} suggested, "
          f"status={processing_status}")

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
            print(f"  [processing] ERROR #{dump_id}: {type(e).__name__}: {e}")
            conn.execute(
                "UPDATE brain_dumps SET processing_status = 'unprocessed' WHERE id = ?",
                (dump_id,),
            )
            conn.commit()
            return 500, {"error": f"Processing failed: {str(e)}"}

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
    """Handler for POST /api/brain-dumps/:id/process"""
    return process_brain_dump(dump_id)


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
        action = body.get("action", "approve")  # approve, reject, edit_approve
        edit_data = body.get("edit_data")  # optional edited data

        if item_index is None or item_index < 0 or item_index >= len(processed_items["items"]):
            return 400, {"error": "Invalid item index"}

        item = processed_items["items"][item_index]

        if action == "reject":
            item["status"] = "rejected"
        elif action in ("approve", "edit_approve"):
            if edit_data:
                item["data"].update(edit_data)
            created_id = _auto_create_item(conn, item, dump_id)
            item["created_id"] = created_id
            item["status"] = "approved"

        # Update processed_items JSON
        ts = now_utc()
        processed_items["processed_at"] = ts

        # Check if all suggestions are now resolved
        has_pending = any(
            i["status"] == "suggested"
            for i in processed_items["items"]
        )
        new_status = dump["processing_status"]
        if not has_pending and dump["processing_status"] == "needs_review":
            new_status = "processed"

        conn.execute(
            "UPDATE brain_dumps SET processed_items = ?, processing_status = ?, "
            "processed = ?, updated_at = ? WHERE id = ?",
            (
                json.dumps(processed_items, ensure_ascii=False),
                new_status,
                1 if new_status == "processed" else dump["processed"],
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
