# Contract: <feature>

**Authors:** Vault (server), Lumen (client)
**Status:** draft | accepted | deprecated | superseded
**Last updated:** YYYY-MM-DD

One page. Working document. Update when reality forces a change.

## Mount story
How is the app mounted in production vs development? Where does the mount prefix come from at runtime (env var, config, injected into HTML, derived from `window.location`)? How does the client resolve a path like `login` against the prefix? How does the server compose a redirect `Location` against the prefix? Name the function or variable on each side.

- Prod mount: `/lifeplan/`
- Dev mount: `/`
- Client resolver: …
- Server resolver: …

## Endpoints
For each endpoint the client hits:

### `<METHOD> <path-relative-to-mount>`
- **Request headers:** …
- **Request body:** shape / content-type
- **Response 2xx:** status, body shape, headers (especially `Set-Cookie`)
- **Response 4xx/5xx:** status codes used and their meaning

(repeat per endpoint)

## Redirects
Every redirect issued by the server or performed by the client. Target path (relative to mount), trigger condition, who issues it. Confirm the path is composed mount-aware on whichever side issues it.

| Trigger | Issuer | Target (relative) | Notes |
|---|---|---|---|
| | | | |

## Error matrix
What the UI does for each documented non-2xx response.

| Status | Meaning | Client behaviour |
|---|---|---|
| | | |

## Open questions
Things still to resolve before code starts. Strike through when answered.

-
