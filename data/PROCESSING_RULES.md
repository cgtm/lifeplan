# Brain Dump Auto-Processing Specification

**Version:** 1.1
**Created:** 2026-04-20
**Author:** Reed (Knowledge Architect)
**Implementer:** Lumen (Full-Stack Engineer)

## Purpose

When Cam submits a brain dump, the system should automatically analyse the raw text and extract structured items (tasks, knowledge, people mentions, tags, dates). Items extracted with high confidence are created directly. Items with low confidence are flagged for Cam's review. The goal is to turn messy capture into structured data with minimal manual effort.

## Endpoint Design

**Endpoint:** `POST /api/brain-dumps/{id}/process`

**Trigger:** Called after a brain dump is saved. Can also be called manually to reprocess.

**Flow:**
1. Fetch the brain dump row by `id`
2. Set `processing_status` to `'processing'`
3. Run all extraction rules (below) against the `content` text
4. Store the full extraction result as JSON in `processed_items`
5. If all extracted items have confidence >= 0.8, set `processing_status` to `'processed'`
6. If any extracted item has confidence < 0.8, set `processing_status` to `'needs_review'`
7. Set `processed_at` to current UTC timestamp
8. For items with confidence >= 0.8, auto-create the database rows (tasks, knowledge_items, tags, links)
9. For items with confidence < 0.8, store them in `processed_items` only -- do not create database rows until Cam approves

**Idempotency:** Reprocessing a brain dump should clear previously auto-created items from that dump before re-extracting. The `processed_items` JSON includes IDs of created rows to enable this cleanup.

---

## `processed_items` JSON Schema

The `processed_items` column stores a JSON object with the following structure:

```json
{
  "version": 1,
  "processed_at": "2026-04-20T14:30:00Z",
  "items": [
    {
      "type": "task | knowledge | person_mention | person_new | tag | goal_link | goal_new",
      "confidence": 0.0-1.0,
      "status": "auto_created | suggested | approved | rejected",
      "source_text": "the exact substring from the brain dump that triggered this extraction",
      "data": { ... },
      "created_id": null
    }
  ]
}
```

**Field definitions:**

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | What kind of item was extracted (see rules below) |
| `confidence` | float | 0.0 to 1.0. Items >= 0.8 are auto-created; below that, suggested |
| `status` | string | `auto_created` (done), `suggested` (awaiting review), `approved` (Cam accepted), `rejected` (Cam dismissed) |
| `source_text` | string | The exact substring from the dump that triggered this extraction |
| `data` | object | The structured data to insert. Shape depends on `type` (see each rule) |
| `created_id` | integer or null | If a row was created, its ID in the target table. Null if suggested/rejected |

---

## Extraction Rules

### Rule 1: Task Detection

**Goal:** Find actionable items and create task rows.

**Trigger patterns** (case-insensitive):

| Pattern Category | Examples |
|-----------------|----------|
| Explicit markers | "todo:", "to-do:", "task:", "remind me to", "don't forget to" |
| Modal verbs | "need to [verb]", "must [verb]", "should [verb]", "have to [verb]", "gotta [verb]" |
| Action imperatives | Lines starting with a verb in imperative form: "call", "email", "book", "buy", "send", "check", "schedule", "ask", "find out", "look into", "follow up", "set up", "organise", "sort out" |
| Checkbox syntax | Lines starting with "- [ ]", "[ ]", "* [ ]" |

**Extraction logic:**

1. Split the dump into segments (sentences or line-separated blocks)
2. For each segment, check against trigger patterns
3. If matched, extract:
   - `title`: The action, cleaned up to a concise imperative (e.g. "need to call Priya about the house" becomes "Call Priya about the house")
   - `description`: The full original text for context
   - `due_date`: If a date is detected in the same segment (see Rule 6), attach it
   - `goal_id`: Run goal matching (see Rule 4) on the segment. If a match is found with confidence >= 0.7, link it
   - `status`: Default `'active'`

**Confidence scoring:**

| Condition | Score |
|-----------|-------|
| Explicit marker ("todo:", "remind me to", checkbox) | 0.95 |
| Modal verb + clear action verb | 0.85 |
| Imperative verb at line start with clear object | 0.80 |
| Action verb present but context ambiguous | 0.60 |
| Might be a task, might be a statement | 0.40 |

**Data shape:**
```json
{
  "type": "task",
  "data": {
    "title": "Call Priya about the house",
    "description": "need to call priya about the house before friday",
    "due_date": "2026-04-24",
    "goal_id": 3,
    "goal_title": "Move House",
    "status": "active"
  }
}
```

