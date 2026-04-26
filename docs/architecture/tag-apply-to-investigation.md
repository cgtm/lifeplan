# Tag `apply_to` Investigation

**Status:** proposed
**Author:** Reed (Knowledge Architect)
**Date:** 2026-04-23
**Triggered by:** Atlas's production scan — 5/5 tag items in `processed_items` had `apply_to=[]`.
**Parallel work:** Vault is doing the immediate code fix on Cairn's separate ticket; this paper covers the design question.

## 1. What `apply_to` is supposed to do

Per `data/PROCESSING_RULES.md` Rule 5, the `apply_to` array references other items in the same `processed_items.items` array by their index, so when a tag is auto-created the pipeline knows which extracted entities to attach it to via the per-content-type junction tables (`task_tags`, `knowledge_tags`, `person_tags`, `goal_tags`).

The retrieval scenario this enables is the one called out in `SCHEMA.md` "TAGS (cross-content search)": *"All content tagged 'leadership'"* across tasks, knowledge, people, goals — not just brain dumps.

## 2. Why it's always empty

Three independent gaps, all in `app/processing.py`. Any one of them alone would produce the symptom.

- **LLM prompt does not request `apply_to`.** `_build_llm_prompt` (around L1051) defines the `tags[]` schema as `{tag_name, is_new, confidence, source_text}` — no `apply_to` field. Examples shown to the model don't include it either. The model has no way to know it should produce that field, so it never does.
- **LLM response builder hard-codes `"apply_to": []`.** `_llm_response_to_items` (around L1448–L1467) constructs each tag item with a literal empty list, ignoring anything the model might have returned anyway.
- **Regex fallback hard-codes `"apply_to": []`.** `detect_tags` (L921–L991) — same pattern in all three branches (exact match, unhyphenated form, stemmed variant).
- **Sink-side: `_auto_create_item` ignores `apply_to`.** The `tag` branch (L1584–L1609) inserts the tag into `tags` (if new) and links *only* to `brain_dump_tags`. There is no read of `apply_to` and no write to `task_tags`, `knowledge_tags`, `person_tags`, or `goal_tags` from the extraction path. Even if the LLM returned a populated `apply_to`, nothing would consume it.

Production junction-table counts confirm the picture: `brain_dump_tags=17`, while `task_tags=19`, `knowledge_tags=10`, `goal_tags=24`, `person_tags=6` exist but *only* via the manual-tagging UI — extraction has never written to them.

## 3. What the right behaviour should be

I recommend **(A) Auto-apply tags to all items extracted from the same dump**, with one carve-out (below).

Rationale via Reed rules 5 and 6 (minimal viable structure; capture friction vs retrieval power):

- **Capture friction:** zero — Cam writes a brain dump, the system fans the dump's tags out to the dump's items. No prompt change, no UI change, no model trust required.
- **Retrieval power:** unlocks the cross-content query in `SCHEMA.md` immediately. "All tasks tagged `leadership`" starts returning rows the moment a leadership-flavoured dump is processed.
- **Failure mode:** over-tagging. If a dump produces 1 task and 3 knowledge items and the dump is tagged `seoul`, all four entities get `seoul`. That is almost always what you want for retrieval; the cost of a wrong tag is a stray hit in a filter, not a corrupted entity. Reversible via UI.
- **(B) Trust the LLM:** rejected. The LLM consistently produced empty `apply_to` even when the schema implied it. Fixing the prompt is fixable, but the failure mode (LLM tags one item and silently misses a sibling) is precisely the kind of quiet-data-loss bug Cairn's audit is already chasing on the `_auto_create_item` "lie by construction" thread.
- **(C) Hybrid (auto-fan default, LLM override):** worth keeping in our pocket for a v2 if Cam ever wants per-item tag specificity. Don't build it now — bootstrap rule (Reed #4): the system has tens of dumps, not thousands. Default-everything is the right starting point.

**Carve-out:** `apply_to` should *not* fan tags onto `person_mention` items that resolved to an existing person. A person is a long-lived entity across many dumps; tagging a person with the topic of one dump pollutes the person's tag set. Tag the brain dump and its tasks/knowledge/new_people/new_goals; skip existing-person mentions.

## 4. Is this worth fixing?

**Yes, but as low-priority follow-up, not a hotfix.** The honest read:

- The retrieval pattern *is* in the schema docs as a first-class scenario, and the cross-content tag query is exactly the kind of "find me everything about X" capability the system was designed to enable.
- Today, Cam *can* tag manually in the UI (and does — see the prod junction counts), so the gap isn't blocking. But manual tagging on every extracted item is exactly the friction the auto-extraction pipeline is supposed to eliminate.
- If we don't fix this, the `processed_items.items[].data.apply_to` field is a dead schema element — Reed rule 11 (never be precious about the system) says we should either make it work or remove it from the contract.

I would queue this behind anything user-blocking, but not let it sit indefinitely. Tag-cross-content-search is the kind of query Cam is more likely to want in month 3 than in week 1; building it now means the data is already there when the question is asked.

## 5. What changes where

If/when picked up, this is a small, contained dispatch:

- **Vault** — `_auto_create_item` change. After processing all items in a dump, when the `tag` branch fires and `apply_to` is empty (default case), iterate the dump's other extracted items in the same `processed_items.items` array and insert into the appropriate junction table per item type. Implement the existing-person carve-out from §3. No schema change.
- **Lumen** — optional UI affordance: on the brain-dump detail view, show which entities a tag was fanned to ("leadership applied to: 1 task, 3 knowledge items"), with a one-click "remove from this entity" per junction row. Not required for the fix to be valuable; nice for trust.
- **Reed (me)** — no schema migration needed. The junction tables already exist and the contract for `apply_to` is already in `PROCESSING_RULES.md` Rule 5. I'd update Rule 5's prose to document the auto-fan default and the existing-person carve-out, and either drop the `apply_to` field from `_llm_response_to_items` (since the fan-out is sink-side) or keep it as the override hook for future-(C).

## 6. Provenance

- **Atlas's production scan** — 5/5 finding (every tag item in production had `apply_to=[]`). This paper builds on that scan; the code-trace in §2 confirms the cause is upstream (prompt + builder + sink), not a sampling fluke.
- **Background-processing retro lessons** — `docs/retrospectives/2026-04-25-background-processing.md` and `-summary.md`. The person_mention fall-through (an `auto_created` item that produced no row) is the same shape of bug as the tag fall-through here: extraction declares success, sink does nothing, no warning logged. The fix discipline is the same: every branch of `_auto_create_item` must either do the work or be honest about not doing it.
- **Queued audits, `team-practices.md` §"Queued audits"** — specifically the "`_auto_create_item` status-truthfulness audit (Vault + Reed joint)" entry, which already names *"tag and goal_link branches hold the same fall-through hazard person_mention had."* This investigation is the second occurrence that audit was waiting on; the trigger to pull it forward is met.
