# TASK-11 handoff — Galaxy router: in-process system shards, cap, dispatch

## Status
Functionally complete and mostly verified: all 11 new TASK-11 tests pass (6 unit + 5 live-ws), and the previously-passing `crash-restart.test.ts` was broken by the rewire and then fixed. A full `npm run test` has NOT been green-verified since the last two fixes (periodic flush + test assertion fix); the last targeted run showed `11 passed | 1 failed` where the failure was the now-fixed concurrent-spawn assertion. Do one final full-suite + tsc + lint pass before flipping `passes: true`.

## Done
- `app/src/shared/protocol.ts` — added `MAX_PLAYERS_PER_SYSTEM = 16`.
- `app/src/shared/health.ts` — added `GalaxyShardHealth` / `GalaxyHealthPayload` types.
- `app/src/server/galaxy/router.ts` (NEW) — `createGalaxyRouter({repo, galaxySeed, shipSwapBus, now?, graceMs?, log?})`:
  - Precomputes ALL systems once (200 systems ≈ 20 ms) into `Map<systemId, SystemGen>`. **Critical detail: `systemId` is `hash(seed, starId)`, NOT the star id** (`generateSystem(seed, starId).systemId`). Validity check is O(1) against this map.
  - `getShard` — idempotent, pending-promise collapse for same-system concurrent joins, **loads serialized on a `loadChain`** (concurrent `persist.loadShips()` transactions on the single better-sqlite3 connection abort each other with "cannot start a transaction within a transaction").
  - `enter` — getShard → cap check → `shard.registerConnection` synchronously (no await between check and reserve → cap race-proof) → `shard.adoptEntity` (async) → returns `{ok, snapshot: StateSnapshot}`.
  - `leave` — `shard.leavePlayer`, stamps `graceSince` on last leave; re-enter clears it.
  - `reapEmpty` — 60 s grace (`REAP_GRACE_MS`), ships flushed via `queueFlush` BEFORE `shard.stop()`, shard deleted, `upsertSystem(id, name, false)`. `startReaper(5000)` (unref'd).
  - `startPeriodicFlush(intervalMs)` — flushes every active shard on an interval (the crash bound; wired from `env.SHARD_FLUSH_INTERVAL_MS`). All flushes (periodic/reap/shutdown) serialize on a `flushChain` promise.
  - `stats()` → `{systemId, name, players, uptimeMs}[]`; `stopAll()` (shutdown).
- `app/src/server/galaxy/gateway.ts` (NEW) — `createRouterGateway(router)`: `SystemGateway` over the router.
- `app/src/server/ws.ts` — `SystemGateway.enterSystem` player arg gained optional `send` (shard snapshot delivery); `join_system` now supports **rejoin**: if already in a system, the NEW system is joined first; on failure (system-full / not-found) the player stays exactly where they were, on success the old system is left (presence leave + `onLeaveSystem` + `gateway.leaveSystem`).
- `app/src/server/shard/shard.ts` — split `join()` into `adoptEntity(playerId, callsign)` (entity spawn/re-adopt, no conn) + connection registration; added `leavePlayer(playerId)`; `leave(conn)` delegates.
- `app/src/server/routes/galaxy.ts` (NEW) — `GET /api/galaxy/health` (auth via `requireAuth`) → `{shards: router.stats()}`. Registered when `RouteDeps.galaxyRouter` present (new optional field in `routes/callsigns.ts` + conditional in `routes/index.ts`).
- `app/src/server/index.ts` — REWIRED: single test-only shard removed; router + router gateway + reaper + periodic flush + `router.stopAll()` on SIGTERM/SIGINT. Input routing: `onGameMessage` 'input' → `router.active(conn.systemId)?.shard.enqueueInput`.
- Tests (NEW): `app/src/server/galaxy/router.test.ts` (6: concurrent-spawn collapse + load budget, unknown id, reap grace w/ fake clock + DB flush check, grace-cancel on rejoin, 16-cap + slot-free retry, restart/same-world incl. exact velocity + planet determinism) and `app/src/server/galaxy/router.ws.test.ts` (5: 10 clients / 3 systems parallel, cap w/ "stays in previous system", health endpoint 200 + 401, system-not-found).

## Working tree
Committed: nothing yet (this handoff + all of the above will be the WIP commit). Not committed / unrelated local changes to LEAVE ALONE: `opencode.json`, `ralph.config.json`, `ralph/package-lock.json`, `package.json`, `package-lock.json` (pre-existing env noise, not from this task). Task-related files: the ones listed under Done plus `.agent/handoff/TASK-11.md`. Build state: `npx tsc --noEmit` was clean after all code changes EXCEPT the last two edits (periodic flush in router.ts + the `listShipsInSystem` assertion fix in router.ws.test.ts) — re-run tsc first.

## Next steps
1. `cd app && npx tsc --noEmit`
2. `npx vitest run src/server/galaxy/ src/server/ws.test.ts src/server/shard/crash-restart.test.ts src/server/shard/shard.ws.test.ts src/server/ship-swap.ws.test.ts src/server/livery.ws.test.ts`
3. Full: `npm run test` then `npx tsc --noEmit`, `npx eslint --fix src/server/galaxy src/server/routes/galaxy.ts src/server/ws.ts src/server/index.ts src/server/shard/shard.ts src/shared/protocol.ts src/shared/health.ts src/server/routes/callsigns.ts src/server/routes/index.ts && npx prettier --write <same list>`
4. Optional live smoke: boot `src/server/index.ts` on a free port (GALAXY_SEED, DB_PATH temp), claim a callsign, WS-join `generateSystem(seed, generateStars(seed)[0].id).systemId`, then `curl -H "Authorization: Bearer <token>" /api/galaxy/health`.
5. If green: set `passes: true` for TASK-11 in `.agent/tasks.json`, log to `.agent/logs/LOG.md` (newest on top), update `.agent/STRUCTURE.md` (new dir `app/src/server/galaxy/` with router.ts + gateway.ts + 2 test files; `app/src/server/routes/galaxy.ts`), commit (Conventional Commit), output `<promise>TASK-11:DONE</promise>`.

## Dead ends
- Validating system ids against STAR ids → every join returned `system-not-found` (systemId = hex hash of (seed, starId), see `generateSystem` in `app/src/shared/galaxy/system.ts`). Fixed by precomputing all 200 systems.
- Concurrent shard loads without a load chain → `SqliteError: cannot start a transaction within a transaction` (drizzle `withTransaction` on one better-sqlite3 connection interleaves BEGINs). Fixed with per-router `loadChain`.
- Removed the old single-shard flush timer from index.ts without replacement → crash-restart test failed with ship `state !== 'flying'` (no flush ever ran before SIGKILL). Fixed with `startPeriodicFlush`.
- Concurrent-spawn test asserted "shard holds only joined players' ships" → flaky because starter ships are docked at the player's HOME system, and when home ∈ {joined systems} the shard legitimately loads that row on spawn. Fixed by computing expected per-system ship sets from `repo.listShipsInSystem(id)` ∪ joined players.
- `repo.createPlayer` requires the caller-supplied `id` to be passed explicitly (it otherwise mints a random uuid) → FK failure on the starter-ship insert in the test helper.

## How to verify
- Unit: `cd app && npx vitest run src/server/galaxy/router.test.ts` (6 tests, fake clock for the 60 s reap grace, real DB).
- Live: `npx vitest run src/server/galaxy/router.ws.test.ts` (real server on random port, 25+ ws clients).
- Regression guard: `npx vitest run src/server/shard/crash-restart.test.ts` (boots real `src/server/index.ts` twice via tsx, SIGKILL between) — this test exercises the new index.ts wiring end-to-end.
- Full: `npm run test` (was 477 tests; +11 new = 488 expected) + `npx tsc --noEmit`.
