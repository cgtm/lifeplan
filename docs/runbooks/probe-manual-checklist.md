# Probe — Manual Pre-Deploy Checklist

**Owner:** Probe
**Cadence:** every deploy in Probe's remit (auth, mobile/PWA, layout
chrome, anything user-observable). Per practice 8.
**Format:** Cairn-style runbook — Goal, Preconditions, Steps,
Verification, Failure modes.

The automated suite (`tests/e2e/`) covers what's deterministic and boring.
This checklist covers what isn't: real iOS device behaviour, visual
judgement, anything an emulator quietly lies about. Every item here exists
because automation can't or shouldn't own it — not because Probe was lazy.

## Goal

Catch the class of bug a desktop Chromium pass cannot catch:

- iOS PWA standalone-mode chrome (no browser bar; the home-screen icon is
  a different launch surface from Safari).
- Visual regressions in dark mode and focus rings on a real OLED screen.
- Pre-auth surfaces (Basic Auth dialog leaks, missing icons) that only
  appear on first install / fresh bookmark.

## Preconditions

- Automated suite green (chromium + webkit) on the candidate build —
  no-go without it. See `docs/runbooks/probe-go-no-go.md`.
- Cam's iPhone has the Lifeplan PWA installed (or is about to install it
  for a fresh-bookmark check).
- Cam is on a network that can reach the deploy target (production:
  `https://your-domain.example/lifeplan/`).
- For dark-mode checks: device is in dark mode, or the OS-level scheduled
  switch is active.

## Steps

### A. iOS PWA standalone-mode launch (every auth/chrome change)

1. From the iPhone home screen, tap the Lifeplan icon. **Do not** open
   Safari first — the standalone launch surface is the one that ships
   bugs.
2. Observe the first frame:
   - **No HTTP Basic Auth dialog** appears. (The cookie-auth retro shipped
     a build where one did. This is the sentinel.)
   - The login page renders in standalone chrome (no Safari URL bar).
   - The login form is centred, the input is focused, the keyboard is
     usable.
3. Sign in. The app loads at the mount root (`/lifeplan/` in prod).
4. Pull-to-reload (swipe down). The app stays signed in (cookie present).
5. Force-quit the PWA from the iOS app switcher. Tap the icon again.
   Still signed in.

### B. Real-device visual pass (every layout/chrome change)

1. Open the app on the iPhone in **light** mode. Walk every primary view
   (Home, Brain Dump, Goals, Tasks, More menu items). Look for:
   - Misaligned elements at the safe-area top/bottom.
   - Buttons that look unclickable (poor contrast).
   - Focus rings present and visible on every interactive element when
     using the iPad keyboard or VoiceOver swipe.
2. Switch to **dark** mode (Control Centre → Dark Mode). Walk the same
   views. Look for:
   - Dark-mode focus ring colour is distinguishable from the dark
     background.
   - Borders haven't disappeared into the surface.
   - The danger / red colour is still legible (the cookie-auth retro
     queued one paper-cut here).
3. Both modes: log out via desktop chip on iPad-landscape; log out via
   the More menu on iPhone-portrait. Both flows land on the login page.

### C. Safari force-quit + bookmark recreation

This catches the case where the user has *just* re-added the app to the
home screen — the bookmark's start URL must be the mount root, the icon
must be the right one, and the launch must not require a Safari round-trip.

1. From the home screen, long-press the Lifeplan icon → **Delete from
   Home Screen**. Confirm.
2. Open Safari. Visit `https://your-domain.example/lifeplan/`.
3. Share sheet → **Add to Home Screen**.
4. Confirm:
   - Suggested name is "Lifeplan" (from `<title>`).
   - Icon shown is the high-res app icon, not a blurry screenshot.
5. Tap **Add**. Find the new icon on the home screen.
6. Tap it. Verify (A) above end-to-end on this fresh bookmark.

### D. Background processing (every worker / processing change)

The automated suite (`tests/e2e/background-processing.spec.ts`) covers
HTTP shape, status transitions, and the in-page polling loop. The items
here are what automation can't see: cross-process restart behaviour,
real-device PWA behaviour, sustained-load behaviour, and the privacy
invariant.

