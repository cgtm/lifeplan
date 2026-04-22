# journal

A quiet, personal interface for your lifeplan journal entries.

## Run

```
cd /Users/cam/lifeplan/app
python3 server.py
```

Then open **http://localhost:3131** in your browser.

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `N` | New entry |
| `/` | Focus search |
| `Esc` | Close modal / blur |
| `Cmd+Enter` | Save entry (when composing) |

## API

The server exposes a simple REST API:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/entries` | List all entries (supports `?q=`, `?date=`, `?tag=` filters) |
| `GET` | `/api/entries/:id` | Get a single entry |
| `POST` | `/api/entries` | Create an entry (`{entry_date, content, tags[]}`) |
| `PUT` | `/api/entries/:id` | Update an entry |
| `DELETE` | `/api/entries/:id` | Delete an entry |
| `GET` | `/api/tags` | List all tags with entry counts |

## Structure

```
app/
  index.html    Frontend (single HTML file, no build step)
  server.py     Python server (stdlib only, no dependencies)
  README.md     This file
```

No dependencies. Just Python 3 and a browser.
