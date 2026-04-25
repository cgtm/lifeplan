# Lifeplan — End-to-End Suite

Owned by **Probe** (Ship Verifier). Every test maps to a clause in
`app/contracts/cookie-auth.md`. New shipped bug → permanent fixture here.

## Install

```sh
cd tests/e2e
npm install
npx playwright install chromium webkit
```

Browsers are downloaded into `~/Library/Caches/ms-playwright`, not into the
repo.

## Run locally

The local server (`lp start`) must be up on `http://localhost:3131/`.

```sh
LIFEPLAN_TEST_PASSWORD='<the-current-dev-password>' npm test
```

The dev password lives in Vault's notes — **not** in this repo. If unsure
which password is current, ask Atlas. The previous documented value
(`testpass-dev`) was rotated.

### Headed / single-browser

```sh
LIFEPLAN_TEST_PASSWORD='…' npm run test:headed         # show the browser
LIFEPLAN_TEST_PASSWORD='…' npm run test:webkit-only    # iOS proxy
LIFEPLAN_TEST_PASSWORD='…' npm run test:chromium-only
```

### Rate-limit test

The rate-limit test needs a fresh in-process limiter. Set
`LIFEPLAN_RESTART_CMD` so the test resets the server itself:

```sh
LIFEPLAN_TEST_PASSWORD='…' \
LIFEPLAN_RESTART_CMD='/Users/cam/dev/personal/lifeplan/lp restart' \
  npm test
```

Without that env var, the rate-limit test is **skipped with a clear
message** (not silently passed) — Probe rule: a flaky/optional test that
appears green is worse than a skipped test that surfaces the gap.

## Run against production

The same suite, retargeted via env var:

```sh
LIFEPLAN_TEST_BASE_URL='https://your-domain.example/lifeplan/' \
LIFEPLAN_TEST_PASSWORD='<prod-password>' \
  npm test
```

Mount-prefix-sensitive tests resolve their expectations from the URL's path
(`/lifeplan/`), so the same `Location` and `Path=` assertions verify the
prod mount automatically.

**Do not** run the rate-limit test against production unless you know the
production limiter state — burning 5 prod login slots locks you out for 15
minutes from your current IP.

## Coverage

| # | Area | File / case |
|---|---|---|
| 1 | `GET /login` 200 + form | `auth.spec.ts` → "GET /login" |
| 2 | `POST /login` happy path + cookie flags | "POST /login" → correct password |
| 3 | `POST /login` wrong password 401 + UI message | "POST /login" → wrong password / UI |
| 4 | `POST /login` rate limit (5 then 429) | "POST /login rate limit" |
| 5 | Authenticated `GET /` 200 | "GET / (auth-required)" → authenticated |
| 6 | Unauthenticated HTML `GET /` 302 to mount-aware login | "GET / (auth-required)" → 302 (regression) |
| 7 | Unauthenticated API → 401 JSON, NOT 302 | "API auth gate" |
| 8 | `POST /logout` clears cookie + future 401 | "POST /logout" |
| 9 | Desktop logout chip lands on `<mount>login` | "Logout via UI" → desktop |
| 10 | Mobile breakpoint: chip hidden, More-menu works | "Logout via UI" → mobile |
| 11 | Tampered cookie → redirect to login | "Tampered cookie" |
| 12 | Content-Type gate (`x-www-form-urlencoded` → 415) | "POST /login" → Content-Type gate |
| 13 | Public assets reachable unauthenticated | "Public assets" |

## What's NOT covered (deferred to manual)

See `docs/runbooks/probe-manual-checklist.md` for the manual list. Probe
intentionally automates only what's deterministic and boring. The manual
checklist owns:

- iOS PWA standalone-mode launch (real device).
- Real-iPhone visual checks for dark mode and focus rings.
- Safari force-quit + bookmark recreation flow.
- 30-day cookie expiry / sliding refresh (time-machine territory; not
  worth a flaky timer-mocked test).
- Cross-site CSRF (browser-engine territory; SameSite=Lax is asserted by
  cookie-flag check, the behaviour itself is browser-enforced).

## Conventions

- One behaviour per `test()`. When something fails, the failure tells you
  which contract clause regressed.
- Locate by role / id / accessible name. Never CSS-class chaining.
- Wait on conditions, never on `setTimeout` / `waitForTimeout`. A
  hard-coded sleep is a flaky test in waiting.
- Bugs found in production earn a permanent fixture. The desktop-logout
  regression is already here (clause 9).

## Adding a feature suite

For each new feature in Probe's remit:

1. Confirm there is a contract document in `app/contracts/<feature>.md`
   (practice 1). If not, push back to Atlas — no contract, no Probe.
2. Add `<feature>.spec.ts` next to `auth.spec.ts`.
3. Use the `auth.ts` fixture (`loggedInPage`) for tests that need an
   authenticated session.
4. Each `test()` title prefixed with the contract clause ("contract:" /
   "regression:" / "UI:") so failures point at the right artefact.
