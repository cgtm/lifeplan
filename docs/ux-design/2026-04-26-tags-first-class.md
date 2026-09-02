# Tags as a First-Class Surface

**Author:** Iris (Senior Interaction Designer)
**Date:** 2026-04-26
**Status:** Spec — ready for implementation
**Implementer:** Lumen (UI), Vault (API), Reed (schema/SQL review on merge)
**Audit ref:** `docs/ux-audit/2026-04-26-system-wide-audit.md`, finding #2

---

## Pitch

> Tags stop being decoration and start being doors. Every chip in the app becomes the entrance to a cross-content view of everything that shares that label, and Cam gets the controls (rename, merge, delete) that make a folksonomy actually navigable.

---

## The Problem

Tags exist on six entity types (goals, tasks, people, knowledge, journal entries, brain dumps), share one vocabulary (`tags` table), and are auto-created by the LLM during brain-dump processing. There are 200+ of them already. And yet:

- There is **no surface that lists them**. `GET /api/tags` exists. Nothing renders it except the journal filter bar.
- Every chip is a **dead pixel**. No hover, no click, no "show me everything tagged this way."
- There is **no rename, merge, or delete**. Typos and near-duplicates (`ai-team` vs `ai-teams`, `finance` vs `finances`) accumulate forever.
- There is **no usage view**. Cam can't see "what is this tag actually attached to?"

This is the canonical "passive and flat" failure. One design fix unsticks chips across the entire app. Highest leverage-per-line in the audit's top three.

---

## Three-line surface contract

**Surface: Tags (top-level view) + Tag Drawer (inline)**
**Job:** Find every piece of knowledge that shares a label, and curate the labels so the vocabulary doesn't drift.
**Next action:** From the list — open a tag. From a chip anywhere in the app — open a tag. From the drawer — jump to a tagged item, rename, merge, or delete.

---

## Scope (MVP)

In:
1. `view-tags` top-level surface — list, sorted by usage, with row affordances.
2. Tag drawer — opens when any chip is clicked; shows usages grouped by entity type.
3. Every existing chip becomes clickable.
4. Manual tag create (input at top of `view-tags`).
5. Rename, merge, delete with confirms.
6. Empty state.
7. Inert / hover / focus chip treatment + the `×` remove affordance on entity detail views only.

Out (iterations section):
- Bulk select + bulk merge.
- Tag colours / categories.
- Pre-attaching a new tag to multiple entities at create time.
- Tag aliases (synonyms that resolve to a canonical tag).
- Tag usage charts over time.

---

## 1. The Tags view (`view-tags`)

### Job
Cam wants to (a) audit his vocabulary — *"what tags do I even have?"* — and (b) get to the cross-content set of items behind a tag.

### Layout (mobile-first, ≤ 780px column, same `--max-w` as other views)

```
┌───────────────────────────────────────────────────┐
│ Tags                                              │
│ 47 tags · 312 usages                              │  ← header (counts in --text-3)
│                                                   │
│ [ + new tag________________________ ]   Add       │  ← create row, sticky-ish under header
│                                                   │
│ ai-team                                  28       │
│   12 goals · 9 tasks · 4 knowledge · 3 dumps      │  ← --text-3, 0.6875rem
│                                                   │
│ finance                                  24       │
│   8 goals · 11 tasks · 5 knowledge                │
│                                                   │
│ settlement                                15       │
│   2 goals · 3 tasks · 5 knowledge · 5 dumps       │
│                                                   │
│ ...                                               │
└───────────────────────────────────────────────────┘
```

### Row affordances

A tag row is a **launchpad**, not a label. Each row:

- **Whole-row click** → open the tag drawer (primary action, lowest cost).
- **Three-dot kebab** on the right (or long-press on touch) → action menu:
  - Rename
  - Merge into…
  - Delete
