# TASK-79 handoff

## Status
The fix is fully implemented, unit-tested, and verified end-to-end. What remains is pure
close-out bookkeeping (flip flags, delete this handoff, one commit) — the work itself is done.

## Done
- `app/src/shared/physics/vec.ts`: added `quatInverse(q)` (conjugate normalized).
- `app/src/client/net/correction-smoother.ts` (NEW, pure, DOM-free, no three.js):
  `CorrectionSmoother` with `onCorrection(renderedBefore, predictedAfter)`, `apply(predicted, dtSec)`,
  `reset()`. Exports `CORRECTION_TAU_S = 0.1`, `CORRECTION_SNAP_U = 50`. Position offset is
  additive (accumulates); rotation offset is world-space and composed (`renderedBefore · predictedAfter⁻¹`).
  Decay is `exp(-dt/CORRECTION_TAU_S)` (rotation slerped toward identity). A position delta > 50 u
  clears the offset (snap) for teleport/respawn/warp.
- `app/src/client/net/correction-smoother.test.ts` (NEW): 10 unit tests, all green.
- `app/src/client/main.tsx`: `correctionSmoother` in a `useMemo` + `lastRenderedShipPoseRef`.
  Self-entity bridge: after `reconcile(...)`, calls `correctionSmoother.onCorrection(renderedBefore,
  predictor.getState())` where `renderedBefore` = last smoothed pose (fallback = wire self pose).
  Frame hook renders `correctionSmoother.apply(raw, dt)` (stored to `lastRenderedShipPoseRef`) instead
  of the raw predicted state. `reset()` on all predictor drop/re-seed sites (disembark, no-self-ship,
  system swap, re-seed). `shipNavSample` still reads the RAW prediction (HUD unsmoothed).
- `app/tests/e2e/chase-camera.spec.ts`: extended steady-window log (correction p50/p95/max + camera
  displacement); added TASK-79 camera AC (per-frame camera disp dt-normalized ≤ 2 u, same rewind/snap
  exclusion) and a (g) mid-flight teleport section (400 u snap: ship snaps in 1 frame, camera within 2,
  chase distance ≤ 16 u). Screenshot path `TASK-79-1.png` added.
- `.ralph/logs/LOG.md`: full TASK-79 entry with pre-fix/post-fix numbers (top of file).

## Working tree
- Commits (all present): 6e415da (baseline e2e log), 2d5c3e2 (smoother + tests), f4ed62b (main.tsx
  wiring), 8bfb86f (e2e ACs).
- Uncommitted (this handoff): prettier reformatting of `main.tsx` + `chase-camera.spec.ts` (cosmetic),
  `.ralph/logs/LOG.md` entry, `.ralph/handoff/TASK-79.md`, and the screenshot `.ralph/screenshots/
  TASK-79-1.png`.
- `tasks.json` TASK-79 `passes` is FALSE and all 4 spec steps are `pass: false` (I had flipped them
  during verification and then REVERTED them per the handoff instructions — flip them again to close out).
- Builds clean: `npx tsc --noEmit` green. Do NOT commit the pre-existing dirty `*.png` mods
  (TASK-27…81 screenshots are locally modified — leave them).

## Next steps
1. In `.ralph/tasks.json`, set `"passes": true` for TASK-79 (currently the TASK-79 object).
2. In `.ralph/tasks/TASK-79.json`, set all 4 steps `"pass": true`.
3. Verify quickly: `cd app && npx tsc --noEmit` (should be clean) and optionally one re-run of
   `npx playwright test --config playwright.e2e.config.ts tests/e2e/chase-camera.spec.ts` (~25 s).
4. Delete `.ralph/handoff/TASK-79.md`.
5. Commit ONLY the intended files (never the dirty screenshots):
   `git add .ralph/tasks.json .ralph/tasks/TASK-79.json .ralph/logs/LOG.md .ralph/screenshots/TASK-79-1.png app/src/client/main.tsx app/tests/e2e/chase-camera.spec.ts && rm .ralph/handoff/TASK-79.md && git commit -m "fix(TASK-79): smooth prediction corrections instead of snapping (CorrectionSmoother)"`
6. Output `<promise>TASK-79:DONE</promise>`.

## Dead ends
- None. First e2e attempt failed only because a log block referenced `events` before its `const`
  declaration (ReferenceError) — fixed by moving the block below the `events` const. A rotation
  first-frame unit bound was initially too tight (one 60 fps frame decays to ~0.85 of the offset,
  leaving ~76° of a 90° correction) — loosened the bounds, all green.

## How to verify
- `cd app && npx vitest run src/client/net/correction-smoother.test.ts` (10 green).
- `cd app && npx vitest run src/client/net/prediction.test.ts` (untouched, green).
- `cd app && npx tsc --noEmit` (clean).
- `cd app && npx playwright test --config playwright.e2e.config.ts tests/e2e/chase-camera.spec.ts`
  — expect PASS; the `[TASK-79]` console line shows camera clean max-dev ≤ 2 u and the mid-flight
  teleport snapping in one frame.
