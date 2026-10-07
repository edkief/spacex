# TASK-83 handoff — True-scale system view (2/4): planets rendered at their sim anchors

## Status
All code (steps 1–4 of the spec) is implemented and unit-tested; `npx tsc --noEmit` is green.
The only remaining red is the NEW e2e spec `app/tests/e2e/planets-visible.spec.ts`, which fails on a
known race in the "hold D until the anchor is in the viewport" step (details in Dead ends + Next
steps). Steps 1–4 of `.ralph/tasks/TASK-83.json` can be flipped to `pass: true` after a final
re-verification pass; step 5 (e2e + screenshots + verify + commit) is what remains.

## Done
- **Step 1 — shared surface-extent constant.** `app/src/shared/galaxy/planets.ts` now exports
  `PLANET_SURFACE_RADIUS_M = 2_000` (block comment: radius holding a planet's surface content;
  client renders the island to it, TASK-84 streams terrain within it).
  `DEPOSIT_SCATTER_RADIUS_M` (deposits.ts, now `export`) and `HAZARD_SCATTER_RADIUS_M`
  (hazards.ts) both reference it — values unchanged (2000). New unit test in
  `app/src/shared/galaxy/planets.test.ts` asserts both equal the constant.
- **Step 2 — pure scaled-proxy math.** New `app/src/client/render/scaled-proxy.ts`:
  `PROXY_START_M = 3_000`, `PROXY_DISTANCE_M = 3_000` (both < CAMERA_FAR = 4000, commented why),
  pure `proxyTransform(cameraPos, worldPos): { pos, scale }` — identity inside the threshold,
  beyond it `pos = cameraPos + dir × PROXY_DISTANCE_M`, `scale = PROXY_DISTANCE_M / distance`.
  Full unit test `scaled-proxy.test.ts` (identity, continuity at threshold, angular size +
  direction preserved, far-from-origin camera case).
