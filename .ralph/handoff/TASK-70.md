## Status
The Playwright E2E harness is scaffolded but currently failing due to a React runtime error during the initial render of the game app, which prevents the "Claim Callsign" screen from appearing.

## Done
- Implemented `app/tests/e2e/fixtures.ts`: A Playwright fixture that boots the dev server (Fastify) and Vite on random free ports, sets up a temporary SQLite database, and performs health checks.
- Created `app/tests/e2e/pages/claim.ts`: Page Object Model for the callsign claim flow.
- Implemented `app/tests/e2e/core.spec.ts`: Tests for the core flow (claim -> render) and multiplayer interaction (presence + chat).
- Updated `app/vite.config.ts` to support dynamic server ports via `SERVER_PORT` environment variable.
- Added `test:e2e` script to `app/package.json`.
- Added `app/playwright.config.ts` with required WebGL headless flags (`--use-gl=angle`, `--use-angle=swiftshader`).
- Updated `app/src/client/main.tsx` to include the "Claim Your Callsign" UI flow and logic to connect to the WebSocket server using the token received from `/api/callsigns`.
- Updated `app/src/client/net/NetworkManager.ts` to accept a token for authentication.
- Fixed a broken import in `app/src/client/components/ChatLog.tsx` (changed `../net/network` to `../net/NetworkManager`).
- Updated existing E2E tests (`prediction.spec.ts`, `livery.spec.ts`, `presence.spec.ts`) to use the new fixtures and callsign claim flow.

## Working tree
- All changes are committed.
- The project builds, but E2E tests are failing.
- The failure is a runtime error in the browser: `Cannot read properties of null (reading 'width')`. This appears to happen in the `Renderer` or `App` component before the claim screen can be displayed.

## Next steps
1. **Debug the React Runtime Error**: Investigate `Cannot read properties of null (reading 'width')`. It likely occurs in `Renderer.ts` or `main.tsx` because the canvas or window dimensions are accessed before they are available or because the `Renderer` is initialized before the DOM is ready.
2. **Verify Render Sequence**: Ensure that `Renderer` only attempts to access the canvas after the React component has actually mounted the `#main-canvas` element.
3. **Run E2E Tests**: Once the runtime error is fixed, run `npm run test:e2e` to verify the core flow and multiplayer tests.

## Dead ends
- Tried running tests in parallel, but the environment is resource-constrained; running with `--workers=1` is more stable.
- Attempted to use `npx` in fixtures, but using absolute paths to `node_modules/.bin/` was more reliable.

## How to verify
1. Run `cd app && npm run test:e2e`.
2. Verify that `core.spec.ts` passes, including the WebGL variance check and the multiplayer chat test.
