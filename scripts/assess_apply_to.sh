#!/bin/bash
# assess_apply_to.sh — production scan for the LLM-supplied apply_to feature
# (option (C) from docs/architecture/tag-apply-to-investigation.md).
#
# Owner: Reed (Knowledge Architect)
# Trigger: 10 production brain dumps post-deploy of (C), OR 4 weeks from
#          deploy date, whichever comes first.
#
# What this script does:
#   1. Pulls production brain_dumps + tags + junction tables from your-domain.example.
#   2. Filters to dumps captured (processed_at) AFTER DEPLOY_DATE.
#   3. Per-dump: prints id, content preview, tags extracted, apply_to
#      populated count, populated ratio, junction-table attachments observed.
#   4. Overall: dumps-with-non-empty-apply_to / total, tags-with-apply_to /
#      total, average apply_to count per tag, suspicious-empty count,
#      suspicious-noisy count.
#
# What this script does NOT do:
#   - Auto-grade correctness. Cam reads the per-dump rows and scores each
#     (tag, item) attachment as correct / incorrect manually.
#   - Decide pass / marginal / fail. That's Cam's spot-check applied to the
#     thresholds below.
#
# Thresholds for "earns its keep" (Reed's bar — see investigation paper §
# Success criteria):
#
#   PASSES:    precision >= 85% on Cam's spot-check
#              AND populated-rate >= 50% of LLM-emitted tags
#              AND sample size >= 20 (tag, item) attachments across >= 5 dumps
#
#   MARGINAL:  precision 70-85%
#              OR populated-rate 30-50%
#              (Cairn's call: keep, iterate prompt, or fall back to (B))
#
#   FAILS:     precision < 70%
#              OR populated-rate < 30%
#              (Cairn pulls (B) per-segment tagging forward as follow-up)
#
# "Precision" means: of all (tag, item) attachments the LLM caused via
# apply_to, the fraction that Cam would have made manually.
# "Populated-rate" means: of all tag items emitted by the LLM in eligible
# dumps, the fraction with a non-empty apply_to array.
#
# If sample size < 20 attachments at trigger time, the assessment is held
# open — don't grade noise. Re-run after the next batch of dumps.
#
# ---------------------------------------------------------------------------
# CONFIGURATION
# ---------------------------------------------------------------------------

set -euo pipefail

# Deploy timestamp for option (C) — commit ac58c06, prod restart at 2026-04-26.
# Format: YYYY-MM-DD HH:MM:SS (UTC, matches brain_dumps.processed_at).
# Override at run time: LIFEPLAN_APPLY_TO_DEPLOY_DATE=YYYY-MM-DD HH:MM:SS ./assess_apply_to.sh
DEPLOY_DATE="${LIFEPLAN_APPLY_TO_DEPLOY_DATE:-2026-04-26 01:00:00}"

PROD_HOST="your-user@your-domain.example"
PROD_DB="/opt/lifeplan/data/lifeplan.db"

# Suspicious-empty: a tag with apply_to=[] in a dump that ALSO produced >=2
# non-tag items. (LLM should usually attach the tag to at least one when
# multiple candidates exist.)
SUSPICIOUS_EMPTY_THRESHOLD=2

# Suspicious-noisy: a tag whose apply_to count exceeds this. Cam's
# multi-topic-respect requirement means a tag spanning many items is a
# smell worth flagging for review.
SUSPICIOUS_NOISY_THRESHOLD=4

# ---------------------------------------------------------------------------
# GUARDS
# ---------------------------------------------------------------------------

if [ "$DEPLOY_DATE" = "PLACEHOLDER" ]; then
  echo "ERROR: DEPLOY_DATE is not set." >&2
  echo "Edit this script and replace the PLACEHOLDER, or export" >&2
  echo "LIFEPLAN_APPLY_TO_DEPLOY_DATE=YYYY-MM-DD HH:MM:SS before running." >&2
  exit 2
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 not found in PATH." >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# PULL PRODUCTION DATA
# ---------------------------------------------------------------------------

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

