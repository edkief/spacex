# TASK-85 handoff — space cruise boost (Shift)

## Status
Steps 1–3 (shared physics + protocol + server + client + unit tests) are complete and committed (`12afe3d` + this WIP commit). Only step 4 remains: the e2e spec `app/tests/e2e/cruise.spec.ts` is written but **never got a passing run** (first run failed on a page-context ReferenceError, now fixed; re-run not yet done), the regression e2e set, the full unit suite, and the LOG/STRUCTURE/close-out bookkeeping are pending.

## Done
- **Step 1 (shared rule + physics, committed 12afe3d):**
  - `app/src/shared/physics/flight.ts` — `ShipInput.boost?: number` (default 0, clamped to [0,1]), `FlightOptions.cruiseAllowed?: boolean` (default false), `CRUISE_SPEED_FACTOR = 4`, `CRUISE_ACCEL_FACTOR = 2`. `integrateShip` computes the effective `maxVelocity`/`acceleration` once per tick (`cruising = regime === 'space' && boost > 0 && options?.cruiseAllowed === true`) and passes them into `integrateStep` (which now takes both as params — signature changed, call site is the only caller). The TASK-81 thrust clamp AND the per-tick soft cap use the EFFECTIVE max, so release bleeds off at 5 %/tick.
  - `app/src/shared/regime.ts` — `CRUISE_CLEARANCE_M = 1_500` + `cruiseAllowedAt(pos, planets): boolean` (3D distance ≥ atmosphereRadius + 1500 for EVERY planet; airless planets count at `ATMOSPHERE_BOUNDARY_M` = 1000).
  - Tests (all green): `flight.test.ts` new `space cruise boost (TASK-85)` describe (5 tests: 480 cap ±1e-9 + accel×2 check, effective-cap steering clamp, cruiseAllowed-false/atmosphere → 120, monotonic release 480→≤121 in 6 s, boost=0 bit-identical to no channel). `regime.test.ts` new `cruiseAllowedAt` describe (4 tests incl. false@2400/true@2600).
- **Step 2 (protocol + server, committed 12afe3d):**
  - `app/src/shared/protocol/inputs.ts` — `action` string now '+'-joined: `inputToShipInput` maps tags 'vtol'→up, 'boost'→boost (combined 'vtol+boost' carries both); `shipInputToPayload` inverse ('vtol' wins = listed first). `inputToCharacterInput` untouched ('run' still 'run').
  - `app/src/server/shard/shard.ts` — `resolveRegimeCtx` now passes `cruiseAllowed: cruiseAllowedAt(entity.ship.pos, this.regimePlanets)` in options for BOTH the space (empty) and atmosphere branches. AI ships (`stepAiShips`) integrate without options → never boost (unchanged).
  - `app/src/server/shard/shard.cruise.test.ts` (new) — 3 tests: deep-space boost > 120 within 5 s via the real SimLoop (`enqueueInput` + `sim.step`, same pattern as `shard.regime.test.ts`); near-planet (2 km out, 8000,300,0) stays ≤ 121; no-options integrateShip path (AI style) with boost demand stays ≤ 120.
- **Step 3 (client, committed 12afe3d):**
  - `app/src/client/input/controls.ts` — `ControlScheme.boost: Key | null` ('Shift' in space, null in atmosphere/surface), set in `readInput`. `flight-loop.ts` `shipInputKey` includes boost (key-change send cadence).
  - `app/src/client/net/prediction.ts` — `PredictionContext.regimePlanets?: RegimePlanet[]`; new `optionsAt(ctx, pos)` resolves `cruiseAllowedAt` at the CURRENT state position on every integrate call (used in `step`, `replay`, `replayOnServerTimeline`); `inputFinite` includes boost.
  - `app/src/client/state/regime-wiring.ts` — new `get regimePlanets()` (mirrors what `setSystem` hands the tracker; field `regimePlanetList`).
  - `app/src/client/state/cruise.ts` (new) — emit-on-change store: `setCruiseState({held, allowed})` / `cruiseState` / `cruiseStateSubscribe` / `__resetCruiseState`.
  - `app/src/client/main.tsx` — predictor constructed/updated with `regimePlanets: regimeWiring.regimePlanets`; flight loop adds boost to the `nonzero` check and calls `setCruiseState({held, allowed: cruiseAllowedAt(p.getState().pos, regimeWiring.regimePlanets)})` each frame. `scaleLookDemand` spreads → boost untouched (verified).
  - `app/src/client/ui/ship-hud/ship-hud.tsx` — `CruiseTag` component (`#ship-hud-cruise`, role=status): 'CRUISE' bright #67e8f9 when held+allowed, dimmed 0.65 'CRUISE BLOCKED' #f59e0b when held+not-allowed, hidden when not held.
  - Tests: `controls.test.ts` (Shift scheme + readInput cases), `prediction.test.ts` (3 cruise tests: >120 in 5 s deep space, ≤120 in band, excess decays in band), `ship-hud.test.tsx` (4 cruise tag tests), `inputs.test.ts` (round-trip cases extended with boost + 'vtol+boost').
- **Verification done this session:** `npx tsc --noEmit` clean (after the checkpoint commit); 8 touched unit suites green (127 tests); eslint --fix + prettier --write applied to all touched files (flight.test.ts got an added `CRUISE_ACCEL` usage to satisfy no-unused-vars — green).

## Working tree
- Committed: `12afe3d feat(TASK-85): ... (steps 1-3)` — all of the above EXCEPT:
  - uncommitted (this WIP commit): prettier/eslint touch-ups on `flight.ts`, `prediction.ts`, `prediction.test.ts`, `inputs.test.ts`, `shard.cruise.test.ts`, `flight.test.ts` (+ the CRUISE_ACCEL accel test)
  - untracked: `app/tests/e2e/cruise.spec.ts` (the e2e for step 4)
