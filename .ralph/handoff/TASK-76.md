# TASK-76 handoff — Blackout fix (atmosphere): camera far plane must contain the whole dome

Spec: `.ralph/tasks/TASK-76.json` (4 steps). Priority bug: black 3D view inside
atmosphere because the game camera far plane (1000 u) clips the far wall of the
atmosphere dome (radius 1010 u, centred on the planet anchor).

## Status
Only STEP 3 (the e2e) has been built and is committed. STEPS 1, 2, 4 are NOT done:
the far-plane fix is not applied, the unit test is not written, and the e2e has
NOT yet been shown to fail pre-fix (it currently PASSES pre-fix — see Dead ends).

## Done
- `app/tests/e2e/atmosphere-sky.spec.ts` (new, 236 lines): full e2e per step 3.
  Claims a ship, resolves a landable atmospheric pad via `GET /api/dev/pad-target`
  (home system first, then unscoped, warps with `keyboardWarp` if off-home), taps
  the ship's WebSocket via an init-script (`addInitScript(installShipTap, callsign)`)
  reading `flightRegime` (NOT `regime` — ship-level regime is 'sublight'),
  presses W to undock, teleports off-centre, polls until `__SELF_SHIP__.probe().pos`
  is within 50 u AND `flightRegime === 'atmosphere'`, then asserts the TOP band
  (`{x0:0,y0:0,x1:1,y1:0.3}`) mean luminance > 5 via `canvasRegionStats`, and
  screenshots `.ralph/screenshots/TASK-76-1.png`.
  - It tries offsets `[600,450,300,150]` u off the pad and altitude = `pad.y + 200`
    (pad-relative, see Dead ends re: terrain relief).
  - It RAN GREEN pre-fix: `[TASK-76] off-centre 600 u ... regime=atmosphere: top band
    mean=56.8 bright=348` (1 passed, 17.4s). **This is NOT a failing repro.**

## Working tree
- NOT committed yet: `app/tests/e2e/atmosphere-sky.spec.ts` (new) and
  `.ralph/screenshots/TASK-76-1.png` (new). `ralph.config.json` is a pre-existing
  unrelated dirty file (a `ui.token` line) — DO NOT commit it.
- The 4 modified `.ralph/screenshots/TASK-28.1/70/72/73-1.png` are pre-existing
  dirty files from prior tasks — DO NOT commit (spec note says so).
- `app/src/client/world/WorldManager.ts` line 387 still reads
  `new THREE.PerspectiveCamera(70, 1, 0.1, 1000)` — the FIX IS NOT APPLIED.
- Build: not re-verified after cleanup; the e2e spec compiles (it ran). No unit tests
  were touched, so `npm run test` / `tsc` state is unchanged from before this session.

## Next steps (in order)
1. **Make the e2e actually reproduce the bug (the blocker).** Currently at +600 u /
   pad-relative +200 u the top band is hazy (mean 56.8), not black — the dome's far
   wall is evidently still inside the 1000 u far plane for this geometry, or the
   chase-camera ship is not facing the clipped dome region. Options to try:
   - The chase camera sits behind the ship (CHASE_BEHIND=14, CHASE_HEIGHT=4) looking
     at a point CHASE_LOOK_AHEAD=20 ahead along the ship's +Z (`src/client/camera/pose-math.ts`).
     The clipped far wall is toward the ANCHOR, so the ship must be YAWED to face the
     anchor (dome centre) for the top band to look at the clipped region. `__SELF_SHIP__.probe().rot`
     is available (a Quat) — compute the ship forward (local +Z: fx=2(q.x*q.z+q.w*q.y),
       fy=2(q.y*q.z-q.w*x), fz=1-2(q.x*q.x+q.y*q.y)) and, while it points away from the
     anchor, send a yaw input. Yaw key = 'd' (right) / 'a' (left), pitch 'r'/'f'
       (`src/client/input/controls.ts`). Hold W is off; a `page.keyboard.down('d'|'a')`
       + release should rotate the nose. This was investigated but NOT yet implemented.
   - OR increase the offset so the far wall (up to 2×1010 u) is genuinely beyond 1000 u
     AND re-check: note the spec's own AC places the ship 600 u from the anchor. The
     real question is which dome direction the camera views. Confirm empirically (see
     How to verify) BEFORE trusting a pass.
   - A pre-fix mean must be ≤ 5 (black) to satisfy AC #3. Record the failing value in
     LOG.md.