DUMPS_TSV="$TMPDIR/dumps.tsv"
TASK_TAGS_TSV="$TMPDIR/task_tags.tsv"
KNOWLEDGE_TAGS_TSV="$TMPDIR/knowledge_tags.tsv"
GOAL_TAGS_TSV="$TMPDIR/goal_tags.tsv"
PERSON_TAGS_TSV="$TMPDIR/person_tags.tsv"
TAGS_TSV="$TMPDIR/tags.tsv"

echo "Pulling production data from $PROD_HOST..." >&2

# brain_dumps with processed_items JSON, processed AFTER deploy date.
# Use NULL-safe processed_at filter; brain_dumps.processed_at is set by the
# worker when it writes processed_items.
ssh "$PROD_HOST" "sqlite3 -separator $'\t' '$PROD_DB' \
  \"SELECT id, processed_at, substr(content, 1, 80), processed_items
    FROM brain_dumps
    WHERE processed_at IS NOT NULL
      AND processed_at >= '$DEPLOY_DATE'
      AND processed_items IS NOT NULL
    ORDER BY id;\"" > "$DUMPS_TSV"

# Junction tables — for cross-checking that what apply_to claimed actually
# landed in the DB.
ssh "$PROD_HOST" "sqlite3 -separator $'\t' '$PROD_DB' \
  'SELECT task_id, tag_id FROM task_tags;'" > "$TASK_TAGS_TSV"
ssh "$PROD_HOST" "sqlite3 -separator $'\t' '$PROD_DB' \
  'SELECT knowledge_id, tag_id FROM knowledge_tags;'" > "$KNOWLEDGE_TAGS_TSV"
ssh "$PROD_HOST" "sqlite3 -separator $'\t' '$PROD_DB' \
  'SELECT goal_id, tag_id FROM goal_tags;'" > "$GOAL_TAGS_TSV"
ssh "$PROD_HOST" "sqlite3 -separator $'\t' '$PROD_DB' \
  'SELECT person_id, tag_id FROM person_tags;'" > "$PERSON_TAGS_TSV"
ssh "$PROD_HOST" "sqlite3 -separator $'\t' '$PROD_DB' \
  'SELECT id, name FROM tags;'" > "$TAGS_TSV"

# ---------------------------------------------------------------------------
# ANALYSE
# ---------------------------------------------------------------------------

DUMPS_TSV="$DUMPS_TSV" \
TASK_TAGS_TSV="$TASK_TAGS_TSV" \
KNOWLEDGE_TAGS_TSV="$KNOWLEDGE_TAGS_TSV" \
GOAL_TAGS_TSV="$GOAL_TAGS_TSV" \
PERSON_TAGS_TSV="$PERSON_TAGS_TSV" \
TAGS_TSV="$TAGS_TSV" \
DEPLOY_DATE="$DEPLOY_DATE" \
SUSPICIOUS_EMPTY_THRESHOLD="$SUSPICIOUS_EMPTY_THRESHOLD" \
SUSPICIOUS_NOISY_THRESHOLD="$SUSPICIOUS_NOISY_THRESHOLD" \
python3 - <<'PY'
import json
import os
import sys
from collections import defaultdict

DEPLOY_DATE = os.environ["DEPLOY_DATE"]
SUSPICIOUS_EMPTY_THRESHOLD = int(os.environ["SUSPICIOUS_EMPTY_THRESHOLD"])
SUSPICIOUS_NOISY_THRESHOLD = int(os.environ["SUSPICIOUS_NOISY_THRESHOLD"])


def load_tsv(path):
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line:
                continue
            rows.append(line.split("\t"))
    return rows


def load_pairs(path):
    """Load junction-table rows as a set of (parent_id, tag_id) tuples."""
    out = set()
    for row in load_tsv(path):
        if len(row) < 2:
            continue
        try:
            out.add((int(row[0]), int(row[1])))
        except ValueError:
            continue
    return out


