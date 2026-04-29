---
title: Lifeplan — User Guide
status: accepted
audience: Cam (single user)
last_updated: 2026-04-23
---

# Lifeplan — User Guide

Hello, future Cam. This is the tour. If you've been away for a while and you've forgotten what's where, read this end-to-end (about four minutes). If you've come looking for one specific thing, the headings should get you there.

The guide is opinionated about which doors are obvious and which aren't. The non-obvious ones get more space.

---

## What Lifeplan is

Lifeplan is a personal knowledge management app for your life and your work. You type raw thoughts into it; the system extracts structure (goals, tasks, people, knowledge, tags) from those thoughts; you stay in control of what gets kept. Everything lives in a private SQLite database that only you can see — nothing leaves your machine or your droplet without your consent. The LLM is a *suggestion engine*, not a decider; you approve, edit, or reject what it proposes.

The whole app runs on the principle **capture first, structure later.** You shouldn't have to know which folder a thought belongs in at the moment you have it. You dump it; the system files it; you check the work.

---

## The mental model

Nine entity types, and they all link to each other.

- **Brain dumps** — raw text you typed. The on-ramp for everything.
- **Goals** — the things you're trying to do with your life. Active, stalled, completed, someday, cancelled.
- **Tasks** — concrete actions. Usually attached to a goal.
- **Blockers** — what's stopping a goal or task from moving. Lives on the dependency edge between things.
- **People** — anyone who matters. Linked to goals and tasks via roles.
- **Knowledge** — facts, decisions, learnings, references, notes. The stuff you want to remember that isn't an action.
- **Journal entries** — dated, reflective. Different from brain dumps (see below).
- **Tags** — the connective tissue. Lowercase-hyphenated labels that sit on every other entity type and let you find related things across the whole app.
- **Prompts** — what the system says back to you. Suggestions generated from looking at the rest of your data.

Mental shorthand: **Brain dumps come in, structure comes out, prompts come back at you.**

---

## The primary on-ramp: brain dumps

This is the front door. Use it.

### Capturing

- The home screen has a quick-capture textarea. The brain dump view has a fuller one. Either works.
- Type whatever — half a sentence, a paragraph, a stream of consciousness. No formatting required.
- Hit Capture (or Cmd+Enter). The dump saves *immediately* — the response is fast because processing happens in the background.

### What happens next

A worker process picks the dump up and runs it through the LLM. The LLM extracts items it thinks are in the text:

- *"I need to call mum about her birthday."* → likely a **task**, possibly a **person mention** for "mum."
- *"Korean lesson cancelled — Yuki is back next Tuesday."* → possibly a **person** ("Yuki"), possibly a **knowledge note**.
- *"Move to Seoul is blocked on Nadia's visa."* → a **blocker** linking the goal "Move to Seoul" to the person "Nadia."

The system applies a confidence rule: high-confidence items get **auto-created**; lower-confidence items go to a **review queue** so you can approve, edit, or reject each one.

### The status badges (this is the bit you'll forget)

Every dump row carries a badge. They mean:

| Badge | Meaning | What you do |
|---|---|---|
| **Pending** (grey) | Queued or not yet picked up | Wait — usually seconds |
| **Processing** (grey + spinner) | Worker is running it now | Wait |
| **Done** (green) | Processed cleanly, items auto-created | Nothing — open it if you want to see what came out |
| **Needs review** (amber) | Some items were uncertain | Click the row to triage |
| **Failed** (red) | Worker exhausted retries | Click **Retry** (visible on the row) |

Polling is automatic — when something is in flight, the UI re-fetches every 3 seconds until it lands. You don't have to refresh.

### The dump detail modal

Click any dump row (in the brain dump view, or in "Recent captures" on home) to open it. From here you can:

- See the full original text.
- See every extracted item — approved, suggested, dismissed.
- **Approve / Edit & Approve / Dismiss** each suggestion individually.
- **Retry** a failed dump.
- **Re-process** a dump if the LLM was clearly wrong (edit the text first, then re-process — the system runs the LLM again on the new text).
- **Delete** the whole thing.

### Honest about what to expect

The LLM is good but not magical. It will sometimes:

- Extract a "person" called "mum" when you already have one called "Mum." You'll dedupe in review.
- Tag things you didn't mean to tag. You can untag in the Tags drawer (see below).
- Miss a task you thought was obvious. Edit the dump and re-process, or just type a new dump that's more explicit.

