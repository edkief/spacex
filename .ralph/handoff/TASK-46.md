# TASK-46 handoff — AI combat state machine (patrol/aggro/engage/retreat)

## Status
All 8 shard-integration tests now pass (previously never run), all AI unit tests + schema test green, tsc/eslint/prettier clean, and the 5 pre-existing full-suite failures caused by earlier TASK-46/45 work are FIXED. The only remaining work is ONE flaky timing test (`multiplayer-foot.ws.test.ts` scale test) that fails intermittently under full parallel-suite load, plus final bookkeeping (pass flags, LOG.md, commit).

## Done
This iteration (all uncommitted until the wip commit that includes this handoff):

- **`app/src/server/shard/shard.ts`** — `notePlayerFireAt(aiId, playerId)` now stores the player's **ENTITY id** (`this.playerEntities.get(playerId)?.id ?? playerId`), not the raw player id. The machine's `aggroCandidate` matches `lastPlayerFireBy === p.id` where `p.id` is the entity id (`ship-p1` vs `p1` mismatch was the fire-memory aggro bug).
- **`app/src/server/shard/shard.ai-combat.test.ts`** — 3 fixes, suite is now 8/8 GREEN:
  - Evasion test: player starts at `(0,0,550)` with **`player.ship.vel = {x:0,y:0,z:180}` set BEFORE warmup** (no acceleration phase for the AI to close on). Player flies a 150 m circle (180 u/s / 1.2 rad/s) from tick 1; all AI missiles miss, zero laser (AI stays >300 m). Deterministic — once green, always green.
  - Fire-memory test: after the aggro assert, teleport player to (0,0,-10_000) and `advance(shard, 6_500)` (5 s memory + one full aggro→engage→out-ranged→patrol cycle) before asserting `patrol`. Shorter advances fail because the AI is still in `aggro` (1 s acquire not elapsed) and the fresh memory re-aggros from patrol anyway.
  - Parity test: `rogue.energy = 40` right before the 1 s sample window; assert `energy < 50` (40 + 10 regen − 3×2 committed = 44). The old `energy < 100` was mathematically impossible (3 shots cost 6, 1 s regen gives +10). Rate assert now counts only window shots via a `firedBefore` snapshot.