---

### Rule 2: People Detection

**Goal:** Identify mentions of known people and detect potential new people.

**Step 2a: Known people matching**

Query the `people` table at processing time. Current known names: Nadia, Priya, Sam, Jess, Minji.

- Case-insensitive whole-word match against all names in `people.name`
- Also match common variations if stored (future: add an `aliases` column)
- For each match, record the person_id and the surrounding context

**Step 2b: New person detection**

Scan for patterns that suggest a person name not already in the database:

| Pattern | Example |
|---------|---------|
| "met [Name]" / "met with [Name]" | "met with James at the cafe" |
| "[Name] said" / "[Name] told me" | "Sarah said the lease is ready" |
| "call [Name]" / "email [Name]" / "text [Name]" | "call Dr. Osei tomorrow" |
| "talked to [Name]" / "spoke with [Name]" | "spoke with the lawyer Mike" |
| "[Name] from [place/org]" | "Jenny from the embassy" |

**Name detection heuristic:** A capitalised word (or sequence of capitalised words) appearing in a person-context pattern that does not match a known person, a common English word, or a known place name.

**Confidence scoring:**

| Condition | Score |
|-----------|-------|
| Exact match on known person name | 0.95 |
| Known person name appears but could be a different person with same name (uncommon for this DB) | 0.90 |
| New name in strong person-context pattern ("met with X", "X said") | 0.70 |
| Capitalised word near action verb, possibly a name | 0.40 |

**Data shape (known person):**
```json
{
  "type": "person_mention",
  "data": {
    "person_id": 2,
    "person_name": "Priya",
    "context": "Priya said the settlement papers are ready"
  }
}
```

**Data shape (new person):**
```json
{
  "type": "person_new",
  "data": {
    "name": "Dr. Osei",
    "inferred_relationship": "professional",
    "context": "call Dr. Osei tomorrow about the visa medical"
  }
}
```

New person suggestions should always go to review (never auto-create people).

---

### Rule 3: Knowledge Extraction

**Goal:** Extract facts, decisions, learnings, and notes into `knowledge_items`.

**Trigger patterns:**

| item_type | Trigger Patterns |
|-----------|-----------------|
| `decision` | "decided to", "decision:", "going to [verb] instead of", "chose to", "I've decided", "we agreed to" |
| `learning` | "I learned", "learned that", "TIL", "turns out", "realised that", "now I know", "lesson:" |
| `fact` | "important:", "note:", "FYI:", "for the record", "[subject] is [factual statement]", "the [thing] is [value]" |
| `reference` | Segments containing URLs, phone numbers, addresses, email addresses, or "the number is", "the address is", "the link is" |
| `note` | "remember:", "keep in mind", "note to self" |

**Extraction logic:**

1. For each segment matching a trigger pattern, extract:
   - `title`: A concise summary of the knowledge item (generated from the content, max 80 chars)
   - `content`: The full original text
   - `item_type`: Based on which trigger pattern matched
   - `source`: `"brain_dump:{id}"` where `{id}` is the brain dump's ID

**Confidence scoring:**

| Condition | Score |
|-----------|-------|
| Explicit marker ("decided to", "I learned", "important:", "note:") | 0.90 |
| Strong factual pattern with clear subject-predicate | 0.80 |
| Contains a URL, phone number, or address (reference) | 0.85 |
| Declarative sentence that might be a fact or might be an opinion | 0.50 |

**Data shape:**
```json
{
  "type": "knowledge",
  "data": {
    "title": "Korean visa requires medical exam",
    "content": "Found out the D-4 visa requires a medical exam from an approved clinic",
    "item_type": "fact",
    "source": "brain_dump:42"
  }
}
```

---

### Rule 4: Goal Relevance Matching

**Goal:** Link extracted items to existing goals by matching content against goal titles and descriptions.

**Current goals for matching:**
- Move to Seoul
- Finalise Property Settlement
- Move House
- Nadia's Visit (26 Sept - 8 Oct 2025)
- Learn Korean
- Attend Korean Language School in Seoul
- Achieve Debt Freedom
- Work Transition
- Achieve Korean Proficiency

**Matching strategy (applied to each extracted item and to the dump as a whole):**

