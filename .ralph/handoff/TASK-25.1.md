# HANDOFF: TASK-25.1 (Regime manager: fix the 2 stale atmosphere fixtures)

## Status
Both failing fixtures in `app/src/server/shard/shard.test.ts` are FIXED in the working tree (uncommitted). Full unit suite (652 passed / 1 skipped) and `tsc --noEmit` are GREEN. Remaining blocker: `npm run lint` fails — `prettier --check` reports 4 PRE-EXISTING unformatted files I never touched (`src/client/state/warp-controller.test.ts`, `src/server/ws.ts`, `tests/e2e/e2e.md`, `tsconfig.json`). eslint itself is clean.

## Done
- Step 1: test 'integrates atmosphere ships against chunk-cached terrain (O(1) heightAt)' — spawn moved from (40, startY, 40) to (10040, startY, 40); probe `terrain.update(10040, 40)` + `heightAt(10040, 40)`. Ship now spawns ~57 u from anchor (10000, 0) → stays in atmosphere. Verified passing.
- Step 2: test 'VTOL lift (action: vtol) settles a ship on the pad' — replaced `terrain.update(0, 0)` with a deterministic ring walk around `planetAnchor(0)` = (10000, 0) in 320 m (CHUNK_SIZE × CELL_SIZE_M) steps (rings r=0..3, fixed dx/dz order), picking the pad CLOSEST to the anchor from `terrain.pads()`. Spawn at (chosen.x, ground+10, chosen.z). All original assertions kept (settled <0.5 m, |vel.y|<1, onPad, snapshot regime 'docked'). Verified passing. Added a temp check (deleted after) confirming the chosen pad has d < 1000 u of the anchor.
- New imports in shard.test.ts: `planetAnchor` from '@shared/galaxy/planets', `CELL_SIZE_M, CHUNK_SIZE` from '@shared/galaxy/surface', `type LandingPadRef` from '@shared/physics/flight'.
- No changes to `src/shared/regime.ts`, `src/server/shard/shard.ts` resolveRegime, or the 5 green TASK-25 test files.

## Working tree
- ONLY modified file: `app/src/server/shard/shard.test.ts` (NOT committed).
- Builds: `npx vitest run src/server/shard/shard.test.ts` → 21/21 pass; `cd app && npm run test` → 652 passed, 1 skipped, 0 failed; `cd app && npm run typecheck` → clean.
- `cd app && npm run lint` → FAILS on `prettier --check` for the 4 pre-existing files above (they are unmodified in the working tree — the failures are at HEAD, not caused by this work).

## Next steps
1. Fix the 4 pre-existing prettier warnings: `cd app && npx prettier --write src/client/state/warp-controller.test.ts src/server/ws.ts tests/e2e/e2e.md tsconfig.json` (formatting-only; sanity-run `npm run test` if any of these are code files).
2. `cd app && npm run lint` → must be clean.
3. `cd app && npm run test` → confirm still green.
4. Mark TASK-25.1 steps pass and set `passes: true` in `.ralph/tasks.json`; log to `.ralph/logs/LOG.md`; commit with e.g. `test(TASK-25): spawn atmosphere fixtures inside the planet atmosphere (d < 1000 u of anchor); full suite green`; then `<promise>TASK-25.1:DONE</promise>`.

## Dead ends
- A throwaway verification test using `testSystem()`'s first landable planet gave a different planet than the fixture's `landablePlanet()` helper (`generatePlanet(SEED, 'land-star', i)`, i=0..15 first landable) — use the helper's exact generator when checking pad placement.
- The interrupted command was `git stash` + prettier check + `git stash pop` — do NOT rerun the stash; the working tree was verified separately (git status shows only shard.test.ts modified; the 4 prettier warnings are on unmodified files, hence pre-existing at HEAD).

## How to verify
```
cd app && npx vitest run src/server/shard/shard.test.ts   # 21/21
cd app && npm run test                                    # 652 passed / 1 skipped / 0 failed
cd app && npm run typecheck                               # clean
cd app && npm run lint                                    # clean only after the 4 prettier --write fixes
```
