# TASK-24 Handoff — Ship state persistence across restarts

## Status
Functionally complete and fully green: flush service, restart-load, crash-restart
integration test, and the p95 flush-latency guard all pass. What remains is
bookkeeping + review polish (tasks.json `passes`, LOG.md, STRUCTURE.md, lint,
commit) — see Next steps.

## Done
- **Flush service (step 1)** — `app/src/server/shard/persist.ts` (NEW):
  `createShardPersist({ repo, systemId, options })` with `flushShips(shard)` and
  `loadShips()`; `startShardFlushTimer()` (unref'd interval, failure logs via
  `warn`, retry next tick). Flush = ONE transaction containing ONE multi-row
  `INSERT ... ON CONFLICT (owner_id) DO UPDATE ... RETURNING-free` statement
  (`repo.upsertShipStates`, new in `app/src/server/db/repo.ts` — one statement
  for all ships, `excluded.*` on conflict). Persists {pos, vel, quat, regime,
  hull (normalized→points vs class caps), shields, livery (only if full 3-slot
  via `isLivery`), onPad, state, destroyedAt}. Wire-up in `app/src/server/index.ts`:
  flush every `SHARD_FLUSH_INTERVAL_MS` (env, default 30 000) + final async flush
  on SIGTERM/SIGINT before `process.exit(0)`.
- **Load on spawn (step 2)** — `loadShips()` returns `{ships, wrecks, deletedExpired}`
  in one transaction; expired/corrupt destroyed rows deleted in the SAME tx (no
  orphans). `SystemShard.loadShips()` + `SystemShard.entityFromShipRow()` (both
  new, `app/src/server/shard/shard.ts`): flying ships resume at saved
  pos/vel/quat/regime, docked at `homeDockPosition(seed, systemId)`, unexpired
  destroyed ships as static `wreck:<id>` entities with remaining ttl
  (`WRECK_TTL_MS` = 600 s). `SystemShard.join()` now builds the entity from the
  persisted ship row instead of a fresh rest state (no spawn teleports).
  `SimEntity.destroyedAtMs` added (`shard/types.ts`), set in `destroyEntity`.
- **Schema/migration** — `app/src/server/db/schema.ts`: ships gains
  `rotation` (Quat json), `regime` ('space'|'atmosphere', `SHIP_REGIMES`),
  `on_pad`, `destroyed_at` (sqlite + pg; pg also gets `uq_ships_owner` unique
  index). `app/src/server/db/migrations/000001_ship_persistence.sql` (NEW):
  ALTERs + `uq_ships_owner` unique index on `ships.owner_id` (sqlite).
  `repo.saveShipState` accepts the new optional fields; `repo.deleteShips` added
  (expired-wreck cleanup).
- **Tests** (all passing):
  - `app/src/server/shard/persist.test.ts` (NEW, 14 tests): flush one-tx
    upsert, full-state round-trip, missing-row upsert, destroyed/destroyedAt,
    onPad→docked, partial-livery guard, AI-ship skip, NaN rollback; load
    classification + expired deletion + system isolation; `SystemShard`
    restart-load entity states + join re-adoption; flush timer behavior;
    perf guard (16 ships × 40 flushes, asserts p95 < 8 ms, logs the bench line).
  - `app/src/server/shard/crash-restart.test.ts` (NEW, integration, 60 s
    timeout): boots the REAL server (`src/server/index.ts` via tsx loader flags,
    same pattern as the TASK-63 test) on two random free ports with one temp DB,
    `SHARD_FLUSH_INTERVAL_MS=300`, claims a callsign, WS join (hello/auth/
    join_system, system id computed via `generateStars`/`generateSystem` of the
    test seed `drift-crash-restart-seed-001`), 2 s of thrust inputs, SIGKILL,
    reads the surviving WAL db directly, reboots on the SAME db (same
    SESSION_SECRET so the 7-day token still verifies), rejoins, asserts:
    position within measured drift + 1 tick of the persisted row, still far from
    the dock (no spawn teleport), velocity exactly equals the persisted
    velocity, hull ~full, regime sublight.
  - `app/src/server/db/repo.test.ts`: migration count expectation updated 1→2
    for the new 000001 file.
- Full suite at handoff: `npm run test` → **44 files / 466 tests all pass**;
  `tsc --noEmit` clean. Flush bench line (logged by the perf test) shows p95
  under the 8 ms assertion.