1. **Keyword index:** Build a keyword set for each goal from its title and description. Include synonyms and related terms:

   | Goal | Keywords |
   |------|----------|
   | Move to Seoul | seoul, korea, move, relocate, apartment, housing, visa, immigration |
   | Finalise Property Settlement | settlement, settlement, lawyer, legal, custody, separation, Priya |
   | Move House | house, move, packing, lease, rent, landlord, moving |
   | Nadia's Visit | nadia, visit, september, october |
   | Learn Korean | korean, language, study, vocabulary, grammar, hangul, TOPIK |
   | Attend Korean Language School | language school, enrolment, semester, tuition, student visa, D-4 |
   | Achieve Debt Freedom | debt, money, payment, loan, finance, budget, savings |
   | Work Transition | work, job, career, remote, contract, employer, freelance |
   | Achieve Korean Proficiency | korean, proficiency, fluency, TOPIK, level, exam |

2. **Scoring:** Count keyword matches in the segment. Normalise by segment length. Weight title-word matches higher (2x) than description-word matches.

3. **Threshold:** A goal match is considered valid at score >= 0.5. Multiple goals can match a single item.

**Confidence scoring:**

| Condition | Score |
|-----------|-------|
| 3+ keyword matches including a title word | 0.90 |
| 2 keyword matches including a title word | 0.80 |
| 2+ keyword matches, description words only | 0.65 |
| 1 keyword match only | 0.40 |

**Output:** Goal matches are attached to extracted tasks and knowledge items via their `goal_id` field (for tasks) or as a separate `goal_link` item that creates tag associations.

**Data shape (standalone goal link):**
```json
{
  "type": "goal_link",
  "data": {
    "goal_id": 1,
    "goal_title": "Move to Seoul",
    "matched_keywords": ["seoul", "visa", "apartment"],
    "target_type": "brain_dump",
    "target_id": 42
  }
}
```

---

### Rule 4b: Goal Creation Detection

**Goal:** Detect when Cam is stating a new life goal and create a goal row.

**Trigger patterns** (case-insensitive):

| Pattern Category | Examples |
|-----------------|----------|
| Explicit markers | "new goal:", "goal:", "my goal is", "I want to", "life goal:" |
| Aspirational statements | "I'm going to [verb]", "I plan to [verb]", "this year I will" |

**Extraction logic:**

1. For each segment matching a trigger pattern, extract:
   - `title`: A concise goal name (max 80 chars)
   - `description`: The full original text for context
   - `status`: Default `'active'`

**Confidence scoring:**

| Condition | Score |
|-----------|-------|
| Explicit marker ("new goal:", "goal:", "my goal is") | 0.90 |
| Aspirational with clear objective ("I plan to move to Berlin") | 0.75 |
| Vague aspiration ("I want to be healthier") | 0.55 |

**Data shape:**
```json
{
  "type": "goal_new",
  "data": {
    "title": "Move to Berlin",
    "description": "new goal: move to Berlin by end of 2027",
    "status": "active"
  }
}
```

**Post-processing note:** If an item is classified as a task but contains goal-like language (e.g. "new goal: ..."), post-processing should reclassify it as `goal_new`.

---

### Rule 5: Tag Generation

**Goal:** Extract topic keywords and match against existing tags or suggest new ones.

**Current tags in the database:**
`admin`, `ai-team`, `blocked`, `completed`, `debt`, `settlement`, `nadia`, `nadia-visit-2025`, `finance`, `kids`, `knowledge-management`, `korean`, `language-school`, `legal`, `life-goal`, `lifeplan`, `move-house`, `passport`, `seoul`, `setup`, `sqlite`, `priya`, `visa`, `work`

**Strategy:**

1. **Existing tag matching:** Check if any existing tag name (or its un-hyphenated form) appears as a word in the dump text. Case-insensitive.
   - "move-house" matches "move house", "moving house"
   - "korean" matches "Korean", "korean"
   - "settlement" matches "settlement", "settling"

2. **New tag suggestion:** After extracting all items, identify the dominant topics that are NOT already covered by matched existing tags. A new tag is suggested when:
   - A noun or noun-phrase appears 2+ times in the dump
   - A proper noun (place, tool, concept) appears that could be a useful future filter
   - The extracted tasks/knowledge cluster around a theme not covered by existing tags

3. **Tag format:** Lowercase, hyphenated, max 30 characters. E.g. `health`, `visa-medical`, `apartment-search`.

**Confidence scoring:**

