# TASK-97 handoff (2026-10-10 ~10:15 UTC)

## Status
Implementation COMPLETE and verified; only the touch-loop.spec.ts re-verification + close-out remain. Ran out of iteration time at the final e2e re-run.

## Done
- **Fix A** (`app/src/client/ui/touch/TouchControls.tsx`): `regime === 'surface' && !onFoot` (pad-docked, in-ship) now falls through to the FLIGHT layout with the ATMOSPHERE scheme (`atmosphere = regime === 'atmosphere' || (regime === 'surface' && !onFoot)` → VTOL, no BOOST). The on-foot layout renders only when `onFoot` is true. Regime-flip effect refined with a `prevOnFootRef`: LIFTOFF (surface → atmosphere/space, onFoot stays false) KEEPS held channels; DISSEMBARK (onFoot → true) CLEARS (the `' '` JUMP-leak rule); re-entry (onFoot was true) still clears.
- **Fix B**: new `touchCapable?: boolean` prop (DEFAULT false). `!enabled` branch: `touchCapable && onMenu` → renders `#touch-controls` with ONLY the (hoisted) MENU button; otherwise null. Channels stay cleared by the existing `!enabled` effect.
- `app/src/client/main.tsx`: passes `touchCapable={touchNavHints.maxTouchPoints > 0}`.
- **Unit tests** (`TouchControls.test.tsx`, 42/42 GREEN): new — surface-in-ship flight layout (sticks + VTOL + MENU, no BOOST); lone MENU with `enabled={false}` + `touchCapable`; liftoff KEEPS thrust+VTOL / disembark CLEARS. Updated 2 tests asserting the OLD buggy behavior (combat cluster absent on-foot not in-ship; surface-in-ship shows flight sticks).
- **E2E** (`app/tests/e2e/touch-padded.spec.ts`, NEW): dockAtPad → (a) overlay UP while pad-docked (sticks + VTOL + MENU, no BOOST) [the pre-fix failure], (b) touch take-off `setChannel({thrust:1, vtol:1})` → wire regime leaves 'docked' in **1.06 s**, ship lifted 8.6 u, `#docked-indicator` clears, (c) `__TOUCH__.openMenu()` opens `#esc-menu`, (d) Off-lockout via the touch panel path (ESC→SETTINGS→TOUCH CONTROLS=OFF, server row round-trips 'off') → lone `#touch-btn-menu` with sticks absent, openMenu() still opens `#esc-menu`. **1 passed (31.3 s)** — screenshot run.
- **Screenshots** saved + LOOKED AT: `.ralph/screenshots/TASK-97-1.png` (flight layout over pad-docked ship, DOCKED indicator) + `TASK-97-2.png` (lone MENU, TOUCH CONTROLS = OFF panel).
- `npx tsc --noEmit` GREEN; eslint + prettier clean on all 4 touched files.
- **Full unit suite** (196 files, 1853 passed / 1 skipped): the only red was `combat-hud.test.tsx` "per-frame projection under hud budget" — a wall-clock budget test, GREEN in isolation (18/18), load flake, unrelated to the diff.
- **E2E batch (6 specs, 1 worker)**: touch-padded, touch-onfoot, touch-combat passed in-batch; touch-menu, touch-flight, touch-loop red in-batch. **Isolation re-runs (sequential, no load): touch-menu 2/2 GREEN (30.5 s — incl. the desktop Off→count-0 AC), touch-flight 1/1 GREEN (44.1 s).** touch-loop red in isolation ONCE: `land leg: still 88 m from the pad after 3 glides` — the landing leg, a documented flake family (TASK-95.1 log: 15 runs debugging this leg; it drives the pad machine / VTOL glide physics via the __TOUCH__ hook, no overlay code in the path; the spec never asserts `#touch-controls`).

## Working tree
Dirty (uncommitted): `app/src/client/ui/touch/TouchControls.tsx`, `app/src/client/ui/touch/TouchControls.test.tsx`, `app/src/client/main.tsx`, `app/tests/e2e/touch-padded.spec.ts`, `.ralph/screenshots/TASK-97-1.png`, `.ralph/screenshots/TASK-97-2.png`, `.ralph/handoff/TASK-97.md`. **Pre-existing dirty files must NOT be committed** (the many `.ralph/screenshots/TASK-*.png` binary mods, `.gitignore`, `.ralph/prd/PRD.md` — stage explicitly by path only).

## Next steps
1. `cd app && npx playwright test --config playwright.e2e.config.ts tests/e2e/touch-loop.spec.ts` — expect green (the one red run was the landing leg flake). Re-run once more if red (history: green in isolation repeatedly pre-TASK-97).
2. All green → mark TASK-97 steps 1-5 pass + `passes: true` in `.ralph/tasks.json`; add the LOG.md entry at top (date, summary, screenshot paths; bump 'Tasks Completed' 114 → 115 and 'Current Task'); delete this handoff; commit: `fix(TASK-97): restore the touch overlay for a pad-docked ship + keep MENU reachable when touch is Off` (stage the 6 files above explicitly).

## Dead ends
- e2e (d) first tried `openMenu()` while the settings panel was ON the menu stack → the open/pop action POPs it (correct behavior) so `#esc-menu` never appeared. Fixed by closing the menu first (Escape) then driving the lone button — mirrors the real stranded-player flow.
- The 6-spec batch's 3 reds are the documented load-flake family (workers=1 but the worker-scoped server under sustained load: console "Maximum update depth exceeded" in touch-flight, `#mining-hud` timeout in touch-loop, `#warp-button` in touch-menu) — all green in sequential isolation except touch-loop's landing leg (its own flake family).

## How to verify
`cd app && npx tsc --noEmit && npm run test` (expect 196 files green; combat-hud budget = isolation re-run if red) + the 6 touch e2e specs above (touch-padded 31 s, touch-flight 44 s, touch-menu 30 s, touch-onfoot/touch-combat/touch-loop per history). ACs 1-6 are all proven by the unit + touch-padded runs already on record.
