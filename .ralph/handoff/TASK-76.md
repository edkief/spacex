# Handoff: TASK-76 — Blackout fix (atmosphere): camera far plane must contain the whole dome

## Status

Steps 1, 2, 4 are NOT done (far-plane fix not applied, no unit test, no final verify). Step 3's
e2e exists and now has a WORKING aim loop, but it still PASSES pre-fix (top band mean 24.3 at
pad-relative altitude 200 u). This session nailed down the ROOT CAUSE of the non-repro and the
exact physics of what the top band shows pre-fix — see Dead ends + Next steps.

## Done

- `app/tests/e2e/atmosphere-sky.spec.ts` (UNCOMMITTED changes this session): added a closed-loop
  aim block after the teleport loop. It reads `__SELF_SHIP__.probe().pos/.rot`, computes the
  ship's forward (local +Z under the quat, pose-math convention), calibrates the 'd'/'a' yaw
  sign empirically with one 120 ms press, then yaws (holding W to keep altitude) until the
  heading error to the pad anchor < 0.12 rad. Verified working:
  `[TASK-76] aimed at the anchor: heading error 5.3°`.
- Run result pre-fix (aimed, pad-relative altitude 200 u, actual altitude 373 m per HUD):
  `top band mean=24.3 bright=398` → PASSES, not a failing repro yet.
- Committed earlier (daec652): the spec without the aim loop (pre-fix mean 56.8, worse repro).

## Working tree

- `app/tests/e2e/atmosphere-sky.spec.ts` — MODIFIED (aim loop), not committed.
- `.ralph/screenshots/TASK-76-1.png` — regenerated this session (hazy-but-bright sky), untracked.
- Do NOT commit: `ralph.config.json`, the 4 pre-existing dirty `.ralph/screenshots/TASK-28.1/70/72/73-1.png`.
- `app/src/client/world/WorldManager.ts` line ~387 still reads `new THREE.PerspectiveCamera(70, 1, 0.1, 1000)` — FIX NOT APPLIED.
- Builds fine (spec ran). Scratch analysis scripts were deleted (numbers captured below).

## Key facts (measured this session, seed DRIFT-SEED-0001)

Geometry (why aiming at the anchor IS the right direction):
- Ship 600 u from the dome anchor → far dome wall in the ANCHOR direction is 600+1010 = 1610 u
  away (clipped by far=1000). Toward the opposite wall: only 410 u (not clipped).
- The clipped cap extends to ~73.5° from the anchor direction (law of cosines:
  cosθ = (600² + 1000² − 1010²)/(2·600·1000) ≈ 0.283). So the whole top band (15–35° above the
  aimed nose) is inside the clipped cap once the nose faces the anchor. The committed aim loop
  targets the anchor — correct, keep it.

What the top band actually shows pre-fix (this was the missing piece):
- The sky sphere (r=420, TASK-75 re-centred on the camera) and stars (r=150–200) are both
  INSIDE far=1000 → never clipped. In the clipped dome region you see the skybox (opacity
  1−haze) over the renderer's DEFAULT BLACK clear color (WorldManager never calls setClearColor;
  no alpha flag).
