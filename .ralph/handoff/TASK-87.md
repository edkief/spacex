# TASK-87 handoff (2026-10-08, iteration 6 of 100, ran out of time)

## Status
**Fix implemented and unit-verified.** The root cause (airless-planet pass-through: regime stays 'space' forever + no ground collision in space) is fixed at the shared source. Full unit suite + tsc are GREEN. The e2e spec is written and passed once (atmospheric target) but is **flaky on the canvas lower-half variance check** and has **not yet exercised the airless browser path** in a live run. Remaining: make the e2e robust (verify airless + fix the variance flake), run the full e2e set, lint/format, final commit `fix(TASK-87): ...`, close out.

## Done (this iteration — no code was shipped in the prior one)
Implemented the fix (hybrid of the handoff's options A+B, kept `integrateShip`/`regimeFor` the single shared source):

1. **`app/src/shared/galaxy/planets.ts`** — added `SurfaceDisc` interface + `surfaceDiscAt(pos, planets)`: returns the 2 km surface disc of the landable AIRLESS planet (atmosphereRadius 0) under the ship, else undefined. Shared source of the solid-surface rule (regime machine, flight model, server, client all call it → agree). Imports `Vec3` type.

2. **`app/src/shared/regime.ts`** — relaxed the TASK-25 "airless stay space" rule (line ~139, the `nearest.atmosphereRadius <= 0` branch). Now a LANDABLE airless planet yields **'surface'** when the ship is inside its 2 km disc, `alt < SURFACE_ENTER_ALT_M` (2 u), and `speed <= SURFACE_SPEED_LIMIT_M_S` (5 u/s) — resolved DIRECTLY from 'space' (airless has no atmosphere to step through). Surface hysteresis: holds while in disc + low + slow; drops to 'space' (not 'atmosphere') when leaving the disc / climbing out of the band / speeding up. Non-landable airless stays space. Updated module + `regimeFor` doc comments to document the new airless→surface path.

3. **`app/src/shared/physics/flight.ts`** — (a) `FlightOptions.surfaceDisc?: SurfaceDisc`; (b) `integrateShip` reads it and threads it into `integrateStep`; (c) ground handling rewritten: `'atmosphere'/'surface'` always clamp to terrain (unchanged), and a **'space' ship INSIDE a `surfaceDisc` also clamps to terrain (no tunnel-through)**; (d) new `SURFACE_FRICTION = 1.0` (1/s): while grounded with NO atmosphere (airless → no drag), horizontal vel decays `v *= (1 − FRICTION·h)` per substep, stopping a 120 u/s approach in ~3 s / ~115 m (inside the 2 km disc) so it can resolve 'surface'. Updated header doc.

4. **`app/src/server/shard/shard.ts`** — `resolveRegimeCtx` (line ~3908): for a 'space' entity, if `surfaceDiscAt` matches a landable airless planet, wire that planet's terrain (`heightAt` via `padSurfaceHeight`+`TerrainContext`, `pads`, `surfaceDisc`) with `planet: undefined` (airless → no drag). Imports `surfaceDiscAt`. Non-space path unchanged.

5. **`app/src/client/net/prediction.ts`** — `optionsAt` now also sets `surfaceDisc: surfaceDiscAt(pos, ctx.regimePlanets)` at the CURRENT predicted position (same as the server tick's `cruiseAllowed`), so the client predictor clamps+friction-grounds airless space ships identically. Imports `surfaceDiscAt`. `regime-wiring.ts` `planetAtmo` stays undefined for airless (no drag) — correct, no change needed.

**Tests:**
- `app/src/shared/regime.test.ts` — rewrote the "airless never yield surface" test (now: airless never yields ATMOSPHERE) + added a new "TASK-87: LANDABLE airless yields surface on its solid disc" test (surface from space, hysteresis, fast-flyby stays space, outside-disc stays space, non-landable stays space).
- `app/src/shared/planet-approach.test.ts` — added an `AIRLESS planet` describe block (3 tests): 120 u/s approach → `space → surface` + no tunnel + ends slow; 480 u/s approach → same; friction stops it fully. These **FAIL pre-fix** (verified by `git stash`ing the 5 source files → 3 airless tests fail, 5 atmospheric pass) and PASS post-fix.
- **Full unit suite GREEN**: `npm run test` = 191 files, 1757 passed / 1 skipped. **`npx tsc --noEmit` GREEN.** (One run of `tests/abuse/abuse.spec.ts` timed out under full parallel load, passed in isolation and on full-suite re-run — pre-existing flake, not caused by this change.)

**E2E:**
- Deleted `app/tests/e2e/t87-repro.spec.ts` (the diagnostic).
- New `app/tests/e2e/planet-approach.spec.ts`: claims a fresh player, deterministically picks the home system's nearest landable planet (AIRLESS when present = the bug case, else atmospheric), teleports to ground level outside it, `faceAnchor` closed-loop aim, holds W+Shift, taps wire `flightRegime`. Asserts: sequence reaches 'surface' (`space→surface` for airless, `space→atmosphere→surface` for atmospheric, never 'atmosphere' for airless); wire `minY ≥ -5` (never below surface); ship ends inside the 2 km disc (no tunnel); streamed terrain mounts ≥ 9 chunks for the target planet; canvas lower-half variance > 1; screenshot `.ralph/screenshots/TASK-87-1.png`.
- **Result: passed once** (atmospheric, `space→atmosphere→surface`, terrain 35 chunks, variance 4.4, screenshot saved). **Flaky on 2 subsequent runs**: failed at the canvas lower-half variance check (`Received: 0.0175, Expected: > 1`) even though the terrain-mount probe passed (scene graph had ≥9 chunks, correct planetId). The ship lands at altitude ~200-246 u (the terrain UNDER it is hilly/elevated, so altitude ≈ 2 u → 'surface' is correct) ~800-1000 u from the anchor, so the chase camera's ground framing / SwiftShader render timing makes the lower-half variance flaky.

## Working tree
**Not committed (this handoff commits them):**
- `app/src/shared/galaxy/planets.ts` (M — `surfaceDiscAt` + `SurfaceDisc`)
- `app/src/shared/regime.ts` (M — airless→surface rule)
- `app/src/shared/physics/flight.ts` (M — `surfaceDisc` option + `SURFACE_FRICTION` + space ground-clamp)
- `app/src/server/shard/shard.ts` (M — `resolveRegimeCtx` airless terrain wiring)
- `app/src/client/net/prediction.ts` (M — `optionsAt` `surfaceDisc`)
- `app/src/shared/regime.test.ts` (M), `app/src/shared/planet-approach.test.ts` (M)
- `app/tests/e2e/planet-approach.spec.ts` (new), `app/tests/e2e/t87-repro.spec.ts` (DELETED)
- `.ralph/handoff/TASK-87.md` (this file, overwritten)

Builds: tsc GREEN, unit suite GREEN. `app/test-results/` deleted (not gitignored). Pre-existing dirty files NOT mine — do NOT commit: `.gitignore`, `.ralph/decisions.jsonl`, `ralph.config.json`, `.gitattributes`, `.ralph/ESCALATION.md`, `.ralph/logs/t761/`, `.ralph/logs/t83/`, `.ralph/tasks/TASK-87.json`, `.ralph/tasks/TASK-88.json`, `app/.ralph/`, and all pre-existing `.ralph/screenshots/*.png` mods.

## Next steps
1. **Make the e2e robust.** The terrain-mount probe (scene graph) is reliable; the canvas lower-half variance check is the flake. Fix by one of: (a) poll the lower-half variance over a few seconds (it was 4.4 when it passed, 0.017 when it failed) with `expect.poll` and a few-frame settle; (b) after landing, do a short VTOL hover / small forward nudge so the chase camera has ground in the lower half before sampling; (c) sample the full canvas or a region more likely to contain terrain. Keep the ≥9-chunk terrain-mount assert (it is the authoritative "terrain mounted" signal) — the variance check only needs to prove pixels are on screen.
2. **Exercise the AIRLESS browser path.** 3/3 live runs so far picked an atmospheric planet at the nearest-landable index (home systems `05b6ba27...`, `57935f8d...`, `30d9583e...`). The airless branch is unit-verified but not e2e-verified. To force it: either keep re-running until a home system's nearest landable planet is airless (~26% of systems per the prior sim), or add a deterministic airless target (e.g. warp to a known system with an airless planet at a low anchor index, the landing.spec.ts raw-WS warp pattern), or temporarily prefer airless in the idx pick. Confirm the wire sequence is `space → surface` (no 'atmosphere') and it lands inside the disc.
3. **Step 4 of the spec:** `cd app && npx tsc --noEmit` (already green); full `npm run test` (already green); e2e set: `npx playwright test --config playwright.e2e.config.ts tests/e2e/planet-approach.spec.ts tests/e2e/atmosphere.spec.ts tests/e2e/atmosphere-view.spec.ts tests/e2e/terrain-live.spec.ts tests/e2e/deep-space.spec.ts tests/e2e/cruise.spec.ts tests/e2e/flight.spec.ts`; then `npx eslint --fix` + `npx prettier --write` on the touched files.
4. **Close out:** commit `fix(TASK-87): land on airless planets — solid surface disc (regime space→surface) + space ground-collision + friction, shared by server+client`; set the 4 step `pass` flags true in `.ralph/tasks/TASK-87.json`; set `"passes": true` for TASK-87 in `.ralph/tasks.json`; add the LOG.md entry at the top (date, summary, screenshot `.ralph/screenshots/TASK-87-1.png`); delete this handoff.

## Dead ends
- The atmospheric-planet approach is NOT the bug (3/3 landed) — the owner's tunnel is the AIRLESS case (confirmed by prior-iteration sim + this iteration's pre-fix failing unit tests).
- e2e lower-half variance flake is a RENDERING/CAMERA-timing artifact, not a regime/physics bug: the ship genuinely lands in 'surface' (wire-confirmed, correct planet, terrain mounted in scene graph). Do NOT chase it by changing physics — fix the e2e sampling/aiming.
- Do NOT gate on the raw `minY ≥ 0` — the terrain is hilly (a 'surface' ship can sit at world-y ~200+ because the ground under it is elevated ~200), so assert `minY ≥ -5` (never BELOW the flat y=0 reference / island slab top at -2), which is the no-tunnel guarantee.

## How to verify
- Unit (fast, definitive for the fix): `cd app && npx vitest run src/shared/planet-approach.test.ts src/shared/regime.test.ts` (planet-approach = 8 tests incl. 3 airless; regime = 20). Full: `npm run test`.
- Pre-fix proof the test encodes the bug: `git stash push src/shared/galaxy/planets.ts src/shared/regime.ts src/shared/physics/flight.ts src/server/shard/shard.ts src/client/net/prediction.ts` then `npx vitest run src/shared/planet-approach.test.ts` → 3 airless tests FAIL; `git stash pop` → all pass.
- E2E: `cd app && npx playwright test --config playwright.e2e.config.ts tests/e2e/planet-approach.spec.ts` (boots its own server; logs `[TASK-87] ... flightRegime=... minDist=... minY=... last=...`; ~40 s). Screenshot lands at `.ralph/screenshots/TASK-87-1.png`.
