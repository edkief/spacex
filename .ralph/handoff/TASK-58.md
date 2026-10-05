# TASK-58 handoff — LOD/impostor tuning to draw and memory budgets

## Status
All four tuning passes are IMPLEMENTED and the benchmark driver + CI test
EXISTS and the 10 s CI test PASSES (1.2 s wall, no-spike rule green).
What remains is: run the full `npm run bench:render` (1 baseline + 5 tuned
60 s runs ≈ 3-6 min wall), re-run the full unit suite, rewrite the perf.ts
"bench-run-1" comments with the REAL recorded numbers, WorldManager budget
gauges, close-out. Task NOT complete; no step flag set yet.

## Done (all committed)
- **5a0b2f2** (prior session): `src/shared/perf.ts` PERF_PROFILES table,
  combat-fx FX caps + group expiry, profile-bridge.ts, live label cap,
  frameMonitor maxFrameMs/frameSpikes, debug-overlay.test maxFrameMs fix.
- **318c2b4** (this session):
  - `src/client/render/ship-mesh.ts` — TASK-58 merged ship: class silhouette
    baked into ONE geometry (per-class cached `mergedLayout`), per-ship
    vertex-color buffer, THREE shared state materials (normal/dimmed/stale —
    the stale rule is material selection, not per-material opacity).
    `buildMergedShip` / `recolorMerged` / `shipStateMaterial` /
    `stateKeyForOpacity`. 16 ships: 16 draw calls + 3 materials (was 112 + 48).
  - `src/client/world/remote-ships.ts` (rewritten) — `createShipRender`
    defaults to merged mode; `{ merged: false }` keeps the legacy 7-mesh +
    3-material path (the bench baseline). `ShipRender` now carries
    `classId` + `mergedMesh`/`legacyMesh` — remote-entities.ts updated
    (`r.classId` in renderShip + shipProbes). Wrecks ride the merged path too.
  - `src/client/world/ore-rocks.ts` (rewritten) — `OreRockLayer({ instanced
    = true, batchSize })`: per-(resource, pulse-bucket) InstancedMesh batches
    (4 resources × 2 buckets ≤ 8 draws, 8 materials; was 30 + 30).
    `instanced: false` = legacy per-rock path (baseline). `instancedMeshCount`
    probe; `views()` unchanged in shape.
  - `src/client/world/combat-fx.ts` — FX material POOL (9 types, recycled,
    never disposed) + module-level shared geometries (spark/impact/core/
    wave/debris/tracerBody). `Flash.release` closure recycles per piece;
    only unique geometries (laser line, tracer trail) are disposed. No more
    per-flash material/geometry allocation churn. Also fixed
    `stretched()` to use a `typeof document !== 'undefined'` guard — the old
    `document?.documentElement` THREW a ReferenceError in Node (caught when
    running the bench driver; commit 318c2b4 + the fix commit).
  - `src/client/test/renderBenchmark.ts` (NEW) — the AC-1 benchmark driver
    (DOM-free, transitionCycle pattern): 16 orbiting ships (8 player
    liveries + 8 AI) firing lasers at rate + 16 in-flight missiles + a
    destruction every 3 s; 13-chunk warmed streaming scene; hazard discs +
    4 drones; 30 deposits in the 500 m ring (OreRockLayer); RemoteEntityLayer
    labels with a real camera projector. `tuned` toggles merged-ships/
    instanced-ore/capped-FX vs the legacy baseline. `runRenderBenchmark({
    frames, tuned, monitor, ... })` → p50/p95/max/spikes50Ms/drawCalls
    (scene-graph tally = renderer.info stand-in)/materialsMax/trianglesMax/
    maxLaserFlashes/maxDebrisSets/stageMs/wallMs.
  - `scripts/bench-render.ts` + `npm run bench:render` — 1 baseline + 5
    tuned 60 s runs, prints the table, FAILS (exit 1) on no-spike breach /
    draw ≥120 / materials ≥40 / triangles ≥500k / p95 spread ≥20 %, records
    the numbers to `.ralph/bench/TASK-58.json` for TASK-61.
  - `src/client/test/render-benchmark.test.ts` — the 10 s CI version (600
    frames, no-spike rule only) — **PASSES (1.2 s wall as of this handoff)**.

## Working tree
Clean (last commit = the `stretched()` document guard fix). No background
processes left running.

## Next steps (in order)
1. `cd app && npm run test` — FULL suite. The merged-ship + ore-rewrite +
   fx-pool changes have NOT been re-verified against the existing suites:
   `remote-entities.test.ts` (may assert zone materials / per-ship mesh
   counts), `ship-mesh.test.ts`, `world-manager.test.ts`,
   `debug-overlay.test.tsx`, `settings.test.ts`, fx-related tests.
   Fix fallout before trusting anything.
2. `cd app && npm run bench:render` (≈3-6 min) — the first REAL numbers.
   It writes `.ralph/bench/TASK-58.json` (add that file to git in the close
   commit). Expected risks: draw calls near 120 in the worst FX frame (if
   a burst coalesces 8 debris sets + 16 flashes + 16 tracers ≈ +144 FX
   calls; if it fails, tighten the script cadence or pool the laser lines
   into one LineSegments); p95 spread ≥ 20 % on a noisy machine (the tally
   stage is a per-frame scene walk — could dominate variance; if the spread
   fails, consider excluding the tally stage from the frame clock — it is a
   measurement, not pipeline work).
3. Rewrite the perf.ts comments: they cite a "bench-run-1" that did not
   exist — replace with the REAL recorded numbers from step 2.
4. WorldManager: register the profile budgets as gauges on frameMonitor
   (`registerGauge` draw-calls/materials/triangles from
   `PERF_PROFILES[settingsState().quality].budgets` at world build;
   `gaugeCheck` after `endFrame` with renderer.info +
   `renderer.info.memory.materials`).
5. AC-2 delta: bench:render prints the baseline→tuned p95/max delta; the
   ≥ 30 % target must hold (it comes from the ship-build one-shot spike +
   FX churn; if it does NOT hold on this machine, record absolute numbers,
   note it in LOG.md, and flag TASK-61 per AC-2's fallback clause).
6. Set TASK-58 step pass flags (steps 1-4) in .ralph/tasks/TASK-58.json,
   `passes: true` in .ralph/tasks.json, LOG.md entry, delete this handoff,
   eslint/prettier on touched files, commit.

## Dead ends / risks
- `document?.` in Node throws (ReferenceError) — use `typeof` guards in any
  DOM-free driver path (fixed in stretched(); audit similar patterns).
- The FX clock: CombatFx ages effects in REAL time (performance.now via
  frame(nowMs) dt) while the bench advances a SIM clock — a 60 s sim run
  takes ~30-60 s wall, so flash lifetimes are stretched ~1-2× in sim time
  (recorded in the report; does not affect the no-spike rule or budgets).
- The scene-graph tally runs INSIDE the measured frame (it is measurement,
  not pipeline work) — it can dominate the p95 spread; see next-steps.2.
- e2e NOT re-run: the merged ship changes the ship render path (e2e ship
  specs + screenshots may need a look; the unit suite is the gate for this
  task per the spec — e2e screenshots are cosmetic).

## How to verify
- `cd app && npx tsc --noEmit` (green as of handoff)
- `cd app && npx vitest run src/client/test/render-benchmark.test.ts`
  (green as of handoff, 1.2 s)
- `cd app && npm run bench:render` (NOT yet run end-to-end)
- `git show 318c2b4 --stat`
