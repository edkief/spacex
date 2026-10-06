# Handoff: TASK-76 — Blackout fix (atmosphere): camera far plane must contain the whole dome

## Status

Steps 1 and 2 are DONE and green (far-plane fix + unit test). Step 3's e2e repro is
confirmed to FAIL pre-fix (central top band mean = 0.0, pure black — recorded for the
LOG). The one remaining blocker is that the e2e's **aim loop is flaky** (it steers the
ship at the dome anchor via the flight model and once ended 174.7° off), so a reliable
post-fix pass is NOT yet confirmed. Everything else (step 4 full verify) is queued behind that.

## Done

All committed as `135fd31` (on top of the prior wip commits `daec652`, `6dafa52`):

- **Step 1 (fix)** — `app/src/client/world/WorldManager.ts`:
  - `export const CAMERA_FAR = 4000;` with a block comment stating the invariant:
    >= 2 × ATMOSPHERE_BOUNDARY_M × DOME_RADIUS_FACTOR (2020 u = longest dome chord, so the
    far wall is never clipped from any point inside the dome) and comfortably > 420 u
    (sky radius, TASK-75 keeps it centred on the camera). near stays 0.1; no logDepthBuffer.
  - Constructor: `new THREE.PerspectiveCamera(70, 1, 0.1, CAMERA_FAR)` (was hardcoded 1000).
  - `DOME_RADIUS_FACTOR` added to the existing `@client/render/atmosphere-dome` import
    (it was already exported there, line 24).
  - Verified `CameraRig` (app/src/client/camera/CameraRig.ts:115) only sets `fov` +
    `updateProjectionMatrix()` — it does NOT reset `far`.
  - `npx tsc --noEmit` clean.
- **Step 2 (unit test)** — `app/src/client/world/world-manager.test.ts`:
  - New `describe('CAMERA_FAR (TASK-76) contains the whole atmosphere dome')` asserting
    `CAMERA_FAR >= 2 * ATMOSPHERE_BOUNDARY_M * DOME_RADIUS_FACTOR` and `CAMERA_FAR > 420`.
  - `npx vitest run src/client/world/world-manager.test.ts` → 10 passed.
- **Step 3 (repro, half done)** — `app/tests/e2e/atmosphere-sky.spec.ts`, fully rewritten:
  - Deterministic target: `densestAtmosphericPad('DRIFT-SEED-0001')` re-derives the seeded
    galaxy with the SAME shared code the server uses (relative imports — the Playwright
    runner does not resolve tsconfig aliases, so `../../src/shared/...` paths are used).
    Picks the densest landable+atmospheric planet: system `9f065b79f5c34fd3` (ocean),
    density 0.0985, pad (20170, 229.0, 195). WHY densest: haze = (1 − alt/1000) ×
    min(1, density/0.1); at 60 u altitude density→0.1 gives haze ≈ 0.93 → skybox opacity
    ≈ 0.07 over the black clear = black. A thin pad (density ~0.06) caps haze ~0.6 and
    the band would stay bright — the bug would be invisible.
  - Flow: raw REST claim → raw WS warp to that system (pvp-kill.spec.ts pattern; the router
    validates the warp target only against the seed, NOT the chart neighbor list, so the
    densest system is reachable even though keyboardWarp is not) → browser joins via
    `?sys=` → dev-teleport 600 u off the pad at **60 u LOCAL altitude** (terrain height
    re-derived with `generateSurfaceChunk` so altitude is exact) → aim nose at the planet
    anchor → re-pin to the same spot → measure band.
  - **KEY FINDING (why the earlier full-width band false-passed with mean 51):** pre-fix the
    clipped dome cap (black region) sits in the view CENTRE, ringed by the VISIBLE part of
    the dome (within the 1000 u far plane) — a bright-blue ring reaching the corners.
    Assertion band is therefore a CENTRAL top strip `TOP_BAND = {x0:0.35, y0:0, x1:0.65,
    y1:0.3}` that stays inside the clipped cap (cap spans ~67° from the nose at 794 u from
    the anchor; the strip only spans ~14–38°). A full-width band is still logged for the record.
  - **CONFIRMED pre-fix (2 runs): central top band mean = 0.0, bright = 0 → fails `> 5`.**
    This is the failing value to record in the LOG.md entry.

## Working tree

Committed in `135fd31`: `app/src/client/world/WorldManager.ts`, `app/src/client/world/world-manager.test.ts`,
`app/tests/e2e/atmosphere-sky.spec.ts`, `.ralph/handoff/TASK-76.md`, `.ralph/screenshots/TASK-76-1.png`.

