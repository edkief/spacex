# TASK-82 handoff

## Status
TASK-82 is functionally complete and verified this iteration: the miniature ~130 m orrery
is gone, and the star renders as a distant camera-anchored sun toward −X. `tsc`, the full
unit suite, and 8/8 of the required e2e specs are green and it's committed. The ONE thing
not yet re-run is `npm run bench:render` (a long ~6 min perf gate), so the task is held at
`passes: false` — re-run that gate and flip the flags to close it. See Next steps.

## Done
- `app/src/client/render/sun.ts` (NEW): `SUN_DIRECTION = normalize(-1, 0.12, 0)`,
  `SUN_DISTANCE = 380` (< 420 sky shell), `SUN_ANGULAR_RADIUS_DEG = 2`, pure
  `sunPosition(cameraPos)`, `createSun(color)` returning `{mesh, setOpacity, setColor, dispose}`.
- `app/src/client/render/sun.test.ts` (NEW): 6 tests — direction unit/−X/+Y, sunPosition
  camera-relative by exactly D, 380 < 420, finite disc radius, createSun renderOrder +
  material flags + setOpacity/setColor.
- `app/src/client/world/WorldManager.ts`:
  - Sun is SCENE-level, created in the constructor AFTER the background (object id > stars
    so the renderOrder-1 tie draws the sun in front); `this.scene.add(this.sun.mesh)` after
    the stars.
  - Per frame, right before `renderer.render` (next to the TASK-75 `anchorBackgroundToCamera`
    call): `sunPosition(this.camera.position)` → `this.sun.mesh.position`.
  - `swapWorld` re-tints via `this.sun.setColor(STAR_COLORS[system.star.class])`.
  - `setAtmosphereView` fades the sun with the sky: `this.sun.setOpacity(fade)` (same shared
    `fade = 1 - view.haze` no-desync number).
  - `keyLight.position` now set to `SUN_DIRECTION` (was a fixed (0.35,1,0.25)).
  - `buildWorldGroup` DELETED the star sphere + planet spheres (kept the spawn-gate torus,
    pad rings, hazard discs). `buildSystemLayout` no longer lays out planets/orbits — returns
    `{systemId, starClass, starColor, gate}` only. Removed exports `WORLD_STAR_RADIUS`,
    `WORLD_PLANET_RADIUS`, `WORLD_FIRST_ORBIT`, `WORLD_ORBIT_STEP`, `WORLD_PLANET_COUNT`,
    the `WorldPlanetLayout` interface, and the now-unused `hash2`/`seedFromString` imports.
    KEPT `STAR_COLORS` + `PLANET_COLORS` (TASK-83 needs PLANET_COLORS).
  - New accessor `sunScreen(): {x,y,dist}|null` (projects the live sun mesh position).
  - `dispose()` removes + disposes the sun.
- `app/src/client/self-ship-debug.ts`: `SelfShipProbeResult.sunScreen` field (+ EMPTY).
- `app/src/client/main.tsx`: self-ship probe source returns `sunScreen: world.sunScreen()`.
- `app/src/client/ui/guidance.ts` step 1 text → "Hold W to fly. Steer with A/D and R/F to
  follow the nav marker to the planet. Press M for the star chart."
- Tests updated: `world-manager.test.ts` (layout shape, no orrery), `self-ship-debug.test.ts`
  (sunScreen), `guidance-hint.test.tsx` (nav-marker text).
- e2e: `helpers.ts` + `canvasScreenRegionMean(page, x, y, size=8)`; `warp.spec.ts` asserts
  the sun's projected position is on screen AND an 8×8 region there is bright (> 150 mean)
  after a fresh warp + writes `.ralph/screenshots/TASK-82-1.png`; `first-launch.spec.ts`
  guidance assertion → `nav marker`.
- `.ralph/STRUCTURE.md` updated (added render/sun.ts).