| Condition | Score |
|-----------|-------|
| Exact match on existing tag | 0.95 |
| Stem/variant match on existing tag ("settling" -> "settlement") | 0.85 |
| New tag, strong thematic evidence (2+ mentions, or tied to 2+ extracted items) | 0.70 |
| New tag, single mention but clear topic | 0.50 |

**Data shape:**
```json
{
  "type": "tag",
  "data": {
    "tag_name": "visa-medical",
    "is_new": true,
    "matched_existing_id": null,
    "apply_to": [
      {"type": "task", "index": 0},
      {"type": "knowledge", "index": 2}
    ]
  }
}
```

For existing tags, `is_new` is `false` and `matched_existing_id` has the tag's ID. The `apply_to` array references other items in the same `processed_items.items` array by their index, so the approval UI knows what to tag.

---

### Rule 6: Date Detection

**Goal:** Find dates, deadlines, and timeframes and attach them to extracted tasks.

**Patterns to detect:**

| Pattern | Example | Resolution |
|---------|---------|------------|
| ISO 8601 | "2026-05-01" | Direct parse |
| Written dates | "April 25th", "25 April", "Apr 25" | Parse to ISO 8601 |
| Relative days | "today", "tomorrow", "day after tomorrow" | Resolve relative to processing date |
| Named days | "Monday", "next Tuesday", "this Friday" | Resolve to next occurrence from processing date |
| Relative weeks | "next week", "in two weeks", "this week" | Resolve to Monday of target week |
| Relative months | "next month", "in 3 months" | Resolve to 1st of target month |
| Deadline language | "by Friday", "before May", "due April 30", "deadline: May 1" | Parse the date, mark as due_date |
| Vague timeframes | "soon", "eventually", "at some point", "when I can" | Do not attach a date; note the vagueness in the item |

**Attachment logic:**
- When a date is detected in the same segment as a task extraction, attach it as the task's `due_date`
- When a date appears near a knowledge item, store it in the knowledge item's `content` but do not create a separate field
- When a date appears without an associated task, create a standalone note: "Date mentioned: [date] in context: [surrounding text]" with confidence 0.50 (suggested for review)

**Confidence scoring:**

| Condition | Score |
|-----------|-------|
| Explicit ISO date or unambiguous written date | 0.95 |
| Relative date ("tomorrow", "next Tuesday") | 0.90 |
| Relative week/month ("next month", "in two weeks") | 0.80 |
| Ambiguous date (e.g. "Friday" without "next" or "this") | 0.70 |
| Vague timeframe ("soon", "eventually") | 0.30 |

---

### Rule 7: Ambiguity Handling

**Goal:** When the system is not confident about an extraction, flag it for Cam's review rather than creating bad data.

**Confidence thresholds:**

| Threshold | Action |
|-----------|--------|
| >= 0.80 | **Auto-create.** Insert the row into the database. Set `status` to `auto_created` in `processed_items` |
| 0.50 - 0.79 | **Suggest.** Store in `processed_items` only. Set `status` to `suggested`. Show to Cam in review UI |
| < 0.50 | **Discard quietly.** Do not store. Too noisy to be useful. Log for debugging only |

**Review UI contract (for Lumen to implement):**

For items with status `suggested`, the review UI should present:
- The original source text (highlighted in the brain dump)
- What the system thinks it found (e.g. "Task: Call Dr. Osei about visa medical")
- The confidence score as a simple indicator (not a raw number -- use "likely", "maybe", "uncertain")
- Two actions: **Approve** (creates the row, sets status to `approved`) and **Dismiss** (sets status to `rejected`)
- Optional: **Edit and Approve** (lets Cam modify the extracted data before creating the row)

**Conflict resolution:**
- If the same segment triggers both a task and a knowledge item extraction, keep both but note the overlap. Let Cam decide in review.
- If two goals match with similar scores, link to the higher-scoring one at auto-create threshold. Show both in review if the difference is < 0.1.
- If a person name matches both a known person and a potential new person pattern, prefer the known person match.

---

## Processing Pipeline Summary

