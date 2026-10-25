## Status
The inter-system warp flow is functionally implemented on both server and client, but integration tests are currently failing.

## Done
- **Server**:
    - Implemented `warp` message handler in `app/src/server/ws.ts`.
    - Added `spawnShip` method to `Shard` in `app/src/server/shard/shard.ts` to place ships at a fixed spawn gate offset.
    - Updated protocol schemas in `app/src/shared/protocol/schemas.ts` to include `WarpSchema` and `WarpArrivedSchema`.
    - Implemented message sequencing via a promise queue in `ConnectionContext` to prevent race conditions during authenticated handshakes.
- **Client**:
    - Created `WorldManager.ts` for deterministic world generation (star and placeholder planets) based on system seeds.
    - Integrated `WorldManager` into `Renderer.ts`.
    - Implemented `WarpOverlay.tsx` with CSS animations for warp transitions.
    - Coordinated the warp state machine (`warping-in` -> `awaiting` -> `warping-out` -> `idle`) in `main.tsx`.
- **Testing**:
    - Created `tests/warp.integration.test.ts` covering successful warp, target system full, and same-system rejection.

## Working tree
- All changes are committed to the master branch.
- The project builds, but the warp integration tests are failing.

## Next steps
- **Fix Integration Tests**: The tests currently report `invalid-message` or `error` instead of `warp-arrived` or specific error codes. This suggests that the authentication/join state is not being correctly established before the `warp` message is processed, despite the added promise queue.
- **Verify State Transition**: Check if `ctx.state` is transitioning to `active` correctly in the tests.
- **E2E Test**: Once integration tests pass, implement the Playwright e2e test as per the spec to verify the absence of black frames and correct warp duration.

## Dead ends
- Tried using a simple `async` handler in `ws.on('message')`, which led to race conditions where `warp` was processed before `join_system` completed.
- Attempted a basic promise chain for the queue, but the logic needed to be shifted to a more robust async wrapper.

## How to verify
- Run integration tests: `cd app && npx vitest run tests/warp.integration.test.ts`
- Manually verify in browser:
    1. Claim callsign.
    2. Open Star Chart (M).
    3. Select a target system and click 'Warp'.
    4. Verify warp animation plays and the world swaps to the target system without a loading screen.