Uncommitted (pre-existing dirt — do NOT commit per spec notes): `ralph.config.json`,
`.ralph/screenshots/TASK-28.1-1.png`, `TASK-70-1.png`, `TASK-72-1.png`, `TASK-73-1.png`.

Builds: `npx tsc --noEmit` clean; unit test file green. No background processes running
(e2e fixture self-tears-down; verified with `ps`). Scratch files `app/galaxy-scan.mts`
and `app/band-check.mjs` were deleted.

## Next steps

1. **Fix the flaky aim (the only blocker), in `atmosphere-sky.spec.ts`:** the aim block
   (~line 295-352) yaws with the flight model holding `w` + `d`/`a` for up to 14 fixed
   iterations. `w` at 60 u altitude changes altitude/pitch, so the ship can end facing the
   wrong way (observed heading errors: 4.2°, 14.9° — good; 174.7° — FAILED, and that post-fix
   run read central band 0.0). Make it robust: (a) yaw WITHOUT holding `w`; (b) loop against a
   time deadline (not a fixed count) until |err| < 0.12 rad; (c) ASSERT convergence (log +
   expect) before measuring; (d) the existing re-pin re-teleport already restores the exact
   spot (teleport preserves orientation — verified in shard.teleportForTesting).
2. **Re-run post-fix:** `cd app && npx playwright test --config playwright.e2e.config.ts atmosphere-sky`
   (run it a few times to check stability; config has retries:1). Expect central band mean
   ≈ 150 (ocean haze #6fa8dc luminance ~160 at haze 0.93), bright ≫ 0. LOOK at
   `.ralph/screenshots/TASK-76-1.png`: it must be a hazy blue sky, not black.
3. **Step 4:** full `npm run test`; `npx tsc --noEmit` (already clean); e2e specs:
   `atmosphere-sky`, `atmosphere-view`, `atmosphere`, `landing`, `transitions`, `self-ship`;
   `npm run bench:render` must pass its gates (a larger far plane can raise draw calls — if a
   gate fails, report the numbers and DECIDE; do NOT lower CAMERA_FAR below 2020 u);
   `eslint --fix` + `prettier --write` on the three touched files.
4. **Close-out:** record the failing pre-fix value (central top band mean 0.0) in the LOG.md
   entry (top of `.ralph/logs/LOG.md`); set `passes: true` for TASK-76 in `.ralph/tasks.json`;
   delete this handoff; one final commit `fix(TASK-76): ...`; output the promise.

## Dead ends

- **Aiming with the flight model at 60 u altitude is flaky** (14 fixed iterations, `w` held):
  ended at 174.7° heading error once, and that post-fix run read central band 0.0. Needs the
  verified no-thrust-yaw + convergence assert from Next step 1. Do NOT give up on the aim —
  the geometry is correct (aiming at the anchor IS the clipped cap; the cap spans ~67° and
  the strip only ~14–38°); the failure is purely the steering loop.
- **Full-width top band as the assertion region** (earlier attempt): false-passes pre-fix
  (mean 51) because it averages in the visible blue dome ring around the black cap. The
  central strip is the fix.
- **Using the home system's pad** (earliest attempt): too-thin atmosphere (density ~0.06)
  → haze ~0.6 at 60 u → band stays bright, bug invisible. Must use the densest seeded planet.
- **keyboardWarp to the densest system**: not viable (chart only exposes neighbors); the
  raw WS warp (pvp-kill pattern) works because the router doesn't validate adjacency.

## How to verify

- Spec: `.ralph/tasks/TASK-76.json` (acceptance criteria list the failing pre-fix value in
  LOG.md, the screenshot, bench:render gates, one commit).
- Repro: `cd app && npx playwright test --config playwright.e2e.config.ts atmosphere-sky`
  — revert `CAMERA_FAR` to 1000 to see it fail (central band 0.0); with 4000 it must pass (~150).
- Unit: `npx vitest run src/client/world/world-manager.test.ts` (already green).
- Types: `npx tsc --noEmit` (already clean).
- Facts (seed DRIFT-SEED-0001): densest pad system `9f065b79f5c34fd3` density 0.0985 pad
  (20170, 229.0, 195); pad sits ~260 u off its planet anchor, so 600 u pad-offset = 794 u
  from anchor; dome radius 1010 u (far wall 1804 u, clipped by 1000; clip cap ~67°);
  sky top #131f33 (lum ~30); ocean haze tint #6fa8dc (lum ~160); haze = (1 − alt/1000) ×
  min(1, density/0.1) (`hazeFactor` in @shared/physics/atmosphere).
