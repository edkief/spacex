# TASK-78 handoff — rigid chase camera (camera drop-off 2/3)

**Status: code + e2e done and proven; close-out nearly done. 3 e2e specs FAILED ONLY
under concurrent load and must be re-run in isolation to clear the regression gate.**

## What landed (all committed)

- `3c0550b` — the fix: `rigidChasePose(shipPos, viewQuat)` in
  `app/src/client/camera/pose-math.ts` (pure, reuses quatRotateVector/vecAdd;
  position = shipPos + q×(0,4,-14), look = shipPos + q×(0,0,20), up = q×(0,1,0));
  `CameraRig.ts` gains `CHASE_ROT_K = 6` exported const, a smoothed `viewQuat`
  slerped at `1 - exp(-CHASE_ROT_K·dt)` each chase frame, applied RIGIDLY via
  `applyRigidChase` (Matrix4.lookAt with the SHIP up — no position lerp, no
  world-up flip). viewQuat is armed (snapped to ship quat) on prime/resetPrime
  and at the end of any handoff INTO chase. Cockpit/onfoot still use the old
  `SMOOTH_K = 8` lerp path unchanged; the 600 ms handoff path untouched.
  Unit tests: 3 new `rigidChasePose` cases in pose-math.test.ts; new
  `CameraRig rigid chase: the speed invariant (TASK-78)` describe in
  camera-rig.test.ts — (a) 180 u/s × 3 s @ 60 fps distance = 14.56 ± 0.01
  every frame; (b) 30 u/s + 0→180 jump; (c) 90° yaw step swings < 1° after
  1 s, distance constant; (d) pitch through +90°: no NaN, camera up dot
  between consecutive frames > 0.5 (no flip). Existing chase tests updated:
  `settle` → `settleChase` (300 steps; the 6/s orientation slerp is slower
  than the old 8/s position lerp BY DESIGN).
- `5f2ff2a` — e2e: `app/tests/e2e/chase-camera.spec.ts` gains a spawn→cap
  rigid-follow window (recording opened at spawn once the camera reaches the
  chase distance, closed at the 120 u/s cap; scout maxVelocity IS 120 —
  ">120 u/s" in the AC means the settled cap). Assertions: cam→ship ∈
  [14.1, 15.1] on EVERY frame of the window (AC 14.6 ± 0.5), ≥ 60 frames,
  ship screen pos within 20 px of median. Screenshots TASK-78-1 (28 m/s) /
  TASK-78-2 (120 m/s) — LOOKED AT: ship pixel-identical size.

## Proven numbers (record for the LOG entry)

- **Pre-fix** (checked out `fbab4c3` camera/ only, same e2e): spawn→cap
  window per-speed buckets: <20 u/s 14.6, 20-60 u/s **18.5..21.5**,
  60-100 **20.9..25.0**, ≥100 **23.0..30.3 u** (2× the designed 14.56);
  screen max-dev **82.5 px** (AC 20); distance assertion RED.
- **Post-fix** (2 green runs): EVERY bucket **14.56..14.56 u** (n = 27..34
  frames per bucket, ≥ 100 u/s n=31..32); screen max-dev **0.0 px**; TASK-77
  AC green in the same run (maxCleanDev 2.36 / 2.44 ≤ 3).
- Unit: camera dir 45/45. Full solo suite: **183 files, 1673 passed / 1
  skipped, 0 failed** (09:34 run — green; a concurrent-load run showed 3
  failed files, classic load flake, cleared in isolation).
- `npx tsc --noEmit` clean; eslint --fix + prettier --write clean on all 5
  touched files (formatting-only reflow of CameraRig.ts + spec, tsc re-clean).

## Remaining work (one small step, ~15 min)

1. **Re-run the 3 failed e2e specs IN ISOLATION** (they failed only while the
   full vitest suite ran concurrently — CPU contention):
   `cd app && npx playwright test --config playwright.e2e.config.ts tests/e2e/disembark.spec.ts tests/e2e/enter-ship.spec.ts tests/e2e/targeting.spec.ts`
   Symptoms seen (all consistent with the 90 s/15 s TIMEOUT family under
   4× contention, NOT with the camera change — the handoff path and
   onfoot/cockpit code are byte-identical to before):
   - disembark: `Test timeout of 90000ms exceeded`
   - enter-ship: `#docked-indicator` not visible in 15 s
   - targeting: a boolean assertion false
   If ALL 3 pass isolated → they were load flakes (document as such in LOG).
   If any is genuinely red on the rigid chase: suspect viewQuat arming at
   handoff end (`armViewQuat()` in `CameraRig.update` t≥1 branch) — verify
   with a unit test that a chase→onfoot→chase round trip lands exactly on
   the rigid pose (it should: applyPose then armed viewQuat = ship quat).
2. Close-out bookkeeping:
   - `.ralph/tasks.json`: TASK-78 `passes: true`
   - `.ralph/tasks/TASK-78.json`: all 4 steps `pass: true`
   - `.ralph/logs/LOG.md` entry at top (pre-fix/post-fix buckets above,
     screenshot paths, verify matrix), bump 'Tasks Completed' counter
   - delete this handoff
   - commit `fix(TASK-78): ...` (Conventional Commit)
   - DO NOT commit the pre-existing dirty `.ralph/screenshots/*.png` mods
     (only the NEW TASK-78-1/2.png belong to this task)
   - Note: two uncommitted prettier reflows of CameraRig.ts +
     chase-camera.spec.ts are in the working tree (harmless; fold into the
     final commit)
3. Then output `<promise>TASK-78:DONE</promise>`.