# Junction-table state (post-deploy snapshot).
task_tag_pairs = load_pairs(os.environ["TASK_TAGS_TSV"])
knowledge_tag_pairs = load_pairs(os.environ["KNOWLEDGE_TAGS_TSV"])
goal_tag_pairs = load_pairs(os.environ["GOAL_TAGS_TSV"])
person_tag_pairs = load_pairs(os.environ["PERSON_TAGS_TSV"])

tag_id_by_name = {}
for row in load_tsv(os.environ["TAGS_TSV"]):
    if len(row) < 2:
        continue
    try:
        tag_id_by_name[row[1].strip().lower()] = int(row[0])
    except ValueError:
        continue


# Map apply_to.type -> (junction-set, the type label we report).
JUNCTION_FOR_TYPE = {
    "task": ("task_tag", task_tag_pairs),
    "knowledge": ("knowledge_tag", knowledge_tag_pairs),
    "goal_new": ("goal_tag", goal_tag_pairs),
    "person_new": ("person_tag", person_tag_pairs),
    "person_mention": ("person_tag", person_tag_pairs),
}


def truncate(s, n):
    s = (s or "").replace("\n", " ").replace("\r", " ")
    return s if len(s) <= n else s[: n - 1] + "…"


# ---------------------------------------------------------------------------
# Per-dump analysis
# ---------------------------------------------------------------------------

dumps = load_tsv(os.environ["DUMPS_TSV"])

if not dumps:
    print(f"No brain dumps processed_at >= {DEPLOY_DATE}.")
    print("Either the deploy hasn't landed yet, or no dumps have been")
    print("processed since. Re-run after Cam captures more dumps.")
    sys.exit(0)


total_dumps = 0
dumps_with_any_apply_to = 0
total_tag_items = 0
tag_items_with_apply_to = 0
total_apply_to_refs = 0
suspicious_empty = []   # list of (dump_id, tag_name)
suspicious_noisy = []   # list of (dump_id, tag_name, ref_count)
attachments_observed = 0  # rows in junction tables that match this tag+item
attachments_claimed = 0   # apply_to entries the LLM emitted
attachments_unmatched = 0  # apply_to entries with no matching sibling
per_dump_rows = []


