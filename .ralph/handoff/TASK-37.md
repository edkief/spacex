# TASK-37 Handoff — Resource deposits: seeded placement and persistence

## Status

Steps 1 (catalog + placement) and 2 (persistence) are implemented, committed below, and their unit tests pass (21 new tests green: `deposits.test.ts` + `shard.deposits.test.ts`). Step 3 (client rendering) is ~80% wired but UNVERIFIED (no tsc/rerun after the last WorldManager edits, no e2e, no screenshots). Step 4 is blocked on ONE deterministic regression this iteration introduced: `multiplayer-foot.ws.test.ts` fails 2/4 with `exit_ship rejected: {"code":"not-docked"}` — root cause NOT found.

## Done

All uncommitted at handoff time — committed in the `wip(TASK-37)` commit:

**Shared (step 1, complete + tested):**
- `app/src/shared/resources.ts` (NEW): `RESOURCE_CATALOG` — iron {weight 1, basePrice 5, spawn 0.4, grey}, copper {1, 8, 0.3, orange}, rare-earth {2, 25, 0.2, blue}, crystal {3, 60, 0.1, violet}; `pickResource(rng)` weighted draw. Weights are asserted equal to `RESOURCE_WEIGHTS` in the test.
- `app/src/shared/world/deposits.ts` (NEW): `depositsFor(seed, system)` → up to 120 deposits {depositId `${systemId}:${seq}`, depositSeq, planetId, pos (y = terrain exactly), resourceId, amount 10..50, discovered: false}. Eligible planets: landable && !ocean && !gas. Cell-aligned candidates (5 m grid) around each planet's `planetAnchor(index)` within 2000 m; rejections: spacing < 200 m (per planet), slope > 30° (2-cell gradient, memoized cell cache — derivation is ~30–45 ms warm per system). `planetHeightAt(seed, planet, x, z)` = bilinear over the SAME planet-wide field TerrainContext uses (that's the AC's heightAt). Per-system cache + `__resetDepositCache()` test hook. Constants: `DEPOSIT_DISCOVERY_RADIUS_M=50`, `DEPOSIT_RENDER_RANGE_M=500`.

