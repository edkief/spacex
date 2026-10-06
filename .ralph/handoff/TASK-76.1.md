# Handoff: TASK-76.1 — Stabilize the atmosphere-sky e2e: deterministic aim, confirmed pre-fix FAIL + 3x post-fix PASS

## Status

~70% done. The deterministic aim (step 1) is implemented and VERIFIED — heading error
converged < 6.9° in 5 consecutive runs (previously up to 174.7°). The pre-fix FAIL is
re-confirmed with the new aim (step 2, central top band mean = 0.0). Step 3 (3 consecutive
post-fix passes) is NOT met: 1 of 3 runs passed (mean 66.0), 2 read 0.0 — a NEW flake that
is NOT the aim (it converged in all of them) and is not a settle transient or a
preserveDrawingBuffer race. The root cause is narrowed to a rendered-state/camera issue and
needs one verification step (see Next steps 1).

## Done

- **Step 1 (aim, DONE)** — `app/tests/e2e/atmosphere-sky.spec.ts`, the aim block rewritten
  (~lines 298-383, `--- Aim the nose at the dome ANCHOR ---` through the convergence
  assert):
  - Yaw WITHOUT holding `w` (server yaw is thrust-independent, `integrateStep` in
    `@shared/physics/flight` applies `input.yaw * turnRate * h` unconditionally). The ship
    just falls while it turns — safe: there is no ship-terrain crash damage in the sim, and
    the re-pin teleport below restores the exact spot anyway.
  - Calibration press is now `press(['d'], 120)` (was `['w','d']`), sign logic unchanged.
  - Wall-clock loop: `AIM_DEADLINE_MS = 9_000`; each iteration probes via the existing
    `aimProbe` and presses for a PROPORTIONAL duration:
    `ms = clamp(80..450, |err| / 0.8 * 0.8 * 1000)` (scout turnRate 0.8 rad/s, 80 %
    deliberate undershoot so a press can never cross the target; min 80 ms vs key latency).
  - Exit threshold is an INTERNAL `AIM_SETTLE_RAD = 0.05` (tighter than the hard assert,
    leaves tick-overshoot margin), then a 200 ms settle, then the HARD ASSERT
    `expect(Math.abs(finalErr)).toBeLessThan(AIM_TOLERANCE_RAD)` with
    `AIM_TOLERANCE_RAD = 0.12` and an explicit message, before any measurement.
  - Verified across 5 runs: heading errors -1.8°, -0.3°, -3.5°, 6.7°, -0.5° — all
    converged. (The 6.7° pre-fix run was within 0.18° of the 6.88° limit — the tightened
    0.05 rad settle threshold landed all later runs ≤ 4°.)
  - The stale re-pin comment was updated (no thrust is burned during the aim now).
- **Step 2 (pre-fix FAIL re-confirmed, DONE)** — with the constructor temporarily
  `new THREE.PerspectiveCamera(70, 1, 0.1, 1000)` the spec FAILED: **central top band mean
  = 0.0, bright = 0, full top band mean = 0.0** (heading error 6.7° — converged, so a
  genuine blackout, not a mis-aim). `CAMERA_FAR` is exported and untouched; the file was
  restored with `git checkout -- app/src/client/world/WorldManager.ts` (verified empty
  diff). THE MEASURED PRE-FIX VALUE TO RECORD: central top band mean = 0.0.
- `npx tsc --noEmit` clean; `eslint --fix` + `prettier --write` applied to the spec.
- `npx vitest run src/client/world/world-manager.test.ts` → 10/10 green (re-checked this
  iteration; the constants were not touched).
- `.ralph/screenshots/TASK-76-1.png` regenerated from a PASSING post-fix run (hazy blue
  sky, ship visible, HUD intact).

## Working tree

- Committed: nothing this iteration (HEAD = 444c1c7, the split chore commit).
- Modified, UNCOMMITTED (to commit with the final fix):
  - `app/tests/e2e/atmosphere-sky.spec.ts` — the new deterministic aim (step 1).
  - `.ralph/screenshots/TASK-76-1.png` — passing-run image (was a black-sky image before).
  - `.ralph/handoff/TASK-76.1.md` — this file.
- Pre-existing dirt — do NOT commit: `ralph.config.json`, `.ralph/screenshots/TASK-28.1-1.png`,
  `TASK-70-1.png`, `TASK-72-1.png`, `TASK-73-1.png`.
- Builds: `tsc` clean; unit test file green. No background processes (the e2e fixture
  self-tears-down; verified with `ps`).

## Next steps

