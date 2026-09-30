import path from 'node:path';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { ClaimPage } from './pages/claim';

/**
 * TASK-7 star chart smoke: open the chart (M key) → 3 seeded systems render
 * as nodes with labeled edges → select a non-current node → the Warp button
 * enables with the estimated travel time → Escape closes. Screenshot:
 * .agent/screenshots/TASK-7-1.png
 */
test('star chart: open, nodes + edges, select, warp button, close', async ({
  browser,
  e2eServer,
}) => {
  const callsign = uniqueCallsign('chart');
  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  const claim = new ClaimPage(page, e2eServer.baseURL);

  await claim.claim(callsign);
  const currentSys = await claim.systemId();

  // Open with the M key (the HUD Systems button is the same toggle).
  await page.keyboard.press('m');
  await expect(page.locator('#star-chart')).toBeVisible();
  await expect(page.locator('#star-chart-loading')).toBeHidden();

  const nodes = page.locator('[data-testid="star-chart-node"]');
  await expect(nodes).toHaveCount(3); // 3 seeded systems in v1
  await expect(page.locator('[data-testid="star-chart-edge"]')).toHaveCount(3); // K3

  // The current system is highlighted.
  await expect(
    page.locator(`[data-testid="star-chart-node"][data-system-id="${currentSys}"]`),
  ).toHaveAttribute('data-current', 'true');

  // Edges carry the light-second distance + warp time label.
  const edges = page.locator('[data-testid="star-chart-edge"] text');
  await expect(edges.first()).toHaveText(/ls · \d+(s|m \d+s|h \d+m)/);

  // Select a different node → the Warp button enables with the ETA.
  const other = page.locator('[data-testid="star-chart-node"][data-current="false"]');
  await expect(other).toHaveCount(2);
  await other.first().click();
  await expect(page.locator(`[data-system-id="${currentSys}"]`)).toHaveAttribute(
    'data-selected',
    'false',
  );
  await expect(other.first()).toHaveAttribute('data-selected', 'true');
  const warpButton = page.locator('#warp-button');
  await expect(warpButton).toBeEnabled();
  await expect(warpButton).toHaveText(/WARP — \d+(s|m \d+s|h \d+m)/);

  await page.screenshot({
    path: path.join(__dirname, '../../../.agent/screenshots/TASK-7-1.png'),
  });

  // Escape closes the chart.
  await page.keyboard.press('Escape');
  await expect(page.locator('#star-chart')).toBeHidden();

  assertClean();
  await context.close();
});
