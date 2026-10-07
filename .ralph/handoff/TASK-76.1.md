# Handoff: TASK-76.1 — Stabilize the atmosphere-sky e2e: deterministic aim, confirmed pre-fix FAIL + 3x post-fix PASS

## Status

The DECIDE (Option A: pitch-down aim at the dome centre + pre-fix threshold 20) is implemented in
the spec, tsc-clean, and the pre-fix FAIL has been measured once (central top band mean 10.0 with
far=1000, aim converged). The task now hinges on ONE open problem: the new two-axis aim FLAKES at
the 12 s deadline — 3/3 post-fix runs died on the hard assert at 8.6/9.1/9.0° — so the aim loop
needs a measured-rate fix, then a fresh pre-fix (1×) + post-fix (3×) confirmation, then close-out.

## Done

- Spec aim block rewritten in `app/tests/e2e/atmosphere-sky.spec.ts` (the block from
  `--- Aim the nose at the dome CENTRE` through the two hard asserts):
  - `aimProbe()` (no args) returns `{yawErr, pitchErr, h, noseElev}` for target
    `domeCentre = {x: anchor.x, y: 0, z: anchor.z}` (the dome mesh is pinned to y=0;
    `planetAnchor()` has no `.y`). Nose = local +Z under the ship quat:
    `nx = 2(xz+yw)`, `ny = 2(yz−xw)`, `nz = 1−2(x²+y²)`;
    `yawErr = wrap(atan2(dz,dx) − atan2(nz,nx))`;
    `pitchErr = atan2(dy, hypot(dx,dz)) − asin(clamp(ny,−1,1))`.
  - Hover (`space`) for the whole aim — VTOL lift is VERTICAL and heading-independent
    (flight.ts `integrateStep`), so a ship pitched 26° down still hovers exactly.
  - 'd' sign calibrated as before (one 120 ms press, Δheading, wrapped); 'r' sign calibrated
    the same way (one 120 ms press, ΔnoseElev). Measured in the diag run: dSign=−1, rSign=−1
    ('r' LOWERS the nose — matches the controls.ts doc `pitch: ['r','f']`).
  - Loop vs `AIM_DEADLINE_MS = 12_000` wall deadline: probe, then press ONE axis at a time
    (yaw key → 300 ms drain → pitch key → 300 ms drain). Proportional press =
    `clamp(0.8 × |err| / 0.8 rad/s × 1000, 80, 450)` ms (80 % undershoot).
  - Hard-asserts BOTH `|yawErr| < 0.12` AND `|pitchErr| < 0.12` rad with explicit messages.
    Final log: `[TASK-76] aimed at the dome centre: heading error <X>°, pitch error <Y>°`.
