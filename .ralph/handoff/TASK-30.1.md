# TASK-30.1 handoff — 2026-10-05 21:50 UTC

TASK-30.1 was re-opened by TASK-61 (`reopened:` field in tasks.json): at HEAD the
transition bench missed the 4 ms per-phase p99 budget in the atmosphere↔surface
phases (15–26 ms, both suite and isolated re-runs — see app/docs/performance.md
FAIL register). The spec assumed a green HEAD ("re-verify, lint, record
numbers"); it was NOT green, so this iteration diagnosed the regression and
committed the root-cause fix. The bench is now ~4.0–4.6 ms p99 — inside the
noise band of the budget but still RED, so the task is not done.

## Status

Root cause of the TASK-30 regression found and fixed (ChunkScene merged-mode
rebuilds, 15–26 ms → 4.0–4.6 ms p99). The 4 ms gate still fails by ~0.1–0.6 ms
on most runs in atmosphere-to-surface; remaining cost is identified (streamer
4 ms slice overrun + mid-ring merge copies). Close-out steps (re-verify matrix,
e2e, fresh numbers, handoff TASK-30.md update) are NOT yet done — the task stays
`passes: false`.

## Done

- **Diagnosis (confirmed empirically):**
  - `merged: false` on the harness (app/src/client/test/transitionCycle.ts
    line ~539, `new ChunkScene(streamer, { monitor, merged: false })`) → worst-p99
    medians 0.57–0.81 ms (green). The merged path is the culprit; merged MUST
    stay the default (draw-call budget, TASK-58).
  - Per-group instrumentation (removed after diagnosis): 1707 merged-group
    rebuilds per cycle, but only ~267 had real membership change — ~84% wasted.
    `mid:frozen` alone: 210 rebuilds / 1170 ms per cycle. Cause: since TASK-58.2
    the merged path rebuilt ALL (ring, material) groups whenever ANY membership
    changed; during streaming the membership changes every frame (chunk
    boundary + burst drain, 24 frames per new chunk entry).
- **Fix — app/src/client/world/chunk-scene.ts (the ONLY file changed, ~131/39
  lines, eslint + prettier applied, tsc clean):**
  1. Per-group dirty check: `builtGroupSigs` (group key → sorted member-key
     signature); only groups whose membership actually changed are re-merged in
     `rebuildRingMeshes()`. Vanished groups are dropped + disposed.
  2. `translatedCache` (`chunkKey:ring` → world-translated position+index copy):
     built once per (chunk, ring), reused by every rebuild. Tracks source
     geometry identity (`{ geo, src }`) — an impostor→full upgrade replaces the
     geometry under the same key, so a stale copy is rebuilt when `hit.src !==
     src`. Frees copies in `releaseTranslated()` (handleEvict) and `dispose()`.
  3. The merged buffer carries **position + index only** — the `normal`
     attribute is dropped (materials are unlit `MeshBasicMaterial`; never read).
  4. Per-frame membership detection is now a plain structural diff
     (`membershipChanged`, O(n), no string building/sorting) instead of the old
     `signatureFor` per-frame sort. `builtSignature` field removed;
     `prevMounted` added; `handleEvict` nulls it.
- **Verification so far:**
  - `npx tsc --noEmit` clean.
  - `npx vitest run src/client/world/chunk-scene.test.ts src/client/world/chunks.lod-preset.test.ts` — 18/18 pass.
  - `npm run bench:transitions` fresh run (21:40 UTC):
    `worst-p99 medians: 4.14, 4.09, 4.58, 4.03, 4.25 ms | mean=4.22ms spread=13.1% (strict gate 20%: PASS) | session CPU floor=49%`
    `pad near ring ready 867 frames before arrival | maxFrame=16.67ms worstDelta=9.346ms wall=1375ms`
    Gate still FAILS: atmosphere-to-surface p99 4.0–4.6 ms ≥ 4 ms in 12/15
    cycles; one surface-to-atmosphere outlier (9.35 ms, run 5 cycle 3).
    (Pre-fix: 15–26 ms p99. TASK-61 isolated re-run medians were 18.30/19.69/
    18.92/22.37/18.49 ms.)
  - `npm run test` (21:40, ~2 min): 180 passed / 2 failed files. Failures:
    (a) `transitionCycle.test.ts` — the CI twin of this bench, red on the SAME
    4 ms gate (expected; it is the task's own gate); (b) `src/server/persist.test.ts`
    (16-dirty-ships < 20 ms guard) and (c) `src/client/ui/combat-hud/combat-hud.test.tsx`
    (hud budget) — BOTH pass when run alone (27/27, 2.0 s). They are timing
    guards flaking under VM load (session CPU floor was 48–49 %); not
    regressions from this change. Re-run them alone before close-out to confirm.
- Full suite counts at last known good (2026-10-02): 107 files, ~919 passed / 1
  skipped. The 21:40 run shows 182 files / 1637 tests — the suite has grown
  since; use the FRESH numbers, not the spec's stale counts, when recording.

## Working tree

- UNCOMMITTED: `app/src/client/world/chunk-scene.ts` (the fix above) + this
  handoff file. Everything else clean. tsc clean, chunk-scene + lod-preset
  tests green, eslint/prettier already applied.
- Committed before this session: HEAD `b8e9615` (ralph run record); the
  TASK-61 perf report commit is `c58fd8e`.
- No background processes left running.

## Next steps

1. Confirm state: `cd app && npx tsc --noEmit && npx vitest run src/client/world/chunk-scene.test.ts` (expect 12 pass).
2. Close the last ~0.1–0.6 ms in atmosphere-to-surface. Measured per-frame cost
   of the tagged burst frames (diagnostic onFrame print, frames 1305–1318):
   `streamer (str) ≈ 4.2–5.7 ms` (the 4 ms slice contract; a single
   `advanceUnit` in `ChunkBuild`/`ImpostorBuild` (src/client/world/chunk-geometry.ts)
   runs past the budget before the loop in `ChunkStreamer.update`
   (src/client/world/chunks.ts ~line 440) breaks) **+** `scene (scn) ≈ 4.5–5.9 ms`
   on boundary/burst frames (1–2 group re-merges; mid groups ≈ 20 chunks × 2048
   tris of position+index copied per merge). p99 over ~25 tagged frames means
   even 1–2 heavy frames set it. Candidate approaches (NOT yet tried):
   - Reduce the mid-ring re-merge cost during bursts — e.g. defer the re-merge
     of far/mid groups until the 24-frame burst drain ends (mount the newly
     arrived chunk with its per-chunk mesh in the meantime, merge later), or
     lower `NEAR_ROWS_PER_UNIT`-style unit granularity for the `mid`/`near-index`
     stages so `advanceUnit` stays ≤ ~1 ms.
   - Check `mountable()`/ring assignment: at 120 m/s descent the new window
     edge lands in near/mid and each entry triggers a mid-group re-merge; a
     cheaper first-frame representation for fresh mid chunks would remove most
     of the `scn` cost.
   - Keep the harness methodology unchanged (median-of-3, streaming-control
     baseline, 4 ms budget) — see Dead ends.
3. Then run the full spec matrix: `npx vitest run src/client/test/transitionCycle.test.ts` (5/5), `npm run bench:transitions` (expect PASS, all 7 phases < 4 ms, 0 warnings, AC5 gate), `npx playwright test --config playwright.e2e.config.ts tests/e2e/transitions.spec.ts` (~20 s), `npm run test` (all green — re-run persist.test.ts + combat-hud.test.tsx alone if they red under load).
4. Close-out per spec step 6: update `.ralph/handoff/TASK-30.md` 'Recorded numbers' with the fresh bench table + append 'Verified on fresh session' evidence; lint the 5 spec-listed files (transitionCycle.ts, transitionCycle.test.ts, scripts/bench-transitions.ts, src/client/main.tsx, tests/e2e/transitions.spec.ts) — none were touched this iteration; commit as the spec's message; then TASK-30.2 does the bookkeeping (it will flip tasks.json `passes`, LOG.md, and the TASK-61 perf-page rows from the fresh artifacts).

## Dead ends

- `merged: false` is NOT a fix — it is the diagnostic that proved the merged path
  the cause; it regresses the draw-call budget (TASK-58's whole point).
- A per-frame time cap on merged rebuilds (defer groups past ~2 ms to the next
  frame) was considered but NOT adopted: the merged-mode tests
  (chunk-scene.test.ts, e.g. "every chunk is mounted" / group-count assertions)
  require full convergence in a single `sync()`. Any deferral design must keep
  tests converging in one sync.
- From the original TASK-30 notes (still valid, do not re-derive): raw < 20 %
  single-run variance is unachievable on this VM (CPU floor jitters 26–54 %);
  the gate is median-of-3 + strict 20 % with the recorded dev-machine clause
  (spread < 2× session CPU floor). Do not revert the e2e spec to single in-page
  run. Do not add a second `window.__TRANSITION__` declare global. Do not remove
  the `idle-surface` branch in `analyzeCycle`. Do not pre-load the world.
- `--gc-interval` / `--max-old-space-size` / CPU-probe normalization: all
  previously rejected (see TASK-30.1 notes field).

## How to verify

```
cd /workspace/master/app
npx tsc --noEmit                      # clean
npx vitest run src/client/world/chunk-scene.test.ts src/client/world/chunks.lod-preset.test.ts   # 18/18
npm run bench:transitions             # THE gate: expect PASS with 0 budget warnings
npx vitest run src/client/test/transitionCycle.test.ts   # 5/5 (CI twin)
npx playwright test --config playwright.e2e.config.ts tests/e2e/transitions.spec.ts
npm run test                          # full suite green (re-run alone any timing-guard flake)
```
