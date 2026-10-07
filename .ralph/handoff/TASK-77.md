# TASK-77 handoff — Camera drop-off (1/3): one writer for the self-ship pose

## Status
Steps 1–4 are implemented (probe recorder, drivePose policy, flight step as pre-render
frame hook) with 28 green unit tests; the e2e was written, the PRE-FIX baseline was
measured (FAIL as required), and the fix is applied in the working tree — but the e2e
AC (median displacement deviation ≤ 3 u) still FLAKES post-fix (PASS once at 2.99 u,
then 5.78 u and 8.05 u). Root cause identified (see Dead ends): headless frame times
vary 20–40 ms, so raw per-frame displacement cannot hold a fixed 3 u bound — the
assertion must be dt-normalized. Remaining work is the e2e assertion fix + full
verification + close-out bookkeeping. No time was spent on that; that is the next
iteration's job.

## Done
- **Step 1 (probe)** — `app/src/client/self-ship-debug.ts`: `SelfShipProbeResult`
  gained `camera: { pos: Vec3 } | null`; `SelfShipDebug` gained
  `startRecording()` / `stopRecording(): SelfShipFrameSample[]` (one sample per
  rendered frame, zero cost while not recording), `sampleFrame(sample)`,
  `recordReconcile(mode, correctionDistance)` and a live `reconcile` stats object
  ({blend, rewind, snap, lastCorrectionDistance}). Still `import.meta.env.DEV`
  guarded. Unit tests: `app/src/client/self-ship-debug.test.ts` (5 tests,
  happy-dom).
- **Step 3 (drivePose)** — `app/src/client/world/self-ship.ts`:
  `SelfShip.set(state, { place = true })` — pose skipped when `place: false`,
  create/rebuild/retint unchanged. `app/src/client/world/WorldManager.ts`:
  `setSelfShip(state, opts?: { drivePose })` — when false: no `cameraRig.setShip`,
  no steady-state pose write; a CREATED/REBUILT mesh IS placed once.
  `reEnterShip(pos, quat, opts?: { drivePose })` — rig fed only when drivePose or
  a character capsule exists (handoff destination). Unit tests in
  `self-ship.test.ts` (1 new) + `world-manager.test.ts` (new describe, 5 tests —
  drives the REAL WorldManager: `three`'s `WebGLRenderer` is `vi.mock`ed, rAF is
  scripted via `vi.stubGlobal`, `performance.now` is mocked to +16 ms/tick; rig
  behavior observed through `cameraSample()` because CameraRig keeps the ship pose
  private).
- **Step 4 (frame hook)** — `WorldManager.setFrameHook(fn)` invoked at frame START
  (before `cameraRig.update`, same nowMs/dt, ordering-contract comment in place);
  `setFrameSampler(fn)` invoked right after `renderer.render` (dev recorder).
  `app/src/client/main.tsx`: the flight loop's own rAF is replaced — its body is
  now `body(nowMs, dtSec)` registered via `setFrameHook` in the
  `[regimeWiring]` effect (cleanup unregisters; `flightStepRef` + the
  world-creation effect re-register on world re-creation). The body itself is
  unchanged. The frame sampler is bound in the world-creation effect next to
  `bindSelfShipDebug` (reads `selfShipView()` + `cameraSample()` +
  `projectToScreen`). The probe source now returns `camera: { pos }`.
- **Bridge (step 3 wiring + reconcile stats)** — in main.tsx's ship branch:
  `const predicted = shipPredictorRef.current !== null` BEFORE the calls, both
  `setSelfShip(..., { drivePose: !predicted })` and `reEnterShip(..., {
  drivePose: !predicted })`; the `reconcile(...)` result is fed to
  `selfShipDebug.recordReconcile(recon.mode, recon.correctionDistance)`.
- **Step 2/5 (e2e)** — `app/tests/e2e/chase-camera.spec.ts`: claim → join →
  `POST /api/dev/teleport` {x:0,y:50,z:3000} (rogue AI ships) → hold W until speed
  > 100 u/s AND settled ≥ 115 (scout cap 120) → record 3 s of frames → assert
  ≥ 90 frames and max |disp − median(disp)| ≤ 3 u; logs median/maxDev, implied
  speed, residual |disp − speed×dt| max+p95 (server 10 Hz vel via a WS tap),
  cam→ship min/max, reconcile counts; screenshot `.ralph/screenshots/TASK-77-1.png`.
  A TEMPORARY `[TASK-77-DIAG]` console.log block (dt stats + top-5 outliers) is in
  the spec right above the main log — DELETE it before the final commit.
- **Committed baseline checkpoint** — commit `c47024c` has everything above EXCEPT
  the two behavior-fix hunks in main.tsx (there main.tsx is in PRE-FIX state:
  separate rAF loop, no drivePose pass), so that commit is the honest baseline for
  re-measuring pre-fix numbers.

## Working tree
- Committed: `c47024c wip(TASK-77): probe frame recorder + drivePose options +
  measurement e2e (pre-fix baseline state)` (probe, options, unit tests, e2e,
  WorldManager hooks — main.tsx pre-fix).
- Uncommitted (the fix + e2e tuning): `app/src/client/main.tsx` (drivePose pass +
  flight step as frame hook), `app/tests/e2e/chase-camera.spec.ts` (steady-state
  wait ≥ 115 u/s + temporary DIAG block), new untracked
  `.ralph/screenshots/TASK-77-1.png` (fine to commit).
