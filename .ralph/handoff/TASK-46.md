# TASK-46 handoff — AI combat state machine (patrol/aggro/engage/retreat)

## Status
Implementation (steps 1-3) is complete, typechecks clean, and the state-machine unit suite (15 tests) is green. The shard-integration suite (`shard.ai-combat.test.ts`, 8 tests) is WRITTEN but has NEVER BEEN RUN — that is the main remaining work, plus lint/prettier, the full suite, and bookkeeping. No `passes` flags are set; tasks.json is untouched.

## Done
All committed in `180dad9` + `app/src/server/shard/ai.ts` follow-up edits (steering gain fix — see Working tree):

- **`app/src/server/shard/ai.ts` (NEW, ~330 lines)** — the pure state machine:
  - `AiMode = 'patrol' | 'aggro' | 'engage' | 'disengage' | 'dead'`; `AiState {mode, targetId, acquireStartedAtMs, waypointIdx, waypoints, disengageUntilMs, lastPlayerFireAtMs, lastPlayerFireBy, lastModeChangeAtMs}`.
  - `stepAi(state, ship, stats, world)` — mutates only state, returns `{input: ShipInput, fire?, acquiring?}`. Constants exported: AGGRO_RANGE_M=600, AGGRO_CONE_COS (60°), PLAYER_FIRE_MEMORY_MS=5000, ACQUIRE_DELAY_MS=1000, MISSILE_MIN_RANGE_M=300, DISENGAGE_HULL_FRACTION=0.25, DISENGAGE_DURATION_MS=30000, LOST_TARGET_RANGE_M=1200, PATROL_SPEED_FACTOR=0.5.
  - `tickRng(systemId, tick)` = mulberry32 over `hash2(seedFromString(systemId), BigInt(tick))` (the AC's "systemId ^ tick" shard RNG); `makeWaypoints` (4 pts, radius jitter 0.75–1.25× around the roster patrolCenter); `createAiState` / `resetAiState`.
  - Steer: yaw/pitch demand = dot of desired dir with ship right/up axes × **gain 3** (clamped ±1 → class turnRate is the limit); thrust = speed-error P-controller, never thrusters forward when misaligned. Lead point = target pos + vel×0.5 s.
- **`app/src/server/shard/shard.ts`** — integration:
  - `readonly ai = new Map<string, AiState>()` (test-observable); ctor option `spawnRogues?: boolean` (default true — the benchmark seam); waypoint loops seeded at ctor from `tickRng(systemId, 0)`.
  - `tick()` now calls `this.stepAiShips(tick)` (after updateMining, before tickTargetLocks/fire sweeps). `stepAiShips`: builds the player list ONCE (kind 'ship', not destroyed/disembarked — rogues never target rogues), steps each rogue, integrates via the SAME `integrateShip`, regens energy (same as players), broadcasts the new `ai-acquiring` combat event, resolves fire intents.
  - `resolveAiFire` — commits energy + per-weapon cooldown EXACTLY like `handleFire`, then calls the same `fireLaser`/`fireMissile` (their `source` param was widened to `DamageSource`; AI source = `{kind:'ai', id}`). `aiCanFire` mirrors handleFire's loadout/cooldown/energy checks.
  - Aggro memory hooks: `notePlayerFireAt(aiId, playerId)` called from `fireLaser` (resolved target) and `fireMissile` (valid target) when `source.kind === 'player'` and target is an ai-ship.
  - Dead/respawn: destroyed rogue → mode 'dead' (zero input); the existing TASK-45 respawn sweep resets the entity, and `stepAiShips` calls `resetAiState` (fresh patrol loop) on the first live tick.
- **`app/src/shared/protocol/schemas.ts`** — new `combat_event` variant `{kind:'ai-acquiring', source, target}`.
- **`app/src/client/fx.ts`** — exhaustive switch case for 'ai-acquiring' (no FX). **`app/src/client/main.tsx`** — on that event with `event.target === selfShipIdRef.current`, `store.notify('ACQUIRING')` (reuses the existing 'notice' toast).
- **`app/src/server/shard/ai.test.ts` (NEW, 15 tests, ALL PASS)** — RNG determinism, waypoints, the exact state cycle with timing, cone/range gating, fire-memory aggro, weapon choice (missile only >300 m AND interceptor-only, nothing beyond range, canFire-gated), out-ranged give-up, dead/respawn, 0.5× patrol speed cap via real integrateShip, and the mini outrun test.

## Working tree
- Committed: `180dad9 feat(rogue-ai): patrol/aggro/engage/disengage state machine on the shared combat pipeline (TASK-46 steps 1-2)` (ai.ts v1, shard.ts, schemas.ts, fx.ts, main.tsx).
- UNCOMMITTED (this handoff commit): `ai.ts` (turn-demand gain fix ×3 — without it the patrol ship ORBITS waypoints instead of converging; also the aggro cone check gained the missing `dist <= AGGRO_RANGE_M` range gate — a real bug found by tests), NEW `ai.test.ts` (green), NEW `shard.ai-combat.test.ts` (compiles, **never executed**), this handoff file.
- Builds: `npx tsc --noEmit` in `app/` is CLEAN. No background processes were started (no dev server, no Playwright).
- Unrelated noise: ~22 modified PNGs in `.ralph/screenshots/` (byte-diff from prior runs) — leave them, don't commit.

## Next steps
1. **Run the integration suite**: `cd app && npx vitest run src/server/shard/shard.ai-combat.test.ts` (15 s testTimeout per test; the 60 s-sim tests take ~5-15 s wall). Expected problem spots:
   - **evasion test** ("a sharp turn within 200 m breaks the AI's missile lock"): least certain — interceptor rogue at origin, interceptor player at (0,0,450) doing full burn + full turn (yaw:1) in a ~150 m circle. If any missile hits, tweak the geometry (start the player at (0,0,600), or start the turn earlier) — it is deterministic (fake clock + seeded RNG), so once it passes it always passes.
   - **outrun / cycle / parity tests** use the fake-clock `advance()` pattern from `shard.ai.test.ts`; note `sim.step` on a never-started loop runs a 5-tick catch-up burst on the FIRST step (existing repo behavior) — timing assertions already carry slack for it.
   - `combatEvents()` helper: `decodeMessage` returns `{ok, envelope}` (Envelope type from `@shared/protocol`).
2. Fix whatever fails (the machine in `ai.ts` is the likely suspect, not the pipeline — player-side combat is untouched).
3. **Optional small add**: a schema test for the new `ai-acquiring` variant in `app/src/shared/protocol/schemas.test.ts` (the existing combat_event tests show the pattern) — not in the AC, 2 minutes.
4. Lint/format: `cd app && npx eslint --fix src/server/shard/ai.ts src/server/shard/ai.test.ts src/server/shard/shard.ai-combat.test.ts src/server/shard/shard.ts src/shared/protocol/schemas.ts src/client/fx.ts src/client/main.tsx && npx prettier --write <same list>` (prettier will reflow the long expect lines).
5. Full suite + typecheck: `npm run test` (104 files, 898 passed baseline) + `npx tsc --noEmit`.
6. Bookkeeping: set steps 1-4 `pass: true` in `.ralph/tasks/TASK-46.json` and `passes: true` in `.ralph/tasks.json`; LOG.md entry at top + bump 'Tasks Completed'; commit (Conventional Commit, e.g. `test(rogue-ai): state cycle, outrun/evasion sims, determinism + 16-ship benchmark (TASK-46)`); output the promise.

## Dead ends
- Proportional (gain-1) steering demands: the patrol ship circles waypoints forever without entering the 50 m reach radius — fixed with ×3 gain (saturates turn rate beyond ~20° off-axis). Don't "simplify" it back.
- TS narrows `state.mode` across the whole `case` block after mutation (function calls don't reset property narrowing) — restructured the engage/disengage cases to use booleans + immediate returns instead of re-checking `state.mode`; a naive `if (state.mode === 'patrol')` after `toPatrol()` is a compile error.
- `decodeMessage` is `{ok, envelope}`, not the envelope directly — first draft of the test helper didn't compile.
- The aggro cone originally LACKED the 600 m range gate (a 700 m player straight ahead aggros) — caught by the integration-style unit test; fixed in ai.ts.
- No live-server (real WS) test was attempted for the "real ws player aggro'd" AC — the fake-conn `registerConnection` + `handleFire` path exercises the same pipeline; if the reviewer wants a literal ws test, `shard.combat.ws.test.ts` is the template (full fastify + ws stack, ~slow).

## How to verify
- `cd app && npx vitest run src/server/shard/ai.test.ts` → 15 passed (verified green at handoff).
- `cd app && npx tsc --noEmit` → clean (verified at handoff).
- `cd app && npx vitest run src/server/shard/shard.ai-combat.test.ts` → NOT YET RUN (the main open item).
- `cd app && npm run test` → full suite (not yet run at handoff).
- Wire check: `grep -n "ai-acquiring" app/src/shared/protocol/schemas.ts app/src/client/main.tsx app/src/server/shard/shard.ts`.