**Server (step 2, complete + tested):**
- `app/src/server/db/migrations/000003_deposits.sql` (NEW): `deposits` table, PK (system_id, deposit_seq), columns deposit_id/planet_id/pos json/resource_id/remaining/discovered.
- `app/src/server/db/schema.ts`: `DepositRow` + sqlite `deposits` (composite PK via `primaryKey` helper) + pg `pgDeposits` (composite unique index); added to both table maps.
- `app/src/server/db/repo.ts`: `upsertDeposit` (ON CONFLICT (system_id, deposit_seq)), `listDeposits(systemId)`, `decrementDeposit` (atomic UPDATE guarded `remaining >= amount`, sets discovered) — the last one is available for TASK-38's mine channel.
- `app/src/server/shard/types.ts`: SimEntity gains `depositSeq?`, `depositDiscovered?`.
- `app/src/server/shard/shard.ts`: constructor spawns the 120 deposit entities (`spawnDepositEntity`); `sweepDiscovery()` in the tick (any player's active entity — ship or character, incl. idle ships — within 50 m flips `depositDiscovered`, emits `deposit-discovered`); `snapshot()` now EXCLUDES seeded deposits (>500 m from every player — the 500 m streaming ring; dev-hook deposits without `depositSeq` always ride, keeping the existing e2e working); `applyPickup` persists seeded deposits via `persistDeposit` (row created lazily on FIRST mine; depleted deposits despawn but their row stays at remaining 0); `applyDepositDeltas(rows)` + `loadShips` overlays remaining/discovered/despawned on restart. `CreateSystemShardOptions.repo` extended with optional `upsertDeposit`.
- `app/src/server/shard/persist.ts`: `ShipsLoad` gains `deposits: DepositRow[]`, loaded in `loadShips()` in the same tx.
- `app/src/server/shard/shard.deposits.test.ts` (NEW, 6 tests, all green): mine-5 → restart (new shard, same repo, `createShardPersist().loadShips()` + `shard.loadShips(load)`) → remaining = initial−5; depletion despawns entity, row stays at 0, still gone after restart; discovery flips at ≤50 m, stays false beyond, boundary test; snapshot 500 m ring (far player gets zero seeded deposits; near player gets only in-ring, all ≤500 m).

**Test fixes for the new 120-entity shards (all applied):**
- `shard.test.ts` reconnect test: `entities.size` compare-before/after instead of `toBe(1)`.
- `shard.ws.test.ts`: look the player's entity up by playerId instead of `entities.size === 1`.
- `shard.character.test.ts`: snapshot assertion filters `playerId === 'p1'`.
- `repo.test.ts`: migrations count 3 → 4, `deposits` added to table list.
- `pg-parity.test.ts`: `deposits` added to the expected-7-tables list.

**Client (step 3, PARTIAL — verify before trusting):**
- `app/src/client/world/ore-rocks.ts` (NEW): `OreRockLayer` (dodecahedron rocks, per-resource color from the shared catalog, visible only inside the 500 m ring of the player, emissive pulse `oreEmissiveIntensity(q, nowMs)` while q < 10, `views()` probe shape), pure helpers `depositsInRange` / `oreEmissiveIntensity` (unit-testable, no GL).
- `app/src/client/world/WorldManager.ts`: oreLayer attached to scene, `setDeposits(depositsFor(seed, system))` in `swapWorld`, `feedQuantities` from `feedRemoteEntities`, per-frame `oreLayer.update(this.selfPos, nowMs)` in the render loop, public `oreRocks()`. **NOTE:** cold `depositsFor` in `swapWorld` costs ~100–250 ms once per system — the TASK-30 transition e2e (`tests/e2e/transitions.spec.ts`, "no frame > 100 ms") may catch it; if so, move the derivation out of the measured swap (defer one frame).
- NOT done: `window.__DEPOSITS__` dev hook in main.tsx (pattern: existing `__CHAR__`/`__STREAM__` hooks + `installTransitionDebug` in main.tsx), e2e spec `tests/e2e/deposits.spec.ts`, screenshots `.ralph/screenshots/TASK-37-{1,2}.png`.

## Working tree

Committed as `wip(TASK-37)`: everything listed above (shared + server + client wiring + test fixes + this handoff). NOT committed / not done: step flags in `.ralph/tasks/TASK-37.json` (all four still `false` — flip 1+2 to true), `passes` in `.ralph/tasks.json` (must stay false), LOG.md entry, STRUCTURE.md update (new dirs? none — new files only in existing dirs; add the new files' lines), e2e + screenshots.

Build: `npx tsc --noEmit` CLEAN at handoff. Suite: last full run = 6 failed / 955 passed / 1 skipped; of those, 4 are FIXED in this tree (shard.test, shard.ws, repo.test, shard.character) — NOT yet re-run. The 2 `multiplayer-foot.ws.test.ts` failures are NOT fixed (see Dead ends).

## Next steps

1. **Fix the multiplayer-foot regression (the only red test).** `cd app && npx vitest run src/server/galaxy/multiplayer-foot.ws.test.ts` → 2 fail: `Error: exit_ship rejected: {"code":"not-docked","message":"ship is not docked on a landing pad"}` at `multiplayer-foot.ws.test.ts:219`. Sequence: `teleportForTesting` ship to pad+5 m → a `regime:'docked'` entity_update arrives (so padId WAS set) → `exit_ship` a few ticks later says not-docked (padId was cleared between). The test was green before this diff, so bisect THIS commit's shard.ts changes: (a) comment out the `sweepDiscovery()` call in `tick()`, (b) comment out the deposit filter in `snapshot()`, (c) comment out the constructor's `depositsFor` spawn loop — rerun after each. Check `updatePadState` + `resolveRegimeCtx` for any path my entities touched (e.g. anything iterating `this.entities` in the tick now seeing 120 extra static entities).
2. Re-run full suite `npm run test` (expect all green) + `npx tsc --noEmit` + `eslint --fix`/`prettier --write` on touched files.
3. Step 3 finish: `__DEPOSITS__` dev hook (expose `worldRef.current.oreRocks()`), e2e `tests/e2e/deposits.spec.ts` (dock via raw WS like `walk.spec.ts` → disembark → `POST /api/dev/deposit` at the char's `__CHAR__` pos → assert `window.__DEPOSITS__` renders it + a seeded `depositsFor` entry is listed → screenshots TASK-37-1/2.png). Run the dev server (`npm run dev`) + `npx playwright test --config playwright.e2e.config.ts tests/e2e/deposits.spec.ts`. ALSO run `tests/e2e/transitions.spec.ts` to check the swap-budget note above.
4. Close-out: flip step flags 1–4 in `.ralph/tasks/TASK-37.json`, `passes: true` in `.ralph/tasks.json` (TASK-37 entry), LOG.md entry at top, STRUCTURE.md lines for the 5 new source files, commit (Conventional Commit), then the promise tag.

## Dead ends

- `multiplayer-foot.ws.test.ts` `not-docked`: investigated `updatePadState`, `playerPositions()`, `sweepDiscovery`, the snapshot filter — none obviously mutate ship/pad state; `playerPositions()` and the sweep are read-only, dev deposits/seeded deposits are static. NOT root-caused before time-out. Do NOT assume it's flakiness: it failed the same 2 tests in two consecutive full runs.
- Placing deposits at arbitrary (non-cell-aligned) positions: the AC's `heightAt ≈ pos.y ± 0.5` is trivially and exactly met by cell-aligned positions (integer cell height = bilinear corner value), which is what shipped.
- Storing deposit positions in the DB: rejected — spec note says positions are derived (seed is the source of truth), the table stores deltas only.

## How to verify

- `cd app && npx vitest run src/shared/world/deposits.test.ts src/server/shard/shard.deposits.test.ts` (21 tests — the step 1/2 ACs: determinism ×3 systems cold-cache, spacing ≥200 m, surface ±0.5, ≤120, amounts 10..50, catalog weights/prices/mix, mine-5→restart persistence, depletion row-stays-0, discovery 50 m, snapshot 500 m ring).
- `cd app && npx vitest run` full suite — must be all green (watch the 2 multiplayer-foot failures above).
- `cd app && npx tsc --noEmit` — clean at handoff.
- Client: dev server + browser, disembark near a seeded deposit (positions: `depositsFor(seed, system)` — pads sit near planet anchors at (index+1)×10000 m); ore rocks appear in the 500 m ring, pulse under 10 units (force via repeated `[E] Take ore`).
