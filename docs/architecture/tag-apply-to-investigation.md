# Tag `apply_to` Investigation

**Status:** proposed
**Author:** Reed (Knowledge Architect)
**Date:** 2026-04-23 (revised 2026-04-23 after Cam's pushback on dump-level fan-out; revised again 2026-04-23 after Cam confirmed tag-on-task retrieval is a real workflow)
**Triggered by:** Atlas's production scan — 5/5 tag items in `processed_items` had `apply_to=[]`.
**Parallel work:** Vault is doing the immediate code fix on Cairn's separate ticket; this paper covers the design question.

**Revision note (v2 → v3, 2026-04-23):** Cam answered the §5 product question — yes, he uses (or wants to use) tag-on-task / tag-on-knowledge / tag-on-goal retrieval. That moves the recommendation from (D) drop-the-field to **(C) LLM-supplied `apply_to`**, with (B) per-segment tagging held in reserve as the fallback if (C) doesn't earn its keep. §4 below now records the live recommendation. §6 (what changes where) has been kept under the (D) path-not-taken header for provenance; the active dispatch list is summarised inline in §4. Status remains `proposed` — it promotes to `accepted` only after Reed's post-deploy assessment confirms (C) clears the success threshold.

**Revision note (v1 → v2, 2026-04-23):** v1 of this paper recommended option (A) auto-fan-out: tag every item in the dump with every tag the dump produced. Cam pushed back — correctly — that a brain dump is deliberately multi-topic stream-of-consciousness ("call mum about her birthday and also fix the dishwasher leak"), and dump-level fan-out would crosstag the dishwasher task with `family` and the birthday task with `home-repair`. That's noise, not signal, and it violates the *purpose* of the brain-dump intake. The recommendation has changed. The trace through current behaviour (§1, §2) is unchanged.

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

## 3. The design space, after Cam's pushback

The constraint that has to hold: **brain dumps are freeform and multi-topic by design.** Any rule that scopes a tag to "everything in the dump" is wrong on its face — it punishes Cam for the very behaviour the intake is supposed to encourage. So whatever we do has to either (a) scope tighter than dump-level, (b) get per-item specificity from somewhere with real signal, or (c) admit we can't do it automatically and stop pretending.

I considered six shapes. Five live ones, one already excluded.

### (A) Dump-level auto-fan — *rejected (was v1's pick)*
Cam's pushback. Multi-topic dumps get cross-contaminated. Out.

### (B) Per-segment tagging
The regex path already calls `segment_text(content)` in `process_brain_dump` — it splits the dump into smaller chunks before extraction. If a tag is detected *within* a segment, attach it only to items extracted from that same segment.
- **Pro:** respects multi-topic dumps natively. The "mum/dishwasher" example works: `family` lives in one segment, `home-repair` in another, neither crosses.
- **Pro:** zero new model trust required for the regex path.
- **Con:** the LLM path doesn't expose segments today. Two ways to plug that gap: (i) ask the LLM to emit a segment-id alongside each item *and* each tag, or (ii) post-process by string-matching `source_text` back to a segment offset. (i) is more model trust; (ii) is brittle when the LLM paraphrases.
- **Con:** segment boundaries are heuristic. A dump that flows mid-thought across what the segmenter thinks is a boundary will still split a tag from its items. Better than dump-level, not perfect.

### (C) LLM-supplied `apply_to`, no fallback
Trust the LLM when it provides `apply_to`; do nothing if it doesn't. Fix the prompt so the model knows the field exists and what it means.
- **Pro:** the LLM has the strongest signal — it sees the full text, the segmentation, the surrounding items. It is the only actor in the pipeline that can reason about "this tag belongs to *this* task and not *that* one."
- **Pro:** failure is silent-no-tag, not silent-wrong-tag. A missing tag is recoverable via manual UI tagging; a wrongly-attached tag pollutes retrieval and is harder to notice.
- **Con:** v1 of the prompt didn't even ask for the field, so we have no evidence of how reliably the model would emit it once asked. That's a knowable unknown — one prompt iteration would tell us.
- **Con:** regex path still produces `apply_to=[]` and so contributes zero to junction tables. That's an honest gap, not a bug — the regex path doesn't have the signal to do better.

### (D) No automatic `apply_to` — drop the field
Tags continue to attach to the brain dump itself via `brain_dump_tags` (which already works). Extracted tasks/knowledge/people/goals are not auto-tagged. If Cam wants a task tagged, he tags it in the UI. Remove `apply_to` from the `processed_items` contract as a dead field; update `PROCESSING_RULES.md` Rule 5 to match.
- **Pro:** honest. Reed rule 11 (never be precious): if we can't make it work cleanly, retire it rather than ship a half-feature.
- **Pro:** zero false positives. Every junction-table row reflects an explicit human decision.
- **Con:** "find all tasks tagged `leadership`" returns only what Cam has manually tagged. The cross-content retrieval scenario in `SCHEMA.md` becomes a manual-curation feature rather than an emergent-from-extraction one.
- **Con:** the friction the auto-extraction pipeline is supposed to eliminate stays in place for tagging specifically.

### (E) UI-driven post-extraction tagging
Frontend shows the dump's detected tags as chips next to each extracted task/knowledge/person/goal, with one-click "apply to this item." Cam picks.
- **Pro:** highest accuracy. Human in the loop on every attachment.
- **Pro:** discoverable — Cam sees what tags were detected and which items exist, in the same view.
- **Con:** Lumen work, not a sink-side fix. Bigger build than (B), (C), or (D).
- **Con:** still friction at capture time, just relocated to a review step.

### (F) Hybrid: LLM-supplied `apply_to` with UI fallback chips
(C) for the auto path, (E) for the holes (C) leaves. LLM populates `apply_to` when it's confident; for tags where it didn't, UI shows chips so Cam can attach in one click.
- **Pro:** belt-and-braces. Auto-attach where signal is strong, manual where it isn't.
- **Pro:** failure modes compose well — LLM omission falls through to UI, not to a wrong attachment.
- **Con:** two code paths and a UI piece. More surface area than the bootstrap deserves today (Reed rule 4).

## 4. Recommendation

**Primary: (C) — LLM-supplied `apply_to`. Kick off.** Cam's answer to §5 (2026-04-23) confirms tag-on-task / tag-on-knowledge / tag-on-goal retrieval is a real workflow he uses (or wants to use), so the cross-content junction tables need to populate from extraction, not only from manual UI tagging. (C) is the cheapest path with the strongest signal: the LLM is the only actor in the pipeline that sees the full text and can reason about which extracted item a tag belongs to. Failure mode is silent-no-tag rather than silent-wrong-tag, which is recoverable via manual UI tagging.

**Active dispatches under (C):**
- **Vault** — extend the LLM extraction prompt in `app/processing.py` (the `_build_llm_prompt` scaffolding around L1051 and the `process_brain_dump_llm` path) to request `apply_to` on each tag item, with prompt instructions and examples that make it clear the field carries item indices into the same `processed_items.items` array. Stop hard-coding `"apply_to": []` in `_llm_response_to_items` — read the field through. Extend the `tag` branch of `_auto_create_item` so when `apply_to` is non-empty, the tag is attached to the named items via the appropriate junction tables (`task_tags`, `knowledge_tags`, `person_tags`, `goal_tags` — Vault confirms exact table names against `data/SCHEMA.md`). When `apply_to` is empty or absent, behaviour stays as today: insert into `tags`, link only to `brain_dump_tags`. Privacy invariant holds — `apply_to` values are item indices, not text, so they're fine to log; no extracted content is logged.
- **Reed** — owns the success criteria and the post-deploy assessment. Defines the measurable bar for "earns its keep" (e.g. after N production brain dumps with `apply_to` populated, ≥X% of `(tag, item)` pairs are correct on Cam's spot-check, ≤Y% are incorrect; numbers per Reed's judgment for a single-user system). After Vault's patch ships and Cam has captured a handful of real brain dumps, Reed runs a production scan in the shape of Atlas's earlier scan and reports `apply_to` populated/empty/wrong rates back to Cairn. Below threshold → Cairn pulls (B) per-segment tagging forward as a follow-up.
- **Probe** — regression coverage. At minimum: existing tag flow (empty `apply_to`) does not break. New path is exercised by an e2e test that asserts a tag with non-empty `apply_to` attaches to the named items in the DB via the correct junction tables.

**Watch entry:** Reed's assessment is queued in `docs/processes/team-practices.md` under "Queued audits" with a 10-dumps-or-4-weeks trigger so the check-in doesn't get forgotten.

**Status discipline:** this paper stays `proposed` until Reed's assessment confirms (C) clears the threshold. On confirmation, status moves to `accepted`. On miss, this paper is superseded by a follow-up dispatching (B).

**Pocket alternatives, in order of preference if (C) misses the threshold:**
1. **(B) Per-segment tagging** — first fallback. Respects the multi-topic constraint structurally. The LLM-path-doesn't-expose-segments problem is solvable but not free.
2. **(F) Hybrid C+E** — only if Cam wants both auto-attachment *and* the safety net. Probably not bootstrap-stage work.
3. **(D) Drop `apply_to`** — last resort if the auto-extraction approaches don't pan out *and* Cam's manual-tagging discipline is sufficient. Still on the table; no longer the recommendation.

**Why not (E) standalone:** UI chips are good but they're a Lumen build and they relocate friction to a review step rather than removing it. Held in reserve as part of (F).

## 5. Question for Cam (product input needed)

The whole choice between (D) and any of (B/C/E/F) hinges on one thing I can't answer from the schema or the data:

> **Do you actually use tag-on-task (or tag-on-knowledge, tag-on-goal) retrieval today, and how often?**
>
> Concretely: when you want to find something, do you ever start from a tag and ask "show me all tasks tagged `seoul`" or "all knowledge tagged `leadership`" — or do you mostly retrieve by searching content, browsing recent items, or filtering by status/date?
>
> If the answer is "rarely or never" → (D) is right. Drop the dead field, lean on manual tagging where it matters, move on.
>
> If the answer is "yes, regularly, and the manual-tagging gap annoys me" → we go to (C) and try the prompt fix; (B) if (C) doesn't earn its keep.
>
> If the answer is "I'd love to but the data isn't there to make it useful" → that's an argument for (C) or (B), but it's also an argument for being patient and letting the manual junction-table data accumulate first, so we have a baseline to compare auto-attachment against.

I'd rather not build any of (B)(C)(E)(F) on a guess about your retrieval habits. Two minutes of your answer here saves a week of building the wrong thing.

## 6. What changes where (path not taken — recommendation D, retained for provenance)

The block below was the v2 implementation plan under recommendation (D). Cam's answer flipped the recommendation to (C); §4 above now carries the active dispatch list. Kept here so future readers can see what the (D) path looked like if (C) is later abandoned.

If (D) had been confirmed:

- **Vault** — remove the hard-coded `"apply_to": []` from `_llm_response_to_items` (L1448–L1467) and from `detect_tags` (L921–L991). Tag items in `processed_items.items` no longer carry that field. The `tag` branch of `_auto_create_item` (L1584–L1609) keeps doing what it does — insert into `tags`, link to `brain_dump_tags`. No new junction-table writes. Cairn's separate audit on `_auto_create_item` truthfulness still applies; this just means the tag branch is honest about its scope (dump-level only) instead of carrying a field it never honours.
- **Reed (me)** — rewrite `PROCESSING_RULES.md` Rule 5 to document the new contract: tags attach to the brain dump only; cross-content tagging is manual via UI. Remove the `apply_to` field from any schema doc that mentions it. Note the queued audits entry as resolved-by-removal, not resolved-by-implementation.
- **Lumen** — no work required for (D). If Cam later picks (E) or (F), Lumen's UI chip work would land then.
- **Migration** — none. No schema change. Existing `brain_dump_tags` rows stand. The empty `apply_to` arrays already in `processed_items` JSON blobs become historical noise; we can leave them or strip them in a one-shot cleanup, doesn't matter.

If Cam picks (C) instead, the work shifts to the prompt + `_llm_response_to_items` reading the field through, plus a small `_auto_create_item` change to honour it when present. That's a separate dispatch I'll write up if we go that way.

## 7. Provenance

- **Atlas's production scan** — 5/5 finding (every tag item in production had `apply_to=[]`). This paper builds on that scan; the code-trace in §2 confirms the cause is upstream (prompt + builder + sink), not a sampling fluke.
- **Background-processing retro lessons** — `docs/retrospectives/2026-04-25-background-processing.md` and `-summary.md`. The person_mention fall-through (an `auto_created` item that produced no row) is the same shape of bug as the tag fall-through here: extraction declares success, sink does nothing, no warning logged. The fix discipline is the same: every branch of `_auto_create_item` must either do the work or be honest about not doing it.
- **Queued audits, `team-practices.md` §"Queued audits"** — specifically the "`_auto_create_item` status-truthfulness audit (Vault + Reed joint)" entry, which already names *"tag and goal_link branches hold the same fall-through hazard person_mention had."* This investigation is the second occurrence that audit was waiting on; the trigger to pull it forward is met. Note that under recommendation (D), the resolution is *removal of the field* rather than *implementation of the missing write* — the audit closes either way, just via a different door.
- **Cam's pushback (2026-04-23)** — verbatim: *"For reed's recommendation, I would have to keep to one specific topic and keep everything i said related to that. I'm not sure that follows the idea of a braindump."* This is the design constraint that ruled out v1's option (A) and reframed the whole question around respecting multi-topic intake. Recorded here so future readers see why the recommendation flipped.
