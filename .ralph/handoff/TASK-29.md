## Status
The task is nearly complete, but E2E tests for the 'DOCKED' indicator are failing due to authentication issues with the debug teleport endpoint.

## Done
- Implemented landing pad derivation logic in `app/src/shared/world/pads.ts`.
- Implemented server-side docking state machine in `app/src/server/shard/shard.ts`.
- Added VTOL drift damping in `app/src/shared/physics/flight.ts`.
- Implemented client-side pad ring visualization in `app/src/client/world/WorldManager.ts`.
- Added `DockedIndicator` UI component in `app/src/client/main.tsx`.
- Added `/api/debug/teleport-to-pad` and `/api/debug/teleport` endpoints in `app/src/server/routes/ships.ts`.
- Updated `app/src/server/db/types.ts` to include `quat` and `regime` in `Ship` interface.
- Added client-side wrappers for teleportation in `app/src/client/driftDebug.ts`.

## Working tree
- All changes are committed.
- The server builds and runs.
- Unit tests are not yet fully verified in this session, but the core logic is implemented.
- E2E tests are currently failing.

## Next steps
1. Fix the session token storage in the client so that `localStorage.getItem('drift_token')` actually returns the token. Currently, `App` in `main.tsx` sets the token in state but does not save it to `localStorage`.
2. Verify that the `authMiddleware` is correctly applied to the debug routes in `app/src/server/routes/ships.ts`.
3. Run `npx playwright test tests/e2e/docking.spec.ts` and verify the 'DOCKED' indicator appears.
4. Run `npm run test` in the `app` directory to ensure no regressions.
5. Update `tasks.json` and log progress in `.ralph/logs/LOG.md`.

## Dead ends
- Attempting to disable `authMiddleware` for debug routes caused `TypeError` because the routes relied on `session.player_id`.

## How to verify
1. Run the E2E test: `npx playwright test tests/e2e/docking.spec.ts` in the `app` directory.
2. Manually verify by using the `teleportToPad` debug function (once token issues are fixed) and checking for the green 'DOCKED' text in the HUD.
