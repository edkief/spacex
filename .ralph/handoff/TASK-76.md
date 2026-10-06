# Handoff: TASK-76 — Blackout fix (atmosphere): camera far plane must contain the whole dome

## Status

Steps 1 and 2 are DONE and green. Step 3's e2e repro is confirmed to FAIL pre-fix
(central top band mean = 0.0, pure black). Step 3's e2e has NOT yet been confirmed
to PASS post-fix reliably — the aim loop (steering the ship at the dome anchor via the
flight model) is FLAKY, and the one post-fix run observed had a failed aim (heading
error 174.7°) and read band mean 0.0. That is the single thing left to fix.

## Done (all committed? — see "Working tree")

- **Step 1 (fix)** — `src/client/world/WorldManager.ts`:
  - `export const CAMERA_FAR = 4000;` with a block comment stating the invariant
    (>= 2 × ATMOSPHERE_BOUNDARY_M × DOME_RADIUS_FACTOR = 2020 u longest dome chord;
    comfortably > 420 u sky radius; near stays 0.1, no logDepthBuffer).
  - Constructor now `new THREE.PerspectiveCamera(70, 1, 0.1, CAMERA_FAR)`.
  - Imported `DOME_RADIUS_FACTOR` from `@client/render/atmosphere-dome` (already exported there).
  - Verified `CameraRig` only sets `fov` + `updateProjectionMatrix()` — it does NOT reset `far`.
  - `npx tsc --noEmit` is clean.
- **Step 2 (unit test)** — `src/client/world/world-manager.test.ts`:
  - New `describe('CAMERA_FAR (TASK-76) contains the whole atmosphere dome')`:
    asserts `CAMERA_FAR >= 2 * ATMOSPHERE_BOUNDARY_M * DOME_RADIUS_FACTOR` and
    `CAMERA_FAR > 420`. `vitest run` on the file: 10 passed.

## E2E repro (step 3) — what works and what's left

File: `app/tests/e2e/atmosphere-sky.spec.ts` (fully rewritten this iteration).

Design (deterministic, no hardcoded seed ids — re-derives the galaxy with the same
shared code the server uses via relative imports):
- Picks the **densest** landable+atmospheric pad in the seeded galaxy
  (`densestAtmosphericPad('DRIFT-SEED-0001')` → system `9f065b79f5c34fd3`, density 0.0985).
  Rationale: haze = (1 − alt/1000) × density/0.1. At 60 u altitude on a density→0.1
  planet, haze ≈ 0.93, so the skybox fades to opacity ~0.07 over the black clear.
  A thin-atmosphere pad (density ~0.06) would cap haze at ~0.6 and the band would stay
  bright — invisible to the assertion. The densest pad is what makes pre-fix read black.
- Flow: raw REST claim → raw WS warp straight to that system (pvp-kill pattern; the
  router validates the warp target only against the seed, NOT the chart neighbor list,
  so the densest system is reachable) → browser joins via `?sys=` → dev-teleport
  600 u off the pad at **60 u LOCAL altitude** (terrain height re-derived with
  `generateSurfaceChunk`, so altitude is exact) → aim nose at the dome anchor → re-pin
  to the same spot → measure the band.
- **Key geometry finding (why the first full-width attempt false-passed):** pre-fix the
  clipped dome cap (the black region) sits in the view CENTRE and is ringed by the
  VISIBLE part of the dome (within the 1000 u far plane) — a bright-blue ring reaching
  the corners. A full-width top band averages in that ring (mean 51 → false pass).
  The assertion therefore samples a **CENTRAL top strip** `TOP_BAND = {x0:0.35, y0:0,
  x1:0.65, y1:0.3}` that stays inside the clipped cap (cap spans ~67° from the nose;
  the strip only spans ~14–38°). A full-width band is still logged for the record.
