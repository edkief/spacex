# TASK-51 Handoff — Ship HUD: nav, velocity, regime, cargo, weapons

## Status
Implementation is COMPLETE and unit-green + tsc-clean + eslint-clean. The full e2e spec
(`tests/e2e/ship-hud.spec.ts`) already passed (1 passed, 7.2 s) with both regime screenshots
produced. What remains is bookkeeping close-out only (run the full unit suite once, mark the
task done, log + structure + commit). It fits comfortably in one iteration.

## Done
All 4 spec steps are implemented and tested:

- **Step 1 — Readouts.** `app/src/client/ui/ship-hud/ship-hud.tsx` — `ShipHud` assembles the
  bottom-left instrument block (`#ship-hud-block`): `#ship-hud-speed` (m/s, 1 decimal + a small
  circular thrust-direction vector bar), `#ship-hud-altitude` (regime-aware: `ALT <n> m` in
  atmosphere/surface, `—` in space), `#ship-hud-regime` tag (SPACE/ATMOS/SURFACE), the nav
  readout, and `#ship-hud-docked` (green `DOCKED · <STATION>` when on a pad). All 10 Hz, from the
  `selfShipView` store.
- **Step 2 — Nav readout.** `app/src/client/ui/ship-hud/nav-readout.tsx` — `NavReadout` shows the
  chart selection first (interstellar: `→ <NAME> · WARP`) else the implicit dock target (nearest
  station pad). Bearing math is pure in `nav-math.ts` (`bearingTo` = 3D relative vector rotated by
  ship yaw; `thrustYawDeg`; `elevLiftPx` for the above/below component). The chevron is a
  CSS-rotated `▲` driven by an rAF loop writing a ref'd `style.transform` (no React re-render) —
  the ONLY per-frame HUD work. Distance text is a ref'd `textContent` write.
- **Step 3 — Hull/shield bar.** `vitals-bar.tsx` — `VitalsBar` (top-left under chat, 200 px slot):
  shield (blue) over hull (amber), numeric % always shown, red flash = `data-hit` toggle for
  `HIT_FLASH_MS` (300 ms) after a self-targeted `hit`/`destroyed` combat_event.
- **Supporting stores.** `state/ship-hud.ts` (self-ship view + hit flash, emit-on-change +
  `hitFlashActive`), `state/chart-target.ts` (chart selection bridge). `ui/ship-hud/layout.ts`
  (slot geometry, shared with the combat-HUD `protectedRects`).
- **Wiring.** `main.tsx`: entity_update sets `setSelfShipView(...)` (null on foot / new system);
  combat_event routes self-targeted hits to `flashHullHit`; `ShipHud` rendered; `nearestDockTarget`
  / `stationNameFor` / `shipNavSample` callbacks derive from the world's pads + the live
  `ClientShipPredictor` pose. `star-chart.tsx` now calls `setChartTarget` on selection (clears on
  close).
- **Tests.** `nav-math.test.ts` (14 tests: speed/altitude/regime/distance formatting, 3D bearing →
  screen arrow incl. elevation + degenerate cases, thrust yaw, lift clamp). `state/ship-hud.test.ts`
  (store emit-on-change + 300 ms flash window). `ship-hud.test.tsx` (13 live-render tests: readouts,
  regime switch, docked tag, nav, vitals flash, layout disjointness vs protected rects). e2e
  `tests/e2e/ship-hud.spec.ts` — teleports to atmosphere (600 m) / space (3000 m) / docked and
  screenshots `.ralph/screenshots/TASK-51-1.png` + `TASK-51-2.png` (regime tag differs).

## Working tree
All of the above is UNCOMMITTED (working tree dirty) but fully green:
`tsc --noEmit` clean, `eslint` clean on all touched files, 30/30 ship-HUD unit tests pass, and the
e2e spec passed this session. Nothing else was modified. `passes: false` still in `tasks.json`;
the 4 step `pass` flags in `TASK-51.json` are still `false`.

## Next steps
1. Run the full unit suite once to confirm no cross-task regressions: `cd app && npm run test`.
   (Ship-HUD subset already verified green: 30/30. `tsc --noEmit` already verified clean.)
2. Mark the 4 step `pass` flags `true` in `.ralph/tasks/TASK-51.json`.
3. Set `"passes": true` for TASK-51 in `.ralph/tasks.json`.
4. Add a LOG.md entry at the top (date, summary, screenshot paths `TASK-51-1.png`/`TASK-51-2.png`)
   and bump the 'Tasks Completed' counter.
5. Update `.ralph/STRUCTURE.md` — new dirs/files: `app/src/client/ui/ship-hud/` (ship-hud.tsx,
   nav-readout.tsx, nav-math.ts, vitals-bar.tsx, layout.ts + tests) and `app/src/client/state/`
   gains `ship-hud.ts`, `chart-target.ts`. Follow the existing comment style (TASK-51: …).
6. Commit (Conventional Commit, e.g. `feat(TASK-51): flight HUD — speed/alt/regime nav readout,
   vitals bar, docked tag`). Delete this handoff. Output the promise.

## Dead ends
- **happy-dom `requestAnimationFrame` + fake timers**: `vi.useFakeTimers()` did not advance the
  rAF-driven chevron, so I dropped fake timers and let rAF run in real time via
  `act(async () => { await new Promise(r => setTimeout(r, ms)) })` (see `rafTick` in
  `ship-hud.test.tsx`). Works fine.
- **Flash-clear "negative window" bug (caught + fixed)**: `hitFlashActive()` originally read
  `lastHitAtMs > 0 && atMs - lastHitAtMs < HIT_FLASH_MS`; when the vitals bar reset `hitAt=0` after
  the clear timeout, `Date.now() - lastHitAtMs < 300` was still momentarily true and `data-hit`
  stayed `1`. Fixed by (a) adding `atMs >= lastHitAtMs` to `hitFlashActive`, and (b) making
  `VitalsBar` compute `flashing = hitFlashActive()` (fresh `Date.now()`) instead of keying off the
  stale `hitAt` state. A debug test confirmed the 300 ms window now closes.
- **Quaternion convention for tests**: the ship nose is quat-rotated **+Z** (the flight model's
  thrust axis, `shared/physics/flight` FORWARD), NOT the camera's -Z. Yaw +90° about Y puts the
  nose on +X; a target behind reads ~+90° (not −90°). Straight-up (`+Y`) is the degenerate
  zero-horizontal branch (yaw clamped to 0, `elevRad = atan2(1000, 1e-6)`).

## How to verify
- Unit: `cd app && npx vitest run src/client/ui/ship-hud src/client/state/ship-hud.test.ts` → 30/30.
- Types: `cd app && npx tsc --noEmit` → clean.
- E2E: `cd app && npx playwright test --config playwright.e2e.config.ts tests/e2e/ship-hud.spec.ts`
  → 1 passed (verified green, 7.2 s; screenshots at
  `.ralph/screenshots/TASK-51-1.png` [ATMOS] and `TASK-51-2.png` [SPACE, altitude '—']).
- Full suite for final close-out: `cd app && npm run test`.
