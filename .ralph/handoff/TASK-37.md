# TASK-37 Handoff — Resource deposits: seeded placement and persistence

## Status

Steps 1 (catalog + placement) and 2 (persistence) are implemented, committed, and unit-tested (21 tests: `deposits.test.ts` + `shard.deposits.test.ts`). Step 3 (client rendering) is ~80% wired but has no e2e/screenshots yet. The `multiplayer-foot.ws.test.ts` regression that blocked step 4 is now ROOT-CAUSED and FIXED — it was a pre-existing racy test (stale "docked" wire match), not a shard bug. All affected unit tests green, `tsc --noEmit` clean.

## Done

**Committed in `wip(TASK-37)` (iteration 1) — unchanged since:**

- Shared (step 1): `app/src/shared/resources.ts` (`RESOURCE_CATALOG`: iron/copper/rare-earth/crystal weights+prices+colors, `pickResource`); `app/src/shared/world/deposits.ts` (`depositsFor(seed, system)` → ≤120 cell-aligned deposits {depositId `${systemId}:${seq}`, planetId, pos (y = terrain exactly), resourceId, amount 10..50, discovered:false}; spacing ≥200 m, slope ≤30°, 2000 m scatter around `planetAnchor`; `planetHeightAt` = bilinear over the same field TerrainContext uses; per-system cache + `__resetDepositCache()`; `DEPOSIT_DISCOVERY_RADIUS_M=50`, `DEPOSIT_RENDER_RANGE_M=500`).
- Server (step 2): `000003_deposits.sql` (PK system_id+deposit_seq); `schema.ts` `DepositRow` + sqlite/pg tables; `repo.ts` `upsertDeposit`/`listDeposits`/`decrementDeposit`; `shard/types.ts` `depositSeq?`/`depositDiscovered?`; `shard.ts`: constructor spawns the 120 deposit entities, `sweepDiscovery()` in tick (≤50 m flips flag + emits `deposit-discovered`), `snapshot()` streams only seeded deposits within 500 m of any player (dev-hook deposits without `depositSeq` always ride), `applyPickup` persists deltas (row created lazily on FIRST mine; depleted deposits despawn, row stays at 0), `applyDepositDeltas` + `loadShips` overlay on restart; `persist.ts` `ShipsLoad.deposits`. 6 green tests in `shard.deposits.test.ts`.
- Client (step 3, PARTIAL): `app/src/client/world/ore-rocks.ts` (`OreRockLayer` dodecahedron rocks, per-resource color, 500 m ring visibility, emissive pulse via `oreEmissiveIntensity` while q<10, pure helpers `depositsInRange`/`oreEmissiveIntensity`); `WorldManager.ts` wiring (`setDeposits(depositsFor(...))` in `swapWorld`, `feedQuantities` from `feedRemoteEntities`, per-frame `oreLayer.update(selfPos, nowMs)`, public `oreRocks()`).
- 120-entity test fixes (committed): `shard.test.ts` (reconnect compare-before/after), `shard.ws.test.ts` (playerId lookup), `repo.test.ts` (4 migrations), `pg-parity.test.ts` (7 tables).

**Committed in `wip(TASK-37)` (iteration 2 — this session, test fixes only):**

1. **Root-caused + fixed the multiplayer-foot regression** in `app/src/server/galaxy/multiplayer-foot.ws.test.ts`. Mechanism (proven with temporary instrumentation, since removed): `handleExitShip` requires `entity.padId`; the test's "docked" wait (`client.next`) scans the ENTIRE buffered message history and matched a STALE snapshot where the ship's wire regime was `'docked'` because of the `docked: true` FIELD (home-dock rest — wire regime = `docked || onPad || padId`, see `entityToState` in `shard.ts`), buffered before the `teleportForTesting` call. The test then sent `exit_ship` immediately, before the ship actually pad-docked → correct server rejection → failure. Running the PARENT commit (25bf5e1) with the same instrumentation reproduced it ~1/4 runs, proving it is pre-existing; TASK-37's larger/slower snapshots only raised the probability a stale snapshot is buffered (~25% → ~75%). Fix: both docked waits now require `e.regime === 'docked' && e.padId !== undefined` (the real pad dock — exactly what `handleExitShip` checks; same pattern as `exit-ship.ws.test.ts` line ~196). Sites: the `onFoot` helper (predicate + `padId?: string` added to `WireEntity`) and the presence test's "B docked" wait.
2. **Fixed two broken/missed 120-entity assertions** the iteration-1 handoff had claimed fixed but were not:
   - `app/src/server/shard/shard.ws.test.ts` (~line 218): still `expect(shard.entities.size).toBe(1)` (shard now holds 121+ entities). Now captures `sizeBeforeClose` before `client.close()` and asserts equality (close releases the connection only; entities stay).
   - `app/src/server/shard/shard.character.test.ts` (~line 207): the "fix" `filter((s) => s.playerId === 'p1')` is wrong — wire `playerId` rides on CHARACTERS ONLY (`entityToState`), so the filter dropped the ship and the assertion saw `['character']` instead of `['character','ship']`. Now `filter((s) => s.kind !== 'deposit')`.