for row in dumps:
    if len(row) < 4:
        continue
    dump_id_s, processed_at, content_preview, processed_items_json = row[:4]
    try:
        dump_id = int(dump_id_s)
    except ValueError:
        continue

    try:
        pi = json.loads(processed_items_json)
    except (json.JSONDecodeError, TypeError):
        # Malformed JSON — log to per-dump output and skip metric counting.
        per_dump_rows.append({
            "dump_id": dump_id,
            "processed_at": processed_at,
            "preview": truncate(content_preview, 80),
            "tags": [],
            "non_tag_count": 0,
            "tag_count": 0,
            "apply_to_populated": 0,
            "apply_to_total_refs": 0,
            "junctions_found": 0,
            "junctions_unmatched": 0,
            "note": "MALFORMED processed_items JSON",
        })
        continue

    items = pi.get("items") or []
    tag_items = [i for i in items if i.get("type") == "tag"]
    non_tag_items = [i for i in items if i.get("type") != "tag"]

    total_dumps += 1
    total_tag_items += len(tag_items)

    dump_apply_to_populated = 0
    dump_apply_to_refs = 0
    dump_junctions_found = 0
    dump_junctions_unmatched = 0
    tag_summaries = []

    for tag in tag_items:
        data = tag.get("data") or {}
        tag_name = (data.get("tag_name") or "").strip().lower()
        apply_to = data.get("apply_to") or []
        ref_count = len(apply_to)
        dump_apply_to_refs += ref_count

        if ref_count > 0:
            tag_items_with_apply_to += 1
            dump_apply_to_populated += 1
        else:
            # Suspicious-empty: tag emitted, dump has multiple non-tag
            # items, but apply_to is empty. Could be honest (dump-level
            # tag) or a miss. Flag for Cam's eye.
            if len(non_tag_items) >= SUSPICIOUS_EMPTY_THRESHOLD:
                suspicious_empty.append((dump_id, tag_name or "<unknown>"))

        if ref_count > SUSPICIOUS_NOISY_THRESHOLD:
            suspicious_noisy.append(
                (dump_id, tag_name or "<unknown>", ref_count)
            )

        # Cross-check: did the apply_to entries land in the junction
        # tables? Look up the tag_id by tag_name, then check each ref
        # against the appropriate junction set.
        tag_id = tag_id_by_name.get(tag_name)
        landed = 0
        unmatched = 0
        ref_details = []
        for ref in apply_to:
            ref_type = (ref.get("type") or "").strip()
            ref_src = (ref.get("source_text") or "").strip()
            junction_label, junction_set = JUNCTION_FOR_TYPE.get(
                ref_type, (None, None)
            )

            # Find the matching sibling and its created_id.
            matched_created_id = None
            for sib in non_tag_items:
                if sib.get("type") != ref_type:
                    continue
                if (sib.get("source_text") or "").strip() != ref_src:
                    continue
                matched_created_id = sib.get("created_id")
                break

            if matched_created_id is None or junction_set is None or tag_id is None:
                unmatched += 1
                attachments_unmatched += 1
                ref_details.append(
                    f"{ref_type}:'{truncate(ref_src, 30)}' [unmatched]"
                )
                continue

            if (matched_created_id, tag_id) in junction_set:
                landed += 1
                ref_details.append(
                    f"{ref_type}#{matched_created_id} [attached]"
                )
            else:
                unmatched += 1
                ref_details.append(
                    f"{ref_type}#{matched_created_id} [missing-junction]"
                )

        attachments_observed += landed
        attachments_claimed += ref_count
        dump_junctions_found += landed
        dump_junctions_unmatched += unmatched

        tag_summaries.append({
            "tag_name": tag_name,
            "ref_count": ref_count,
            "landed": landed,
            "unmatched": unmatched,
            "ref_details": ref_details,
        })

    if dump_apply_to_populated > 0:
        dumps_with_any_apply_to += 1
    total_apply_to_refs += dump_apply_to_refs

    per_dump_rows.append({
        "dump_id": dump_id,
        "processed_at": processed_at,
        "preview": truncate(content_preview, 80),
        "tags": tag_summaries,
        "non_tag_count": len(non_tag_items),
        "tag_count": len(tag_items),
        "apply_to_populated": dump_apply_to_populated,
        "apply_to_total_refs": dump_apply_to_refs,
        "junctions_found": dump_junctions_found,
        "junctions_unmatched": dump_junctions_unmatched,
        "note": "",
    })


# ---------------------------------------------------------------------------
# REPORT
# ---------------------------------------------------------------------------

print("=" * 78)
print(f"apply_to assessment scan  |  deploy date >= {DEPLOY_DATE}")
print("=" * 78)
print()

print(f"Eligible brain dumps:  {total_dumps}")
print(f"Total tag items:       {total_tag_items}")
print(f"Total apply_to refs:   {total_apply_to_refs}")
print()

if total_dumps == 0:
    sys.exit(0)

dumps_pop_pct = 100.0 * dumps_with_any_apply_to / total_dumps
print(
    f"Dumps with >=1 populated apply_to:  "
    f"{dumps_with_any_apply_to}/{total_dumps}  "
    f"({dumps_pop_pct:.1f}%)"
)

