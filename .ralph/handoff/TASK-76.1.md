# Handoff: TASK-76.1 — Stabilize the atmosphere-sky e2e: deterministic aim, confirmed pre-fix FAIL + 3x post-fix PASS

## Status

The aim is deterministic and converged (0.4° / -1.8° in this iteration's runs — step 1 is
effectively done), and the NaN-frame guards are committed — BUT step 2 (pre-fix FAIL
re-confirmation) did NOT reproduce: with the constructor at `far = 1000` the spec now
PASSES the band assert (live means 45.5 and 32.4, two runs) instead of failing with ≤ 5.
The earlier 0.0 pre-fix readings (commit 22eab45) came from the pre-VTOL-hover aim, which
left the ship non-level; with the level aim the rendered black region no longer covers the
central TOP_BAND. Root-causing that geometry mismatch is the one remaining problem before
the 3× post-fix PASS + close-out.

## Done

- (Prior iterations, committed — all still in place): VTOL-hover closed-loop yaw aim with
  wall-clock deadline, NaN-probe retry, server-drain 300 ms settle, hard |err| < 0.12 rad
  assert; client NaN-frame guards (prediction.ts / WorldManager.ts / shipStateFromWire) +
  unit tests; all earlier temp diagnostics removed.
- (THIS iteration):
  - Ran the pre-fix check twice with `new THREE.PerspectiveCamera(70, 1, 0.1, 1000)`:
    both PASSED. Run 1: aim 0.4°, central band 45.5 (bright 45854), full band 57.0.
    Run 2: aim -1.8°, central band 32.4 (bright 31666), full band 57.6. No FAIL recorded.
  - Added a TEMP-TASK-76.1 attitude log to the spec (marked `TEMP-TASK-76.1 (remove before
    commit)`, sits between the aim assert and `keyboard.up(' ')`): prints dome centre,
    spot, and full rendered attitude via `__SELF_SHIP__.probe()`. Run 2 output:
    pitch=0, roll=0, noseHeading=-163.98°, anchorDepression=26.37°, anchorDist=886.6,
    shipY≈394 (spot y=413). Ship is perfectly LEVEL and yaw-aimed (dome centre is ~1.8°
    left of the nose, 26.4° BELOW the boresight).
  - Measured the run-1 screenshot (`.ralph/screenshots/TASK-76-1.png`, the dark-disk
    pre-fix frame) with throwaway chromium-pixel scripts (deleted): same DOM-fraction
    band mapping as `canvasRegionStats` reads **13.7** (not the live 45.5; live ≠ PNG,
    see Dead ends). The frame shows a big dark starry DISK filling most of the view with
    a bright haze RING around it. The traced disk edge in the centre column sits at
    v≈67 px = ~15.7° ABOVE the boresight, i.e. ~42° from the dome-centre direction.

## Working tree

- Committed at dade5dd (aim + guards + post-fix screenshot); this handoff commit adds the
  spec's TEMP attitude log.
- UNCOMMITTED: `app/tests/e2e/atmosphere-sky.spec.ts` (only change = the TEMP-TASK-76.1
  block; keep it — it's the diagnostic the next run needs; REMOVE it before the final
  commit per step 4).
- `app/src/client/world/WorldManager.ts` was RESTORED to the committed state this
  iteration (constructor line 422 reads `new THREE.PerspectiveCamera(70, 1, 0.1, CAMERA_FAR)`
  again) — re-edit it to 1000 for the pre-fix run.
- Pre-existing dirt — do NOT commit: `ralph.config.json`,
  `.ralph/screenshots/TASK-28.1-1.png`, `TASK-70-1.png`, `TASK-72-1.png`, `TASK-73-1.png`.
- No background processes (the e2e fixture self-tears-down).
- tsc/eslint were clean at dade5dd; the TEMP block is type-checked by the same `tsc`
  (spec is in the tsconfig), but re-run before committing anything.

## Next steps

Verification only, no fix work until the geometry question is answered.

