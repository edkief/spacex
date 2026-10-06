# TASK-30 handoff — TASK-30.1 fresh verification (2026-10-06)

TASK-30.1 (re-verify green, lint, record fresh numbers) is complete. The
reopened 4 ms gate went GREEN after the final fix: three's `mergeGeometries`
in the merged-ring rebuild (3.7–8.7 ms for a 20-member mid group) was
replaced with a uniform fast path — raw typed-array concat
(`buildMergedGeometry` in `app/src/client/world/chunk-scene.ts`: one
`Float32Array`/`Uint16Array` sized to the group, `set()` per member's
position, one vertex-offset add over each index array, one
`computeBoundingSphere()`), with `mergeGeometries` kept as the divergent
attribute-set fallback. Combined with the earlier deferral + fast-pack
commits (`89224c3`, `fea723e`), every transition phase now lands far under
budget on a fresh session.

## Recorded numbers

Fresh `npm run bench:transitions` run, 2026-10-06 (dev machine: Intel N100 /
16 GB headless VM — below the reference class, same clause as before),
replaces all earlier tables:

```
worst-p99 medians: 0.66, 0.68, 0.67, 0.62, 0.88 ms | mean=0.70ms spread=37.0% (strict gate 20%: n/a) | session CPU floor=62%

recorded numbers (dev machine, TASK-30):
  per-run worst-p99 medians (ms): 0.664, 0.675, 0.674, 0.619, 0.879
  strict 20% gate: spread 37.0% (dev-machine clause applied)
  session CPU jitter floor: 61.9%
  space-to-atmosphere: frames=440 tagged=5 baseline=0.001ms (phase-steady) worstDelta=0.025ms p99=0.025ms
  atmosphere-to-surface: frames=698 tagged=210 baseline=4.656ms (streaming-control) worstDelta=1.42ms p99=0.879ms
  disembark: frames=36 tagged=36 baseline=0.068ms (idle) worstDelta=0.717ms p99=0.717ms
  walk-10m: frames=200 tagged=0 baseline=0.076ms (phase-steady) worstDelta=0.085ms p99=0.033ms
  re-enter: frames=36 tagged=36 baseline=0.068ms (idle) worstDelta=0.066ms p99=0.066ms
  surface-to-atmosphere: frames=250 tagged=4 baseline=4.656ms (streaming-control) worstDelta=-3.08ms p99=-3.08ms
  atmosphere-to-space: frames=440 tagged=5 baseline=0.098ms (phase-steady) worstDelta=0.091ms p99=0.091ms
  streaming control: p50=0.178ms p95=5.081ms busyP50=4.656ms frames=360
  idle baselines: space p50=0.001 p95=0.001 | atmosphere p50=0.005 p95=0.006 | surface p50=0.068 p95=0.082
  pad near ring ready 866 frames before arrival | maxFrame=7.909ms worstDelta=1.42ms wall=935ms

bench:transitions PASS — every transition < 4 ms over baseline, no frame > 100 ms, 0 budget warnings, spread 37.0%.
```

## Verified on fresh session

- `npx tsc --noEmit` clean (twice — before and after lint/prettier)
- CI test `npx vitest run src/client/test/transitionCycle.test.ts` — 5/5 green (~3.1 s)
- `npm run bench:transitions` — PASS (table above; all 7 phases p99 < 4 ms over baseline, 0 budget warnings, no frame > 100 ms, pad near-ring ready 866 frames early, AC5 via the recorded dev-machine clause: spread 37.0% < 2× session floor 61.9%)
- e2e `npx playwright test --config playwright.e2e.config.ts tests/e2e/transitions.spec.ts` — 1 passed in 18.4 s (screenshot `.ralph/screenshots/TASK-30-1.png`, gitignored, reference only)
- full unit suite `npm run test` — all green: 182 files, 1638 passed / 1 skipped (~133 s)
- lint: `eslint --fix` + `prettier --write` over the 5 spec files (transitionCycle.ts, transitionCycle.test.ts, scripts/bench-transitions.ts, src/client/main.tsx, tests/e2e/transitions.spec.ts) — all unchanged (already clean); the two files this task touched (chunk-scene.ts, chunk-scene.test.ts) also lint/format clean, tsc clean after

Remaining for TASK-30.2 / TASK-61: bookkeeping + final commit per
`.ralph/tasks/TASK-30.2.json`, then TASK-61's reference-hardware pass
(`npm run perf:report desktop` + update `app/docs/performance.md` per its
handoff).