if total_tag_items > 0:
    tags_pop_pct = 100.0 * tag_items_with_apply_to / total_tag_items
    print(
        f"Tag items with non-empty apply_to:  "
        f"{tag_items_with_apply_to}/{total_tag_items}  "
        f"({tags_pop_pct:.1f}%)"
    )
    avg_refs = total_apply_to_refs / total_tag_items
    print(f"Average apply_to refs per tag:      {avg_refs:.2f}")

print()
print(
    f"Junction-table attachments observed:  "
    f"{attachments_observed}/{attachments_claimed}  "
    f"(claims that landed in DB)"
)
print(f"Apply_to refs unmatched/missing:      {attachments_unmatched}")
print()

# Threshold reminder
print("-" * 78)
print("Threshold reminder (Reed):")
print("  PASSES:    precision >= 85%  AND  populated-rate >= 50%  AND")
print("             sample >= 20 attachments across >= 5 dumps")
print("  MARGINAL:  precision 70-85%  OR  populated-rate 30-50%")
print("  FAILS:     precision < 70%   OR  populated-rate < 30%")
print()
print(f"  Sample size for spot-check (claimed attachments): {attachments_claimed}")
print(f"  Sample size for spot-check (landed in DB):        {attachments_observed}")
if total_dumps > 0:
    print(f"  Eligible dumps:                                   {total_dumps}")
populated_rate = (
    100.0 * tag_items_with_apply_to / total_tag_items
    if total_tag_items > 0 else 0.0
)
print(f"  Populated-rate (computed):                        {populated_rate:.1f}%")
if attachments_observed < 20 or total_dumps < 5:
    print()
    print(
        "  NOTE: sample size is below the 'don't grade noise' floor "
        "(>=20 attachments across >=5 dumps). Hold the assessment open "
        "and re-run after more dumps."
    )
print("-" * 78)
print()

# Suspicious flags
if suspicious_empty:
    print(
        f"Suspicious-EMPTY (tag with apply_to=[] in a dump with "
        f">={SUSPICIOUS_EMPTY_THRESHOLD} non-tag items): "
        f"{len(suspicious_empty)}"
    )
    for dump_id, name in suspicious_empty[:20]:
        print(f"  dump {dump_id}: '{name}'")
    if len(suspicious_empty) > 20:
        print(f"  ... and {len(suspicious_empty) - 20} more")
    print()

if suspicious_noisy:
    print(
        f"Suspicious-NOISY (apply_to with > {SUSPICIOUS_NOISY_THRESHOLD} "
        f"refs — possible over-fan): {len(suspicious_noisy)}"
    )
    for dump_id, name, n in suspicious_noisy[:20]:
        print(f"  dump {dump_id}: '{name}' x{n}")
    if len(suspicious_noisy) > 20:
        print(f"  ... and {len(suspicious_noisy) - 20} more")
    print()

# Per-dump detail
print("=" * 78)
print("Per-dump detail (for Cam's spot-check)")
print("=" * 78)
for d in per_dump_rows:
    print()
    print(f"dump #{d['dump_id']}  ({d['processed_at']})")
    print(f"  content:  {d['preview']}")
    if d.get("note"):
        print(f"  NOTE: {d['note']}")
        continue
    print(
        f"  items:    {d['non_tag_count']} non-tag, "
        f"{d['tag_count']} tag  |  apply_to populated: "
        f"{d['apply_to_populated']}/{d['tag_count']}  "
        f"({d['apply_to_total_refs']} refs)"
    )
    print(
        f"  junctions: {d['junctions_found']} attached, "
        f"{d['junctions_unmatched']} unmatched"
    )
    for tag in d["tags"]:
        if tag["ref_count"] == 0:
            marker = "[empty]"
        elif tag["unmatched"] > 0:
            marker = "[partial]"
        else:
            marker = "[ok]"
        print(
            f"    tag '{tag['tag_name']}' {marker}  "
            f"refs={tag['ref_count']} attached={tag['landed']} "
            f"unmatched={tag['unmatched']}"
        )
        for detail in tag["ref_details"]:
            print(f"      - {detail}")
PY
