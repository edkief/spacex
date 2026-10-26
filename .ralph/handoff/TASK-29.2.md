## Status
The task is focused on finalizing E2E tests and resolving project-wide integration test failures. Regime transition tests are now fixed, but chat and rate-limiting integration tests are suffering from severe timeouts.

## Done
- Fixed `app/src/shared/regime.integration.test.ts` by adding missing `atmosphereHeight` and `atmosphereDensity` to the mocked planet, resolving the `AssertionError: expected 'space' to be 'atmosphere'`.
- Verified that `regime.integration.test.ts` now passes.

## Working tree
- Changes to `app/src/shared/regime.integration.test.ts` are uncommitted.
- The project builds, but `npm run test` is failing due to integration timeouts in `src/server/chat.integration.test.ts` and `src/server/ratelimit.integration.test.ts`.

## Next steps
1. **Investigate Integration Timeouts**: Both `chat.integration.test.ts` and `ratelimit.integration.test.ts` are hitting 10s-15s timeouts.
   - The logs show `MaxListenersExceededWarning` for various events (`repair_completed`, `ship_swapped`, `ship_teleported`, `close`, `error`). This suggests that event listeners are not being properly cleaned up between tests, potentially causing memory leaks and slowing down the test suite.
   - Check if `afterEach` hooks in these tests are effectively cleaning up all WebSocket connections and server instances.
2. **Verify E2E Tests**: Ensure `tests/e2e/docking.spec.ts` and other core E2E tests pass.
3. **Finalize Task**: Once all tests pass, update `tasks.json` and remove handoff files.

## Dead ends
- Increasing the timeout in `receiveMessageType` to 15s helped avoid some internal timeouts but did not resolve the overall test suite slowness or hook timeouts.
- Randomizing callsigns fixed `callsign-taken` errors but did not fix the timeouts.

## How to verify
- Run `cd app && npm run test` to check integration tests.
- Run E2E tests using the appropriate test command (e.g., `npm run test:e2e`).