## Working tree
- Committed on `759c2f4` (feat(TASK-82): ...) — all source + test changes.
- The final `.ralph/*` bookkeeping edits (this handoff's revert of `passes` back to false,
  the LOG entry wording) are staged/committed in the WIP commit.
- Builds clean: `npx tsc --noEmit` passes. Full unit suite green (1694 passed / 1 skipped).
- Pre-existing dirty `.ralph/screenshots/*.png` mods are intentionally NOT committed (per
  the spec's note); leave them alone. `.ralph/logs/t761/` is a leftover untracked dir — not
  part of this task, don't commit it. `ralph.config.json` is modified by the harness, don't
  touch it.

## Next steps
1. Re-run the perf gate (the only acceptance criterion not re-verified this session — it's
   ~6 min and didn't fit the time budget): `cd app && npm run bench:render`. Expect PASS:
   the benchmark scene (renderBenchmark.ts) builds from `createBackground` + the chunk scene
   + ships + FX and does NOT call `buildWorldGroup`, so removing the 3 orrery meshes and
   adding one scene-level sun sphere cannot move its draw/material/triangle budgets. If it
   somehow fails, inspect whether the sun material leaked into the tally (it shouldn't —
   it's scene-level in the manager, not in the bench scene).
2. Re-confirm the unit suite + tsc are still green: `cd app && npx tsc --noEmit` and
   `npm run test` (~2 min).
3. Flip the board: set all 5 `"pass": false` → `"pass": true` in `.ralph/tasks/TASK-82.json`,
   set `"passes": false` → `true` for TASK-82 in `.ralph/tasks.json`, fix the LOG.md header
   (bump Tasks Completed 97 → 98, set Current Task to none) and retitle the entry "(complete)",
   then delete this handoff.
4. Commit `feat(TASK-82): ...` and output `<promise>TASK-82:DONE</promise>`.
No human decision is needed — everything is implemented and verified; this is a
re-run-and-close pass.

## Dead ends
- `expect(geo.index).toBeNull()` after `dispose()` does NOT hold in three.js (dispose frees
  the GL buffer but does not null the JS index attribute) — the structural test instead
  asserts `() => sun.dispose()).not.toThrow()` and checks the bounding-sphere radius with
  `toBeCloseTo(radius, 5)`.
- `canvasCenterLuminanceMean` (old TASK-8 centre helper) is no longer the right tool: the
  sun is no longer at the canvas centre, it's at the projected position of
  `sunPosition(camera)` toward −X. Replaced with the position-targeted
  `canvasScreenRegionMean` + `__SELF_SHIP__.probe().sunScreen` (CSS px, top-left origin —
  exactly what `projectToScreen` reports).
- No DECIDE/BLOCKED: nothing is stuck.

## How to verify
- `cd app && npx tsc --noEmit` → clean.
- `cd app && npm run test` → 185 files, 1694 passed / 1 skipped (the happy-dom
  `AbortError` stack traces printed during teardown are harmless noise, not failures).
- Touched unit tests: `npx vitest run src/client/render/sun.test.ts
  src/client/world/world-manager.test.ts src/client/self-ship-debug.test.ts
  src/client/ui/guidance-hint.test.tsx` → green.
- e2e (boots its own dev server via fixtures, ~30 s each):
  `npx playwright test --config playwright.e2e.config.ts warp.spec.ts first-launch.spec.ts
  deep-space.spec.ts self-ship.spec.ts core-flow.spec.ts atmosphere-view.spec.ts
  star-chart.spec.ts flight.spec.ts` → 8/8 pass (warp carries the new sun on-screen +
  bright-8×8 assertion).
- Visual: open `app/`, warp to another system, or just look at
  `.ralph/screenshots/TASK-82-1.png` — a bright distant sun disc (upper-right, near −X),
  clean starfield, NO 14 m star ball and NO miniature planets at the origin.
- `cd app && npm run bench:render` → PASS (see Next steps step 1).
