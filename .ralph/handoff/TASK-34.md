# TASK-34 handoff (iteration 19, cut at deadline)

Status: implementation complete + tsc clean + new unit/WS tests green (11/11).
The WIP commit (5c20895) broke 3 pre-existing test files; 2 of 3 are fixed in
the working tree, `persist.test.ts` (11 failures) still needs fixing, then
the e2e spec + docs + full suite remain.

## Done

This iteration (committed as the wip commit that contains this file):

1. **Shard character-inventory bug fixed** (`app/src/server/shard/shard.ts`):
   the on-foot CHARACTER entity never carried the inventory, but the client
   weight bar reads `self?.inventory` and on foot the self entity IS the
   character → the bar would have been hidden on foot. Added private
   `syncCharacterInventory(playerId)` (mirrors the owner's stacks ref onto
   `char:<playerId>`); called from the tick character loop, `handlePickup`,
   `handleDrop`, `giveInventoryForTesting`. Wire snapshot now carries
   inventory on BOTH the frozen ship and the character.
2. **loadShips parse bug fixed** (`shard.ts`): it called
   `sanitizeInventory(owner.inventory)` on the RAW JSON STRING (typeof string
   → always `{}`). Now uses new `parseInventoryJson` from
   `app/src/shared/inventory.ts` (string → sanitized stacks; empty/corrupt/
   non-object → `{}`). `repo.getPlayerInventory` was refactored onto the same
   helper (`app/src/server/db/repo.ts`).
3. **Dev route for e2e** (`app/src/server/routes/dev.ts`):
   `POST /api/dev/give {resourceId, amount}` (zod: `z.enum(RESOURCE_IDS)` —
   works on zod 4.6.5 readonly tuple) → `shard.giveInventoryForTesting`.
4. **NEW `app/src/server/shard/shard.inventory.test.ts`** — 9 tests, ALL PASS:
   drop (groundItem entity at char pos, snapshot quantity/resourceId,
   inventory on ship+character wire state), partial pickup at the 40/40
   boundary (37 iron + 2 crystal dropped → takes exactly 1 crystal, 1
   remains, `pickup` event {resource, taken, remaining}), inventory-full
   denial (40/40 iron), round trip + despawn at zero, ttl expiry (shard
   created with `dtMs: 1000` → ttl 300 ticks; stepper starts at `t = dtMs/2`
   to get exactly ONE tick per `sim.step` call — first burst otherwise runs
   2), denials (wrong-regime/not-owned/invalid-resource/invalid-amount),
   out-of-range (>3 m, manually spawned item), persistence (real sqlite:
   adoptEntity load → grant → `createShardPersist.flushShips`
   (`summary.inventories === 1`) → fresh shard `adoptEntity` AND `loadShips`
   restore; plus "undefined inventory never clobbers the row").
5. **NEW `app/src/server/galaxy/inventory.ws.test.ts`** — 2 tests, ALL PASS
   (interact.ws.test.ts pattern, real server wiring, `routeGameMessage`):
   A drops 2 crystal over the wire → BOTH clients see the same groundItem in
   the same 10 Hz snapshot stream (id/pos/resourceId/quantity) + A's
   character entity shows `{stacks:{}, weightUsed:0}`; B (37 iron) picks up
   via 'interact' → BOTH see quantity 1 + B's character carries
   `{iron:37, crystal:1}, weightUsed:40`. Second test: wrong-regime drop
   denial over the wire (count-based assertion — the first test's leftover
   item has a 300 s ttl and is still in the shard).
6. **Fixed 2 WIP-broken test files** (working tree, verified the failures
   exist at HEAD via `git stash`):
   - `app/src/shared/protocol/schemas.test.ts`: added the missing `drop` case
     to `CASES` (valid `{resourceId:'iron', amount:2}` / invalid amount 0) —
     the "covers every registered message type exactly once" test.
   - `app/src/server/db/repo.test.ts`: migration count `2` → `3`
     (000002_player_inventory).

## Working tree

- Committed before this iteration: `5c20895` (WIP implementation — model,
  protocol, shard, persistence, client weight bar) + `9a27907` (previous
  handoff docs).
- Committed WITH this handoff: all 8 files listed above.
- Builds: `npx tsc --noEmit` CLEAN. New tests: `npx vitest run
  src/server/shard/shard.inventory.test.ts src/server/galaxy/inventory.ws.test.ts`
  → 11/11 PASS.
- RED: `npx vitest run src/server/shard/persist.test.ts` → 11 of 14 fail
  (broken by 5c20895, NOT by this iteration — verified via git stash at HEAD).
  Full `npx vitest run` otherwise green (last full run: only persist/repo/
  schemas failed; repo+schemas fixed in tree, persist pending).

## Next steps