## Working tree
Everything below is **uncommitted** (this handoff session did not commit):
- Modified: `app/src/server/{persist.ts (untouched, TASK-63), persist-crash-child.ts
  (untouched), index.ts, env.ts, db/{repo.ts, schema.ts, repo.test.ts},
  shard/{index.ts, shard.ts, types.ts}}`, plus +1 line `SHARD_FLUSH_INTERVAL_MS`
  in ~11 test env objects (`health.test.ts`, `*.ws.test.ts`, route tests,
  `tests/*.spec.ts`) — required because `Env` gained a field with no default
  in the test literals.
- New: `app/src/server/shard/persist.ts`, `app/src/server/shard/persist.test.ts`,
  `app/src/server/shard/crash-restart.test.ts`,
  `app/src/server/db/migrations/000001_ship_persistence.sql`,
  `.agent/handoff/TASK-24.md`.
- **Builds/tests: green** (see Done). No dev server or background process left
  running (verified with pgrep).
- NOT committed (pre-existing, unrelated to TASK-24 — leave as-is): root
  `package.json`/`package-lock.json` (untracked), `opencode.json`,
  `ralph.config.json`, `ralph/package-lock.json`. When committing TASK-24, add
  only `app/` and `.agent/` paths.
- `tasks.json` still has `passes: false` and all 4 step `pass: false` — do NOT
  flip them until the next session finishes the steps below and re-verifies.

## Next steps
1. Run `npx eslint --fix` + `npx prettier --write` over the touched files
   (not yet run this session) and re-run `npx tsc --noEmit` + `npm run test`
   (full suite ~60 s). Watch the `[shard persist bench]` line: p95 must stay
   under 8 ms; on slow CI the margin is thinish (~1-2 ms) — if it flakes,
   increase warmup flushes in the perf test, do NOT raise the threshold.
2. Optionally smoke the dev server (`npm run dev` in `app`, then the existing
   `smoke-task13.mjs` pattern) to eyeball a real restart; not required for
   bookkeeping since the integration test covers it end-to-end.
3. Set all 4 step `pass: true` and the task `passes: true` in
   `.agent/tasks.json`.
4. Add a LOG.md entry (newest at top) summarizing flush/load/crash test +
   bench line. No screenshots (no UI).
5. Update `.agent/STRUCTURE.md`: add `shard/persist.ts` under the shard dir,
   note `000001_ship_persistence.sql`, mention the two new test files in the
   shard section.
6. Commit (Conventional Commit, e.g.
   `feat(persistence): shard state flush + crash-restart continuity (TASK-24)`),
   then output `<promise>TASK-24:DONE</promise>`.

## Dead ends
- Per-ship `getShipByOwner` + `saveShipState` flush: p95 13.5 ms (48 drizzle
  statements). One-statement-per-ship upsert (`upsertShipStateByOwner`): p95
  ~8.3-11 ms on this sandbox — still flaky vs the 8 ms target. **Working fix:**
  a single multi-row `INSERT ... ON CONFLICT (owner_id)` for the whole flush
  (p95 now under 8 ms). If you revert to per-ship writes, expect perf flake.
- Drizzle `onConflictDoUpdate.set` keys must be FIELD names (`onPad`,
  `destroyedAt`), not raw column names (`on_pad`, `destroyed_at`) — string
  column names are silently dropped and the nullable columns stay NULL.
- zod parses were NOT the perf bottleneck (removing them moved p50 ~0 ms);
  the cost is drizzle query construction per statement. The repo hot path
  keeps an inlined finiteness guard instead of `ShipPositionSchema`/
  `Vec3Schema` (the NaN rollback unit test depends on it throwing).
- Crash test velocity assertion: comparing the post-restart velocity to the
  last pre-kill SNAPSHOT velocity fails (|Δ| = 8 u/s) because the last FLUSH
  can lag the last snapshot by up to one flush period while the ship still
  holds its last thrust frame (`heldInput` persists until the owner leaves —
  SIGKILL means it never leaves). Assert against `row.velocity` from the DB
  instead (exact match in space coasting).
- `describe`-level `createShardPersist({ repo, ... })` in a test file captures
  `repo` while still `undefined` (beforeAll not run) — build it lazily per
  test.
- Wreck ttl math: 300 s remaining at 20 Hz = 6 000 ticks (not 12 000).

## How to verify
```bash
cd /workspace/master/app
npx tsc --noEmit                                   # clean
npx vitest run src/server/shard/persist.test.ts    # 14 tests, logs bench p50/p95
npx vitest run src/server/shard/crash-restart.test.ts  # integration, ~6 s
npm run test                                       # full suite: 44 files / 466 tests
```
Key invariants to check in the code: flush transaction contains exactly one
`upsertShipStates` statement; `loadShips` deletes expired wrecks in the same
tx; `index.ts` SIGTERM handler does the final async flush before exit.
