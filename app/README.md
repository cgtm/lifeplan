# lifeplan

Personal knowledge management system — brain dumps, goals, tasks, people, journal, and knowledge items backed by SQLite with LLM-powered processing via three-tier fallback (Ollama local -> Mistral cloud API -> regex).

## Run

**Via `lp` command (recommended):**

```
./lp start       # start the server via launchd
./lp restart     # restart
./lp logs        # tail the logs
./lp stop        # stop the server
```

**Manual:**

```
cd /Users/cam/lifeplan/app
python3 server.py
```

Then open **http://localhost:3131**.

Requires [Ollama](https://ollama.com) running locally with the Mistral model for brain dump processing. Falls back to Mistral cloud API, then regex if both are unavailable. Runs via launchd.

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `N` | New brain dump / journal entry |
| `/` | Focus search |
| `G` | Go to Goals |
| `T` | Go to Tasks |
| `Esc` | Close modal / blur |
| `Cmd+Enter` | Save / submit |

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| **Brain Dumps** | | |
| `GET` | `/api/brain-dumps` | List dumps (`?status=`, `?q=`) |
| `POST` | `/api/brain-dumps` | Create and auto-process a dump |
| `POST` | `/api/brain-dumps/:id/process` | Reprocess a dump |
| `POST` | `/api/brain-dumps/:id/approve-item` | Approve/dismiss a suggested item |
| `DELETE` | `/api/brain-dumps/:id` | Delete a dump |
| **Goals** | | |
| `GET` | `/api/goals` | List goals (`?status=`) |
| `GET` | `/api/goals/:id` | Goal detail with tasks and blockers |
| `PUT` | `/api/goals/:id` | Update a goal |
| `DELETE` | `/api/goals/:id` | Delete a goal (unlinks tasks) |
| **Tasks** | | |
| `GET` | `/api/tasks` | List tasks (`?status=`, `?goal_id=`) |
| `PUT` | `/api/tasks/:id` | Update a task |
| `DELETE` | `/api/tasks/:id` | Delete a task |
| **People** | | |
| `GET` | `/api/people` | List all people with connections |
| `GET` | `/api/people/:id` | Person detail |
| `PUT` | `/api/people/:id` | Update a person |
| `DELETE` | `/api/people/:id` | Delete a person |
| **Knowledge** | | |
| `GET` | `/api/knowledge` | List items (`?type=`, `?q=`) |
| `PUT` | `/api/knowledge/:id` | Update an item |
| `DELETE` | `/api/knowledge/:id` | Delete an item |
| **Journal** | | |
| `GET` | `/api/entries` | List entries (`?q=`, `?date=`, `?tag=`) |
| `GET` | `/api/entries/:id` | Get an entry |
| `POST` | `/api/entries` | Create an entry |
| `PUT` | `/api/entries/:id` | Update an entry |
| `DELETE` | `/api/entries/:id` | Delete an entry |
| `GET` | `/api/tags` | List all tags |
| **Prompts** | | |
| `POST` | `/api/prompts/generate` | Generate proactive prompts |
| `GET` | `/api/prompts` | List prompts |
| `GET` | `/api/prompts/count` | Get prompt count |
| **Other** | | |
| `GET` | `/api/dashboard` | Home dashboard data |
| `GET` | `/api/dependencies` | Dependency graph |

## Structure

```
app/
  server.py          HTTP routing and startup
  db.py              Database connection and tag helpers
  processing.py      Brain dump processing (regex + LLM)
  generate_prompts.py  Proactive prompt generation
  handlers.py        REST API handlers
  index.html         HTML markup
  styles.css         Styling
  app.js             Frontend behaviour
  manifest.json      PWA manifest
  icon-*.png         App icons
```

## Deployment

Deployed to `https://your-domain.example/lifeplan` on a DigitalOcean droplet with nginx + HTTP Basic Auth. `deploy.sh` pushes updates via rsync.

No external dependencies beyond Python 3 stdlib + SQLite + Ollama. Requires a `.env` file with `MISTRAL_API_KEY` for the cloud API fallback tier.