- Result: **pre-fix central band mean = 0.0 (bright=0) — FAILS `> 5`** ✓ (repro confirmed,
  run 2×). Post-fix the same strip should read the full dome haze (#6fa8dc ≈ luminance
  160 → ~155) and PASS.

### THE ONE THING LEFT (step 3 + 4)

The **aim loop is flaky.** It steers the ship at the dome anchor by holding `w` and
pressing `d`/`a` (sign calibrated empirically), up to 14 iterations, target |err|<0.12 rad.
Observed heading errors across runs: 4.2°, 14.9° (good), 174.7° (FAILED — ship ended
facing ~opposite the anchor). When the aim fails, the ship is not looking at the clipped
cap, and the post-fix run also read band 0.0 (likely the ship pitched nose-down toward
the terrain during the flaky `w`-held yaw, so the top strip looked at ground — or the
readPixels caught a dark frame).

Next steps, in order:
1. **Make the aim robust and verified:** loop the aim until |err| < 0.12 rad with a
   generous deadline (not a fixed 14), and ASSERT convergence before measuring. Do not
   hold `w` while yawing at 60 u (it changes altitude/pitch) — yaw only, and rely on the
   pin re-teleport afterward to restore the exact spot. Consider re-pinning AND
   re-checking the probe's `rot` before the final read.
2. **Re-run post-fix** and confirm the central band reads ~150 (blue haze), not 0.
   Look at the screenshot: it must be a hazy blue sky, not black.
3. **Then step 4:** full `npm run test`, `npx tsc --noEmit` (already clean), the listed
   e2e specs (`atmosphere-sky`, `atmosphere-view`, `atmosphere`, `landing`,
   `transitions`, `self-ship`), `npm run bench:render` (a bigger far plane can raise draw
   calls — if a gate fails, report numbers and DECIDE, do not lower CAMERA_FAR),
   `eslint --fix` + `prettier --write` on the three touched files.
4. Record the failing pre-fix value (central band mean 0.0) in the LOG.md entry.
5. Set `passes: true` in tasks.json, delete this handoff, one commit `fix(TASK-76): ...`.

## Working tree (when this was written)

- `app/src/client/world/WorldManager.ts` — MODIFIED (step 1 fix).
- `app/src/client/world/world-manager.test.ts` — MODIFIED (step 2 test).
- `app/tests/e2e/atmosphere-sky.spec.ts` — REWRITTEN (repro; aim loop still flaky).
- `.ralph/screenshots/TASK-76-1.png` — untracked, regenerated this session.
- Do NOT commit: `ralph.config.json`, the 4 pre-existing dirty
  `.ralph/screenshots/TASK-28.1/70/72/73-1.png`.
- Scratch `app/galaxy-scan.mts` and `app/band-check.mjs` were DELETED.

## Facts worth keeping (seed DRIFT-SEED-0001)

- Densest pad: system `9f065b79f5c34fd3` (ocean), density 0.0985, pad (20170, 229.0, 195).
  Its planet anchor = planetAnchor(index); the pad sits ~260 u off the anchor, so a
  600 u pad-offset puts the ship ~794 u from the anchor (matches the e2e log).
- Dome radius 1010 u centred on the anchor. Ship 794 u from anchor: far wall (anchor
  direction) = 1804 u (clipped by far 1000), near wall = 216 u (not clipped), clip cap
  ≈ 67° from the anchor direction.
- Sky top gradient #131f33 (luminance ~30); ocean haze tint #6fa8dc (luminance ~160).
  haze = (1 − alt/1000) × min(1, density/0.1) (shared `hazeFactor`).
- e2e runs under `playwright.e2e.config.ts` (`npm run test:e2e`), boots its OWN dev
  server in DEV mode (vite serves live source → the WorldManager fix is live).

## Dead ends

- Aiming with the flight model (`w`+`d`/`a`) is too flaky at 60 u altitude — it drifts
  altitude/pitch and can end facing the wrong way (174.7° observed). Needs a verified,
  no-thrust-yaw aim + convergence assert.
