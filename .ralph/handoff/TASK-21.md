# TASK-21: Persistent ship livery customization - Handoff

## Status
BLOCKED: Client source code is missing from the environment.

## Done
- Implemented `POST /api/ships/livery` endpoint in `app/src/server/routes/ships.ts` with Zod validation for hex colors.
- Added `LIVERY_CHANGED` event to `app/src/server/events.ts`.
- Implemented livery change broadcast in `app/src/server/ws.ts`, sending `entity_update` to all clients in the same system.
- Added API tests in `app/src/server/routes/ships.test.ts` covering valid updates, invalid hex, partial payloads, and persistence.
- Added integration test in `app/src/server/livery.integration.test.ts` verifying the WS broadcast.

## Working tree
- `app/src/server/routes/ships.ts` (updated)
- `app/src/server/events.ts` (updated)
- `app/src/server/ws.ts` (updated)
- `app/src/server/routes/ships.test.ts` (updated)
- `app/src/server/livery.integration.test.ts` (created)
- `.ralph/tasks/TASK-21.json` (updated steps 1, 2, 4 to pass)

## Next steps
- Implement client-side livery application in `ShipMeshBuilder.ts` (once the file is restored).
- Implement livery pickers in `OverviewTab.tsx` (once the file is restored).
- Run Playwright smoke tests to verify UI correctness.

## Dead ends
- Searched for client source code in `app/src/client` and via `find` / `grep`, but only `main.tsx` was found. `STRUCTURE.md` claims a full directory tree exists, but it is absent from the disk and the git repository.

## How to verify
1. Run `cd app && npm run test src/server/routes/ships.test.ts`
2. Run `cd app && npm run test src/server/livery.integration.test.ts`
