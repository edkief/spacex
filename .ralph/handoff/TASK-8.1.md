## Status
The inter-system warp flow has been partially fixed. The critical "Star not found" error during warp arrival was resolved by synchronizing the galaxy seed between client and server, but E2E tests are still failing due to locator strict mode violations and potential visual regression checks (black screen/pixel variance).

## Done
- **Galaxy Seed Synchronization**: 
    - Modified `app/src/client/main.tsx` to fetch the actual `galaxySeed` from the server via `/api/health` on mount, instead of relying on a hardcoded constant. This ensures the client's `WorldManager` uses the same seed as the server when generating the target system.
    - Updated `app/src/server/ws.ts` and `app/src/client/net/NetworkManager.ts` to explicitly pass the `systemId` (derived from the server's seed) during the `auth_ok` handshake, replacing the hardcoded `'sol'` value.
- **World Loading Logic**: Verified that `WorldManager.loadWorld` is now called with the dynamically fetched seed.

## Working tree
- Changes are committed to the current branch.
- The project builds and runs, but E2E tests (`app/tests/e2e/warp.spec.ts` and `app/tests/e2e/core.spec.ts`) are currently failing.

## Next steps
1. **Fix E2E Locator Strict Mode Violations**: 
    - The `getByText(callsign)` locator in `core.spec.ts` is resolving to multiple elements (likely the player list and the claim screen/HUD).
    - Recommendation: Use a more specific locator, such as adding `data-testid="player-list"` to the `PlayerList` component and scoping the search to that element.
2. **Debug "Black Screen" Variance Failures**: 
    - The pixel variance check in `warp.spec.ts` (checking if the screen is black during warp-in) may still be failing. Verify if the `WarpOverlay` is correctly rendering and if the WebGL canvas is actually outputting pixels during the transition.
3. **Verify Warp Flow End-to-End**: 
    - Run `npm run test:e2e` and check `.ralph/screenshots/` to visually verify the warp transition.

## Dead ends
- Attempted to simply align `DEFAULT_GALAXY_SEED` in a shared file, but discovered that `.env.local` was overriding the server seed, causing a discrepancy that only a dynamic fetch or environment cleanup could solve.
- Attempted to use `replaceAll: true` on some `edit` calls that failed due to indentation mismatches; reverted to precise string matching.

## How to verify
1. Run the E2E warp test: `npx playwright test app/tests/e2e/warp.spec.ts`.
2. Check browser console logs for `[WorldManager] World swap for ... took ...ms` to ensure the star is found and the world loads.
3. Verify that the "Star with ID ... not found" error no longer appears in the console.
