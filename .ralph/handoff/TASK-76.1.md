# Handoff: TASK-76.1 — Stabilize the atmosphere-sky e2e: deterministic aim, confirmed pre-fix FAIL + 3x post-fix PASS

## Status

~80% done. Step 1 (deterministic aim) is now genuinely fixed and converging 4/4 — this
iteration found WHY the old aim could stall (the surface control scheme has `yaw: null`,
so landing mid-aim disables 'd'/'a'; holding VTOL `space` hovers and keeps yaw live).
The remaining blocker (2/3 post-fix runs painting the WHOLE canvas black) is ROOT-CAUSED:
the chase camera position becomes NaN and stays NaN forever, because the ship feed into
`CameraRig` occasionally carries non-finite pos/quat values. Temp diagnostics to identify
the exact offending feed are in place but NOT YET RUN. Steps 2-4 of the task remain
(step 2's pre-fix FAIL value 0.0 is already recorded and valid).

## Done

- **Aim fix (REAL, keep) — `app/tests/e2e/atmosphere-sky.spec.ts`, the aim block:**
  - HOLD `page.keyboard.down(' ')` (VTOL) from before the calibration press until after
    the convergence assert, then `page.keyboard.up(' ')`. `VTOL_LIFT === GRAVITY`
    (`app/src/shared/physics/flight.ts` ~lines 124-130) → full VTOL demand is an EXACT
    hover, so the ship stays at ~60 u for the whole aim.
  - WHY: the SURFACE control scheme has `yaw: null`
    (`app/src/client/input/controls.ts`, `CONTROL_SCHEMES.surface`) — the instant the
    ship lands, `readInput` emits zero yaw and `d`/`a` are remapped to character move.
    Observed this iteration: aim stalled at 172.4° (hard assert fired) after the no-thrust
    ship hit the ground ~2 s into the turn. WITH VTOL: 4/4 runs converged (-2.4°, 0.4°,
    2.8°, 1.0°).
  - The comment block above the aim now documents this. Everything else in the aim
    (wall-clock loop, proportional press, AIM_SETTLE_RAD 0.05 exit, hard assert
    < 0.12 rad) is unchanged from the committed 22eab45.
- **Terrain hypothesis REFUTED** (scratch `app/terrain-check.mts`, now deleted — results
  recorded): for ALL ladder offsets (600/450/300/150 u) and heading error ±5°, the chase
  camera pose (ship − 14·forward, +4 u up) sits **48-75 u ABOVE terrain**. The camera's
  TARGET pose is never underground. Do not retry terrain offsets / ±180° re-aims.
- **Black-canvas root cause — NaN camera position, POISONED PERMANENTLY:**
  - The `cam` probe reads NaN in every failing run (JSON.stringify renders NaN as `null`
    — `{x:null,y:null,z:null}` is NaN, not "no camera").
  - A temp capture in `CameraRig.update` (see Working tree) logged the first non-finite
    target pose at **t ≈ 1818 ms — right after the chase camera arms** (arm happens at
    the warp gate pose (100, 0, 0)). First 3 frames: pos NaN AND quat NaN; then pos
    finite but quat NaN continues for many frames.
  - Once `curPos.lerp(NaN, x, f)` runs, `curPos` is NaN FOREVER (lerp with a NaN
    base-component is NaN for any finite x and f < 1) → the camera is unusable forever:
    no ship, no dome, no stars, persistent pure-black canvas. Exactly the observed
    flake signature. It is also consistent with the earlier 1/3 passing: the NaN feed is
    INTERMITTENT.
  - The ship MESH reads a finite quat via the probe in the same frames the RIG's ship
    state is NaN → the two feeds (`setSelfShip` 10 Hz wire path vs
    `setSelfShipTransform` 60 Hz prediction path, both in WorldManager and both feeding
    mesh + rig) are delivering different values at different times; the offender is one
    of the two.
- **Vite stale-bundle hypothesis RULED OUT**: a `window.__TM76 = 'fresh'` marker in
  `main.tsx` (temp) read back 'fresh' in every run — the dev harness always serves fresh
  code.
- `npx tsc --noEmit` clean with all the temp code in place (verified at handoff).

## Working tree

- HEAD = 22eab45 (committed: the deterministic aim v1 + pre-fix FAIL value 0.0 +
  passing-run screenshot `.ralph/screenshots/TASK-76-1.png` + prior handoff).
- Modified, UNCOMMITTED (committed with THIS handoff as wip):
  - `app/tests/e2e/atmosphere-sky.spec.ts` — the REAL VTOL aim fix PLUS temp
    diagnostics to REMOVE before the final commit: the `diagPose()` helper (reads
    pos/cam/pitch/fwd/screen incl. the new `cam` field), the `diag-arm` /
    `diag-ladder` / `diag-aim` console.logs, the 5-sample pose+full-canvas+top-band
    loop, and the `diag-nanframes` log (reads `window.__camNan`).
  - `app/src/client/world/WorldManager.ts` — TEMP ONLY (revert all before final commit):
    `debugCamera()` method (returns camera pos); `__feedNan` loggers at the TOP of
    `setSelfShip` (tags entries `['set', ms, posOk, rotOk]`) and
    `setSelfShipTransform` (tags `['tf', ...]`) — these record which feed path delivered
    non-finite values (`window.__feedNan = { total, bad[] }`).
  - `app/src/client/camera/CameraRig.ts` — TEMP ONLY (revert): a block at the top of
    `update()` that captures non-finite target poses (with the current `this.ship`
    state + dt) into `window.__camNan` (cap 20).
  - `app/src/client/main.tsx` — TEMP ONLY (revert): `window.__TM76 = 'fresh'` marker
    after `installCameraDebug()`; `cam: world.debugCamera()` added to the
    `bindSelfShipDebug` result object.
  - `.ralph/handoff/TASK-76.1.md` — this file.
- Pre-existing dirt — do NOT commit: `ralph.config.json`,
  `.ralph/screenshots/TASK-28.1-1.png`, `TASK-70-1.png`, `TASK-72-1.png`, `TASK-73-1.png`.
- Builds: `tsc --noEmit` clean (verified at handoff). No background processes (the vite
  one-shot check from this iteration self-terminated via `timeout 25`; verified with ps).
- NOTE on the commit constraint: the task spec's step 4 says the FINAL commit must
  contain only the spec (+screenshot+handoff). If the NaN feed turns out to be a real
  client bug that must be fixed in src (likely), the final commit will ALSO need the
  minimal src fix — that is a deviation from the spec wording that should be noted in
  the commit message; the alternative (spec-only workaround) would mean hiding a real
  bug and is not preferred.

## Next steps

1. **Identify the offending feed (the instrumented experiment is ready — run it):**
   - The spec currently reads `__camNan` (rig side) but NOT `__feedNan` (feed side).
     Add one line in the spec after the `diag-nanframes` log:
     `console.log('[TASK-76 diag-feednan] ' + await page.evaluate(() => JSON.stringify((window as unknown as { __feedNan?: { total: number; bad: unknown[] } }).__feedNan ?? 'none')));`
   - Run `cd app && npx playwright test --config playwright.e2e.config.ts atmosphere-sky`
     (a run is ~1-2 min; it will fail on the band assert — that's fine, the diag logs
     are what matter).
   - Read `diag-feednan`: entries tagged `set` = the 10 Hz WIRE path
     (`setSelfShip` ← `selfShipStateFrom` in main.tsx ← self entity_update);
     entries tagged `tf` = the 60 Hz PREDICTION path
     (`setSelfShipTransform` ← `ClientShipPredictor.getState()`, main.tsx ~line 1592).
     `total` tells you the feed cadence; `bad[]` timestamps vs the `__camNan`
     first-hit time (t ≈ 1818 ms, i.e. seconds from page load — VERY early, right at
     chase-arm / first entity / teleport) tell you where to look.
   - Upstream suspects, in order: (a) wire spawn/teleport frames carrying a partial
     state (check `selfShipStateFrom` + the entity bridge at main.tsx ~952/997/1024 —
     does any path call `setSelfShip` with an entity whose pos/rot is absent or
     `undefined` components? `e.rot ?? IDENTITY_ROT` covers rot, but pos has no guard);
     (b) `ClientShipPredictor` construction/reconcile: `lerpState`/`quatSlerp`
     (`app/src/client/net/prediction.ts`) with a NaN quat from the initial or
     reconciled state, or `reconcile` running before the first real snapshot.
   - Likely fix: guard the feed (skip non-finite pos/quat in `setSelfShip` /
     `setSelfShipTransform` / `ClientShipPredictor.step`) so a single bad frame can
     never poison the camera — the rig's lerp gives NaN no recovery path. Keep the
     guard minimal and unit-test it (pattern: world-manager.test.ts / prediction.test.ts).
2. **Revert ALL temp code** (the 4 files listed in Working tree, everything marked
   TEMP) and remove the spec diagnostics; keep only the VTOL aim fix.
3. **Step 3:** with the fix in, run the spec THREE times
   (`cd app && npx playwright test --config playwright.e2e.config.ts atmosphere-sky`,
   retries: 0); each run must pass on its own. Log per run: heading error, central top
   band mean (> 5; the measured pass reads ~66, not the "~150" estimate), bright,
   regime. LOOK at `.ralph/screenshots/TASK-76-1.png`: hazy blue, not black. The
   pre-fix FAIL (step 2) is ALREADY confirmed with the recorded value **central top
   band mean = 0.0** (far=1000, converged aim) — no need to redo it unless the spec's
   aim changed materially.
4. **Step 4:** `npx tsc --noEmit`; `npx vitest run src/client/world/world-manager.test.ts`
   (10/10) plus the test file of whatever src module you fixed; commit (spec +
   screenshot if changed + handoff deleted + the src fix file if any) with the task's
   message shape recording ACTUAL values: pre-fix 0.0, post-fix the three measured
   means. Then close: tasks.json `passes: true`, LOG entry (or leave the LOG to
   TASK-76.2 per the prior handoff's option).

## Dead ends

- **Chase camera inside terrain** (last handoff's leading hypothesis) — REFUTED by
  numeric sampling: camera pose is 48-75 u above terrain at all ladder offsets and
  ±5° heading error. Do not retry terrain/offset/±180°-re-aim workarounds.
- **Vite serving a stale bundle in e2e** — RULED OUT: the `__TM76` freshness marker
  read 'fresh' in every run this iteration.
- **Aim without VTOL** — the previous committed aim works only when the total yaw
  demand lands within the ~2 s of falling before the ship hits the ground; landing
  disables yaw entirely (surface scheme `yaw: null`) and the aim stalls (172.4° seen
  this iteration). The VTOL hover is the fix; do not drop the `space` hold.
- **Old aim (fixed 14 iterations holding `w`)** — up to 174.7° error, never resurrect.
- **preserveDrawingBuffer / readPixels race, settle transient after re-pin, mobile
  perf profile** — all RULED OUT in earlier iterations (persistent black, not
  transient; headless is desktop profile).
- **Writing scratch scripts to `/tmp/opencode/`** — the write tool refuses there; put
  scratch scripts inside `app/` and delete them after.

## How to verify

- Spec: `.ralph/tasks/TASK-76.1.json` (steps 1-4 + acceptance criteria). Parent context:
  `.ralph/split/TASK-76/TASK-76.json` (steps 1-2 committed at 135fd31:
  `CAMERA_FAR = 4000` + invariant unit test).
- Repro commands:
  - `cd app && npx tsc --noEmit`
  - `cd app && npx vitest run src/client/world/world-manager.test.ts` (10/10)
  - `cd app && npx playwright test --config playwright.e2e.config.ts atmosphere-sky`
    (~1-2 min incl. dev-server boot; output lines starting `[TASK-76`)
- Facts (seed DRIFT-SEED-0001, unchanged): densest pad system `9f065b79f5c34fd3`,
  density 0.0985, pad (20170, 229.0, 195); spot = pad + (600, 0, 0) at +60 u local
  altitude (ship ≈ (20770, 395, 195)); anchor (20000, 0) ≈ 794 u away, target heading
  ≈ -166°; dome radius 1010 u, far wall 1804 u; haze ≈ 0.93.
- Recorded values: pre-fix (far=1000): central top band mean = **0.0**, bright = 0
  (converged aim). Post-fix passing run: central band mean **66.0**, bright 83328,
  full top band 65.9.
- NaN evidence if re-verification is wanted: temp capture code is committed in this
  wip state (search `TEMP TASK-76.1` across the 4 modified files — every insertion is
  marked with that comment).
