# Handoff: TASK-58

Written by Ralph: the agent ran out of time without leaving a complete handoff,
so this records what the loop could see.

## Status

Iteration 22 did not finish the task: Iteration exceeded its 45m budget.

## Done

Commits made during the iteration:

```
8821a32 fix(TASK-58): DOM guard for CombatFx.stretched in Node bench runs; update handoff (driver + CI test green)
318c2b4 wip(TASK-58): merged ships, instanced ore, FX material pool, bench driver + script + CI test
```

## Working tree

Clean.

## Next steps

Read the agent's last messages below and any uncommitted changes, decide what is worth
keeping, then continue the task.

## Dead ends

Not recorded.

## How to verify

Follow the task spec.

## The agent's last messages

> the ship render path to merged, with a legacy option for the pre-tuning baseline:
>
>
> Now the OreRockLayer instancing pass:
>
>
> Now the CombatFx shared-pool pass. Adding the pool and shared geometries:
>
>
> Now the benchmark driver. Let me check the wire schema and hazard-discs API:
>
>
> Now writing the benchmark driver:
>
>
> Now the bench script and CI test:
>
>
> TypeScript is clean. Let me commit a checkpoint immediately, then run the benchmark:
>
>
> Time is nearly up (03:14 of 03:18). Let me try one quick verification of the driver, then write the handoff:
>
>
> Found it — `document?.` throws in Node (undeclared identifier). Fixing:
>
>
> CI test passes in 1.2 s. Time is up — committing the fix and writing the handoff now:
>
>
> Time's up. Handoff updated and everything committed (tree clean).
>
> ## TASK-58 — this iteration's progress
>
> **Implemented (all committed in 318c2b4 + 8821a32):**
> - **Merged ships** (`ship-mesh.ts`, `remote-ships.ts`): class silhouette baked into one geometry with per-ship vertex-color liveries + 3 shared state materials → 16 ships = 16 draw calls / 3 materials (was 112 / 48). Legacy path kept behind `merged: false` for the pre-tuning baseline.
> - **Instanced ore rocks** (`ore-rocks.ts`): per-resource InstancedMesh batches (≤ 8 draws / 8 materials vs 30 / 30), batch size from `PERF_PROFILES.high.instanceBatches`.
> - **FX material pool + shared geometries** (`combat-fx.ts`): no more per-flash material/geometry allocation churn.
> - **Benchmark driver** (`renderBenchmark.ts`): full AC-1 scene (16 orbiting ships in combat, 13-chunk streamed surface, 30 deposits, hazard discs + 4 drones, 20 labels), baseline-vs-tuned toggle, scene-graph tally as the renderer.info stand-in.
> - **`npm run bench:render`** (`scripts/bench-render.ts`): 1 baseline + 5 tuned 60 s runs, no-spike/draw/material/triangle/variance gates, records numbers to `.ralph/bench/TASK-58.json` for TASK-61.
> - **10 s CI test** (`render-benchmark.test.ts`): **passes in 1.2 s** (no-spike rule green).
> - Fixed a real bug found by the driver: `document?.` threw a ReferenceError in Node (`stretched()` now `typeof`-guarded).
>
> **Remaining (per updated handoff):** full unit-suite re-run after the ship/ore/fx rewrites, the first real `bench:render` end-to-end run (~3–6 min), perf.ts comment rewrite with the real numbers, WorldManager budget gauges, ≥ 30 % delta check, close-out.
> Handoff complete:
>
> - **Working tree**: clean — all work committed (318c2b4: tuning passes + bench driver + script + CI test; 8821a32: Node DOM-guard fix + updated handoff). `tsc --noEmit` and the 10 s CI bench test are green as of the last commit.
> - **Handoff**: `.ralph/handoff/TASK-58.md` is committed with the required headings (Status / Done / Working tree / Next steps / Dead ends / How to verify) — next session should re-run the full unit suite, then `npm run bench:render` end-to-end for the first real numbers.
> - **Background processes**: none running.
> - No step flags set, no `passes: true`, no promise output — the task is not done.

## The agent's incomplete handoff

> # TASK-58 handoff — LOD/impostor tuning to draw and memory budgets
>
> ## Status
> All four tuning passes are IMPLEMENTED and the benchmark driver + CI test
> EXISTS and the 10 s CI test PASSES (1.2 s wall, no-spike rule green).
> What remains is: run the full `npm run bench:render` (1 baseline + 5 tuned
> 60 s runs ≈ 3-6 min wall), re-run the full unit suite, rewrite the perf.ts
> "bench-run-1" comments with the REAL recorded numbers, WorldManager budget
> gauges, close-out. Task NOT complete; no step flag set yet.
>
> ## Done (all committed)
> - **5a0b2f2** (prior session): `src/shared/perf.ts` PERF_PROFILES table,
>   combat-fx FX caps + group expiry, profile-bridge.ts, live label cap,
>   frameMonitor maxFrameMs/frameSpikes, debug-overlay.test maxFrameMs fix.
> - **318c2b4** (this session):
>   - `src/client/render/ship-mesh.ts` — TASK-58 merged ship: class silhouette
>     baked into ONE geometry (per-class cached `mergedLayout`), per-ship
>     vertex-color buffer, THREE shared state materials (normal/dimmed/stale —
>     the stale rule is material selection, not per-material opacity).
>     `buildMergedShip` / `recolorMerged` / `shipStateMaterial` /
>     `stateKeyForOpacity`. 16 ships: 16 draw calls + 3 materials (was 112 + 48).
>   - `src/client/world/remote-ships.ts` (rewritten) — `createShipRender`
>     defaults to merged mode; `{ merged: false }` keeps the legacy 7-mesh +
>     3-material path (the bench baseline). `ShipRender` now carries
>     `classId` + `mergedMesh`/`legacyMesh` — remote-entities.ts updated
>     (`r.classId` in renderShip + shipProbes). Wrecks ride the merged path too.
>   - `src/client/world/ore-rocks.ts` (rewritten) — `OreRockLayer({ instanced
>     = true, batchSize })`: per-(resource, pulse-bucket) InstancedMesh batches
>     (4 resources × 2 buckets ≤ 8 draws, 8 materials; was 30 + 30).
>     `instanced: false` = legacy per-rock path (baseline). `instancedMeshCount`
>     probe; `views()` unchanged in shape.
>   - `src/client/world/combat-fx.ts` — FX material POOL (9 types, recycled,
>     never disposed) + module-level shared geometries (spark/impact/core/
>     wave/debris/tracerBody). `Flash.release` closure recycles per piece;
>     only unique geometries (laser line, tracer trail) are disposed. No more
>     per-flash material/geometry allocation churn. Also fixed
>     `stretched()` to use a `typeof document !== 'undefined'` guard — the old
>     `document?.documentElement` THREW a ReferenceError in Node (caught when
>     running the bench driver; commit 318c2b4 + the fix commit).
>   - `src/client/test/renderBenchmark.ts` (NEW) — the AC-1 benchmark driver
>     (DOM-free, transitionCycle pattern): 16 orbiting ships (8 player
>     liveries + 8 AI) firing lasers at rate + 16 in-flight missiles + a
>     destruction every 3 s; 13-chunk warmed streaming scene; hazard discs +
>     4 drones; 30 deposits in the 500 m ring (OreRockLayer); RemoteEntityLayer
>     labels with a real camera projector. `tuned` toggles merged-ships/
>     instanced-ore/capped-FX vs the legacy baseline. `runRender