- `ralph.config.json` and `.ralph/logs/t761/` are dirty from BEFORE this task — do
  not commit them. The pre-existing dirty `.ralph/screenshots/*.png` mods — do NOT
  commit (task note).
- Builds: `npx tsc --noEmit` clean; the 3 touched unit files green (28 tests).
  Full unit suite not yet re-run.

## Next steps
In order (each is small; do them one per pass if short on time):
1. **Fix the e2e assertion to be dt-normalized** in `chase-camera.spec.ts`:
   headless frame times vary 19.6–40 ms (diagnosed, see Dead ends), so raw
   displacement can't hold 3 u at 120 u/s. Compute `vMed = median(disp[i]/dt[i])`
   (u/s) and assert `max over i of |disp[i] − vMed × dt[i]| ≤ 3` (keep the ≥ 90
   frame check; update the spec comment to explain the normalization — a snapshot
   yank of 10–20 u still blows this bound by far). Delete the `[TASK-77-DIAG]`
   block.
2. Re-run `npx playwright test --config playwright.e2e.config.ts
   tests/e2e/chase-camera.spec.ts` 3× (flakiness check). If runs with several
   `rewind`s still spike (rewind corrections are one-frame pose jumps written by
   the PREDICTION — TASK-79 will smooth them; this task must not change
   reconcile), correlate the spike with a rewind in the log and consider
   measuring the deviation as a RESIDUAL over the per-frame expectation is not
   enough if a rewind adds 2–3 u on a 40 ms frame; in that case log a DECIDE
   (p95 ≤ 3 vs max ≤ 3 with rewind frames excluded) rather than stretching the
   bound silently.
3. Regression e2e per spec step 5: `flight.spec.ts`, `self-ship.spec.ts`,
   `enter-ship.spec.ts`, `disembark.spec.ts`, `camera-handoff.spec.ts`,
   `warp.spec.ts` (they boot their own servers via `tests/e2e/fixtures.ts` — no
   `npm run dev` needed).
4. `cd app && npx tsc --noEmit`, full `npm run test`,
   `npx eslint --fix` + `npx prettier --write` on all touched files.
5. Close-out: LOG.md entry (top) with BASELINE and POST-FIX numbers (below),
   screenshot path `.ralph/screenshots/TASK-77-1.png`; set the 5 step `pass`
   flags true in `.ralph/tasks/TASK-77.json` and `"passes": true` for TASK-77 in
   `.ralph/tasks.json`; commit `fix(TASK-77): one writer for the self-ship pose —
   prediction drives before render, snapshots reconcile only`.

### Numbers recorded so far (for the LOG entry)
- **PRE-FIX baseline** (commit c47024c, 120 frames @ ~40 fps, 120.6 u/s): median
  disp 3.12 u, **max-dev-from-median 5.67 u (FAILs the 3 u AC)**, residual
  |disp − speed×dt| max 5.24 / p95 1.88 u, cam→ship 23.7–31.5 u, reconcile
  blend 72 / rewind 4 / snap 0.
- **POST-FIX runs** (working tree): (a) PASS — 118 frames, maxDev **2.99 u**,
  residual max 2.14 / p95 1.58, cam→ship 25.9–29.4 u, blend 75 / rewind 1 / snap 0;
  (b) FAIL 5.78 u (blend 71 / rewind 7); (c) FAIL 8.05 u (worst sample 11.12 u on
  a 39.7 ms frame = 280 u/s apparent; blend 73 / rewind 3). (b)/(c) predate the
  dt-normalized assertion; re-measure after step 1.

## Dead ends
- **Raw median-deviation AC at headless ~40 fps**: headless SwiftShader frame
  times vary 19.6–40 ms (DIAG: p50 26.2 / p95 36.6), so a smooth 120 u/s ship's
  per-frame displacement legitimately varies ~2.4–4.8 u → a 3 u raw bound fails
  ~half the time post-fix (2.99 / 5.78 / 8.05 across runs). Must normalize by
  each frame's own dt (Next step 1).
- **Waiting only for speed > 100 u/s** put the 100→120 acceleration ramp into the
  window (added the settle-at-≥ 115 wait); that alone did not fix the flake —
  the dt variance, not the ramp, is the main effect.
- A 3 s record window gives ~114–120 frames; the ≥ 90 floor is met but tight on a
  slow machine — bump to ~3.5 s if frame count becomes the failure.
- Not yet tried: excluding rewind-correction frames from the AC window (would
  need the recorder to stamp each sample with the concurrent reconcile mode or a
  timestamped event list). Only pursue if dt-normalization still flakes on
  rewind-heavy runs.

## How to verify
- Unit: `cd app && npx vitest run src/client/world/self-ship.test.ts
  src/client/world/world-manager.test.ts src/client/self-ship-debug.test.ts`
  (28 tests).
- E2E: `npx playwright test --config playwright.e2e.config.ts
  tests/e2e/chase-camera.spec.ts` (green 2–3× in a row; console line `[TASK-77]
  ...` carries the measurement).
- Types/lint: `npx tsc --noEmit`, `npx eslint --fix` + `npx prettier --write` on
  touched files; full `npm run test`.
- Visual: `.ralph/screenshots/TASK-77-1.png` — ship mid-flight, centered in the
  chase view.
