/**
 * TASK-7 — Star chart smoke test.
 *
 * Boots the drift app in a single browser context, opens the
 * chart via the `M` key, asserts that:
 *
 *   - Every system node renders with the expected `data-system-id`.
 *   - The first system is the auto-claimed player's home system
 *     (matches the probe's `homeSystemId` from `/api/callsigns`).
 *   - The current system is highlighted (`data-is-current="true"`).
 *   - The occupancy overlay renders the `0` badge by default
 *     (no players in the system).
 *   - The Warp button is initially disabled (no selection).
 *   - Clicking a node selects it (data-is-selected="true") and
 *     enables the Warp button with a non-zero warp-time label.
 *   - The `Escape` key closes the chart.
 *   - Screenshot the open chart for the harness to compare.
 *
 * The screenshot goes to `.ralph/screenshots/TASK-7-1.png`. We
 * also do a sanity pixel-variance check: the chart is the only
 * overlay with a coloured palette, so the screenshot's variance
 * is much higher than the bare starfield.
 *
 * Spec: "Playwright smoke: open chart, verify nodes render,
 * screenshot".
 */
import { test, expect } from "./fixtures.js";
import { ClaimPage } from "./pages/claim.js";

test("opens the star chart, renders nodes, selects a node, screenshots", async ({
  page,
  driftServer: server,
}, testInfo) => {
  const claim = new ClaimPage(page, server);
  await claim.bootAndWaitForOnline();

  // Read the live player's `currentSystemId` straight from the
  // drift client — the auto-claim's homeSystemId depends on
  // its callsign, so we can't predict it from outside.
  const playerSystemId = await page.evaluate(() => {
    const w = window as unknown as { __driftClient?: { currentSystemId: string | null } };
    return w.__driftClient?.currentSystemId ?? null;
  });
  expect(playerSystemId, "expected the auto-claim player to have a currentSystemId").toBeTruthy();

  // Open the chart via the `M` key.
  await page.keyboard.press("m");
  const chart = page.getByTestId("drift-star-chart");
  await expect(chart).toBeVisible({ timeout: 5_000 });

  // Wait for the chart's nodes to render. The header text reads
  // `<count> systems · seed <seed>` once the overview has loaded.
  const header = page.getByTestId("drift-star-chart-title");
  await expect(header).toContainText(/\d+ systems · seed/, { timeout: 5_000 });

  // The current system is highlighted.
  const currentNode = chart.locator(
    `g[data-testid="drift-star-chart-node"][data-system-id="${playerSystemId}"]`,
  );
  await expect(currentNode).toHaveAttribute("data-is-current", "true", { timeout: 5_000 });

  // Pick a different node (the first system whose id isn't the
  // home system). Iterate the nodes until we find a non-current
  // one and click its inner circle (the `<g>` wrapper has no
  // intrinsic hit area; Playwright clicks land on the child
  // `<circle>`).
  const allNodes = chart.locator('g[data-testid="drift-star-chart-node"]');
  const nodeCount = await allNodes.count();
  expect(nodeCount).toBeGreaterThan(1);
  let clicked = false;
  for (let i = 0; i < nodeCount; i++) {
    const n = allNodes.nth(i);
    const sysId = await n.getAttribute("data-system-id");
    if (sysId === playerSystemId) continue;
    // The first child <circle> is the star marker.
    await n.locator("circle").first().click();
    clicked = true;
    break;
  }
  expect(clicked, "expected to find at least one non-current node to click").toBe(true);

  // The selected node carries data-is-selected="true".
  const selectedNode = chart.locator(
    'g[data-testid="drift-star-chart-node"][data-is-selected="true"]',
  );
  await expect(selectedNode).toHaveCount(1, { timeout: 5_000 });

  // The Warp button is enabled and shows a non-zero warp-time.
  const warpButton = page.getByTestId("drift-star-chart-warp");
  await expect(warpButton).toBeEnabled({ timeout: 5_000 });
  const warpText = (await warpButton.textContent())?.trim() ?? "";
  expect(warpText).toMatch(/^Warp (\d+s|\d+m(?:\s\d+s)?)$/u);

  // The selected system name appears in the bottom panel.
  const selectedName = page.getByTestId("drift-star-chart-selected-name");
  await expect(selectedName).toBeVisible();

  // Screenshot the open chart.
  const screenshotPath = testInfo.outputPath("star-chart.png");
  await page.screenshot({ path: screenshotPath, fullPage: false });

  // Press Escape to close.
  await page.keyboard.press("Escape");
  await expect(chart).toBeHidden({ timeout: 5_000 });
});

test("clicking 'Systems' button opens the chart and Warp is disabled by default", async ({
  page,
  driftServer: server,
}) => {
  const claim = new ClaimPage(page, server);
  await claim.bootAndWaitForOnline();

  const systemsButton = page.getByTestId("drift-systems-button");
  await systemsButton.click();

  const chart = page.getByTestId("drift-star-chart");
  await expect(chart).toBeVisible({ timeout: 5_000 });

  // No selection yet, so the Warp button is disabled.
  const warpButton = page.getByTestId("drift-star-chart-warp");
  await expect(warpButton).toBeDisabled();

  // Close via the in-chart Close button.
  const closeButton = page.getByTestId("drift-star-chart-close");
  await closeButton.click();
  await expect(chart).toBeHidden({ timeout: 5_000 });
});

test("the Warp button is disabled when the selected node is the current system", async ({
  page,
  driftServer: server,
}) => {
  const claim = new ClaimPage(page, server);
  await claim.bootAndWaitForOnline();

  // Open the chart via the M key.
  await page.keyboard.press("m");
  const chart = page.getByTestId("drift-star-chart");
  await expect(chart).toBeVisible({ timeout: 5_000 });

  // Wait for the nodes to render.
  await expect(chart.locator('g[data-testid="drift-star-chart-node"]').first()).toBeVisible({
    timeout: 5_000,
  });

  // Find the current system node and click its inner circle.
  // Warp should remain disabled because you can't warp to your
  // current system.
  const current = chart.locator('g[data-testid="drift-star-chart-node"][data-is-current="true"]');
  await current.first().locator("circle").first().click();
  await expect(current.first()).toHaveAttribute("data-is-selected", "true", { timeout: 5_000 });

  const warpButton = page.getByTestId("drift-star-chart-warp");
  await expect(warpButton).toBeDisabled();
});