```
Brain dump submitted
        |
        v
[1. LLM extraction (three-tier fallback)]
    Primary:  Ollama (local Mistral 7B)
    Fallback: Mistral cloud API (mistral-small-latest)
    Fallback: Regex pattern matching
    |
    |-- LLM path produces structured JSON with types,
    |   confidence scores, and extracted data per Rules 1-6.
    |
        v
[2. Post-processing]
    Fix goal misclassification (tasks with goal-like
    language reclassified as goal_new, Rule 4b).
    Attach dates to tasks (Rule 6).
    Resolve goal links (Rule 4).
        |
        v
[3. People detection (Rule 2)]
    Match known people names.
    Detect potential new people.
        |
        v
[4. Tag generation (Rule 5)]
    Match existing tags.
    Suggest new tags.
    Associate tags with extracted items.
        |
        v
[5. Confidence filtering (Rule 7)]
    >= 0.80: auto-create in database
    0.50-0.79: store as suggestion
    < 0.50: discard
        |
        v
[6. Store results]
    Write processed_items JSON to brain_dumps row.
    Set processing_status ('processed' or 'needs_review').
    Set processed_at timestamp.
    Update processed flag to 1 (backward compat).
```

---

## Database Changes

The `brain_dumps` table now has two additional columns:

| Column | Type | Description |
|--------|------|-------------|
| `processing_status` | TEXT | `'unprocessed'`, `'processing'`, `'processed'`, `'needs_review'`. Replaces the boolean `processed` for richer state tracking. Default: `'unprocessed'` |
| `processed_items` | TEXT (JSON) | JSON object containing all extracted items, their confidence scores, statuses, and created row IDs |

The old `processed` column (INTEGER 0/1) is retained for backward compatibility. When `processing_status` changes to `'processed'`, also set `processed = 1`.

**New index:** `idx_brain_dumps_processing_status` on `processing_status`.

---

## Example

**Input brain dump:**
> Talked to Priya today about the settlement. She said the lawyer wants everything signed by May 15th. Need to call Dr. Osei about the visa medical before next week. Decided to go with the Itaewon apartment -- 1.5M won/month. Also I should probably start packing boxes for the house move. TIL the D-4 visa processing takes 3-4 weeks not 2.

**Expected extractions:**

| # | Type | Extracted | Confidence | Action |
|---|------|-----------|------------|--------|
| 1 | person_mention | Priya (id: 2) | 0.95 | auto |
| 2 | task | "Get settlement papers signed" (due: 2026-05-15, goal: Finalise Property Settlement) | 0.85 | auto |
| 3 | person_new | Dr. Osei (professional) | 0.70 | suggest |
| 4 | task | "Call Dr. Osei about visa medical" (due: 2026-04-27, goal: Move to Seoul) | 0.90 | auto |
| 5 | knowledge (decision) | "Chose Itaewon apartment at 1.5M won/month" | 0.90 | auto |
| 6 | task | "Start packing boxes for house move" (goal: Move House) | 0.80 | auto |
| 7 | knowledge (learning) | "D-4 visa processing takes 3-4 weeks" | 0.90 | auto |
| 8 | tag (existing) | settlement, seoul, visa, move-house | 0.95 | auto |
| 9 | tag (new) | itaewon | 0.50 | suggest |
| 10 | goal_link | Finalise Property Settlement, Move to Seoul, Move House | 0.85 | auto |

---

## Implementation Notes for Lumen

1. **LLM-assisted extraction.** The pattern matching described above is the minimum baseline. The primary extraction engine is Ollama (local Mistral 7B), with Mistral cloud API (`mistral-small-latest`) as the first fallback and regex as the final fallback. These rules serve as the specification for what the LLM should find, not as a regex-only implementation.

2. **Segment splitting.** Start simple: split on newlines and sentence-ending punctuation. Do not over-segment -- keep "need to call Dr. Osei about the visa medical before next week" as one segment.

3. **Goal keyword index.** Build this at processing time by querying `goals` table. Cache it if processing multiple dumps in sequence. The keyword lists in Rule 4 are starting points -- the implementation should also include words from each goal's `description` field.

4. **People matching.** Query the `people` table at processing time. Match whole words only to avoid false positives (e.g. "set" should not match "Jess" -- use word boundary matching).

5. **Date resolution.** All relative dates resolve against the brain dump's `captured_at` timestamp, not the processing time. This matters if processing is delayed.

6. **Backward compatibility.** Keep setting the old `processed` column to 1 when processing completes, so existing queries in SCHEMA.md continue to work.

7. **Error handling.** If processing fails partway through, set `processing_status` back to `'unprocessed'` and log the error. Do not leave it in `'processing'` state. Consider a timeout -- if a dump has been `'processing'` for more than 5 minutes, treat it as failed.

8. **Testing.** Build a test suite with at least 10 sample brain dumps covering: pure tasks, pure knowledge, mixed content, ambiguous content, empty/minimal text, text with no extractable items.
