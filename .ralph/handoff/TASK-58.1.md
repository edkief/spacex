# TASK-58.1 handoff (iteration 23, ran out of time ~04:21)

## Status
Step 1 (full green: typecheck / lint / 178-file unit suite) is DONE and committed (e7edb34). Step 2 got its FIRST EVER end-to-end `npm run bench:render` run — it completed all 6 runs but exited 1, and I diagnosed WHY (three distinct driver bugs, none of them the committed gates). Step 3 (gates green + numbers committed) not started.

## Done
- **Step 1 complete (committed e7edb34)**: fixed 23 eslint errors (mostly unused imports/vars across bench driver, tests, shared modules); added `argsIgnorePattern: '^_'` to eslint.config.js (the underscore-arg style in settings-panel tests is pre-existing codebase style — the config lacked the convention, so DON'T rename those args); 2 remote-entities tests rewritten to assert the merged-ship (TASK-58) vertex-color livery/trim semantics (`shipVertexColors`/`colorIs` helpers, linear-working-space compare). Verified: `npm run typecheck` + `npm run lint` + `npm run test` → 178 files, 1593 passed / 1 skipped (ran twice, green both times).
- **First real 60 s bench run executed** (`npm run bench:render`, log was /tmp/bench-render-1.log, uncommitted record in `.ralph/bench/TASK-58.json` — `pass: false`, will be overwritten by a later run). Results:
  - BASELINE: p95=0.283ms max=0.391ms spikes=0 draws=175p95/177max mats=90 tris=91530 wall≈1235ms
  - TUNED (all 5): p95 0.262–0.323ms, spikes=0, draws=149p95/151max, mats=90, tris=88722, wall≈0.7s each
  - FAILURES: draws 151 ≥ 120 and materials 90 ≥ 40 (every tuned run) + p95 spread 20.9 % ≥ 20 %.

## Working tree
- Committed: e7edb34 (all of step 1). Since then: `app/src/client/world/remote-entities.test.ts` prettier-reformatted only (no functional change, lint green) — uncommitted, and untracked `.ralph/bench/TASK-58.json` (failed-run record).
- Everything builds: typecheck ✓, lint ✓, unit tests ✓ (full suite, 2×). Debug instrumentation I used was REMOVED from `app/src/client/test/renderBenchmark.ts` before this handoff; the file is back to its committed state + the step-1 lint fixes.
- Kill nothing: no dev server or background process is left running.

## Next steps
The run exposed three driver bugs (fix ONLY in `app/src/client/test/renderBenchmark.ts` / `scripts/bench-render.ts`; NO scene tuning, NO new passes):

1. **The driver does not pace frames to 60 Hz.** 60 s of simulation runs in ~0.7–1.2 s wall (each `runRenderBenchmark` call: 3600 frames back-to-back). Spec expects ~60 s wall/run. Consequences: (a) frame times are sub-ms timer noise → the p95-spread gate (AC-6) compares 0.262–0.323 ms values, so 20.9 % "spread" is noise; (b) FX time is decoupled from real time (below). FIX: pace the loop in `runRenderBenchmark` — target wall time per frame `frameIndex / BENCH_FRAME_HZ * 1000` from run start (sleep/spin between frames, `setTimeout` or a busy `Atomics.wait`/`Date.now()` loop; ~16.7 ms/frame). Keep `wallTimeoutMs` (180 s/run) — it will now be realistic. Re-run after this; p95/spread/spikes become meaningful and the spread gate should stop tripping.
2. **FX slow-mo is stuck ON in the bench.** `CombatFx.frame(simMs)` advances its virtual `fxTime` by `simMs` deltas, but `armSlowMo()`/`timeScale` read `performance.now()` (real time). Unpaced, explosions fire every 3 s SIM ≈ 50 ms REAL, so the 1 s real-time slow-mo window never expires → `timeScale` stays 0.3 the whole run → 3 s-FX-time debris lives ≈10 s of sim → the capped 4 debris SETS (40 pieces) + 16 tracer pairs (32 objects) sit in the scene permanently. This is why draws grow 90→151 and materials 29→90 over the run (I measured per-frame tallies: f=29 calls=90/mats=29 → f=599 calls=138/mats=77, still climbing at 3600). Fixing (1) makes sim-time == real-time and this resolves itself; verify after the re-run.
3. **Scene is 50 mounted chunks, not the AC-1 "13 chunks".** Warm-up asserts `mountedCount >= BENCH_MOUNT_TARGET (13)` but the streamer's steady state at high-preset LOD radii (512/2048/8000 m) is `mountedCount = 50` (incl. far-ring impostors) — "streaming backlog 13 / farDropped 37" log lines confirm. The 50-chunk tally (≈42 calls / 9 mats for the chunk scene alone, measured at frame 359) plus FX is what pushes over the < 120 / < 40 budgets. Decide after re-running with pacing: the budgets in `PERF_PROFILES.high.budgets` were "bench-run-1"-derived placeholders (perf.ts comments say so), and this task's gates are the *committed* ones in `scripts/bench-render.ts` — if the paced, steady-state scene still exceeds draws < 120 / mats < 40, the honest fix within scope is either (a) making the bench scene match its documented AC-1 description (e.g. cap mounts at the 13 near/mid chunks, or frustum-cull the tally like a real renderer — I prototyped a frustum-culled tally variant, it was removed; far chunks behind the camera were ~35 of the 50) or (b) revisiting which numbers the gates should compare (that touches the "no new tuning" line — if truly ambiguous, that is the one DECIDE candidate). Do NOT merge chunk meshes or add passes (TASK-58.2's job).

Also noted (minor, in scope): missile spawn phases use `Math.random()` in the driver (renderBenchmark.ts, `missiles.push({ phase: Math.random() * ... })`) — a benchmark should be deterministic; seed it (e.g. `Rng` from `@shared/random`).

Then: `npm run bench:render` until exit 0; keep the 10 s CI test green (`npx vitest run src/client/test/render-benchmark.test.ts`); if frames > 50 ms appear once paced and GC is the cause, mirror `NODE_OPTIONS=--expose-gc` into the `bench:render` package.json script (the task spec explicitly allows this); commit `.ralph/bench/TASK-58.json`; final `npm run test`; close out (passes:true, LOG.md, tasks.json steps).

## Dead ends
- Sub-millisecond "frame times" are not a machine problem — the driver is unpaced (see Next steps 1); don't chase GC or machine perf before pacing.
- The materials=90 baseline-vs-tuned parity is NOT a tally bug: legacy per-ship materials (16×3=48) vs merged (3 shared) is real, but FX + 50 chunks + labels drown the difference; per-subtree tallies (measured) attribute it as above.
- Don't rename the `_url`/`_init` args in settings-panel.test.tsx — the lint fix belongs in eslint config (done in e7edb34).
- `document?.` in Node code throws ReferenceError (old finding, still true) — keep `typeof` guards.

## How to verify
1. `cd app && npm run typecheck && npm run lint` → green (currently so).
2. `npm run test` → 178 files, 1593 passed / 1 skipped, ~2 min (currently so).
3. Paced driver re-run: `npm run bench:render` (~8–10 min now that runs are paced) — watch the printed table: want spikes=0, draws<120, mats<40, tris<500k per tuned run, spread<20 %, exit 0.
4. `npx vitest run src/client/test/render-benchmark.test.ts` (10 s CI variant) stays green.
5. `.ralph/bench/TASK-58.json` shows `pass: true` with baseline + 5 tuned runs → commit it.
