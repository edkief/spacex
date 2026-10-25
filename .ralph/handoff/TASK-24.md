## Status
Ship state persistence is partially implemented. A periodic flush service (every 30s) and graceful shutdown hooks are in place. Integration tests are written but currently timing out or failing due to environment/timeout issues.

## Done
- Updated `PersistService` to flush ships every 30s instead of 5s.
- Implemented `persistService.flushShips` to upsert ship positions, velocity, rotation, regime, hull, and shields to the database.
- Added graceful shutdown hooks in `app/src/server/index.ts` to flush all active shards on `SIGTERM` and `SIGINT`.
- Updated `ShardManager.getShard` to be asynchronous and load saved ship states from the database when spawning a shard.
- Modified `Repository.loadSystemState` to cleanup expired wrecks and load all remaining ships in the system.
- Added database migrations (`0002_add_wreck_expires_at.sql`, `0003_add_quat_regime.sql`) and updated schema to support persistence of rotation (`quat`), regime, and wreck expiration times.
- Created a crash-restart integration test in `app/src/server/persistence.integration.test.ts`.

## Working tree
- All changes are committed.
- The project builds.
- The integration test `app/src/server/persistence.integration.test.ts` was last observed as timing out or failing (some `SQUITE_ERROR` issues were fixed, but timeout persisted).

## Next steps
- Fix the timeout and potential instability in `app/src/server/persistence.integration.test.ts`.
- Verify that `persistService.flushShips` does not block the simulation tick beyond 8ms (as per acceptance criteria).
- Ensure `onShardShutdown` correctly handles all necessary state (including resource nodes if applicable).
- Run the full test suite and mark `TASK-24` as passed in `tasks.json`.

## Dead ends
- Attempted to use `db.transaction(async (tx) => ...)` with `better-sqlite3` via Drizzle; discovered that `better-sqlite3` transaction callbacks must be synchronous. Fixed by converting `loadSystemState` to use a synchronous transaction wrapper.
- Encountered `EADDRINUSE` in integration tests because the server process was not always killed cleanly before restarting.

## How to verify
Run the integration test:
```bash
npx vitest run app/src/server/persistence.integration.test.ts
```
The test should boot the server, move a ship, SIGKILL the process, restart, and verify the ship is at the last saved position.
