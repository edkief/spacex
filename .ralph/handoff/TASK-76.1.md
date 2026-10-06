# Handoff: TASK-76.1 — Stabilize the atmosphere-sky e2e: deterministic aim, confirmed pre-fix FAIL + 3x post-fix PASS

## Status

All code work is DONE and committed (this iteration): the aim is deterministic (VTOL-hover
closed-loop yaw, 4/5 sampled runs converged < 3°), and the black-canvas flake is FIXED at
the source (client-side NaN-frame guards, unit-tested). What remains is pure verification:
one pre-fix FAIL run with the FINAL spec form (value 0.0 already recorded twice with the
new aim — see commit 22eab45 — re-confirm once), then 3 consecutive post-fix PASS runs,
screenshot check, and close-out. Delete this handoff in the completing commit.

## Done (this iteration)

- **Aim (REAL) — `app/tests/e2e/atmosphere-sky.spec.ts`:**
  - VTOL `space` held for the whole aim (`VTOL_LIFT === GRAVITY` → exact hover; the
    surface control scheme has `yaw: null`, so a landed ship would stall the aim).
  - Wall-clock deadline (9 s), proportional presses, AIM_SETTLE_RAD 0.05 exit, hard
    assert |err| < 0.12 rad before any measurement.
  - `aimProbe` now returns null on a NON-FINITE mesh pose and the loop RETRIES until
    the deadline (never steers on a NaN readout). This is what made the aim immune to
    the transient bad frames below.
  - After each press the loop waits 300 ms so the SERVER drains the last held turn
    frame before re-probing (the server holds a frame until the next input arrives).
    Without this, the first pre-fix check run ended at -7.0° (just past the 6.9°
    hard assert) because the final readout caught the drain overshoot. NOT yet
    re-run — that is step 1 of the next attempt.
- **Black-canvas flake FIXED (REAL, unit-tested) — root-caused this iteration:**
  - Mechanism: a single non-finite pose reaching the chase camera poisons its smoothed
    state FOREVER (`curPos.lerp(NaN-target, f)` / `curQuat.slerp(NaN)` is NaN for any
    finite target — no recovery path). The flake = an intermittent non-finite frame in
    the 60 Hz prediction feed (instrumented `__feedNan` capture in the wip commit
    9e3b970 showed every bad frame tagged `tf`, pos finite but quat NaN, re-poisoned
    every step and re-healed every 10 Hz reconcile — the classic "held NaN input"
    signature). The server REJECTS non-finite input frames (schemas.ts `finite`
    validator), so the poison is client-local: a transiently non-finite demand frame
    was adopted as the held control and/or replayed during reconcile.
  - Fixes (all committed):
    - `app/src/client/net/prediction.ts`: `ClientShipPredictor.step()` DROPS non-finite
      demand frames (not queued, not held) and never adopts a non-finite integrated
      state; `reconcile()` never adopts a non-finite reconciled state;
      `shipStateFromWire()` defaults vel→zero / rot→identity when ABSENT or
      NON-FINITE (an omitted vel used to spread to `{}` = undefined components, and a
      corrupt frame is truthy past `?? IDENTITY_ROT`).
    - `app/src/client/world/WorldManager.ts`: `setSelfShip` / `setSelfShipTransform`
      DROP non-finite feed frames (mesh + rig backstop, `poseFinite` helper).
    - Unit tests: `prediction.test.ts` "non-finite frame guard (TASK-76.1)" (3 cases)
      + shipStateFromWire absent-vel / corrupt-rot cases. 26/26 green in that file pair.
- **All TEMP diagnostics REMOVED** (spec diagPose/diag-*/5-sample loop, WorldManager
  noteBadFeed+debugCamera, CameraRig `__camNan` capture, main.tsx `__TM76` + `cam`
  probe field). `grep TEMP TASK-76|__feedNan|__camNan|__TM76|debugCamera src tests`
  is empty.
- Also removed the pre-existing unused `DOME_RADIUS_FACTOR` import in WorldManager.ts
  (lint error, only referenced in the CAMERA_FAR invariant comment).
- `npx tsc --noEmit` clean, eslint clean on all touched files, prettier applied.

## Working tree

- HEAD: the wip commit made with this handoff; tree clean apart from pre-existing dirt.
- The constructor is verified at `new THREE.PerspectiveCamera(70, 1, 0.1, CAMERA_FAR)`
  (the temp 1000 from the pre-fix check run was reverted before the commit).
- Pre-existing dirt — do NOT commit: `ralph.config.json`,
  `.ralph/screenshots/TASK-28.1-1.png`, `TASK-70-1.png`, `TASK-72-1.png`, `TASK-73-1.png`.

## Next steps (verification only — NO code changes expected)

1. **Pre-fix FAIL (step 2):** edit the constructor to `new THREE.PerspectiveCamera(70,
   1, 0.1, 1000)`, run `cd app && npx playwright test --config playwright.e2e.config.ts
   atmosphere-sky`. Expect FAIL on `central top band mean > 5` with a value ≤ 5 (two
   earlier runs read exactly 0.0; the fixed aim faces the clipped cap deterministically,
   so expect as dark or darker). Record the value. Restore the constructor to CAMERA_FAR
   and verify the line reads `new THREE.PerspectiveCamera(70, 1, 0.1, CAMERA_FAR)`.
   NOTE: the first attempt at this run (before the drain fix, this iteration) failed on
   the AIM assert at -7.0° instead of the band assert — with the drain fix it should
   converge < 3° and fail on the band (value expected ≤ 5, likely 0.0). If the aim
   STILL misses, check the `aimed at the anchor` line and add settle time, do not
   loosen the 0.12 rad assert.
2. **3× post-fix PASS (step 3):** with far=4000, run the same command THREE times
   (retries: 0 — every run must pass on its own, ~1.5-2.5 min each). Each run must log
   heading error < 6.9°, `central top band mean > 5` (expect ~66-150: this iteration's
   instrumented PASS run read mean 74.5, bright 83328, regime=atmosphere — the lower
   end is fine, the AC threshold is 5), and `regime=atmosphere`.
3. **Look at** `.ralph/screenshots/TASK-76-1.png` after the last run: hazy blue sky,
   NOT black.
4. **Close-out (step 4):** `npx tsc --noEmit`, `npx vitest run src/client/world/world-manager.test.ts`
   (10/10), then commit per the spec (spec + screenshot; note in the message that the
   commit includes the client NaN-frame fix as a minimal src change, per the handoff's
   deviation note), delete THIS handoff file, set `passes: true` in tasks.json if the
   ralph flow requires it for this task's bookkeeping (check how prior tasks did it —
   TASK-76.2 owns the full matrix/bench close-out, so keep this commit scoped to
   76.1's deliverables), LOG.md entry, Conventional Commit.
5. If a post-fix run FAILS: do NOT loosen the assertion. The guards make the camera
   unkillable and the aim immune to transient bad frames; a failure now would be an
   aim/geometry problem (check the `aimed at the anchor` heading-error line first).

## Decisions honored

- Feed-guard approach per the prior handoff ("likely fix": skip non-finite pos/quat so
  a single bad frame can never poison the camera) — implemented at BOTH the predictor
  boundary and the WorldManager feed boundary, with the predictor fix being the
  causal one (the server rejects non-finite inputs, so the wire is clean).