- Top band mean pre-fix ≈ (1−haze) × 34 (sky top gradient #131f33 luminance ≈ 34) + ~0.5 stars.
  To read < 5 (fail) you need haze ≥ ~0.85.
- haze = (1 − alt/1000) × min(1, density/0.1). The current spec teleports pad.y + 200 → actual
  altitude 373 m → haze ≈ 0.39 → skybox 61% opaque → mean 24.3. Way too high to fail.

Per-planet densities (first pad per system, seed DRIFT-SEED-0001): best = Rynar Major
(sys e32d177b956ddb13) density 0.087 → haze@60u = 0.815 → predicted pre-fix mean ≈ 6.3 (STILL
marginally above the >5 threshold at 60 u; at ~20 u altitude ≈ 5.0). Others: Ulmess Rigel 0.080,
Belien Minor 0.066, home bb3c7b914ab3554c 0.062 (haze@60u 0.585), Kaelum Vega (unscoped
pad-target) 0.062. Worst-case best-reachable-by-keyboard-warp density over ALL 200 homes: 0.022
→ haze@60u 0.21 → hopeless.

## Next steps (in order)

1. **Steps 1+2 (quick, do first — independent of the repro blocker).**
   - `WorldManager.ts`: add `export const CAMERA_FAR = 4000;` with the invariant block comment
     (>= 2 × ATMOSPHERE_BOUNDARY_M × DOME_RADIUS_FACTOR = 2020, > sky radius 420, no
     logarithmicDepthBuffer), use it at line ~387. `DOME_RADIUS_FACTOR` is ALREADY exported
     (src/client/render/atmosphere-dome.ts:24); `ATMOSPHERE_BOUNDARY_M = 1000` is in
     src/shared/physics/atmosphere.ts:20. CameraRig only sets fov (line 115) — verified safe.
   - Unit test in `src/client/world/world-manager.test.ts` (it already imports constants from
     WorldManager with NO GL context): assert `CAMERA_FAR >= 2 * ATMOSPHERE_BOUNDARY_M *
     DOME_RADIUS_FACTOR` and `CAMERA_FAR > 420`.
2. **Step 3 — make the e2e FAIL pre-fix.** Required changes to `atmosphere-sky.spec.ts`:
   a. **Target the densest pad.** Home-system pad (density 0.062) can't produce haze ≥ 0.85.
      Keyboard warp only reaches home + its 2 nearest stars (galaxyChart picks exactly 3
      systems), and worst-case reachable density is 0.022. Use the RAW-WS warp instead:
      `tests/e2e/pvp-kill.spec.ts` lines ~62–86 (`warpShip` via `RawWsClient` from
      `./raw-ws`; the server's warp handler, src/server/ws.ts:303, does NOT check chart
      adjacency — only system-full/not-found) to put the ship row in the target system, then
      the browser joins it directly: `page.evaluate(() => localStorage.setItem('drift.session.v1',
      JSON.stringify(s)))` + `page.goto(baseURL + '/?sys=' + targetSystemId)` (pvp-kill step 3
      pattern). To let the Node side pick the densest landable atmospheric pad, either add a
      `density` (and planetId already exists) field to the `GET /api/dev/pad-target` response
      (src/server/routes/dev.ts:80 — dev-only route, adding a field is in scope) and add a
      `?any=1` (or `?maxDensity=1`) variant that scans ALL systems for the MAX-density landable
      atmospheric pad, or add a new tiny dev route. The unscoped variant currently returns the
      FIRST star-order pad (Kaelum Vega, 0.062), not the densest.
   b. **Pin the ACTUAL altitude low (≤ ~40–60 u)** instead of pad.y + 200. The terrain at the
      600 u offset was 173 u lower than the pad, so pad-relative offsets don't equal altitude.
      Read the HUD element `#ship-hud-altitude` (src/client/ui/ship-hud/ship-hud.tsx:69, format
      `ALT 373 m`) after each teleport and adjust `y` until it reads ≤ ~60 (a few iterations is
      enough; gravity 9.8 u/s² means the ship only falls a few u in the ~2 s poll window).
   c. Keep the anchor-aim loop (it's correct). Re-verify the `heading error` log is small.
   d. **If the pre-fix mean lands in 5–7 (marginal, per the predictions above):** (i) measure a
      HUD-free sub-band, e.g. `{ x0: 0.25, y0: 0, x1: 0.75, y1: 0.3 }` (the top-left DRIFT
      panel and top-right CR counter sit in the band and add ~1–2 luminance); (ii) add a
      `bright`-count assertion (canvasRegionStats already returns it; lum>60 pixels: pre-fix the
      clipped band has almost none, post-fix the haze tint, e.g. ocean #6fa8dc lum ≈ 112, fills
      it). Record BOTH pre-fix values in the LOG entry. The spec's intent is "never black"; a
      bright-count gap of ~10 vs hundreds is an unambiguous repro even where the mean is 6.
   e. Before applying step 1, run the e2e and RECORD the failing value (AC requires it in LOG.md).
3. **Step 4 — verify + commit:** `cd app && npx tsc --noEmit`; full `npm run test`;
   `npx playwright test --config=playwright.e2e.config.ts atmosphere-sky atmosphere-view
   atmosphere landing transitions self-ship` (the fixture self-boots the server — no manual
   `npm run dev` needed; ~30 s per spec); `npm run bench:render`; eslint/prettier on touched
   files; regenerate `.ralph/screenshots/TASK-76-1.png` post-fix and LOOK at it (haze sky, not
   black); commit as `fix(TASK-76): ...`; delete this handoff in that commit.
   If `bench:render` gates fail: report numbers + DECIDE, do NOT lower CAMERA_FAR below 2020.

## Dead ends

- Pad-relative altitude 200 u (current spec): PASSES pre-fix, mean 56.8 unaimed / 24.3 aimed —
  haze only ~0.39, skybox 61% opaque. Altitude is the first thing to change.
- Aiming at the anchor alone: improves 56.8 → 24.3 but does not fail the test. The clip
  geometry was already covered unaimed; the skybox is what keeps the band bright.
- Keyboard warp to a dense pad: NOT reliably possible — the chart only ever contains home + the
  2 nearest stars, and the worst-case best-reachable density across all 200 homes is 0.022
  (haze@60u 0.21). Raw-WS warp (any system) is the way.
- E2E specs cannot import @shared at runtime (Playwright doesn't resolve tsconfig aliases);
  `determinism.spec.ts` only imports types. So the pad/density selection must come from a dev
  route, not a direct shared-code import.
- The unscoped `GET /api/dev/pad-target` returns the FIRST star-order pad, not the densest —
  it cannot select Rynar Major (density 0.087) as-is.

## How to verify

- Repro (must FAIL pre-fix): `cd app && npx playwright test --config=playwright.e2e.config.ts
  atmosphere-sky` — expect `top band mean=...` ≤ 5 (or a failing bright-count assert) and a
  screenshot of a black top band.
- Post-fix: same command passes with a hazy top band (mean well above 5, screenshot shows haze).
- Invariant: `npx tsc --noEmit`; `npm run test` (unit, includes the new CAMERA_FAR test);
  `npm run bench:render`; the five related e2e specs listed in Next steps 3.
- Task spec: `.ralph/tasks/TASK-76.json` (4 steps, none marked pass yet).