If a dump looks wrong, the cycle is **edit text → re-process → re-review**. You won't break anything.

---

## Working with goals

Goals are the heroes. They sit at the top of home; one is your **primary** hero card.

### The hero card

The single most important goal lives on home, big. **Click it** and the goal detail modal opens. (This used to be a dead pixel — it isn't anymore.)

### The goal detail modal

This is where a goal fully unfurls. You'll see:

- Title, description, status, target date.
- **People** linked to the goal (with their role).
- **Blockers** — each one has a name, type, and a status pill.
- **Active tasks** — each with a check circle (tap to complete).
- **Completed tasks** (struck through).
- **Tags**.
- Footer: Edit / Delete the goal.

### Resolving blockers from anywhere

This is the non-obvious power move. **Every blocker chip in the app is a launcher.** Tap one — on the home hero, in the goal detail, in a blocker_awareness prompt — and you can mark it resolved with a single tap. A toast appears with **Undo** for about five seconds; if you tapped wrong, hit it.

The same affordance shows up in three places. It's the same handler each time. You can resolve a blocker without ever opening the goal it belongs to.

### Adding to a goal

- The Goals list view has a **+ New goal** button in the header — opens a drawer (title, description, target date, status, tags).
- You can also create goals via brain dumps; the LLM extracts a `goal_new` and you approve it. Most goals will probably still be born this way.
- *Adding* a task or a blocker from inside the goal detail modal: the blocker half is in (resolve from inside is live; *creating* a new blocker from inside the goal isn't yet). Add-task and add-person from inside the goal are **not yet** — for now, add tasks from the Tasks view or via a brain dump that mentions the goal.

---

## Tasks

Tasks are the verbs.

- **Tasks view** has filter pills and tasks grouped by goal, with an "Unlinked" bucket at the bottom for tasks that don't belong to any goal yet.
- **+ New task** in the header opens a drawer (title, goal autocomplete, due date, people).
- Each task row has a **check circle** — tap to complete.
- Three-dot menu on a row gives Edit / Delete.
- Group headers collapse and expand.

### Per-goal inline add

The underrated bit: in the Tasks view, each goal-grouped section has a **+ task** affordance on the group header. Use it. It's the affordance most tasks want — you're already looking at the goal, add the task in context, don't go hunting.

---

## People

The People view shows everyone the system knows about.

- **Inline add form** at the top — name, hit Add. Optimistic insert, the new card flashes into the list.
- Each card shows the person's name, relationship, location, notes, and the goals/tasks they're linked to.
- Three-dot menu: Edit / Delete.

### How people get connected to goals

Mostly through brain dumps. When you write *"Talked to Nadia about the visa,"* the LLM extracts a person mention for "Nadia" and links it to whatever goal the dump tagged (e.g. the Move to Seoul goal).

### What's not here yet

There's no rich **person detail page** — the Edit modal is the closest thing to a dossier. If you click a person's name on a goal card, nothing happens (yet). For now, the People view *is* the view of a person. If you need to find everything connected to someone, search by tag (if you've tagged with their name) or open their card and scroll.

---

## Knowledge

The place for things you want to remember that aren't actions.

- **Inline add** at the top: title, content, tags, Add. Same optimistic-flash pattern as People.
- Five types: **fact, decision, learning, reference, note.** Pick what fits; the only difference is the filter pill behaviour.
- Filter pills + search.

### What each type is for

- **Fact** — passport number, address, blood type. Things that are true.
- **Decision** — *"We decided to take the cheaper flat because…"* Captures a choice and its reasoning.
- **Learning** — *"Boiling rice for too long ruins it."* Things experience taught you.
- **Reference** — phone numbers, URLs, contact details. Quick lookups.
- **Note** — general purpose. Use this if nothing else fits.

The line between these is fuzzy on purpose. Don't overthink it.

---

## Tags — the connective tissue

This is the section you should re-read in six months. Tags are the most underrated part of the app.

### The big idea

Every tag chip in Lifeplan, **anywhere**, is a launchpad. Click it.

Tap a chip on a goal card, in a brain dump, on a knowledge item, in the journal, anywhere — a **drawer** slides in with everything across the entire app that shares that label, grouped by entity type. So clicking the `settlement` chip on a single goal shows you every goal, task, person, knowledge item, journal entry, and brain dump that's tagged `settlement`. It's the cross-content lens.

### The Tags view

There's a top-level Tags surface (alongside Goals, Tasks, etc.) that lists every tag in your system, sorted by usage. From here you can:

- See **counts** per tag, broken down by entity type.
- **Rename** a tag — flows through every entity that has it.
- **Merge** two tags — pick a winner; the loser's links transfer over.
- **Delete** a tag — confirms first.
- **Create** a new tag manually (input at the top).

This is where you keep the vocabulary clean. If you see `ai-team` and `ai-teams`, merge them. If you see `leaderhip`, rename it. If you see a tag with one usage from three months ago that you'll never use again, delete it.

### How tags get created

- **You add them manually** in the entity's edit form.
- **The LLM auto-attaches them** during brain-dump processing — including spreading a relevant tag across multiple extracted items from the same dump (the `apply_to` behaviour). If you write a dump tagged `settlement`, the extracted task and person mention will both come out with that tag.

---

## Journal

Different from brain dumps. Brain dumps are raw capture meant to be processed; journal entries are reflective, dated entries you wrote intentionally.

- Toolbar: search, date filter, clear, **+ new entry**.
- Tag filter bar at the top — tap a pill to filter the list.
- Each entry: date, preview, tags. Click to open detail; Edit from the footer.
- Press `N` from the journal view to start a new entry.

Use it for end-of-day reflection, milestone moments, the kind of thing you'd write in a paper journal. Brain dump everything else.

---

## Prompts — what the system suggests

The home screen has a Prompts section. These are *system-generated suggestions* from looking at the shape of your data.

### What's actually firing

Two prompt types are live in production right now:

- **`knowledge_gap`** — *"You keep mentioning X but there's no knowledge item about it. Add a note?"* The CTA is **Add a note** — it opens the Knowledge view with the title and tag pre-filled. There's also a **Got it** to dismiss.
- **`blocker_awareness`** — *"Goal Y has a blocker that's been live a while."* CTAs: **Open the goal** (opens the goal detail) and **Mark a blocker resolved** (jumps straight to the Blockers section so you can resolve a chip in one tap). Plus **Got it** to dismiss.

### Why "Got it" exists

Some prompts you'll actually want to act on; some you'll want to acknowledge and move past. *Both are valid.* Got it isn't a dead-end — it's the "noted, thanks" path. Use it freely.

### What's coming

Five other prompt types exist in the schema but haven't started firing yet (`stale_goal`, `pattern`, `elicitation`, `milestone`, `activity_gap`). When they do, each will get its own action path. Don't worry about them now.

### Manually regenerating prompts

If you've made a lot of changes and want fresh prompts immediately, run `lp prompts` from the terminal. The command queues a regeneration job; the home screen picks it up on the next render.

---

## Background processing

The app feels instant because **nothing waits on the LLM in the foreground**.

When you submit a brain dump, the API responds immediately with the row saved and a status of `queued`. A separate worker process polls the queue every 2 seconds, claims one job at a time, runs the LLM, writes the result back, and updates the badge. The UI polls every 3 seconds while anything is in flight.

The lifecycle:

```
queued  →  processing  →  processed  (clean — items auto-created)
                       ↘  needs_review  (some items want approval)
                       ↘  failed  (LLM ran out of retries — Retry button shows)
```

Failed dumps don't lose your text. The original is still there; you can edit it and re-process, or just hit Retry.

A watchdog reclaims jobs that have been "processing" for more than 5 minutes (i.e. the worker died mid-run). You don't have to know this exists — but if you ever see a dump stuck on Processing forever, that's broken; check the worker is running (`lp worker status`).

---

## Login and access

- The app is publicly reachable at **your-domain.example/lifeplan** — protected by a **single password** behind a cookie session.
- One user (you), one password. The cookie keeps you signed in across visits.
- **Logout** lives in the desktop nav and the mobile More menu.
- **Theme toggle** lives in the same menu.
- **No password reset link in the UI.** Resetting the password is a runbook task: SSH to the droplet and run the `set-password` script. (You wrote this. If you've forgotten, the steps are in `ops/` runbooks.)

If you forget the password, you reset it server-side. There is no email recovery — there's no email account on file because you're the only user.

---

## The `lp` commands

A small terminal CLI lives at `./lp` in the repo root. The commands you'll actually use:

| Command | What it does |
|---|---|
| `lp start` / `stop` / `restart` | Local server lifecycle |
| `lp status` | Is the local server running? |
| `lp logs` | Tail the local server log |
| `lp worker <start\|stop\|restart\|status\|logs>` | Same lifecycle for the background worker |
| `lp restart-all` | Restart server **and** worker together |
| `lp serve` | Run the server in the foreground (for debugging — Ctrl+C kills it) |
| `lp backup [label]` | Snapshot the local database into `data/backups/` |
| `lp prompts` | Manually queue a prompt regeneration |
| `lp pull-db` | Download the prod (droplet) database to local — backs up local first |
| `lp deploy` | Deploy code to the droplet. **Code-only by default**; `lp deploy --with-db` to also push the database (rare; usually you don't want to overwrite prod data) |

For ops detail (systemd unit files, droplet setup, network posture), see `docs/runbooks/`.

---

## Tips and non-obvious wins

The launchpads you'll forget exist:

- **Every tag chip is a door.** Anywhere. Tap any chip and a drawer opens with everything that shares the label.
- **The home hero goal is clickable.** It used to feel like a poster; it's a button.
- **Every blocker chip resolves.** Home hero, goal detail, prompt — same tap, same five-second undo toast. You don't have to navigate to act.
- **Cmd+Enter submits forms.** The brain dump capture, the inline add forms, the goal/task drawers — all of them.
- **Pull-to-refresh works on mobile.** Swipe down at the top of any list view. Reloads the data for the surface you're on.
- **The undo toast lasts about five seconds.** If you tapped the wrong blocker, hit Undo fast.
- **Failed dumps show Retry on home.** You don't have to navigate to the Brain Dump view to retry.
- **The dump row is clickable.** It used to be inert text; click anywhere on the row to open detail.
- **Press `N` in the Journal view** to start a new entry without reaching for the button.
- **The processing badges tell the story.** When a dump shows Pending, the worker hasn't picked it up yet. Processing means the LLM is running. Done means good. Needs review means click. Failed means retry.

---

## What's not here yet

So you're not searching for things that don't exist:

- **Person detail view.** Clicking a person's name on a goal or task doesn't open a person dossier — there isn't one. The People view is the view. The Edit modal shows the most data per person.
- **Inline tag removal (chip-x).** You can untag inside the Tags drawer, but you can't tap an `×` on a chip in-place yet.
- **Add task / add person from inside a goal.** The goal detail modal lets you resolve blockers but not add tasks or attach people from inside. Use the Tasks view's add drawer or a brain dump that mentions both.
- **Five of the seven prompt types.** `stale_goal`, `pattern`, `elicitation`, `milestone`, `activity_gap` — schema-permitted, not firing yet.
- **External systems management UI.** The schema knows about external tools (e.g. your finance app); there's no surface to manage them.
- **Bulk actions in the review modal.** If a dump produced 12 suggestions, you click each one. Fine for current volumes; will become annoying if it ever balloons.
- **Search across everything.** Search exists per-view (Knowledge, Journal). There's no global search yet.

None of these are urgent. They're flagged so you don't waste time looking for them.

---

## A short worked example

To pull it together. A Tuesday morning:

1. You open the app. Home screen. The hero shows your primary goal — *Move to Seoul.* Three blockers underneath it.
2. You glance at Prompts. One says *"Goal 'Move to Seoul' has had a blocker live for 14 days."* You tap **Open the goal**, see the blocker is *Nadia's visa paperwork*, remember Nadia emailed yesterday, tap the chip, mark it **Resolved.** Toast. Done. You didn't have to leave the prompt to get there.
3. You think *"I should call Nadia to confirm."* You hit the brain dump box, type *"Call Nadia today re visa confirmed,"* Cmd+Enter.
4. The dump goes Pending → Processing → Done. The LLM extracts a task ("Call Nadia today") attached to Move to Seoul, and a person mention for Nadia. Auto-created.
5. You navigate to Tasks. The new task is there, under Move to Seoul. You tap the check circle later in the day after you've called.

That's a full loop. Capture, structure, act, mark done. The system took roughly zero of your attention to file the thing in three places.

---

*Iris, on behalf of the system. Re-read in six months.*