- Pre-existing dirty, NOT this task's: ~45 modified `.ralph/screenshots/*.png` and `ralph.config.json` — do NOT commit those (task note). Untracked `.ralph/logs/t761/`, `.ralph/logs/t83/` are leftovers from earlier tasks.
- Builds: tsc clean, unit suites for all touched files green. Full `npm run test` NOT yet re-run this session (golden flight fixtures are expected unchanged — the boost=0 bit-identity unit test guards this, and `flight-space-60s.json` replay passes).

## Next steps
1. **Run the e2e** (the main remaining work): `cd app && npx playwright test tests/e2e/cruise.spec.ts --config playwright.e2e.config.ts --workers=1 --retries=0`. NOTE: it uses `playwright.e2e.config.ts` (the bare `playwright.config.ts` ignores `tests/e2e/**` — "No tests found").
   - First run failed fast on `ReferenceError: quatForward is not defined` (page-context evaluate can't see module helpers) — fixed by inlining the quat math in `yawError`. **While fixing, I briefly dropped the `w·y` term from the inlined nose math and then restored it** — re-check `yawError`'s inline formula: `nose = { x: 2*(x*z + w*y), z: 1 - 2*(x*x + y*y) }`.
   - Likely flake risks to watch on the re-run (in order of suspicion):
     a. `faceAnchor` closed-loop steering: one axis at a time, press = |err|/0.8 rad/s + 120 ms overshoot, 15 s deadline. If it overshoots into a limit cycle, raise the deadline or reduce the +120 ms.
     b. The > 300 poll: server speed needs ~7.5 s to get there (80 u/s² → 300), so it should pass with margin before the 8 s window ends; if the ship entered the atmosphere early (bad aim, planet 0 has atmosphere) speed caps at 120 and the poll times out — check `lastSpeed` values in the failure output.
     c. Section (3) near-planet run: `nearTop` walks the tap backward from the end and breaks when pos is > 900 u from NEAR — the teleport zeroes vel, so the pre-teleport cruise-speed updates must be behind that cutoff; at 480 u/s the ship covers 900 u in 1.9 s, i.e. the last ~2 s of updates before teleport are within 900 u and could leak the pre-teleport speed. If `nearTop` reads > 121 spuriously, tighten the break distance to ~400 u.
     d. Section (4) leg-time poll uses the RENDERED `__SELF_SHIP__.probe().pos` (prediction) — 45 s deadline; expect the measured leg ≈ 22–25 s (10 770 u − 2 500 u at up to 480 u/s, minus the initial 0→480 ramp). Record the printed `[TASK-85] ... measured leg ...` line in the LOG entry.
   - Screenshot `TASK-85-1.png` is written mid-cruise (verify it shows ship + HUD; planet proxy may be tiny/absent at 4 km+ depending on aim — TASK-83 proxies only render within CAMERA_FAR = 4000).
2. **Regression e2e set** (spec list): `cruise, flight, chase-camera, rogue-ai, pvp-kill, landing, keyboard-only, walk` — run with `--config playwright.e2e.config.ts --workers=1 --retries=0`, sequentially. `keyboard-only`/`walk` confirm Shift still = run on foot (the on-foot loop in main.tsx reads `pressed.has('Shift')` directly, unchanged).
3. **Full checks:** `cd app && npx tsc --noEmit`; full `npm run test` (expect ~182 files green, golden flight fixtures unchanged — if `flight-space-60s.json` replay fails, the default path broke); `eslint --fix` + `prettier --write` on anything newly touched.
4. **Close out:** set the 4 step `pass` flags + `"passes": true` for TASK-85 in `.ralph/tasks.json`; LOG.md entry (newest on top, include the measured leg time, note follow-ups: combat lockout, cruise FX, autopilot — do NOT build them); delete this handoff; commit `feat(TASK-85): ...`; output the promise.

## Dead ends
- `npx playwright test tests/e2e/cruise.spec.ts` (no `--config playwright.e2e.config.ts`) → "No tests found" (main config testIgnores `tests/e2e/**`). Use the e2e config.
- happy-dom `el.querySelector(...).style` is typed `Element` without `.style` → cast to `HTMLElement | null` in `ship-hud.test.tsx` (done).
- `tsc` initially flagged: duplicate `regimePlanets` identifier in `RegimeWiring` (field renamed to `regimePlanetList`), possibly-undefined `boost` (use `?? 0` / local `const boost`), `ShipState` widening in `shard.cruise.test.ts` (annotate `let s: ShipState`) — all fixed, tsc clean at checkpoint.

## How to verify
- Unit (fast, ~2 s): `cd app && npx vitest run src/shared/physics/flight.test.ts src/shared/regime.test.ts src/shared/protocol/inputs.test.ts src/server/shard/shard.cruise.test.ts src/client/input/controls.test.ts src/client/net/prediction.test.ts src/client/state/regime-wiring.test.ts src/client/ui/ship-hud/ship-hud.test.tsx` → 8 files green.
- Types: `cd app && npx tsc --noEmit` → clean.
- E2E (the step-4 gate): `cd app && npx playwright test tests/e2e/cruise.spec.ts --config playwright.e2e.config.ts --workers=1 --retries=0` → 1 passed; console prints cruise-top / post-release / near-planet / measured leg numbers.
- Full: `cd app && npm run test` (all green, golden fixtures unchanged) + the 8-spec regression set above.
