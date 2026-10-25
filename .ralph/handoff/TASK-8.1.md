## Status
The inter-system warp flow visuals and happy path are being fixed. The E2E tests for warp flow are currently failing because the Star Chart remains open, obscuring the Warp button and causing timeouts.

## Done
- Added `data-testid="warp-overlay"` to `WarpOverlay.tsx` to allow reliable verification of the warp transition in E2E tests.
- Modified `app/tests/e2e/warp.spec.ts` to verify the visibility of the `WarpOverlay` instead of performing a canvas pixel variance check (which failed because the overlay covers the canvas).
- Attempted to fix the Star Chart visibility issue by calling `setIsChartOpen(false)` when warping begins in `app/src/client/main.tsx`.

## Working tree
- Changes in `app/src/client/ui/WarpOverlay.tsx` (added test ID).
- Changes in `app/tests/e2e/warp.spec.ts` (updated verification logic).
- Changes in `app/src/client/main.tsx` (added `setIsChartOpen(false)` to the warp coordination logic).
- The project builds, but E2E tests are currently failing.

## Next steps
1. Investigate why the `Warp` button is not becoming visible/hidden as expected in `warp.spec.ts`. The current failure is `expect(warpButton).toHaveText('Warping...')` failing because the element is not found.
2. Ensure the `StarChart` is correctly closing when the warp starts, as the `Warp` button is inside the `StarChart` component. If `setIsChartOpen(false)` is called too early, the `warpButton` locator might fail immediately.
3. Verify the timing of `setIsChartOpen(false)` in `app/src/client/main.tsx`. It might need to happen *after* the "Warping..." state is verified in the test, or the test needs to be updated to handle the transition.
4. Run `cd app && npm run test:e2e` to verify.

## Dead ends
- Using `gl.readPixels` to detect "black screens" during warp transitions failed because the `WarpOverlay` is a DOM element that covers the canvas, making the canvas content irrelevant to the user's visual experience of the transition.

## How to verify
1. Run E2E tests: `cd app && npm run test:e2e`.
2. Specifically check `app/tests/e2e/warp.spec.ts`.
3. Manually verify that clicking "Warp" in the Star Chart closes the chart and shows the `WarpOverlay`.