1. **Resolve the geometry mystery first (why the pre-fix frame is not dark in the band).**
   Facts: dome centre = (anchor.x, **0**, anchor.z) — `planetAnchor` returns only {x,z}
   (planets.ts) and WorldManager.setAtmosphereView sets the dome mesh y to 0; dome radius
   1010 u; camera ≈ ship - 14·nose + 4·up (pose-math.ts chasePose, CHASE_BEHIND 14,
   CHASE_HEIGHT 4); ship→dome-centre distance ≈ 887 u (horiz 794, vertical 412); band
   spans 14.5°-35° ABOVE the boresight.
   - With far=1000 the clipped cap is a cone of ~63° half-angle centred 26.4° BELOW the
     boresight → its centre-column top would be ~36.6° above the boresight, i.e. the ENTIRE
     TOP_BAND (and the top of the frame) should be clipped/dark. The screenshot shows the
     dark disk edge at only ~15.7° above the boresight in the centre column → the rendered
     dark region is ~20° smaller than the predicted clip circle. That is inconsistent with
     ANY far plane ≥ 1000 for a 1010 u dome at 887 u (verified by ray math). So either the
     dark disk is NOT the far-clip cap of the dome, or the far plane in effect is not the
     constructor value.
   - Discriminating runs (each ~1 min, far variants in WorldManager.ts line 422):
     (a) far=500: if the disk shrinks → the constructor IS the live far plane and the disk
         is a clip artifact of something else with a larger radius; if the disk is
         unchanged → the live far plane is not this camera's.
     (b) far=2000: the disk should grow/shrink the opposite way (or vanish if it is the
         1010 u dome's clip).
     (c) If still ambiguous, add a TEMP in-page probe (page.evaluate) logging
         `worldManager`-level facts: camera.position, camera.far, dome mesh
         position/visible/haze (the dome material uniforms uHaze/uAtmoColor are exposed on
         `material.uniforms` — reach via scene traversal, or extend atmosphere-debug.ts),
         and compare camera.position to the ship's spot.
   - Also check whether the dark starry disk is the PLANET SURFACE or a background artifact
     rather than the dome: it is a smooth circle offset ~11° left of frame centre, and its
     "stars" are the skybox — a surface mesh would occlude the skybox, so verify by
     teleporting the aim spot to the opposite side of the dome (or 100 u off-centre in the
     other direction) and seeing whether the disk follows the ANCHOR or the TERRAIN.
   - Live-vs-PNG mismatch (45.5 vs 13.7 for the same run's band): the renderer runs with
     `preserveDrawingBuffer: true` (WorldManager.ts ~line 414, comment says e2e readPixels
     depends on it), so the buffer is preserved — yet live readPixels and the PNG of the
     same run disagree. Suspect SwiftShader buffer presentation timing (readPixels catching
     a mid-swap state) — re-run with a `page.waitForTimeout(500)` inserted between
     `canvasRegionStats` and `page.screenshot` and compare which one moves. Decide which
     signal the band value in the commit message should come from (the SPEC asserts the
     live value; the AC threshold is 5).
2. **Then re-attempt step 2 properly**: constructor → 1000, run the spec, record the
   central-band value; it must FAIL (≤ 5) for the AC. If the mystery shows the spec's
   band/geometry assumption ("cap spans ~67° from the nose, band spans 14-38° → band fully
   inside the cap") is simply wrong for a LEVEL nose — which the current evidence suggests —
   that is a SPEC problem, not an aim problem: the spec forbids changing TOP_BAND / the
   target / the assertion, and step 1 says yaw only (no pitch). In that case ESCALATE
   (DECIDE) with the measured numbers rather than loosening the assertion: the options are
   (A) allow a pitch-down aim at the dome centre (dome centre is 26.4° below horizontal —
   aiming there would put the whole cap in the top band pre-fix) vs (B) accept the current
   measured pre-fix value (13.7 PNG / 32-45 live) and revise the AC threshold. Do NOT pick
   one unilaterally.
3. **3× post-fix PASS (step 3)** as per spec, with the constructor restored to CAMERA_FAR
   (currently correct). Expect ~66-150 (instrumented runs read 74.5 live / 66.7 PNG).
   Screenshot after the last run must show hazy blue sky, not black.
4. **Close-out (step 4)**: remove the TEMP-TASK-76.1 block from the spec, `npx tsc
   --noEmit`, `npx vitest run src/client/world/world-manager.test.ts` (10/10), commit
   (spec + screenshot + handoff per the spec's step 4, Conventional Commit, note the client
   NaN-frame fix as the minimal src change), delete THIS handoff, LOG.md entry,
   `passes: true` bookkeeping.

## Dead ends

- Expecting the pre-fix run to FAIL at ≤ 5 with the level VTOL-hover aim: it passed twice
  (45.5, 32.4 live). The 0.0 readings at 22eab45 predate the VTOL hover; without hover the
  ship fell/landed during the aim and the attitude at measurement was non-level, which put
  the cap over the band. The level aim is deterministic — the old 0.0 was an accidental
  aim artifact, not the intended repro.
- Fitting the dark disk as a far-plane clip cone of the 1010 u dome at 887 u with
  far=1000 (grid-search over pitch/cap-angle in a throwaway script): best-fit residual
  5.7-6.6° with a nonsense pitch offset; the disk edge in the centre column (15.7° above
  boresight) cannot be produced by ANY far plane ≥ 1000 for that dome/distance. So the
  "disk = dome clip" model does not fit the pixels; do not keep refining it.
- `planetAnchor()` has no `.y` — a first TEMP-log version crashed with
  `Cannot read properties of undefined (reading 'toFixed')`; the dome centre is
  (anchor.x, 0, anchor.z).
- pngjs is not installed; reading pixels off a PNG required a chromium `file://` page +
  canvas copy (throwaway scripts used that; all deleted).

## How to verify

- Run: `cd app && npx playwright test --config playwright.e2e.config.ts atmosphere-sky`
  (fresh vite+server per run, ~30-60 s; 150 s test timeout; workers 1, retries 0).
- Watch for: `[TASK-76] aimed at the anchor: heading error <X>°` (must be < 6.9°),
  `[TASK-76] TEMP attitude: {...}` (the TEMP block — pitch/roll should be 0), and the band
  log line `central top band mean=<M> bright=<B>, full top band mean=<F>`.
- Screenshot: `.ralph/screenshots/TASK-76-1.png` (overwritten each run). Pre-fix it
  currently shows the dark disk + haze ring; post-fix it should be uniformly hazy blue.
- Type/lint: `cd app && npx tsc --noEmit`; unit: `npx vitest run src/client/world/world-manager.test.ts`.
- `git status --short` before committing: only the spec (after TEMP removal in step 4),
  the screenshot, the handoff, LOG.md, tasks.json — never the pre-existing dirty files.
