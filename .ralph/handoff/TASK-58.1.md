# TASK-58.1 handoff (iteration 24, ran out of time ~05:12)

## Status
Steps 1-2 are DONE and verified: all three driver bugs fixed, and the first truly honest 60 s `npm run bench:render` was executed and recorded. Three of the five committed gates are now green (no-spike, p95 spread 8.5 %, triangles 88 k). The two budget gates — draws < 120 (measured 133) and materials < 40 (measured 72) — fail on the REAL AC-1 scene under the committed FX/scene design: this is the DECIDE candidate the previous handoff flagged, not a driver bug. Step 3 (gates green + numbers committed) not done.

## Done
All driver fixes are in `app/src/client/test/renderBenchmark.ts` ONLY (uncommitted; no combat-fx / chunk / tally-module changes):
1. **60 Hz pacing** — new `paceToRealTime` option (default `true`) + `sleepUntil()` (Atomics.wait on a SharedArrayBuffer slot, re-checked against the deadline). Frame N starts at `loopStart + N/60 s`; sleep is outside the begin/end-frame window. Each 3600-frame run now takes ~60.1 s wall.
2. **FX slow-mo stuck** — fixed by pacing alone (sim time == real time now). Debris `sets=2` (was 40), missiles bounded. NO combat-fx.ts change needed or made.
3. **Frustum-culled tally** — the renderer.info stand-in now builds the camera frustum per frame (`setFromProjectionMatrix` from `projectionMatrix * matrixWorldInverse` after `updateMatrixWorld()`) and counts only draw objects whose `boundingSphere` intersects (respects `frustumCulled === false`), matching three.js. Draws fell 151→133 vs the unculled scene-graph tally.
4. **Determinism** — missile spawn phases from `new Rng(seedFromString(`${seed}:${starId}:missiles`))` (`@shared/random`); the `Math.random()` is gone.

Full bench run executed (log `/tmp/bench-render-2.log`; recorded to `.ralph/bench/TASK-58.json`, `pass: false`):
- BASELINE: p50=0.559 p95=1.059 max=3.622 spikes=0 draws=157p95/159max mats=72 tris=90794 wall=60.2 s
- TUNED 1-5: p95=1.689/1.689…1.841 ms, spikes=0 every run, draws=131p95/133max, mats=72, tris=87986, wall≈60.1 s each
- p95 spread across 5 tuned: **8.5 % < 20 % ✓** (was 20.9 % noise unpaced)
- FAILURES (every tuned run): **draws 133 ≥ 120** and **mats 72 ≥ 40** only.
- Delta note (NOT a gate this task — TASK-58.2's): p95 went 1.059→1.689 ms, i.e. the legacy baseline is FASTER in main-thread ms on this headless proxy while winning draws (157→131). The CPU proxy favors the legacy path here; don't chase it this task.

## Working tree
- Committed so far: e5ac88f (prev WIP: prettier refresh + first unpaced bench record).
- Uncommitted since: `app/src/client/test/renderBenchmark.ts` (all fixes above), `.ralph/bench/TASK-58.json` (paced-run record, `pass: false`), this handoff.
- Builds/verified: `npm run typecheck` ✓, `npm run lint` ✓, CI bench test ✓ (~11 s, paced). Full `npm run test`: 177 files / 1592 passed / 1 skipped plus ONE flaky failure in `src/client/ui/combat-hud/combat-hud.test.tsx` ("per-frame projection stays under the hud budget", line 400 `stats.warnings` — a single rAF tick beat the ~1 ms hud budget on a machine hot after the 7-min bench; passes in isolation, not a regression from this diff).
- No background processes left (bench finished; no dev server).

## Next steps
The remaining failures are structural, not driver bugs:
- **mats=72 vs < 40**: the FX pool recycles material *objects* but each live FX piece holds its own material *instance* — 16 tracers × (body+trail) = 32 instances at steady state alone, plus debris pieces, ships, biomes, discs, sky/stars. Unreachable below 40 without either sharing ONE material instance per FX type (a `combat-fx.ts` change = new FX tuning, out of this task's scope) or re-scoping what "materials" counts.
- **draws=133 vs < 120**: ~40 chunk meshes surviving frustum cull (13 active + far-ring horizon impostors) + 16 merged ships + 32 tracer objects + debris + ore instances + hazard quads + sky/stars.

This is the DECIDE the previous handoff predicted. Options for the human:
- **(A) Revise the two budgets** in `app/src/shared/perf.ts` `PERF_PROFILES.high.budgets` to the measured steady state (draws ~140, mats ~80) — perf.ts comments already say the numbers are "bench-run-1" placeholders; touches the "no new tuning" line, hence DECIDE.
- **(B) Match the bench scene to AC-1's documented description**: cap the mountable set at the 13 active chunks (driver-side: stop adding far-ring impostor entries from `streamer.mountable()` in the driver's warm-up/sync) — in scope as a driver fix; frustum cull + 13 chunks may get draws < 120, but mats still needs the FX-instance question.
- **(C) Commit the run as-is** (exit-1 record) and hand the two budgets to TASK-58.2.
If told (B): edit the driver's `chunkScene.sync` input or filter `mountable()` results to the active set, re-run `npm run bench:render` (~7 min) and see where draws/mats land; if (A): edit the two numbers + comment, re-run, exit 0.

Then, to close: `npm run bench:render` until exit 0 (~7 min); `npx vitest run src/client/test/render-benchmark.test.ts` green; final `npm run test` (~2 min; if combat-hud flakes, re-run that file in isolation and note it); set `passes: true` + all three step flags in `.ralph/tasks.json` / `TASK-58.1.json`; LOG.md entry; delete this handoff; commit; output the promise.

## Dead ends
- (Carried over) Sub-millisecond frame times were the unpaced driver (now fixed). Don't rename `_url`/`_init` args in settings-panel tests (fix lived in eslint config). `document?.` in Node code throws ReferenceError — keep `typeof` guards in bench-path code.
- **New**: pacing + frustum culling CANNOT get materials < 40 — the committed FX pool design allocates one material instance per live FX piece (32 tracer instances at steady state). Don't try to "fix" the material tally to share pooled instances; that would change what the number measures.
- **New**: `combat-hud.test.tsx` hud-budget test flakes when the machine is hot (right after the 7-min bench). Not a regression — verify in isolation before touching it.
- **New**: do not chase the p95 DELTA (legacy baseline is faster in CPU-ms on this headless proxy) — the delta is TASK-58.2's and is not a failure gate here.

## How to verify
1. `cd app && npm run typecheck && npm run lint` → green.
2. `npx vitest run src/client/test/render-benchmark.test.ts` → green in ~11 s (paced 10 s variant).
3. `npm run bench:render` → ~7 min; current state exit 1 with ONLY the draws/mats gate failures (numbers in "Done" above).
4. `.ralph/bench/TASK-58.json` holds the paced baseline + 5 tuned runs (`pass: false` until a gate fix).
