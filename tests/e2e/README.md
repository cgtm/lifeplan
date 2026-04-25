# Lifeplan — End-to-End Suite

Owned by **Probe** (Ship Verifier). Every test maps to a clause in
`app/contracts/cookie-auth.md`. New shipped bug → permanent fixture here.

The suite is designed to be **Probe-runnable**: any team member who needs
to verify a build runs `npm test` and gets an answer. Cam writes the
local-dev password into `tests/e2e/.env` once via `./setup.sh`, and from
that point on the team is self-serve.

## First-time setup

On a fresh checkout, **Cam** runs this once in his own terminal:

```sh
cd tests/e2e
npm install
npx playwright install chromium webkit
./setup.sh
```

`setup.sh` prompts silently (`read -s`) for the local-dev password,
writes `tests/e2e/.env` with mode `600`, and exits. The password is never
echoed, never logged, never committed (`.env` is gitignored).

Browsers are downloaded into `~/Library/Caches/ms-playwright`, not the repo.

`tests/e2e/.env.example` is the committed contract — copy it to `.env`
manually if you'd rather skip the prompt.

## Run the suite (the team — including Probe — does this)

```sh
cd tests/e2e
npm test
```

`playwright.config.ts` loads `tests/e2e/.env` at startup via `dotenv`, so
no env vars need to be passed inline. If the file is missing, the auth
fixture fails with a clear message pointing at `setup.sh`.

### Headed / single-browser

```sh
npm run test:headed         # show the browser
npm run test:webkit-only    # iOS proxy
npm run test:chromium-only
```

## Override at the command line (ad-hoc / production runs)

Inline env vars override `.env`. To verify against production without
touching `.env`:

```sh
LIFEPLAN_TEST_BASE_URL='https://your-domain.example/lifeplan/' \
LIFEPLAN_TEST_PASSWORD='<prod-password>' \
  npm test
```

Mount-prefix-sensitive tests resolve their expectations from the URL's
path (`/lifeplan/`), so the same `Location` and `Path=` assertions verify
the prod mount automatically.

**Do not** run the rate-limit test against production unless you know the
production limiter state — burning 5 prod login slots locks you out for
15 minutes from your current IP.

## Rate-limit test (skipped by default)

The rate-limit test fires 6 wrong-password attempts. That burns the
in-process limiter slots for 15 minutes, so it's gated off. Run it on
demand when `/login` or `app/auth.py` rate-limit code changes:

```sh
RATE_LIMIT_TEST=1 \
LIFEPLAN_RESTART_CMD='/Users/cam/dev/personal/lifeplan/lp restart' \
  npm test
```

Without `RATE_LIMIT_TEST=1` the test is **skipped with a clear reason** —
not silently passed (Probe rule: a flaky/optional test that appears green
is worse than a skipped test that surfaces the gap).

## Coverage

| # | Area | File / case |
|---|---|---|
| 1 | `GET /login` 200 + form | `auth.spec.ts` → "GET /login" |
| 2 | `POST /login` happy path + cookie flags | "POST /login" → correct password |
| 3 | `POST /login` wrong password 401 + UI message | "POST /login" → wrong password / UI |
| 4 | `POST /login` rate limit (5 then 429) | "POST /login rate limit" *(opt-in)* |
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

## Files

- `playwright.config.ts` — Playwright config. Loads `tests/e2e/.env` via
  `dotenv` at startup; CLI env vars still override.
- `setup.sh` — first-run interactive prompt. Writes `.env` with mode 600.
  Re-run on password rotation. **Never sends the password anywhere.**
- `.env.example` — committed contract showing the expected file format.
- `.env` — gitignored, generated by `setup.sh`. Read by the suite.
- `fixtures/auth.ts` — Playwright fixtures (password, mountPrefix,
  loginPath, loggedInPage, apiCtx).
- `auth.spec.ts` — the cookie-auth contract verification.