- **Step 3 — island + dome meshes.** New `app/src/client/world/planet-bodies.ts` (185 lines):
  `buildPlanetBodies(system)` → one `PlanetBody` per planet: group at `planetAnchor(index)` (y=0),
  (a) island slab `CylinderGeometry(PLANET_SURFACE_RADIUS_M, ×0.9, 300, 48)` top at y = −2,
  MeshBasicMaterial `PLANET_COLORS[planet.class]` (palette MOVED here from WorldManager.ts, which
  re-exports it), (b) for `hasAtmosphere` an outside hemisphere shell
  `SphereGeometry(ATMOSPHERE_BOUNDARY_M × DOME_RADIUS_FACTOR, 32, 16, 0, 2π, 0, π/2)`, FrontSide,
  transparent opacity 0.35, depthWrite false, `ATMOSPHERE_HAZE_COLORS[planet.class]`.
  Plus `updatePlanetBodies(bodies, cameraPos)` (per-frame proxy re-anchor),
  `setPlanetShellHidden(bodies, planetId)` (hides only the named planet's shell; null = all shown),
  `disposePlanetBodies`. Unit test `planet-bodies.test.ts` uses a deterministic fixture seed
  `TEST-SEED-83` (first star with a multi-planet atmo system): bodies count = planets.length,
  shells only on atmospheric planets (geometry radius asserted), slab sizing/top at −2, proxy
  positions/scale for a near (800 m) and far (45 000 m) camera, shell-hide rules.
- **Step 4 — WorldManager wiring.** `app/src/client/world/WorldManager.ts`:
  - `planetBodies` field; `swapWorld` builds them and adds the groups to the per-system world
    group (they die with it — `disposeGroup` already traverses and disposes their geometry/materials;
    `dispose()` just clears the ref).
  - Frame loop: `updatePlanetBodies(this.planetBodies, this.camera.position)` every frame,
    right after the TASK-82 sun re-centre, before `renderer.render`.
  - `setAtmosphereView` calls `setPlanetShellHidden(this.planetBodies, view.planet?.id ?? null)` —
    the outer shell of the planet the camera is inside is hidden (inside BackSide haze dome stays
    unchanged).
  - New `planetsView()` dev-probe method: per planet { planetId, anchor, distance (true
    camera→anchor), scale (group.scale.x), screen (projectToScreen of the ANCHOR — exact for
    proxies since they sit on the camera→anchor ray) }.
  - New `app/src/client/planets-debug.ts` (`window.__PLANETS__.probe()`, DEV-only, follows the
    `self-ship-debug.ts` install/bind-lazily pattern) wired in `app/src/client/main.tsx`
    (install at module scope, `bindPlanetsDebug(planetsDebug, () => worldRef.current?.planetsView() ?? null)`
    next to the `bindSelfShipDebug` block).
- **Step 5 (partial) — e2e spec written.** `app/tests/e2e/planets-visible.spec.ts`: joins the
  FIXED system `7df0ed2af70ae07a` (first star of the default seed `DRIFT-SEED-0001`; planet 0 is
  terran WITH atmosphere → dome guaranteed in the screenshot; verified via a quick tsx script).
  Flow: claim → chase-carm poll → tap W (undock) → `POST /api/dev/teleport` to
  `{x: 4000, y: 400, z: 0}` (6 km short of anchor0 = (10 000, 0, 0)) → hold D until
  `__PLANETS__.probe()[0].screen` is inside the viewport → assert 12×12 region around that point
  differs from the TOP_BAND sky mean by > 10 (`canvasScreenRegionMean` + `canvasRegionStats` from
  helpers.ts) → screenshot TASK-83-1 → teleport to `{x: 8500, y: 400, z: 0}` (1 500 m from anchor)
  → screenshot TASK-83-2.

## Working tree
NOT committed — all of the above is uncommitted in the working tree (commit it as the next
iteration's first checkpoint if convenient). Untracked: the 5 new files above + this handoff.
`npx tsc --noEmit` GREEN (verified twice, incl. after the final edits). `eslint --fix` + clean run
over all touched files: exit 0. Touched unit tests (planets, scaled-proxy, planet-bodies,
world-manager, deposits, hazards) all GREEN — 69/69.

Two unit failures in the full `npm run test` run, BOTH timing-budget tests that were run
CONCURRENTLY with the e2e dev-server boot (heavy load) — almost certainly load flake, not my code
(neither file is touched by this task):
1. `src/client/ui/combat-hud/combat-hud.test.tsx` "the per-frame projection stays under the hud
   budget" — `stats.maxMs` 2.29 vs < 1.
2. `src/server/persist.test.ts` — `expect(summary.ms).toBeLessThan(20)` + `maxWrite < 5`.
Re-run `npm run test` WITHOUT anything else running; both should pass (they pass in clean
iterations historically).

Also present in the tree BEFORE this session (do NOT commit): the many dirty
`.ralph/screenshots/*.png` mods, `ralph.config.json` mod, untracked `.ralph/logs/t761/`.

## Next steps
1. **Fix the e2e D-hold race (the one real blocker).** Run:
   `cd app && npx playwright test --config playwright.e2e.config.ts planets-visible.spec.ts`
   It fails at the line `if (screen === null) throw new Error(...)` with "planet 0 anchor screen
   point was null after the turn". Root cause: the ship faces −X on arrival and planet 0 is at +X
   (behind), so it keeps turning through the whole 10 s D-hold; the anchor only sweeps THROUGH the
   viewport for ~0.1–0.2 s mid-turn (island angular radius ~18° at 6 km). The poll catches that
   instant, but `keyboard.up('d')` lands after the planet has left, so the re-read is null.
   Proposed fix (deterministic): stop the poll-while-holding pattern. Instead hold D for a FIXED
   time — half a turn ≈ `Math.PI / 0.8` s ≈ 3.9 s (scout turnRate 0.8 rad/s; check the actual class
   turn rate in the ship catalog before hard-coding) + a ~0.5 s margin, e.g.
   `keyboard.down('d'); waitForTimeout(4400); keyboard.up('d')` — then release the key FIRST and
   poll `planetAnchorScreen(page) !== null` with a ~10 s timeout (ship is stationary, the chase
   camera slerp (CHASE_ROT_K = 6) settles in < 1 s, and the island at 6 km subtends ~18° so a
   modest overshoot still leaves it well inside the 100° horizontal FOV). If the overshoot ever
   overshoots too far, a short corrective 'a' hold can be added. Keep the rest of the spec.
2. After the spec passes: LOOK at `.ralph/screenshots/TASK-83-1.png` (island+dome at 6 km) and
   `TASK-83-2.png` (1 500 m, island + dome clearly visible). If the planet is off-center or the
   12×12 region still reads like sky, nudge the turn time / sampling size before declaring done.
3. `cd app && npx tsc --noEmit` (green), full `npm run test` alone (expect 1703+ pass, the 2
   timing flakes from above must pass in isolation), e2e: `npx playwright test --config
   playwright.e2e.config.ts planets-visible.spec.ts deep-space.spec.ts atmosphere-view.spec.ts
   atmosphere.spec.ts landing.spec.ts warp.spec.ts chase-camera.spec.ts` (spec list per step 5:
   new spec + deep-space, atmosphere-view, atmosphere, landing, warp, self-ship — self-ship =
   `chase-camera.spec.ts` / `controls-direction.spec.ts`; pick whichever file name the suite uses).
   `npm run bench:render` gates: NOTE the benchmark builds its OWN scene (does not use
   WorldManager), so the new island/dome meshes are NOT in the tally — it should pass unchanged;
   still run it per the AC and record numbers.
4. `eslint --fix` + `prettier --write` on touched files (eslint already clean; prettier not yet
   run — run `npx prettier --write` over the touched file list).
5. Close out: set the 5 step `pass: true` flags in `.ralph/tasks/TASK-83.json`; set `"passes": true`
   for TASK-83 in `.ralph/tasks.json`; LOG.md entry at the top (date, summary, screenshot paths);
   commit `feat(TASK-83): ...` (Conventional Commit; EXCLUDE the pre-existing dirty
   `.ralph/screenshots/*.png` mods, `ralph.config.json`, `.ralph/logs/t761/` — stage files
   explicitly). Kill any background dev server before finishing. Output the promise.

## Dead ends
- **Initial `proxyTransform` bug (fixed this session, kept as a lesson):** first version returned
  `pos = dir × PROXY_DISTANCE_M` (the offset) instead of `cameraPos + dir × PROXY_DISTANCE_M`;
  the unit test with a far-from-origin camera (45 000, 300, 0) caught it immediately. If you
  re-derive the math, keep `cameraPos +` in there.
- **Poll-while-holding-D pattern does not work** for turning an object into view: the target
  transits the viewport faster than the key-release round trip. Use fixed-time turn + stationary
  poll (see Next steps).
- Do NOT try to "make the planet visible" by moving the anchor, shrinking the 10 km spacing, or
  changing the atmosphere radius — the sim is the source of truth (task note).

## How to verify
- Unit: `cd app && npx vitest run src/shared/galaxy/planets.test.ts
  src/client/render/scaled-proxy.test.ts src/client/world/planet-bodies.test.ts
  src/client/world/world-manager.test.ts` → 34/34 (before this handoff's e2e work).
- Types: `cd app && npx tsc --noEmit` → exit 0.
- E2E: `cd app && npx playwright test --config playwright.e2e.config.ts planets-visible.spec.ts`
  (currently RED on the D-hold race — fix per Next steps 1).
- Full: `cd app && npm run test` (alone, no concurrent e2e), then the e2e spec list from
  Next steps 3, then `npm run bench:render`.
- Visual: open `.ralph/screenshots/TASK-83-1.png` / `TASK-83-2.png` after the e2e passes —
  the terran island slab + faint dome must be clearly distinguishable from the sky in both.