- **`app/src/server/shard/ai.test.ts`** — removed unused `type AiState` import and `freighter` const (eslint).
- **`app/src/shared/protocol/schemas.test.ts`** — added the optional `ai-acquiring` variant test (accepts `{kind, source, target}`, rejects missing target).
- **Pre-existing failures fixed** (all broken by the default-on rogue AI from TASK-45/46's earlier commits; "npm run test green" is a TASK-46 AC):
  - `app/src/server/shard/shard.test.ts` — `makeShard()` helper got `spawnRogues: false` (patroling rogues dirty the entity buffer every tick → the "shared buffer" 10 Hz test saw 10 distinct buffers). The two inline `new SystemShard` in that file were left alone (passing).
  - `app/src/server/shard/shard.ai.test.ts` (TASK-45 tests) — exact `toEqual(entry.spawnPos)` / zero-velocity asserts replaced with `vecLength(vecSub(pos, spawnPos)) < 25` and `vecLength(vel) < 100` (rogues patrol from spawn now; imported `vecLength, vecSub` from `@shared/physics/vec`).
  - `app/src/server/shard/shard.weapons.ws.test.ts` — beforeAll shard got `spawnRogues: false` (rogue broadcast events polluted the "denied fire emits nothing" wire assert).
  - `app/tests/abuse/property.spec.ts` — moved `let fakeNow = 1_000_000;` ABOVE the `new SystemShard(...)` (the ctor now calls `this.now()` for AI state → TDZ `ReferenceError: Cannot access 'fakeNow' before initialization`) and added `spawnRogues: false`.

## Working tree
- Committed so far: `91a532f` (wip: state machine + shard integration + machine unit tests; integration suite written but never run) + `180dad9` + `b606c9f`.
- UNCOMMITTED (goes into the wip commit with this handoff): the 8 files listed in Done. Builds: `npx tsc --noEmit` CLEAN, eslint CLEAN, prettier applied.
- `npx vitest run` (full): 137/138 files pass. The ONE flake: `src/server/galaxy/multiplayer-foot.ws.test.ts > scale: 4 on foot + 4 in ships — tick p95 stays within baseline + 4 ms` — failed in 2 of 3 full runs (delta 12.5 ms vs 4 ms budget, baseline p95 itself 49.5 ms → machine-wide contention); PASSES in isolation. `src/client/test/transitionCycle.test.ts` (client-side, untouched by this task) also failed once under load, passed another — same flake class.
- Unrelated noise: ~22 modified PNGs in `.ralph/screenshots/` — leave them, don't commit.

## Next steps
1. **Resolve the multiplayer-foot flake.** First just re-run `cd app && npx vitest run` — it may pass (it's load-dependent). If it fails again under load: check whether the pad system's rogues aggro the 4 walkers during the load phase (rogues in the shard come from the production router, `spawnRogues` default true — `PAD = findPadTarget()` at line 55 of the test; compare the roster's `patrolCenter`s for that system vs `PAD.pad.pos` — aggro needs 600 m + 60° cone, walkers are on the surface, rogues are space-only, so this is unlikely; the 49.5 ms baseline p95 points at parallel-suite CPU contention instead). If it's pure load noise, document that in LOG.md and move on (it is not deterministically broken by this task's code).
2. Full re-verify: `cd app && npm run test` + `npx tsc --noEmit` (≈2 min).
3. Bookkeeping: set steps 1-4 `pass: true` in `.ralph/tasks/TASK-46.json`, `passes: true` for TASK-46 in `.ralph/tasks.json`, LOG.md entry at top (mention the 4 repaired pre-existing tests + the flake), bump 'Tasks Completed', DELETE this handoff file, commit (e.g. `test(rogue-ai): shard combat integration green — state cycle, fire memory, outrun/evasion, parity, determinism, 16-ship benchmark (TASK-46)`), output the promise.
4. Benchmark result for LOG.md: the `benchmark: 6 players + 10 rogues` test logs `p95 base / p95 +AI / delta` via console.log during the run — re-run `npx vitest run src/server/shard/shard.ai-combat.test.ts` to capture the exact numbers (both AC bounds < 30 ms and < 3 ms pass).

## Dead ends
- Starting the evasion player from rest (the original 450 m geometry): the AI closes on the player's slow acceleration phase — 6 laser hits + 1 early missile hit. Fixed by pre-arming `ship.vel` to 180 u/s (full circle from tick 1). Don't revert.
- Advancing only 200 ms after the fire-memory teleport expecting patrol: the 1 s acquire delay means the AI is still `aggro` (no out-ranged check runs in aggro), and any `patrol` tick re-aggros while the 5 s memory is fresh. Must advance past the memory window.
- `expect(rogue.energy).toBeLessThan(100)` after 1 s of 3/s laser fire: impossible — 6 spent vs 10 regen. Anchor the window at a known lower energy (40) and assert `< 50`.
- `notePlayerFireAt` storing `source.id` (player id) while `aggroCandidate` compares entity ids: the machine's unit tests set `lastPlayerFireBy` to the same string as the world's player id, so the unit suite can't catch the id-space mismatch — the shard integration test is what caught it.

## How to verify
- `cd app && npx vitest run src/server/shard/shard.ai-combat.test.ts` → 8 passed (verified this iteration).
- `cd app && npx vitest run src/server/shard/ai.test.ts src/server/shard/shard.ai.test.ts src/server/shard/shard.test.ts src/server/shard/shard.weapons.ws.test.ts tests/abuse/property.spec.ts src/shared/protocol/schemas.test.ts` → 131 passed (verified this iteration).
- `cd app && npx tsc --noEmit` → clean (verified this iteration).
- `cd app && npx vitest run` → 137/138 files; the single intermittent failure is the multiplayer-foot scale p95 test (passes in isolation; see Next steps 1).
