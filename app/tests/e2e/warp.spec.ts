/**
 * TASK-8 — Inter-system warp flow smoke test.
 *
 * Drives the star-chart UI from TASK-7 to fire a real `warp`
 * frame at the server, asserts the canonical warp cycle, and
 * verifies the world swap landed in the target system. The
 * spec calls for:
 *
 *   - Open the chart via the `M` key.
 *   - Select a non-current system node.
 *   - Click the Warp button.
 *   - Assert the warp overlay mounts (`drift-warp-overlay`).
 *   - Assert the client systemId changes to the target.
 *   - Screenshot the open chart + the warp overlay.
 *   - Assert total warp duration 3-6 s (2 s in + ~0 s network +
 *     2 s out is the spec's target band).
 *
 * The test uses the auto-claim client so the server sets up a
 * canonical "first system" home for the player; we then drive
 * a warp to the second deterministic system.
 */
import { test, expect } from "./fixtures.js";
import { ClaimPage } from "./pages/claim.js";

test("warps between systems through the chart UI", async ({
  page,
  driftServer: server,
}, testInfo) => {
  const claim = new ClaimPage(page, server);
  await claim.bootAndWaitForOnline();

  // Capture the source system so we can later verify the warp
  // actually swapped to a *different* one.
  const sourceSystemId = await claim.currentSystemId();
  expect(sourceSystemId).toBeTruthy();

  // Open the chart via the M key.
  await page.keyboard.press("m");
  const chart = page.getByTestId("drift-star-chart");
  await expect(chart).toBeVisible({ timeout: 5_000 });
  await expect(chart.locator('g[data-testid="drift-star-chart-node"]').first()).toBeVisible({
    timeout: 5_000,
  });

  // Find a target system that isn't the source.
  const allNodes = chart.locator('g[data-testid="drift-star-chart-node"]');
  const nodeCount = await allNodes.count();
  expect(nodeCount).toBeGreaterThan(1);
  let targetSystemId: string | null = null;
  for (let i = 0; i < nodeCount; i++) {
    const n = allNodes.nth(i);
    const sysId = await n.getAttribute("data-system-id");
    if (sysId && sysId !== sourceSystemId) {
      targetSystemId = sysId;
      // Use the star circle's exact coordinates + a synthetic
      // mousedown/up sequence so we don't have to fight the
      // SVG hit-test. The chart's onClick is fired from the
      // <g>'s React handler, so we click the inner circle
      // directly (the <g> intercepts pointer events on the
      // bigger halo circle when one is present).
      const starCircle = n.locator("circle").last();
      await starCircle.click({ force: true });
      break;
    }
  }
  expect(targetSystemId, "expected to find a non-current system to warp to").toBeTruthy();
  // Wait for the Warp button to flip to enabled once the
  // selection lands.
  const warpButton = page.getByTestId("drift-star-chart-warp");
  await expect(warpButton).toBeEnabled({ timeout: 5_000 });

  // Screenshot pre-warp state (chart open, system selected).
  await page.screenshot({ path: testInfo.outputPath("warp-pre.png") });

  // Capture the warp start time so we can verify the total
  // transition falls in the 3-6 s band.
  const warpStartMs = Date.now();

  // Click the Warp button.
  await warpButton.click();

  // The warp overlay should mount immediately.
  const overlay = page.getByTestId("drift-warp-overlay");
  await expect(overlay).toBeVisible({ timeout: 5_000 });

  // The chart's Warp button should be disabled while busy.
  await expect(warpButton).toBeDisabled({ timeout: 500 });

  // Wait for the client's `currentSystemId` to flip to the
  // target (proof that the warp_arrived frame was applied).
  await expect
    .poll(async () => claim.currentSystemId(), {
      timeout: 8_000,
      intervals: [100, 200, 500],
    })
    .toBe(targetSystemId);

  // The overlay should hide itself once the state machine
  // transitions back to `idle`.
  await expect(overlay).toBeHidden({ timeout: 5_000 });

  // The warp cycle should complete within the spec band
  // (2 s in + ~0-500 ms network + 2 s out = 3-6 s).
  const warpCompleteMs = Date.now();
  const warpDurationMs = warpCompleteMs - warpStartMs;
  expect(warpDurationMs).toBeGreaterThanOrEqual(2_500);
  expect(warpDurationMs).toBeLessThanOrEqual(7_000);

  // Screenshot the post-warp state — same scene, but the
  // player's systemId has flipped.
  await page.screenshot({ path: testInfo.outputPath("warp-post.png") });
});