## Working tree

Clean at handoff. Everything listed above is committed in the two `wip(TASK-37)` commits (iteration 2 = `fix(test): TASK-37 ...` for the three test files + this handoff). NOT done (stays for the next iteration): step flags in `.ralph/tasks/TASK-37.json` (all four still `false`; 1+2 are actually complete+tested), `passes` in `.ralph/tasks.json` (MUST stay false), LOG.md entry, STRUCTURE.md lines for the 5 new source files, e2e + screenshots, and deletion of THIS handoff file (delete it in the commit that completes the task). Build: `npx tsc --noEmit` CLEAN; unit suite green for all touched files (32/32 across the four shard test files; multiplayer-foot ~12 consecutive green solo runs).

## Next steps

1. **Step 3 finish** (dev server + Playwright needed):
   - `window.__DEPOSITS__` dev hook in `app/src/main.tsx` (where the existing `__CHAR__`/`__STREAM__` hooks + `installTransitionDebug` live): expose `worldRef.current?.oreRocks()` — dev-only, same pattern as the other hooks.
   - e2e `app/tests/e2e/deposits.spec.ts`: dock via raw WS like `walk.spec.ts` → disembark → `POST /api/dev/deposit` at the char's `__CHAR__` pos → assert `window.__DEPOSITS__` contains the dev deposit AND ≥1 seeded `depositsFor` entry within 500 m → screenshots `.ralph/screenshots/TASK-37-1.png` (walking near ore rocks) + `TASK-37-2.png` (placed deposit visible). Run: `npm run dev` in `app` (background) + `npx playwright test --config playwright.e2e.config.ts tests/e2e/deposits.spec.ts`.
   - ALSO run `tests/e2e/transitions.spec.ts`: the cold `depositsFor` call in `WorldManager.swapWorld` costs ~100–250 ms once per system and may trip TASK-30's "no frame > 100 ms" budget; if it does, defer the derivation one frame (out of the measured swap).
2. **Close-out:** full `npm run test` once more (expect green; if only the `scale` p95-delta test flakes, re-run it solo — see Dead ends); `eslint --fix` + `prettier --write` on touched files; flip step flags 1–4 true in `.ralph/tasks/TASK-37.json`; `passes: true` for TASK-37 in `.ralph/tasks.json`; LOG.md entry at top (date, summary, screenshot paths); STRUCTURE.md lines for `app/src/shared/resources.ts`, `app/src/shared/world/deposits.ts`, `app/src/client/world/ore-rocks.ts`, `app/src/server/db/migrations/000003_deposits.sql` (+ the new test files if STRUCTURE lists tests); delete THIS handoff; one Conventional Commit (`feat(world): TASK-37 ...`); output the promise tag.

## Dead ends

- Bisecting the wip commit's three shard.ts changes one at a time (sweepDiscovery off / snapshot filter off / spawn loop off): none alone removes the multiplayer-foot failure — it looked like a partial correlation with the spawn loop, which was a red herring (run-to-run variance).
- Suspecting the shard undocks the ship (`updatePadState`/`resolveRegime`/`playerPositions`): DIAG logs proved the ship NEVER undocks (zero undock events in failing runs; at teleport time the ship is `docked:false, padId:null, regime:'space'`). The server is correct per the TASK-31 contract; only the test's wait was racy.
- The `scale` p95-delta failure (`p95 62 ms vs baseline 54 ms: expected 7.75 <= 4`) that appeared once under full-suite parallel load: the baseline itself was 54 ms against a 50 ms tick interval = machine saturation. TASK-37's per-tick cost is walk-invariant and cancels in the delta; solo runs are consistently green. Do NOT re-tune the sim or this test for it — re-run the file solo.
- Placing deposits at non-cell-aligned positions: rejected (the AC's `heightAt ≈ pos.y ± 0.5` is met exactly by cell alignment). Storing deposit positions in the DB: rejected (spec note: positions are derived, seed is the source of truth; the table stores deltas only).

## How to verify

- `cd app && npx vitest run src/server/galaxy/multiplayer-foot.ws.test.ts` — the former regression; expect 4/4 (repeat 2–3× to be sure).
- `cd app && npx vitest run src/shared/world/deposits.test.ts src/server/shard/shard.deposits.test.ts` — 21 step-1/2 AC tests (determinism, spacing, surface height, amounts, catalog weights, mine→restart persistence, depletion row-stays-0, 50 m discovery, 500 m snapshot ring).
- `cd app && npx vitest run src/server/shard/shard.ws.test.ts src/server/shard/shard.character.test.ts src/server/shard/shard.test.ts` — the 120-entity assertion fixes.
- `cd app && npx tsc --noEmit` — clean at handoff.
- Full `cd app && npm run test` — expect green (scale flake caveat above).
- Client verification for step 3: dev server + disembark near a seeded deposit (pads sit near `planetAnchor` offsets; deposit positions = `depositsFor(seed, system)`); ore rocks appear in the 500 m ring and pulse under 10 units.
