# TASK-95 handoff — Full touch loop e2e (SC-1 by touch) + controls docs

## Status

The spec `app/tests/e2e/touch-loop.spec.ts` is written and runs claim → mobile-profile → touch-menu warp → space (thrust + yaw, both pass) in a real green stretch, but dies on the LAND leg: the ship teleported 60 m straight above the pad center free-falls into the 20 m pad disc and the pad machine docks it instantly, so the spec's `regime === 'atmosphere'` poll times out receiving `docked`. The land leg needs an approach, not a direct drop (fix direction in Next steps). The docs half of the task (step 2) is not started.

## Done

- **Egress wiring fix (product, the spec's "fix the responsible wiring" case):** `app/src/client/main.tsx` — the docked `exit_ship` branch (previously ONLY in the E-keydown handler, lines ~1462-1467) moved into the shared `interactPressRef.current` body (now right after the `anySurfaceOpen()` guard), so the touch INTERACT button and the touchDebug `interactPress()` e2e bridge disembark through the SAME code as the keyboard. The E-key handler is now a thin `if (e.repeat) return; interactPress();` wrapper (behaviour-identical: surface guard, docked branch and raycast dispatch all live in `interactPressRef`). `npx tsc --noEmit` GREEN with this change. (Needed for spec legs 5 and 10 — exit ship + exit ship before the sell leg — which cannot work by touch without it.)
- **`app/tests/e2e/touch-loop.spec.ts` (new, ~640 lines):** the full SC-1 loop, single test, 300 s timeout. Structure:
  - Claim via `ClaimPage` in a `hasTouch: true` context with `tapShipUpdates(callsign)` init script (WebSocket tap → `window.__TL__` pos/vel/regime/padId). Claim re-tries (≤3 fresh callsigns `tl95*`) until a CHART NEIGHBOUR of home hosts the seeded pad (`/api/galaxy/overview?home=` + `/api/dev/pad-target?systemId=` per neighbour) — the warp leg needs a non-current destination.
  - Force mobile profile: `PUT /api/players/settings {deviceProfile:'mobile'}` → `page.reload()` → poll `window.__STREAM__?.lodRadii()?.farMaxM === 3000`.
  - Touch MENU (`__TOUCH__.openMenu()`) → `#esc-menu-systems` tap → chart node `[data-system-id="<pad sys>"]` tap → `#warp-button` tap → `#warp-overlay` mounts + clears → `#sys-id` shows the pad system → **tap `#star-chart-close` then `#esc-menu-resume`** (REQUIRED: the flight input loop suppresses input while the chart is open — first run died at the thrust leg because the surfaces were left open; this fix is in and verified working in run 2).
  - Space: `setChannel({thrust:1})` → server speed 0 → rising (s1 < s2 over 2 s) → release; yaw=+1 for 2 s → dot(forward, initialRight) > 0.2 (TASK-80 math, probe from `__SELF_SHIP__`).
  - **LAND (BROKEN — see Dead ends):** currently teleports to `{pad.x, pad.y+60, pad.z}` and polls `atmosphere` (FAILS, gets `docked`), then vtol lift assert → release → descent → `docked` + `padId` poll.
  - Legs 5-10 (untested, run died before them): egress via `touch(page,'interactPress')` (needs the main.tsx fix — in) → on-foot bar visible → deposit 4 m ahead of facing (`/api/dev/deposit`) → walk with `touch(page,'move',{thrust:1})` until prompt contains 'mine iron' → settle → interactPress, 1.8 s, interactRelease → `1/40u` → `walkUntilPrompt()` (prompt-as-sensor steering loop, the touch-onfoot.spec.ts geometry verbatim, generalized to any goal + prompt) to `[E] Enter ship` (stopShort 1.8 m) → interactPress → re-docked → egress again → `walkUntilPrompt()` to `[E] Dock terminal` (terminal from `/api/dev/terminal-target?systemId=<pad sys>`, same planet) → interactPress → `#dock-panel` "hold 0 · inv 1" → tap `button[aria-label="sell all iron inv"]` → `#credits-counter` 500 → 505 cr, "Nothing to sell", `#weight-bar` 0/40u → screenshot `.ralph/screenshots/TASK-95-1.png` → `assertClean()`.
  - Console/log line records the loop wall-time (`[TASK-95] loop wall=… s …`) for the LOG entry.

## Working tree

- `app/src/client/main.tsx` — MODIFIED (egress wiring fix), tsc clean, NOT committed.
- `app/tests/e2e/touch-loop.spec.ts` — NEW (spec as above), NOT committed.
- `app/test-results/` has the run-2 failure artifacts (error-context.md shows the chart-close state that prompted fix #1; the land-leg failure is a regime poll, not a DOM issue).
- Pre-existing dirty files in the repo (screenshots, `.ralph/decisions.jsonl`, `PRD.md`, `.gitignore`, …) are NOT mine — exclude them from the commit, per convention.
- Everything else builds: `npx tsc --noEmit` GREEN (verified after both edits).

## Next steps

1. **Fix the land leg (the only red):** replace the direct-drop teleport with an approach:
   - Teleport to a point INSIDE the atmosphere band but horizontally offset from the pad, e.g. `{ x: t.pad.x + 300, y: t.pad.y + 200, z: t.pad.z }` (300 m > PAD_RADIUS 20 + VTOL-assist 100 m → no instant dock; 200 m altitude, inside the 1000 m band). Poll `atmosphere`.
   - Steer toward the pad: compute the bearing from `__SELF_SHIP__` probe (pos + rot forward) to the pad, fire yaw/pitch touch-channel bursts (the `faceAnchor` math from `app/tests/e2e/cruise.spec.ts` lines 100-149 is the proven pattern — |err| < 0.12 rad, press time |err|/0.8 − 0.2 s release lag), then `setChannel({thrust:1})` to close the distance.
   - Once within ~100 m of the pad, set `vtol:1` — the SERVER VTOL assist (pads.ts: within 100 m + < 50 u/s damps horizontal drift ×0.5/tick) makes parking work; keep closing to the pad disc. Then release vtol → gravity settles the ship onto the flat pad disc → the pad machine docks (regime `docked` + `padId`; keep the 30 s poll).
   - If the steering proves too slow/flaky in headless, fallback (still touch-only): offset teleport to `{x+300, y+80, z}` (atmosphere asserts), vtol:1, then a short `thrust:1` burst toward the pad while VTOL assist damps drift, release, settle → docked. The server's assist does the parking.
   - Bump `test.setTimeout(300_000)` to 360 s if the approach makes the loop longer (run 2 died ~3 min in at the land leg; legs 5-10 add on-foot walking, budget generously).
2. Run: `cd app && npx playwright test touch-loop.spec.ts --config playwright.e2e.config.ts --reporter=line`. Legs 5-10 have NEVER executed — expect first-touch issues there (the walkUntilPrompt loop is copied verbatim from the green touch-onfoot spec, so risk is low; the egress leg needs the main.tsx fix which is in).
3. **Docs (task step 2, not started):**
   - `README.md`: line 17 intro "no touch controls" and line 38 Features "Keyboard-only play" — update both to reflect touch support; add a short 'Touch controls' note under the Controls section (dual-stick flight: left = thrust+yaw, right = pitch+roll, + FIRE/VTOL/BOOST/TARGET/weapon; on-foot: move stick + RUN/JUMP/DROP/INTERACT; MENU button; Settings → Controls Auto/On/Off). Keep it factual and short.
   - Dev note: add a short 'Touch / mobile controls' section to `app/docs/contributing.md` (or architecture.md) explaining the VIRTUAL-KEY design (touch projects to the same key names, merged with the keyboard pressed set via `mergePressed`; server/prediction/wire/cheat-resistance unchanged — see `src/client/input/touch.ts`, `src/client/main.tsx` `effectivePressed()`) and the enablement model (auto = maxTouchPoints > 0, on/off persisted on `Settings.touchControls`).
4. **Full gate:** `cd app && npx tsc --noEmit`; FULL `npm run test` (unit — watch the documented wall-clock/WS load-flake family, re-run reds in isolation); `npm run test:e2e` (full suite incl. touch-loop + all keyboard specs — no regression); `eslint --fix` + `prettier --write` on `app/src/client/main.tsx`, `app/tests/e2e/touch-loop.spec.ts`, `README.md`, the touched doc file.
5. **Bookkeeping:** set both steps `pass: true` in `.ralph/tasks/TASK-95.json`, `passes: true` for TASK-95 in `.ralph/tasks.json` (line 849), LOG.md entry at top with the measured loop wall-time from the `[TASK-95] loop wall=…` console line + screenshot path, then commit `feat(TASK-95): full touch loop + docs` (single close-out commit for the feature; include the main.tsx wiring fix in it).

## Dead ends

- **Direct-drop landing (CURRENT SPEC):** teleport to exactly `{pad.x, pad.y+60, pad.z}` → the ship free-falls straight down, lands inside the 4 m `findPad` / 20 m pad-acquisition disc at < 5 u/s, the pad machine docks it (`docked` + padId) within the 20 s atmosphere poll window. Run-2 failure: `Expected: "atmosphere" Received: "docked"` at the atmosphere poll. The atmosphere regime IS entered (60 m > SURFACE_ENTER_ALT_M 2) only for a split second before docking. Not fixable by a longer poll — the ship never stays in atmosphere. Needs the offset approach (Next steps 1).
- **Left-open surfaces after the warp:** run 1 died at "server speed never rose above 0 with touch thrust" — the chart + ESC menu were still open after the warp and the flight input loop suppresses input while `chartOpen`. Fixed in the spec by tapping `#star-chart-close` + `#esc-menu-resume` after `#sys-id` updates (verified: run 2 passed the space legs).
- No keyboard/mouse input anywhere in the spec except the unavoidable `ClaimPage` form (fill + click, the claim leg the spec explicitly allows via the form) and touch TAPS on DOM buttons (chart close/resume, chart node, WARP, sell) — those are pointer clicks on React buttons, the same surface a real touch finger drives; NO `page.keyboard.*` calls in the spec.

## How to verify

- `cd app && npx tsc --noEmit` (green now).
- `cd app && npx playwright test touch-loop.spec.ts --config playwright.e2e.config.ts --reporter=line` — currently RED at the land leg (step 1 above is the fix).
- After the fix: full `npm run test` + `npm run test:e2e` green, screenshot `.ralph/screenshots/TASK-95-1.png` LOOKED AT (dock panel + 505 cr + 0/40u bar + on-foot touch layout), then bookkeeping per Next steps 5.
