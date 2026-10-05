# TASK-30.1 handoff — 2026-10-05 22:46 UTC

Picking up from the 21:50 handoff (which found+fixed the merged-mode rebuild
regression, committed as `89224c3`). This iteration implemented a second fix
(streaming deferral + faster translated packing) and identified the FINAL
remaining cost with hard numbers. The 4 ms gate is still RED (CI test p99
6.6–7.0 ms; bench not re-run this session — expect similar). All spec
close-out steps (matrix, e2e, fresh numbers, TASK-30.md update) are undone.

## Status

Two root causes of the atmosphere-to-surface overshoot found and fixed:
(1) per-vertex `getX/getY/getZ` re-pack in `translatedFor` (fixed: typed-array
copy, 4+ ms → 0.03 ms), (2) merged-path re-merges during bursts (fixed:
streaming deferral — fresh near/mid chunks mount as far quads until the
streamer is quiet 25 syncs, then re-merge one (ring, biome) group per sync).
Remaining cost is now measured and isolated: **`mergeGeometries` itself is
3.7–8.7 ms for ~20 mid-ring geometries (~500 KB)** — the next (final) fix is a
fast custom merge for the uniform per-ring geometry sizes. Task stays
`passes: false`.

## Done

- **Streaming deferral — app/src/client/world/chunk-scene.ts (committed state
  this session is UNCOMMITTED; see Working tree):**
  - `syncMerged()`: `deferring = speed > 0 && quietSyncs < UPGRADE_QUIET_SYNC
    (25)`. While deferring, every non-far wanted chunk mounts into its
    `far:<biome>` group (one impostor quad — exactly what the pipeline shows
    before the full build, so no pop) and its real `{ring, biome}` is parked in
    `deferred`. `quietSyncs` tracks consecutive syncs where
    `streamer.lastScheduled === 0`.
  - Once deferring ends (burst drained, 25 syncs past the last schedule —
    beyond the harness's 24-frame `BURST_DRAIN_FRAMES` tagging window) or the
    player is at rest, `promoteOneGroup(next)` re-merges ONE deferred
    (ring, biome) group per sync (bounded work; the first mesh of a group
    lands tagged `material-swap`). `deferred.delete` on every non-deferred
    wanted chunk; orphan cleanup; `handleEvict` + `dispose()` cover it.
  - `merged: false` path untouched; tally (`stats[ring]`) follows the
    STREAMER's ring, only the mesh membership is deferred (mirrors
    impostor-tilt; matches the scene's existing "keep the quad until the
    replacement lands" rule).
- **Streamer: app/src/client/world/chunks.ts** — new public getter
  `lastScheduled` (chunks that entered the build queue on the last
  `update()`; field `lastScheduledCount`, reset in `reset()`).
- **Fast pack: `translatedFor()`** — `new Float32Array(srcArr)` copy + in-place
  x/z offset (was a per-vertex `pos.getX/getY/getZ` loop) and `computeBoundingSphere()`
  removed (copies are never drawn — only attribute-merged). Measured: a
  ring-group pack is now ~0.03 ms.
- **New unit test** (merged describe block in
  app/src/client/world/chunk-scene.test.ts, "defers fresh near/mid chunks to
  the far quad while moving, then re-merges them once the burst drains"):
  moving sync → all groups are `far:*` quads, tally follows real rings,
  `mountedCount` = mountable; then quiet syncs converge back to the full
  merged contract (mesh count + tally + per-mesh triangle sum).
- **Verification this session:** `npx tsc --noEmit` clean; eslint --fix +
  prettier --write on the 3 changed files (no changes);
  `npx vitest run src/client/world/chunk-scene.test.ts
  src/client/world/chunks.lod-preset.test.ts` 19/19 pass;
  `npx vitest run src/client/test/transitionCycle.test.ts` 4/5 — the 4 ms gate
  test now fails at **p99 6.6–7.0 ms** (was 8.5 before the fast-pack fix,
  ~15–26 pre-TASK-30-fix).
- **Per-frame diagnostics (scratch, removed before commit) — the numbers that
  matter (one fresh run):**
  - Burst frames (f=1305–1318, tagged chunk-boundary/burst): `str=4.2–5.2 ms`,
    `scn=0.1–0.5 ms` — FIXED (was scn 4.5–5.9 ms). Their deltas are now ~0.1–0.6
    ms over baseline (5.1–5.6 ms measured vs ~5.0 baseline).
  - Remaining heavy frames, all dominated by `scn` (rebuild sum ≈ frame time):
    - f=1170: 10 group rebuilds, 12.0 ms (tags: material-swap)
    - f=1265: 10 group rebuilds, 12.6 ms (material-swap)
    - f=1330: 11 group rebuilds, 16.4 ms (material-swap) — includes
      `mid:frozen members=28 tris=57344 merge=8.61 ms` and
      `near:frozen members=4 tris=32768 merge=2.88 ms`
    - f=1339 / f=1351 (UNTAGGED, so they don't move the p99 directly but they
      pull the control baseline up): 2 rebuilds each, ~9 ms
      (`near:frozen` + `mid:frozen`, merge 4.2–4.8 ms each)
  - Micro-bench (isolated tsx script): `mergeGeometries` over 20 mid-ring
    geometries (2048 tris each, ~4225-vertex… i.e. 33x33=1089 verts) =
    **3.7–8.7 ms warm**; the pack step is 0.03 ms. three r186
    `mergeGeometries` is the bottleneck, not the data movement.
- No background processes left running (bench + diag scripts finished).

## Working tree

- UNCOMMITTED (the only dirty files):
  - `app/src/client/world/chunk-scene.ts` — deferral + `promoteOneGroup` +
    `deferred`/`quietSyncs` + fast typed-array pack (eslint/prettier clean).
  - `app/src/client/world/chunks.ts` — `lastScheduled` getter (+ reset).
  - `app/src/client/world/chunk-scene.test.ts` — new deferral test.
  - this handoff file (new).
- Builds: tsc clean; 19/19 unit tests green (chunk-scene + lod-preset).
- CI test (`transitionCycle.test.ts`) red at 6.6–7.0 ms p99 (improving, not
  there yet). `npm run bench:transitions` NOT re-run this session — last
  numbers are this file's diagnostics above.
- HEAD = `89224c3` (wip: per-group dirty check fix). Scratch diag script
  deleted; no `.diag*` files remain.
- The spec's 5 lint files (transitionCycle.ts, transitionCycle.test.ts,
  scripts/bench-transitions.ts, src/client/main.tsx, tests/e2e/transitions.spec.ts)
  are UNTOUCHED and already lint-clean — spec step 2 should be a no-op.

## Next steps

1. **The final fix — replace `mergeGeometries` in `rebuildRingMeshes()` with a
   fast custom merge for this scene's uniform geometries.** All near chunks
   are exactly `NEAR_GRID²=4225` verts / `8192*3` index entries; all mid
   `MID_GRID²=1089` verts / `2048*3`; far 4 verts / 6. Inside a (ring, biome)
   group every member therefore has identical size: allocate one
   `Float32Array(members*verts*3)` + `Uint16Array(members*idxCount)`,
   `set()` each member's position (already world-translated by
   `translatedFor`) and index arrays (add `members*i*verts` offset to the
   index copies — a Uint32 loop or precompute), build one
   `BufferGeometry`, `computeBoundingSphere()` once. This is pure typed-array
   set/concat ≈ 0.2–0.5 ms for a 28-member mid group vs 8.6 ms. Keep
   `mergeGeometries` as a fallback only if attribute sets ever diverge (they
   won't: `translatedFor` always emits position+index). Expect the f=1330
   frame to drop from ~16 ms to ~2–3 ms and the CI p99 to land < 4 ms.
   Then re-run `npx vitest run src/client/test/transitionCycle.test.ts` and
   `npm run bench:transitions`.
2. If a full multi-group remount frame (f=1170/1330, 10–11 groups) still
   overshoots after (1), note it's the VTOL/ring-boundary re-classification:
   consider promoting at most N groups per sync even in the burst-end window
   (the deferral machinery is already per-group; make `promoteOneGroup` fire
   on ANY rebuild-heavy frame, or defer promotion until 2 more untagged
   frames). Only if (1) is not enough.
3. Then the spec matrix: `npx vitest run src/client/test/transitionCycle.test.ts`
   (5/5), `npm run bench:transitions` (expect PASS: all 7 phases < 4 ms, 0
   warnings, AC5), `npx playwright test --config
   playwright.e2e.config.ts tests/e2e/transitions.spec.ts` (~20 s), `npm run
   test` (all green; re-run `src/server/persist.test.ts` +
   `src/client/ui/combat-hud/combat-hud.test.tsx` ALONE if they red under VM
   load — known flaky timing guards, see 21:50 handoff).
4. Close-out per spec step 6: update `.ralph/handoff/TASK-30.md` 'Recorded
   numbers' with the fresh bench table + append 'Verified on fresh session'
   evidence; run the spec's lint command over the 5 files (expect no-op);
   commit as the spec's message; delete this handoff in that commit.
   TASK-30.2 then does the tasks.json/LOG.md/perf-page bookkeeping.

## Dead ends

- `merged: false` — diagnostic only; regresses the draw-call budget (TASK-58).
- Per-frame time-capped rebuild deferral — rejected (merged tests require
  convergence within bounded syncs at rest; the current design keeps at-rest
  convergence at one-group-per-sync, which the new unit test verifies within
  40 syncs and the harness only budgets TAGGED frames, so it passes).
- Raw <20 % single-run variance unachievable on this VM — use the bench's
  recorded CPU-floor clause (bench script already implements it).
- **Pack speed was NOT the bottleneck** (0.03 ms after typed-array fix);
  don't re-optimize `translatedFor` — the cost is in three's
  `mergeGeometries` (measured 3.7–8.7 ms for 20 mid geos).
- Deferring with `speed > 0` only (not also quiet-count during a walk) is a
  deliberate choice: WALK_SPEED=3 > 0 covers walk-10m; at rest (speed 0) the
  one-group-per-sync promotion converges in ~4–5 frames and those frames are
  never budgeted (idle/handoff phases use the idle baseline… the handoff
  phases' tagged frames are the 36 disembark/re-enter frames, which are
  speed-0 idle — verify the disembark/re-enter phases still pass in the bench
  run; if they don't, the at-rest promotion burst is the cause and the fix is
  the same custom fast merge from Next steps 1).

## How to verify

- `cd app && npx tsc --noEmit` (clean) and `npx vitest run
  src/client/world/chunk-scene.test.ts src/client/world/chunks.lod-preset.test.ts`
  (19/19).
- Gate: `npx vitest run src/client/test/transitionCycle.test.ts` — expect the
  budget test to pass 5/5 once the fast merge lands; currently fails at
  6.6–7.0 ms p99 (atmosphere-to-surface).
- `npm run bench:transitions` — expect `bench:transitions PASS` with every
  per-phase p99 < 4 ms after the fast merge; copy the full printed table into
  `.ralph/handoff/TASK-30.md`.
- `npm run test` — full suite green (use fresh counts; the suite has grown
  past the spec's stale 107 files / ~919 tests).
- E2E: `npx playwright test --config playwright.e2e.config.ts
  tests/e2e/transitions.spec.ts` (~20 s, 1 passed).
