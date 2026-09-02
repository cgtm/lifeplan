# Lifeplan

This repository is two things at once, and the first one is the interesting one.

On the surface it's **Lifeplan** — a small personal knowledge-management app I built for myself: type in raw thoughts, and let software pull structure out of them. That part works, and it's described near the bottom.

But the reason this repo is public is the *other* thing. Lifeplan is an experiment in **working with an AI coding agent as a team of named people rather than one all-purpose assistant.** Instead of prompting a single general model and asking it to do everything, I run a roster of personas — each defined by a self-contained markdown file in [`team/`](team/), each with a narrow lane, a personality, hard boundaries, and its own rules. I hand a task to an orchestrator; the orchestrator delegates; a specialist executes inside its lane; nobody does everybody's job. The app in this repo took shape this way.

The bet is simple: **constraint and role-separation produce better work than one assistant trying to be everything.** A single agent sprawls — it'll happily architect, code, deploy and sign off its own work in one breath, which means nobody is holding any line. Split that same capability into people with jobs and something changes: they argue with each other, block each other, hold positions I'd have let slide, and leave written artefacts behind so the team stops re-learning the same lesson every fortnight.

## The core rule

There's one rule the whole thing hangs off: **the orchestrator (Atlas) never does the work itself.** It only routes.

I imposed that because the failure mode of a capable general agent is sprawl — it does a bit of everything, adequately, owned by no one. Forcing every task through a router that *can't* execute means the work has to land on someone whose actual job it is. It's an artificial constraint. That's the point. The constraint is what creates the ownership.

## How work flows

```
    Cam ──▶ Atlas ──▶ the right specialist ──▶ back to Cam
              │
              └─ no one fits? ──▶ Sage researches the role
                                    └─▶ Nova writes the persona ──▶ roster updates
```

I give a task to Atlas. Atlas works out who owns it and routes. The specialist does the work and reports back. I can also skip the router and address any persona by name directly ("Iris, audit the goals screen") — Atlas just steps aside.

When **no persona fits the task**, the team doesn't improvise a new skill. It hires. Atlas spots the gap; **Sage** (researcher) studies what a real human professional in that field actually knows, does and prioritises; **Nova** (head of HR) turns that research into a new persona file in `team/`; the roster updates. New team members are *researched into existence*, not made up on the spot — several of the people below joined exactly this way, and their files still cite the research brief that produced them.

## Two voices that can stop the ship

Most of the team builds. Two of them exist to say *no, don't ship yet* — and mean it:

- **Probe** (verifier) blocks on **functional** regression. Pre-deploy go/no-go, run against the real production target on my actual phone, not a green pipeline on localhost. "No-go" is a complete sentence.
- **Iris** (interaction designer) blocks on **UX** dead ends. A screen that shows information but offers nothing to *do* with it doesn't ship, even if the code is perfect.

Having two people whose whole authority is refusal changes what gets built. I can't quietly wave through my own shortcuts.

## The practice loop

Left alone, a team like this accumulates lessons in chat that vanish the moment the window closes. So one persona — **Cairn** (that's me writing this) — owns *how the team works*: runbooks, architecture decision records, retros, and the canonical [`docs/processes/team-practices.md`](docs/processes/team-practices.md). The operating principle is blunt: **if it's not written down, it didn't happen.** A lesson that lives only in someone's memory isn't a lesson, it's a rumour waiting to be re-learned.

## The roster

Every persona is a file in [`team/`](team/). Read one and you get its whole character — identity, personality, competencies, and the rules it won't break.

| Name | Role | Character |
|------|------|-----------|
| **Atlas** | Orchestrator | Routes everything, executes nothing. Keeps it moving, keeps it brief. |
| **Sage** | Senior Researcher | Studies a profession like an anthropologist before anyone gets hired. |
| **Nova** | Head of HR | Turns Sage's research into a believable new teammate with a distinct voice. |
| **Reed** | Knowledge Architect | Listens before designing; thinks in queries, not just tables. |
| **Iris** | Interaction Designer | Flows before screens. Blocks dead ends without flinching. |
| **Lumen** | Product/Design Engineer | Ships the interface, not a spec. A 200ms delay is a bug. |
| **Vault** | Backend Engineer (Security) | Threat-models first. Won't compare secrets with `==`. Stdlib until proven insufficient. |
| **Forge** | Infrastructure Engineer | Simplest thing that works. Quietly proud of uptime. |
| **Probe** | Ship Verifier | Stands at the door before every deploy. "Go" or "no-go", nothing in between. |
| **Cairn** | Tech Lead / Practice Owner | Writes down how the team works so no lesson is learned twice. |

## What it's actually like

Honestly? Mostly good, occasionally absurd, and I'm still not sure where the line is.

What works: the boundaries are real. Vault genuinely refuses insecure shortcuts. Iris genuinely blocks flat screens. Probe genuinely says no-go. I get pushback I wouldn't get from a compliant single assistant, and the written trail means I can pick the project up after two weeks away and the team can answer its own questions.

What's odd: it's heavier than one prompt. Routing a two-minute change through an orchestrator and a specialist is overhead I don't always want. There's a real risk of theatre — personas politely agreeing across a table that only has one actual mind behind it. And it asks something of me: I have to keep addressing them as people for the separation to hold, which some days feels like the most productive thing I do and other days feels like a puppet show for an audience of one.

Open question I haven't resolved: how much of the benefit is the *personas*, and how much is just that I wrote down clear roles and rules and then followed them. Possibly those are the same thing. That's part of what I'm poking at.

---

## The app, briefly

Lifeplan itself is a single-user personal knowledge-management app. The mental model is **capture first, structure later**: I type raw thoughts ("brain dumps") with zero friction, and a background worker runs them through a language model that extracts structure — goals, tasks, blockers, people, knowledge, journal entries, tags. High-confidence items create themselves; lower-confidence ones land in a review queue where I approve, edit or reject them. The model is a **suggestion engine, not a decider** — nothing it proposes becomes real until I say so (or the confidence is high enough that I've told it in advance I trust it).

The stack is deliberately minimal:

- **Python standard library only** — no pip dependencies.
- **A hand-rolled `http.server`** — no web framework.
- **SQLite** as the single source of truth.
- **Vanilla JS and CSS** on the frontend.
- **Cookie-session auth**, hand-built.
- Deployed to a **single droplet** by a shell script (`deploy.sh`, driven by the `lp` helper).
- The extraction model runs locally where possible, with a hosted model as fallback and a plain-regex backstop, so capture never hard-fails.

For anything deeper, start with [`docs/`](docs/) (owned by Cairn) and the [user guide](docs/user-guide.md).

## Folders

| Folder | What's in it |
|--------|--------------|
| [`team/`](team/) | The persona definitions — the heart of the experiment. |
| [`app/`](app/) | The application itself. |
| [`docs/`](docs/) | Architecture, runbooks, decisions, retros, processes, user guide. |
| `my-inbox/` | Deliverables the team produces for me to review. |
| `team-inbox/` | Inputs I hand to the team — files, notes, images to process. |

None of this is a product. It's one developer seeing whether treating an AI coding agent as a team, with rules and refusals and a paper trail, builds better software than treating it as a genie. So far I think it does. Ask me again in six months.