1. Fix `app/src/server/shard/persist.test.ts` (11 failures, two kinds):
   - `expect(summary).toEqual({ saved: 0, destroyed: 0, ms: 0 })` now fails
     because `FlushSummary` gained `inventories` — update the toEqual
     assertions (at least lines ~76 and ~278; grep `toEqual({ saved`).
   - `RangeError: Maximum call stack size exceeded` in "upserts … ONE
     transaction" and "performance guard (step 4)" at persist.test.ts:102
     (`return original(fn)` in the `vi.spyOn(repo, 'withTransaction')` mock)
     — ONLY when the file runs all tests; the test passes in isolation
     (`-t "upserts"`). The shared `repo` (beforeAll) + the first test's
     `vi.spyOn(repo, 'withTransaction')`/`spy.mockRestore()` sequence leaves
     the later `const original = repo.withTransaction.bind(repo)` capturing a
     spy-wrapped function → mock calls mock. Untested fix ideas: capture
     `original` ONCE in beforeAll, or stop using the bind-capture and use
     `spy.mockImplementation` with `spy.mockRestore()` replaced by
     `vi.restoreAllMocks()`, or give each test a fresh repo.
2. Re-run full `npx vitest run` (from `app/`) → all green.
3. E2E spec (UI piece): NEW `app/tests/e2e/inventory.spec.ts` following
   `app/tests/e2e/interact.spec.ts` exactly (same RawWsClient class pattern,
   `uniqueCallsign`, `collectErrors`): claim → GET /api/dev/pad-target →
   join/warp → POST /api/dev/teleport (pad + 5y) → wait docked → 'exit_ship'
   → character on wire → POST /api/dev/give `{resourceId:'iron', amount:10}`
   → close raw client → browser (localStorage 'drift.session.v1' +
   `?sys=`) → `#weight-bar` visible with text '10/40u' (the bar mounts only
   when the server reports an inventory — the character-entity sync from
   step 1 of this iteration makes that work) → press Q (client drops 1 iron,
   see main.tsx key handler) → bar '9/40u' + `#interact-prompt` shows
   '[E] Take iron x1' (item at the character's feet, distance 0 = in cone)
   → press E → bar back to '10/40u', prompt hides → screenshot
   `.ralph/screenshots/TASK-34-1.png` → `assertClean()`.
   Run: `npm run test:e2e -- inventory.spec.ts` (also re-run interact.spec.ts).
4. `npx eslint --fix` + `npx prettier --write` on ALL touched files:
   src/shared/inventory.ts, src/shared/protocol/schemas.test.ts,
   src/server/shard/{shard.ts,shard.inventory.test.ts},
   src/server/db/{repo.ts,repo.test.ts}, src/server/routes/dev.ts,
   src/server/galaxy/inventory.ws.test.ts, tests/e2e/inventory.spec.ts
   (plus the files from 5c20895 if not formatted: client main.tsx,
   ui/weight-bar.tsx, state/inventory.ts, input/interaction.ts,
   shared/interaction.ts, protocol/schemas.ts, shard/persist.ts, shard/types.ts,
   server/shards.ts, db/schema.ts, auth/session.test.ts, shared/inventory.test.ts).
5. Close-out: `.ralph/tasks.json` TASK-34 `passes: true` + all 4 step flags;
   LOG.md entry (newest on top, include screenshot path + test counts);
   STRUCTURE.md (shared/inventory.ts, client/state/inventory.ts,
   client/ui/weight-bar.tsx, migration 000002, POST /api/dev/give, shard
   pickup/drop notes); DELETE this handoff file in the final commit.
   Conventional commit (drop the WIP prefix).

## Dead ends

- Partial pickup CANNOT be produced by dropping and re-taking ONE'S OWN
  single resource: after dropping d units you own, remaining room (40 −
  owned) is always ≥ d, so the whole drop always refits. The boundary test
  needs a multi-resource inventory (37 iron → 3 u room vs a 3 u crystal
  item). Documented in the test comment.
- `sim.step(t)` accumulator: the first call with `t = dtMs` runs TWO ticks
  (owed = floor(t/dt)+1). Steppers must start at `t = dtMs/2` for one tick
  per call (makeStepper in shard.inventory.test.ts does this).
- persist.test.ts spy recursion root cause not found (see Next steps 1) —
  isolated vs full-file delta confirmed; no fix attempted before cutoff.

## How to verify

```
cd app
npx tsc --noEmit
npx vitest run src/server/shard/shard.inventory.test.ts src/server/galaxy/inventory.ws.test.ts   # 11/11 now
npx vitest run src/server/shard/persist.test.ts   # 11 failing until Next step 1
npx vitest run                                     # full suite
npm run test:e2e -- inventory.spec.ts              # after the spec exists
```

Dev server for manual check: `npm run dev` in `app/` (vite 3000 / API 3001).
No background processes were left running by this session.
