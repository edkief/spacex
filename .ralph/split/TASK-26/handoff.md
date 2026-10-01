# Handoff: TASK-26

Written by Ralph: the agent ran out of time without leaving a complete handoff,
so this records what the loop could see.

## Status

Iteration 5 did not finish the task: Iteration exceeded its 45m budget; Wrap-up exceeded its 10m budget.

## Done

No commits during the iteration.

## Working tree

Uncommitted changes when it stopped:

```
 M app/src/client/perf/frame-monitor.test.ts
 M app/src/client/ui/debug-overlay.test.tsx
 M app/src/client/world/chunk-geometry.ts
 M app/src/client/world/chunks.ts
 M app/src/shared/galaxy/surface.ts
?? app/src/client/world/chunk-scene.test.ts
?? app/src/client/world/chunks.test.ts
?? app/src/client/world/streaming-benchmark.test.ts
```

## Next steps

Read the agent's last messages below and any uncommitted changes, decide what is worth
keeping, then continue the task.

## Dead ends

Not recorded.

## How to verify

Follow the task spec.

## The agent's last messages

> The WIP is already committed (342f5ad), tree is clean. Let me verify the tsc errors and review the current modules.
>
>
> All 4 errors confirmed. Let me look at the relevant code and fix them.
>
>
> Now fixing all 4 tsc errors:
>
>
> One left — the debug-overlay test. I'll fix MOCK_STATS and add SURFACE-line assertions in the same pass:
>
>
> Now extend the frame monitor tests with gauge + category coverage:
>
>
> All 4 tsc errors should now be fixed. Let me verify and check the test setup:
>
>
> TSC is clean. Let me check the dev-seed fixture to pick the benchmark planet:
>
>
> Planet 0 (Torolm, ice, landable) is the fixture planet. Now I'll write the tests. First `chunks.test.ts`:
>
>
> I need to refine the streamer tests — the LRU interacts with impostor builds during warm-up. Let me rework the `warm` helper and the two streamer tests:
>
>
> Now fix the imports in chunks.test.ts:
>
>
> Now `chunk-scene.test.ts`:
>
>
> I need to make the scene tests robust against which impostors/cardinals are ready at warm-up exit. The scene's contract is to mirror `streamer.mountable()` exactly — let me rewrite:
>
>
> Now let me check the noise channel cost (it's computed per new build in scheduling, outside the 4 ms budget):
>
>
> `makeNoiseChannel` is cheap — good. Now the scripted-flight benchmark:
>
>
> Fixing a bug I left in the pop-in check loop:
>
>
> Now let's measure the benchmark on this box before finalizing the assert bounds:
>
>
> Fast box — 2.6 s total. Only 1 frame with incomplete 3×3. Let me see the full log output:
>
>
> All timing numbers are excellent (max slice 3.50 ms). But 1 frame had an incomplete 3×3 — let me find which one:
>
>
> Import paths were wrong — let me fix the diag file:
>
>
> No misses in the diag run — the earlier failure may be a one-off flake. Let me re-run the benchmark a few times:
>
>
> I've identified two issues: the max-slice jitter is spiking from 3.5 to 9.9 milliseconds due to garbage collection, and there's a rare 1-frame 3×3 miss. I'll try to log exactly when the misses occur:
>
>
> I've identified the root cause: at takeoff, the nearest-priority queue fills up with radially-symmetric chunks (including chunks *behind* the player), so by the time the forward diagonal `(2,1)` gets built, the player has already crossed the first boundary. The fix is to make the scheduling priority account for the direction of travel—chunks that are ahead along the player's direction of movement should get built before chunks at the same distance behind or to the side. This is what actually makes it possible to satisfy the "no pop-in within 100m of chunk edges at max speed" acceptance criterion.
>
>
> Now update the benchmark with the contract check (≤100 m of an edge), the stronger 3×3 property, and slice percentiles:
>
>
> Two known dangling references remain in the benchmark test. Let me quickly verify the new unit tests (excluding the known-broken benchmark) so the handoff is accurate:
>
>
> The run hung (300 s timeout). Let me isolate which file hangs, quickly:
>
>
> Those pass. Now isolate the scene test:

## An earlier handoff

> # TASK-26 handoff (2026-10-01)
>
> ## Status
> ~70% implemented: all core pipeline modules are written (staged chunk builder, scheduler + LRU, three.js scene layer, frame-monitor gauge/category extension, overlay line), but the working tree does not typecheck (4 one-line tsc errors, listed below) and NO tests have been written yet. The only verified result: the `surface.ts` refactor is bit-identical to the old code (golden fixture + snapshot + shard tests pass).
>
> ## Done
> All in the working tree (uncommitted):
> - `app/src/shared/galaxy/surface.ts` (MODIFIED): extracted `heightfieldChannels(seed, planet)` (planet-wide height/moisture fBm channels + amp) and `generateChunkPlacement(seed, planet, chunkX, chunkZ, heightmap)` (biome + pads + nodes, code moved verbatim). `generateSurfaceChunk` is now composition of both — same math, same order. VERIFIED bit-identical: `npx vitest run src/shared/galaxy/surface.test.ts src/shared/galaxy/snapshots.test.ts src/server/shard/shard.test.ts` → 43 passed (run this session, pre-tsc-errors).
> - `app/src/client/world/chunk-geometry.ts` (NEW): `CHUNK_METERS=320`, `NEAR_GRID=65`, `MID_GRID=33`, `RING_TRIANGLES {near:8192, mid:2048, far:2}`, `RING_BYTES` (Uint16 indices, 6 floats/vert → ~189 KB/chunk → 400 chunks ≈ 72 MB < 100 MB). `ChunkBuild`: resumable staged build, stages `height → placement → near-positions → near-index → mid → far → done`; `advanceUnit(now)` does ONE bounded unit (8 fBm rows ≈1 ms / placement / near-grid half w/ analytic central-difference normals / index / mid decimation / far flat-quad) and returns wall ms. Near grid is 65×65: column 64 is the next chunk's column 0 (world-space field), so border vertices are shared — no cracks; the 64×64 subset is bit-identical to TASK-5. `ImpostorBuild`: 1 unit = center-height fBm sample + flat quad, `chunk: null` (far-ring entries carry no world data).
> - `app/src/client/world/chunks.ts` (NEW): `chunkKey/parseChunkKey/chunkOfMeters/chunkCenterOffset`, `lodRingForDistance` (≤512 near, ≤2048 mid, ≤8000 far, else none — player→chunk-CENTER distance), `lodRingForChunk`, `activeSet(px,pz,speed)` → 13 at rest (3×3 + 4 cardinals at dist 2, i.e. "13 chunks in a 5×5 span") / 49 (7×7) at speed ≥ `FAST_TRAVEL_SPEED=100`, sorted nearest-first. `ChunkStreamer(seed, planet, {budgetMs:4, lruCap:400, clock, onChunkReady, onChunkEvict})`: `update(px,pz,speed)` re-derives active set, schedules missing (active full builds, then far-impostor window Chebyshev 6 ≈ 2.7 km horizon; dropped + rate-limited `perfWarn` when backlog ≥ `FAR_DROP_BACKLOG=8`), processes the nearest-first queue with a pre-unit budget check, LRU-evicts oldest non-active beyond cap (never active), returns `StreamUpdateStats {processedMs, scheduled, completed, evicted, farDropped, pending, ready, maxChunkWorkMs, triangles{near,mid,far}}`. `mountable(px,pz,speed)` = active∩ready (ring per distance) + ready far impostors outside the window; side effect: stamps `lastAccessFrame` so the LRU never evicts a mounted chunk. `