2. **STEP 1 — the fix** in `app/src/client/world/WorldManager.ts`: add
   `export const CAMERA_FAR = 4000;` with a block comment stating the invariant
   (≥ 2 × ATMOSPHERE_BOUNDARY_M × DOME_RADIUS_FACTOR = 2020, and > 420 sky radius);
   use it at line 387 `new THREE.PerspectiveCamera(70, 1, 0.1, CAMERA_FAR)`. Keep
   near = 0.1, no logarithmicDepthBuffer. `DOME_RADIUS_FACTOR` is ALREADY exported
   from `src/client/render/atmosphere-dome.ts` line 24 (no change needed there).
   Check `CameraRig` only sets fov and does not reset `far` (`src/client/camera/CameraRig.ts`).
3. **STEP 2 — unit test** in `app/src/client/world/world-manager.test.ts`:
   import `CAMERA_FAR` from `./WorldManager`, `ATMOSPHERE_BOUNDARY_M` from
   `@shared/physics/atmosphere` (=1000), `DOME_RADIUS_FACTOR` from
   `@client/render/atmosphere-dome`; assert `CAMERA_FAR >= 2*ATMOSPHERE_BOUNDARY_M*DOME_RADIUS_FACTOR`
   and `CAMERA_FAR > 420`. (Existing test file only imports pure layout helpers, so
   adding the constant import is safe — it does not construct WorldManager.)
4. **STEP 4 — verify + commit**: `cd app && npx tsc --noEmit`; `npm run test`;
   e2e the new spec plus `atmosphere-view.spec.ts`, `atmosphere.spec.ts`,
   `landing.spec.ts`, `transitions.spec.ts`, `self-ship.spec.ts`; `npm run bench:render`
   (if a gate fails on draw calls, report numbers + DECIDE, do NOT lower CAMERA_FAR
   below 2020); `eslint --fix` + `prettier --write` on touched files. Commit
   `fix(TASK-76): ...`.

## Dead ends
- **Repro does not fail pre-fix.** At +600 u off the pad / pad-relative +200 u altitude,
  top band mean = 56.8 (hazy, not black). Likely cause: the chase camera looks along the
  ship's forward, which after the dev-teleport is NOT aimed at the clipped far wall. The
  spec's plain "pad.x+500, y:60, z:pad.z" teleport was also tried and the ship either
  fell to surface or the facing still missed. Aiming the nose at the anchor (yaw keys)
  is the untried-but-most-promising fix. NOT yet implemented.
- **`regime` vs `flightRegime`:** the entity_update `regime` field is the ship-level
  regime ('docked'/'sublight'/'warp'); the space/atmosphere/surface value is in the
  SEPARATE optional `flightRegime` field (`src/shared/protocol/schemas.ts` line 118).
  The tap reads `flightRegime`. First iteration read `regime` and saw 'sublight' forever.
- **`context.addInitScript(fn, arg)` serializes `fn`;** a wrapper closure that references
  an outer helper (`(cs)=>installShipTap(cs)`) throws in-page (helper not in scope). Pass
  the helper function directly: `addInitScript(installShipTap, callsign)`.
- **Absolute y:60 is unreliable:** terrain undulates ±(250 + radiusKm/8000*350) u
  (`amplitudeM`, `src/shared/galaxy/surface.ts` line 73). The seeded home pad
  (system 7df0ed2af70ae07a, planet 991858ac8ab80324 terran) sits at
  pad {x:10160,y:256,z:160}, anchor {x:10000,z:0}; terrain near the pad can be ~60 u above
  the pad, so an absolute y=60 lands the ship ON/below terrain → regime 'surface'
  immediately. Use pad-relative altitude.
- **Pad/anchor geometry probe** (ran via a temp tsx script, since deleted): density
  0.0623, haze@200=0.498, haze@60=0.585. So haze is well above 0 even at +200 u —
  consistent with the top band reading hazy rather than black (i.e. the fix is about
  the CLIPPED far wall, which requires the camera to look at it).

## How to verify
- e2e: `cd app && npx playwright test --config playwright.e2e.config.ts atmosphere-sky`
  (boots its own server+DB via the `e2eServer` fixture; ~15–20 s). Confirm it FAILS
  pre-fix (top mean ≤ 5) and PASSES post-fix (> 5), and LOOK at
  `.ralph/screenshots/TASK-76-1.png` — hazy sky, not black.
- Unit: `cd app && npx vitest run src/client/world/world-manager.test.ts`
- Types: `cd app && npx tsc --noEmit`
- Benchmark gate: `cd app && npm run bench:render`