- **Count badge** on the right is informational only (it's the same count summed in the breakdown below — repeated for scan-ability).

The kebab is the only secondary affordance on the row. No inline pencil icons. The row is one big tap target; the kebab is a 44×44 touch target inside it.

### Sort + filter

- Default sort: usage count descending, then alphabetical.
- A small filter pill row above the list: `Most used · A–Z · Unused`.
- A search input above the create row: filters the list as Cam types. *(Not a separate surface — same input area as Add. Reuse `.search-box`.)*

Wait — separate inputs. Search and Add are different jobs and conflating them is the kind of clever that breaks under thumb pressure. So:

```
[ Search tags__________ ]
[ + new tag____________ ] Add
```

Two inputs, stacked, both styled with existing `.search-box` / `.form-input`. Search is incremental client-side filter (the list won't get huge — sub-1000 rows for years).

### Backend / data implications

- `GET /api/tags` already exists and returns `{id, name, total_count}`. **Extend it** to also return a `breakdown` object: `{goals: int, tasks: int, people: int, knowledge: int, journal: int, dumps: int}`. One round-trip, no per-row N+1.
- New: `POST /api/tags` — body `{name}`, creates a tag with no usages, returns the row.

---

## 2. Tag detail drawer

### Job
*"Show me everything tagged with X, grouped so I can scan, and let me jump to any of it."*

### Why a drawer, not a dedicated route?
Tag exploration is **lateral navigation** — Cam is mid-thought on a goal, sees a chip, wants to know "what else is in this bucket?" He should not lose his place in the goal. A drawer (right-side slide-in on desktop, bottom sheet on mobile) preserves context. It is dismissible with the back button, the overlay tap, and the close `×` — same gesture set as the existing modal.

For the dedicated case where Cam *did* land on the Tags view and tapped a row, the drawer also works — close it and he's back in the list.

### Layout

```
┌────────────────────────────────────────┐
│ ai-team                            ×   │  ← tag name as h2; close
│ 28 usages                              │  ← --text-3
│ ─────────────────────────────────────  │
│ Rename   Merge into…   Delete          │  ← three text actions, --text-2 / --danger
│ ─────────────────────────────────────  │
│ Goals (12)                             │  ← collapsible section header
│   • Move to Seoul          [open]      │
│   • Pay off contractor debt [open]     │
│   ...                                  │
│                                        │
│ Tasks (9)                              │
│   • Set up Nova hiring brief           │
│   ...                                  │
│                                        │
│ Knowledge (4)                          │
│   • Atlas orchestration rules          │
│   ...                                  │
│                                        │
│ Brain dumps (3)                        │
│   • 2026-04-12 — "ai team should..."   │
│   ...                                  │
└────────────────────────────────────────┘
```

### Behaviour
- Each item is a link → opens the existing detail surface for that entity (goal modal, task modal, person view, knowledge modal, journal entry detail, brain dump detail).
- Sections with zero items are hidden (don't show "Journal (0)").
- Sections collapse if total > 50 items in that section. Otherwise expanded by default — Cam shouldn't have to click to see what's there.
- The drawer **does not** navigate Cam away from the Tags view or from his current entity. Closing the drawer returns him exactly where he was.

### Backend / data implications

- New: `GET /api/tags/<id>/usages` — returns `{tag: {id, name}, usages: {goals: [...], tasks: [...], people: [...], knowledge: [...], journal: [...], dumps: [...]}}`. Each item is the lightweight summary needed to render a row (id, title, plus whatever the existing list endpoints return for that type — re-use those summary shapes).
- One endpoint, one round-trip. Drawer is fast.

---

## 3. Inline chip behaviour (the highest-leverage change)

### Today
```html
<span class="tag">ai-team</span>
```
Static. No cursor, no hover, no listener. Six entity types render this. `app.js:149` (`tagsHtml`) is the single render path for most of them; the journal has a near-duplicate inline at `1828` and `1922`.

### After

```html
<button type="button" class="tag tag-chip" data-tag-id="42" data-tag-name="ai-team">
  ai-team
</button>
```

**One render function. One delegated click handler at the document root.** Click anywhere on a chip → open the tag drawer for that tag.

Visual states (no new tokens — reuse existing):

| State    | Background       | Text             | Border / shadow |
|----------|------------------|------------------|-----------------|
| Inert    | `--tag-bg`       | `--tag-text`     | none            |
| Hover    | `--tag-hover`    | `--tag-text`     | none (cursor: pointer) |
| Active/pressed | `--accent-bg` | `--text`     | none            |
| Focus (keyboard) | `--tag-bg` | `--tag-text` | 2px outline `--focus` |

The chip becomes a `button`, gets a `cursor: pointer`, and inherits the focus ring. Touch targets stay ≥ 32px tall by virtue of existing padding plus tap-area-inflation via `:before` if needed.

### Removing a tag from a specific entity

This is a **distinct job** from "explore this tag." It is destructive scoped to one entity. Two rules:

1. **Never on plain click.** Plain click goes to the drawer.
2. **Only available in edit context.** On a goal detail modal, a task detail modal, an entity edit form — the chip grows a small `×` on hover (desktop) or always-visible on mobile in edit mode. Click `×` → confirm-free remove from this entity (with a 4-second toast undo).

In list views (the goal list card, the task list, the dump list) chips are click-to-explore only. No `×`. Removing a tag from an item is an edit action that lives in the item's edit surface — not in a list.

### Backend / data implications

- No new endpoint required for the chip click — it routes to the drawer which uses `GET /api/tags/<id>/usages`.
- Chips need to render with `tag.id` not just `tag.name`. `get_tags_for()` already returns `{id, name}` (verify in `db.py`). All downstream renderers must include the id in the data attribute.
- For per-entity tag removal: the existing PUT endpoints for each entity already accept a `tags` array — Lumen submits the new array minus the removed one. No new endpoint.

---

## 4. Manual tag create

### Job
*"I know I want a 'seoul-move' tag — let me make it now and use it later."*

### Affordance
Top of `view-tags`, the second input row:
```
[ + new tag____________ ] Add
```

- Lowercase + hyphenate on submit (`"Seoul Move"` → `seoul-move`). Show the normalised form briefly as a toast: "Created tag `seoul-move`."
- If the tag already exists, no error — focus the existing row in the list and pulse it once. *(Cam typed it because he wanted to find it; help him land on it.)*
- Created tags appear in the list immediately with usage count 0.
- A 0-count tag is dim (`--text-3`) and its breakdown line says "Not yet used."

### Out of scope for MVP
Pre-attaching a new tag to multiple entities at create time. Powerful but adds a multi-select picker that needs its own design. Iteration.

### Backend / data implications
- New: `POST /api/tags` — body `{name}`. Server normalises (lowercase, hyphenate, strip). Returns the row (idempotent: existing tag returns 200 with the existing row, not 409).

---

## 5. Rename and merge

### Rename

**Job:** Fix a typo or rewrite a tag name without losing any of its connections.

**Affordance:** From the drawer or the row kebab → "Rename." Inline input replaces the tag name with the current value pre-filled. Enter or "Save" commits; Esc or click-out cancels.

**Behaviour:**
- Normalise on save (lowercase, hyphenate).
- If the new name collides with an existing tag — the UI should not crash into a unique-constraint error. Detect the collision client-side from the loaded list and offer: *"`<new>` already exists. Did you mean to merge instead?"* with a Merge button.
- All chips across the app re-render with the new name on next load. (No live socket; Cam will see it on next view switch — acceptable for personal-scale.)

**Backend:** `PUT /api/tags/<id>` — body `{name}`. Returns the updated row or `409` with the conflicting tag id (so the UI can offer merge).

### Merge

**Job:** *"`ai-team` and `ai-teams` are the same thing. Make them one."*

**Affordance:** From the drawer or the row kebab → "Merge into…" → tag picker (searchable list of all other tags) → preview → confirm.

**Preview shows:**
> Merging `ai-teams` (5 usages) into `ai-team` (28 usages).
> After merge: `ai-team` will have 33 usages. `ai-teams` will be deleted.
> [ Cancel ]   [ Merge ]

**Behaviour after confirm:**
- All junction rows pointing at source-tag-id get re-pointed to target-tag-id.
- For composite-PK collisions (an entity is tagged with both source and target), drop the source row — the target already covers it, no double-tag.
- Source tag deleted.
- No undo. Show a toast confirming the result. Cam can rename if he wants the old name back.

**Why this benefits from Reed's eye:** the re-point is six junction tables, must be transactional, must handle the composite-PK collision case per-table. SQL pseudocode:

```sql
BEGIN;
-- For each junction table:
INSERT OR IGNORE INTO goal_tags (goal_id, tag_id)
  SELECT goal_id, :target FROM goal_tags WHERE tag_id = :source;
DELETE FROM goal_tags WHERE tag_id = :source;
-- Repeat for task_tags, person_tags, knowledge_tags, entry_tags, brain_dump_tags.
DELETE FROM tags WHERE id = :source;
COMMIT;
```
`INSERT OR IGNORE` handles the collision case cleanly thanks to the composite PK. **Reed should review this** — and confirm whether `ON DELETE CASCADE` on the junctions makes the `DELETE FROM <junction>` redundant or harmful when we then `DELETE FROM tags`.

**Backend:** `POST /api/tags/<source_id>/merge` — body `{target_id}`. Returns the merged target tag with new total_count.

---

## 6. Delete

**Job:** *"I never use this tag and don't want to see it. Burn it."*

**Affordance:** From the drawer or row kebab → "Delete." Confirm dialog:

> Delete `seoul-2024`?
> This will remove it from 7 items (3 goals, 2 tasks, 2 knowledge).
> The items themselves will not be deleted.
> [ Cancel ]   [ Delete ]

**Backend:** `DELETE /api/tags/<id>` — relies on `ON DELETE CASCADE` on each junction to clean up. Returns 204.

**No undo for MVP.** Cam can recreate the tag and re-attach it manually if he changes his mind. This is fine for personal-scale; revisit if it bites.

---

## 7. Empty state

When `GET /api/tags` returns an empty list — which is unlikely given there are already 200+ tags, but design every state — the view shows:

```
No tags yet.

Tags appear automatically as you brain-dump, or
you can create one now to start a vocabulary.

[ + first tag__________ ] Create
```

The empty state **continues the flow.** It does not say "no tags" and stop. It points at where tags come from (brain dump) and offers the manual create, focused.

If the list is non-empty but a search returns nothing:

```
No tags match "xyz".

[ Create "xyz" as a new tag ]
```

The "no results" state is also a launchpad. Searching for something you can't find should always offer "make it."

---

## 8. Visual treatment summary

### Chip
- Already-defined `.tag` class. Add a modifier `.tag-chip` for the clickable variant (which becomes the default everywhere — there are no display-only chips anymore).
- `cursor: pointer`, `transition: background var(--transition)`, hover background `--tag-hover`, focus outline `2px solid var(--focus)` with `outline-offset: 2px`.
- Rendered as `<button>` for keyboard / screen-reader correctness.

### Tag list row
- Padding: `12px 16px`. Border-bottom `1px solid var(--border-lt)`. Last row no border.
- Title: `0.875rem`, `--text`, weight 500.
- Count: `0.875rem`, `--text-2`, weight 500, right-aligned.
- Breakdown: `0.6875rem`, `--text-3`, on its own line below, with `·` separators.
- Whole row gets `cursor: pointer` and a subtle `--accent-bg` on hover.
- Kebab: 32px touch target, `--text-3` glyph, `--text` on hover.

### Drawer
- Reuse the existing `.modal` shell. On desktop, override its centred treatment with a right-anchored slide-in (max-width 420px, full height). On mobile, it stays a bottom sheet (the existing modal already behaves this way at narrow widths — verify).
- Header pattern matches existing detail modals (`.modal-header` with title left, close right).
- Action row: three buttons rendered as text links — Rename (`--text-2`), Merge into… (`--text-2`), Delete (`--danger`). Spaced, with a divider above and below.
- Section headers: `0.75rem` uppercase, `--text-3`, with the count in parentheses.
- Item rows: same density as the brain dump item rows in the existing modal — title plus a chevron suggesting it opens.

### Tokens
**No new colours, no new font sizes, no new radii.** Everything maps to existing CSS variables. If Lumen finds he needs one (e.g. a focus state for a button-chip), add it as a derivative of an existing token, not a fresh palette entry.

---

## Recommended persona dispatches (for Atlas to sequence)

In order:

1. **Reed** — review the merge SQL and the `ON DELETE CASCADE` interaction in section 5. Confirm whether the manual `DELETE FROM <junction> WHERE tag_id = :source` is required, redundant, or wrong given the cascades. Spec the migration (none expected — schema is sufficient as-is). Sign off on the contract for `GET /api/tags` extension (adding `breakdown`).
2. **Vault** — implement the four new endpoints (`POST /api/tags`, `PUT /api/tags/<id>`, `POST /api/tags/<id>/merge`, `DELETE /api/tags/<id>`) plus extend `GET /api/tags` (breakdown) and add `GET /api/tags/<id>/usages`. Add request-level tests against an empty DB and a populated DB. Surface area is small — one PR.
3. **Lumen** — build `view-tags`, the drawer component, and convert `tagsHtml()` plus the journal-inline equivalents to render `.tag-chip` buttons. Add the document-level click delegate. Wire to Vault's endpoints. Mobile-first; verify on iOS PWA in landscape and portrait.
4. **Probe** — verify the user-flow checklist (below) on the actual device. Block-the-deploy if any flow has a dead end, the merge produces orphaned junctions, or a chip click does the wrong thing.
5. **Iris (me)** — sign-off pass once Lumen ships. Walk it on the phone, on a Tuesday, in the kitchen. Loom-narrated.

---

## Probe's flow checklist (Iris's hand-off)

- [ ] Click a chip on a goal card → drawer opens with that tag's usages.
- [ ] Drawer item click → opens the entity's detail surface; closing it returns to the original goal card.
- [ ] Open `view-tags` → see all tags, sorted by usage, with breakdowns matching the database.
- [ ] Search filter narrows the list as you type.
- [ ] Create a new tag → appears in the list with count 0.
- [ ] Create an existing tag → focuses the existing row, no error.
- [ ] Rename a tag → all chips across the app reflect the new name on next view switch.
- [ ] Rename to a colliding name → UI offers merge instead.
- [ ] Merge tag A into tag B → A's count becomes 0/disappears, B's count = (A + B - overlap).
- [ ] Delete a tag → confirm shows usage count, item count is correct after.
- [ ] Tap `×` on a chip in a goal edit modal → tag removed from that goal only; toast undo restores it.
- [ ] Empty state on a fresh DB → shows the empty copy and create input.
- [ ] No-search-results state → offers "Create as new tag."
- [ ] Keyboard: chip is tab-focusable, Enter opens drawer, Esc closes drawer.
- [ ] iOS PWA: drawer behaves as bottom sheet, nothing clipped under the home-indicator bar.

---

## Iterations (post-MVP, pocketed)

1. **Pre-attach on create.** New tag input grows a "and attach to…" multi-select for entities. Useful when Cam knows up-front which goals/tasks the tag belongs to.
2. **Bulk merge / bulk delete.** Checkbox column on the tag list. Useful at the 500+ tag mark.
3. **Tag aliases.** A non-canonical tag (`ai-teams`) silently resolves to its canonical form (`ai-team`) without a destructive merge. More forgiving than merge but adds schema (`tag_aliases` table) — defer until Cam asks.
4. **Tag categories / colours.** Optional grouping ("life", "work", "people"). Nice-to-have. Resist until Cam complains the flat list isn't enough.
5. **Tag activity over time.** Sparkline on each tag row showing usages over the last 90 days. Useful for spotting tags that have gone cold. Charting cost > value at MVP.
6. **Live tag suggestions.** When typing in any tags-input field, autocomplete from the existing vocabulary. (This may already partially exist on the journal — check before re-doing.) High-value polish, but a separate surface contract.

---

## Spec ambiguity to resolve before Lumen builds

1. **Drawer vs. full route?** I have specified drawer. Confirm with Cam — he may prefer the URL-shareable `/?tag=ai-team` route. (My recommendation: drawer for laterality, but easy to add a route-style entry point on top.)
2. **`get_tags_for()` shape.** Need to verify in `db.py` that `tags` arrays returned to the client already include `id`, not just `name`. If they don't, every renderer plus the API contracts need a touch — small but worth knowing before Vault starts.
3. **Journal's existing `journalTags` flow.** The journal already has its own tag filter bar (`app.js:1837`). Once `view-tags` exists, does the journal filter bar stay (it's task-specific: filter journal entries by tag inline) or get absorbed (the user clicks a chip and gets a drawer instead)? My recommendation: **keep it.** Filtering the journal in place is a different job from exploring a tag globally. Cam-confirm.
4. **Cascade behaviour on delete.** Reed's call. Spec assumes `ON DELETE CASCADE` is on every junction (SCHEMA.md says yes for "both sides"). Verify before the delete endpoint is wired.
5. **Mobile drawer or full-screen?** On a small iPhone, a bottom-sheet drawer covering 80% of the viewport is fine for a list of ~10 items but cramped if a tag has 60 usages. Acceptable trade for MVP — escape hatch is the per-section collapse.

---

End of spec.