1. **Worker mid-job restart.** Submit a brain dump. Within ~1 s of
   submitting (while the badge is still "Processing"), restart the
   worker:
   ```sh
   /Users/cam/dev/personal/lifeplan/lp worker restart
   ```
   Confirm the dump still completes — either the watchdog (≤ 5 min)
   reclaims the in-flight row, or the next claim cycle picks it up.
   The badge eventually flips to a terminal state without any user
   intervention. May take up to 5 min; that's the contract's reclaim
   window.
2. **iOS PWA live transitions.** Launch the home-screen-installed PWA
   on Cam's actual iPhone (not Safari). Open the Brain Dump page.
   Submit a new dump. Confirm:
   - Row appears with "Pending" within ~1 s.
   - Badge transitions to "Done" / "Needs review" within ~5 s **without
     pull-to-reload**. Standalone-mode polling has shipped bugs before;
     this is the regression sentinel.
3. **Long-running queue (serial processing).** Submit 5 brain dumps in
   quick succession (one every ~1 s). Confirm:
   - All 5 appear with "Pending" badges immediately.
   - They process serially, oldest first, within reasonable time.
   - Worker log shows one `worker.claimed` event per dump:
     ```sh
     /Users/cam/dev/personal/lifeplan/lp worker logs | grep worker.claimed | tail -10
     ```
4. **Prompt regeneration.** Visit a prompt-related surface (Home page,
   prompt list). Trigger prompt regeneration via the UI affordance
   (the "regenerate prompts" button or equivalent). Confirm:
   - The button returns immediately (no UI hang — POST is non-blocking).
   - New prompts appear within ~5 s if the cooldown allows; otherwise
     the existing set remains and the worker logs `worker.processed`
     for the prompt_generation job.
5. **Privacy invariant.** Pick any known dump phrase (Cam knows several)
   and grep the worker logs:
   ```sh
   journalctl -u lifeplan-worker -n 500 2>/dev/null | grep -i "<phrase>"
   /Users/cam/dev/personal/lifeplan/lp worker logs | grep -i "<phrase>"
   ```
   Both must return nothing. If either matches, that's a **blocker** —
   contract states "Worker logs contain no user content." File to Vault.

   **Known finding (open as of 2026-04-25):** `app/processing.py:1679`
   `print(f"  [processing] Starting brain dump #{dump_id}: \"{preview}...\"")`
   currently emits the first 80 chars of dump content via `print(...)`.
   This is the regression to look for; verify it's fixed before
   sign-off on any deploy that *was* supposed to fix it.

### E. Real-network failure modes (when relevant)

When testing changes to the login page or session handling:

1. Toggle iPhone to **Airplane mode** during the login submit. Confirm
   the page shows "Network error. Try again." (per contract error
   matrix), not a blank page.
2. Re-enable network, retry. Logs in.

## Verification

For each section above, write down (in this order):

- Date, deploy SHA, device + iOS version.
- Pass / fail per numbered step.
- For any fail: a screenshot or screen recording, and a one-line
  reproduction.

The output is a `## Pre-deploy verification — <date>, commit <sha>` block
in Probe's report to Atlas. Format per `team/probe.md`.

## Failure modes (what makes Probe say no-go)

- **Blocker (do not deploy).** Any of:
  - PWA launch shows a Basic Auth dialog.
  - Login page fails to render in standalone mode.
  - Logout button on either breakpoint lands on apex (`/`) instead of
    `<mount>login` — even if the automated suite passes; the manual
    check catches the case where the production mount has drifted from
    the test mount.
  - Pull-to-reload after sign-in throws the user back to the login page.
- **Regression (Cam decides).** Visible-but-bounded:
  - Dark-mode contrast paper-cut on a non-primary view.
  - Focus ring missing on a single interactive element.
  - Bookmark icon is the low-res fallback (PWA launches but looks bad).
- **Paper-cut (queue, ship).** Cosmetic flaws on rarely-used views,
  visible only side-by-side with the previous build.

When unsure, escalate to blocker. The cautious direction is the right
default (Probe rule 9).

## Pruning

Items in this checklist that catch nothing for six months are reviewed.
Probe rule: "the checklist is sacred but not frozen." Pruning is
recorded in the next retro.