- Assertion changed `toBeGreaterThan(5)` → `toBeGreaterThan(20)` (message: "top band must show
  the haze color, not the clipped cap"); header comment, TOP_BAND comment and flow comment
  rewritten with the measured seed numbers (pad at world-y ≈ 229 → haze ≈ 0.58 at the 60 u LOCAL
  spot because the shared hazeFactor uses WORLD-y altitude; clipped cap reads ~11-13; post-fix
  dome haze ~66; threshold 20 per the DECIDE, option A).
- The old TEMP-TASK-76.1 attitude block (former lines 412-460) is REMOVED.
- `npx tsc --noEmit` clean (the tsconfig includes `tests/`, so the spec is type-checked).
- **Pre-fix FAIL measured (step-2 evidence, once):** with the constructor temporarily at
  `new THREE.PerspectiveCamera(70, 1, 0.1, 1000)` and the 18 s diagnostic deadline, the aim
  CONVERGED (heading −1.9°, pitch +2.2°, start 14.2°/−27.2°, iter 1 28.0°/−13.4°, single loop
  iteration to convergence) and the run FAILED on the assertion: **central top band mean =
  10.00** ≤ 20. Log: `.ralph/logs/t761/prefix-run-diag.log`. WorldManager.ts then restored
  exactly (`git checkout --` verified empty diff; constructor line 422 back to `CAMERA_FAR`).
  NOTE: that run used an 18 s deadline (the diagnostic form) — the FINAL form ships 12 s, so
  re-confirm the pre-fix run in the final form (or ship 18 s, see Next steps).

## Working tree

- HEAD = previous wip checkpoint; THIS handoff commit adds the rewritten spec (aim + threshold
  20 + TEMP removal) and this handoff file. Nothing else changed.
- `app/src/client/world/WorldManager.ts` is at committed state (line 422 =
  `new THREE.PerspectiveCamera(70, 1, 0.1, CAMERA_FAR)`, CAMERA_FAR = 4000). Builds: tsc clean.
- Uncommitted PRE-EXISTING dirt — do NOT commit: `ralph.config.json`,
  `.ralph/screenshots/TASK-28.1-1.png`, `TASK-70-1.png`, `TASK-72-1.png`, `TASK-73-1.png`, and
  `.ralph/decisions.jsonl`.
- `.ralph/logs/t761/` — untracked raw run logs: `prefix-run-newaim.log` (combined-press stall
  18.1°/−12.5°), `prefix-run-newaim2.log` (one-axis-at-a-time, stalled −4.5°/−8.6° at 12 s),
  `prefix-run-diag.log` (THE pre-fix FAIL, band 10.0, 18 s deadline),
  `postfix-newaim-run{1,2,3}.log` (the 12 s deadline flakes: 8.6/9.1/9.0°).
- `.ralph/screenshots/TASK-76-1.png` on disk is the OLD level-aim post-fix frame (band 65.8) —
  the failed runs don't touch it (the screenshot call is after the assertion), the final
  post-fix run will overwrite it.
- `.ralph/measure-png.mjs` still exists (screenshot luminance tool); plan: delete it and this
  handoff in the FINAL close-out commit.
- No background processes. e2e command (fresh vite+server per run, ~30-60 s, 150 s test
  timeout, workers 1, retries 0):
  `cd app && npx playwright test --config playwright.e2e.config.ts atmosphere-sky`.

## Next steps

1. **Fix the aim flake in `app/tests/e2e/atmosphere-sky.spec.ts`** (the only real blocker):
   - Root cause (measured, not guessed): the server holds the last input frame and picks key
     events up at the 20 Hz tick (≤ 50 ms each end), so a press of `ms` actually rotates the
     ship by `rate × (ms + δ)` with δ ∈ [0, ~100 ms] ≈ up to 4.6° at 0.8 rad/s. The
     0.8×-undershoot press therefore overshoots by the constant `rate×δ` → a limit cycle of
     ~±9° when δ is large, 0-3° when small; the final probe reads the true oscillating value,
     so the run passes/fails on where the cycle sits at the deadline (3/3 consecutive post-fix
     runs failed at 8.6/9.1/9.0°; one 18 s run converged in ~3 s — a coin flip).
   - Fix (a): calibrate the EFFECTIVE rate per axis from the two 120 ms sign-calibration
     presses that already exist: `rateYaw = |Δh|/0.12`, `ratePitch = |ΔnoseElev|/0.12` (fall
     back to 0.8 if |Δ| < 1e-4), and use them in the proportional formula
     `ms = clamp(0.8 × |err| / rate × 1000, 80, 450)`. This absorbs δ into the calibrated rate.
   - Fix (b): raise `AIM_DEADLINE_MS` 12 s → 18 s (the 18 s form is the one with a measured
     convergence; the test's own timeout is 150 s so there is room).
   - Keep everything else: one axis at a time, 300 ms drains, 0.12 rad hard asserts on BOTH
     axes, hover for the whole aim, the re-pin teleport after the aim.
   - If the cycle persists after rate calibration: pre-compensate with
     `ms = max(30, 0.8 × |err| / rate × 1000 − δ_ms)` where δ_ms ≈ |Δ|/0.8 − 120 from the
     calibration press. Do NOT loosen the 0.12 rad asserts or the 20 threshold — both are AC.
   - Sanity: `cd app && npx tsc --noEmit`.
2. **Pre-fix re-run (final form):** edit WorldManager.ts line 422 → `1000`; run the e2e command;
   expect FAIL on the assertion with central top band mean ≤ 20 (last measured 10.0) and the aim
   CONVERGED (both errors < 6.9°). Record the value. Restore EXACTLY:
   `git checkout -- app/src/client/world/WorldManager.ts` + verify `git diff` empty.
3. **Post-fix 3× (final form):** with CAMERA_FAR=4000 restored, run the e2e command THREE times;
   every run must pass on its own: both aim errors < 6.9°, central top band mean > 20 (expect
   ~65-69), regime=atmosphere. The last run overwrites `.ralph/screenshots/TASK-76-1.png` —
   verify it is uniform hazy blue, no dark disk: `cd app && node ../.ralph/measure-png.mjs
   ../.ralph/screenshots/TASK-76-1.png` (expect topBand ~66; reference: pre-fix cap #060a11
   lum ~11, post-fix haze #314b65 lum ~75).
4. **Close out (one commit):** `npx tsc --noEmit`; `npx vitest run
   src/client/world/world-manager.test.ts` (must stay 10/10); check `git status --short` and
   commit ONLY: the spec, `.ralph/screenshots/TASK-76-1.png`, deletion of this handoff and of
   `.ralph/measure-png.mjs`, `.ralph/tasks/TASK-76.1.json` pass flags, `.ralph/tasks.json`
   `passes: true`, LOG.md entry (newest at top; record pre-fix 10.0 and the three post-fix
   values). NEVER the pre-existing dirty files. Commit message per the spec's step 4:
   `wip(TASK-76): deterministic atmosphere-sky e2e aim; pre-fix FAIL re-confirmed (central band
   mean <X>), 3/3 post-fix passes (~<Y>)` — with a note that threshold 20 is per the TASK-76.1
   DECIDE (option A). Then output the DONE promise.

## Dead ends

- Combined yaw+pitch in one `press()` call: the server's `quatFromEuler(yaw, pitch, 0)` then
  rotates about BOTH local axes at once (total rate √2×), so the proportional duration
  overshoots hard — measured stall 18.1°/−12.5° at the deadline. One axis at a time is
  mandatory.
- Proportional press at the NOMINAL 0.8 rad/s with short presses: the input-propagation
  latency δ adds up to ~4.6° per press → ~±9° limit cycle at the 12 s deadline → flaky hard-
  assert failures (measured 8.6/9.1/9.0° on 3 consecutive post-fix runs). Calibrate the
  effective rate from the calibration presses instead of assuming 0.8.
- Expecting the pre-fix run to read ≤ 5 at this seed: impossible — haze is 0.58 at world-y
  ~413 (hazeFactor uses WORLD-y altitude; the pad sits at y=229), not the spec's assumed 0.93.
  The DECIDE resolved it: threshold 20, and the pitch-down aim so the whole band sits in the
  clipped cap.
- Level yaw-only aim: the dome centre is 26° below a level boresight, so the band's top third
  sits over the VISIBLE (bright) dome — pre-fix band 28.6-43.2, and the old `> 5` assertion
  PASSED pre-fix (bug invisible). That is why the aim now pitches down.
- The "live ≠ PNG" buffer-timing hypothesis from earlier iterations: WRONG — live readPixels
  and the same-run PNG agree (33.2 ≈ 32.4). Don't chase SwiftShader presentation timing.
- `camera.far` is never touched after the constructor (only CameraRig fov + resize aspect), so
  the constructor arg IS the live far plane — no far-variant experiments needed.

## How to verify

- Aim: watch for `[TASK-76] aimed at the dome centre: heading error <X>°, pitch error <Y>°` —
  BOTH must be < 6.9° for the run to proceed.
- Pre-fix: `sed`-edit WorldManager.ts line 422 to `1000`, run the e2e command, expect
  `Error: top band must show the haze color, not the clipped cap` with `Received: ~10`;
  restore with `git checkout --` and verify empty `git diff`.
- Post-fix: three consecutive PASSes, `central top band mean=<M> bright=<B>` with M > 20
  (expect ~65-69), `regime=atmosphere`.
- Screenshot: `cd app && node ../.ralph/measure-png.mjs ../.ralph/screenshots/TASK-76-1.png`
  → topBand mean ~66, uniform (no dark disk, no bright sliver at the top rows).
- Types/units: `cd app && npx tsc --noEmit`; `npx vitest run src/client/world/world-manager.test.ts`.
- Before any commit: `git status --short` — spec, screenshot, handoff, measure tool, LOG.md,
  tasks files only; never the pre-existing dirty files.