1. **Root-cause the remaining post-fix flake (the only blocker).** Data from this
   iteration (a temporary diagnostic block, now REMOVED from the spec — re-add a pose+band
   logger if you want fresh data):
   - 3 post-fix runs: run 1 mean 0.0 (heading -1.8°), run 2 mean 0.0 (heading -0.3°),
     run 3 PASS mean 66.0 bright 83328 (heading -3.5°), regime=atmosphere in all.
   - Diagnostic run: the black is PERSISTENT (5 band samples over 2.4 s, all 0.0), the ship
     is exactly at the pin, pitch 0.0°, heading -165.8°. The screenshot showed the ENTIRE 3D
     canvas pure black — no ship, no dome, no stars — while the DOM HUD rendered fine.
     So it is NOT the far-plane clip (that leaves a bright dome ring) and NOT a transient.
   - LEADING HYPOTHESIS: the chase camera ends up INSIDE terrain. The chase pose is
     ship-local (0, +4, -14) (`CHASE_HEIGHT`/`CHASE_BEHIND` in
     `app/src/client/camera/pose-math.ts`, `chasePose`), so camera pos =
     spot − 14·forward(final heading). The spot is terrain+60 u (terrain at spot ≈ 335 u
     absolute; camera ≈ 399 u), and terrain varies across 5 u cells — whichever terrain
     rises BEHIND the ship depends on the per-run final heading. VERIFY by computing the
     terrain at the camera position for the measured heading (target heading toward the
     anchor ≈ -166°): a scratch tsx script in `app/` re-derives the same way the spec does
     (`densestAtmosphericPad` + `generateSurfaceChunk` relative imports; spot =
     (20770, 395, 195)-ish, pad (20170, 229, 195) + 600 u offset); sample
     `terrainY(spot.x - 14*cos(h), spot.z - 14*sin(h))` for h ≈ -166° ± a few degrees and
     compare with cam.y ≈ terrainY(spot)+64. If terrain ≥ cam.y → confirmed.
   - If confirmed: make the camera clear, e.g. after the re-pin check the computed camera
     position against the terrain and, if underground, nudge the aim by ±180° (re-aim the
     nose the other way — the band geometry still works: it is a top strip, and the dome
     fills the whole sky) or pick a different pad offset / rotate the offset direction
     until the terrain behind the ship is clear. Do NOT change TOP_BAND, the assertion, the
     target, or the far-plane constants.
   - If NOT confirmed: next suspects — the client ship prediction (what `__SELF_SHIP__`
     and the renderer use) drifting from the server-set position after the teleport, or the
     chase rig stuck in a handoff animation. Add the pose logger back (the removed block
     shape) and compare the client `probe().pos` with the server spot over time.
2. **Step 3:** with `CAMERA_FAR = 4000`, run
   `cd app && npx playwright test --config playwright.e2e.config.ts atmosphere-sky`
   THREE times; every run must pass on its own (retries: 0). Log per run: heading error,
   central top band mean (> 5; one measured pass read 66.0 — the spec's "~150" expectation
   was a tint-luminance estimate, record the ACTUAL value in the commit message),
   bright, regime. LOOK at `.ralph/screenshots/TASK-76-1.png`: hazy blue, not black.
3. **Step 4:** `npx tsc --noEmit`; `npx vitest run src/client/world/world-manager.test.ts`
   (10/10); commit ONLY `app/tests/e2e/atmosphere-sky.spec.ts`,
   `.ralph/screenshots/TASK-76-1.png` (if changed), and this handoff; check
   `git status --short` first (pre-existing dirty files stay dirty). Then close per the
   task flow (tasks.json `passes: true`, LOG entry — or leave to TASK-76.2 for the LOG
   since the pre-fix value and pass values are now recorded here).

## Dead ends

- **Old aim (14 fixed iterations holding `w`)**: up to 174.7° heading error — replaced by
  the no-thrust wall-clock loop; do not resurrect `w` in the aim.
- **6.7° convergence against the 6.88° (0.12 rad) hard assert** (the pre-fix run): too
  tight. The internal `AIM_SETTLE_RAD = 0.05` exit threshold fixed the margin; keep it.
- **Profile hypothesis**: the `mobile` perf profile has `atmosphereDome: false`
  (`app/src/shared/perf.ts` line ~262) — RULED OUT: headless reports maxTouchPoints 0 →
  desktop profile, and all desktop presets keep the dome on.
- **preserveDrawingBuffer / readPixels race** — RULED OUT: `WorldManager` sets
  `preserveDrawingBuffer: true` (line ~406); the diagnostic showed the black is
  persistent across seconds, not a between-frames read.
- **Settle transient after the re-pin** — RULED OUT: 5 samples over 2.4 s all 0.0 with the
  ship pinned exactly at the spot.
- **Writing scratch scripts to `/tmp/opencode/`**: the write tool refused twice there —
  put scratch scripts inside `app/` (delete after, as the prior attempt did with
  `galaxy-scan.mts`/`band-check.mjs`).

## How to verify

- Spec: `.ralph/tasks/TASK-76.1.json` (steps 1-4, acceptance criteria). Parent context:
  `.ralph/split/TASK-76/TASK-76.json` + `.ralph/split/TASK-76/handoff.md` (steps 1-2 of the
  parent are committed at 135fd31: `CAMERA_FAR = 4000` + invariant unit test).
- Repro commands:
  - `cd app && npx tsc --noEmit` (tsconfig includes `tests/`, so the spec is checked)
  - `cd app && npx vitest run src/client/world/world-manager.test.ts` (10/10)
  - `cd app && npx playwright test --config playwright.e2e.config.ts atmosphere-sky`
- Pre-fix check (already done, value recorded): edit `WorldManager.ts:408` to
  `new THREE.PerspectiveCamera(70, 1, 0.1, 1000)` (leave `CAMERA_FAR` exported), run the
  spec → FAIL, central top band mean = 0.0; restore via
  `git checkout -- app/src/client/world/WorldManager.ts`.
- Facts (seed DRIFT-SEED-0001): densest pad system `9f065b79f5c34fd3`, density 0.0985,
  pad (20170, 229.0, 195); spot = pad + (600, 0, 0) at +60 u local altitude (terrain at
  spot ≈ 335 u absolute → ship ≈ 395 u); anchor ≈ 794 u from the spot, heading ≈ -166°;
  dome radius 1010 u, far wall 1804 u; haze ≈ 0.93; passing-run measurement: central band
  mean 66.0, bright 83328, full top band 65.9.
