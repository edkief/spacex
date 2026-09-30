import path from 'node:path';
import { expect, test } from './fixtures';
import {
  canvasCenterLuminanceMean,
  canvasLuminanceVariance,
  collectErrors,
  uniqueCallsign,
} from './helpers';
import { ClaimPage } from './pages/claim';

/**
 * TASK-8 e2e: the full inter-system warp in a real browser (TASK-70
 * harness). Claim → open the chart (M) → select a non-current system →
 * WARP:
 * - the button disables (WARPING…) for the whole transition (double-warp
 *   guard, spec: warp cannot be started twice);
 * - at t ≈ 1 s into the 2 s warp-in the canvas is still a rendered,
 *   non-flat frame (no loading screen / black frame — pixel-variance);
 * - the total transition (click → overlay detach) is 3–6 s
 *   (2 s in + network + 2 s out);
 * - the world swap landed on the target system and built under the
 *   300 ms budget (__DRIFT__.worldSwap, dev-only hook);
 * - the target system's star renders at the canvas center (mean
 *   luminance of a 32x32 center sample);
 * - no console/page errors.
 * Screenshots: .ralph/screenshots/TASK-8-{1,2,3}.png
 */
test('warp: in-world transition to the target system', async ({ browser, e2eServer }) => {
  const callsign = uniqueCallsign('warp');
  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  const claim = new ClaimPage(page, e2eServer.baseURL);

  await claim.claim(callsign);
  const currentSys = await claim.systemId();

  // Open the chart and select the first non-current system.
  await page.keyboard.press('m');
  await expect(page.locator('#star-chart')).toBeVisible();
  await expect(page.locator('#star-chart-loading')).toBeHidden();
  const other = page.locator('[data-testid="star-chart-node"][data-current="false"]');
  await expect(other).toHaveCount(2);
  await other.first().click();
  const targetSys = await other.first().getAttribute('data-system-id');
  expect(targetSys).toBeTruthy();
  expect(targetSys).not.toBe(currentSys);

  await page.screenshot({ path: path.join(__dirname, '../../../.ralph/screenshots/TASK-8-1.png') });

  // Fire the warp; the button must disable for the whole transition.
  const warpButton = page.locator('#warp-button');
  const t0 = Date.now();
  await warpButton.click();
  await expect(warpButton).toBeDisabled();
  await expect(warpButton).toHaveText('WARPING…');

  // t ≈ 1 s into the 2 s warp-in: the canvas is still a RENDERED frame —
  // the transition is a warp streak over a live scene, never a black or
  // flat frame (spec: no loading screen).
  await page.waitForTimeout(1000);
  expect(await canvasLuminanceVariance(page), 'no black frame mid-warp').toBeGreaterThan(1);
  await page.screenshot({ path: path.join(__dirname, '../../../.ralph/screenshots/TASK-8-2.png') });

  // The overlay (streaks + core) is mounted during the transition and
  // detaches when the phase returns to idle. Total duration: 3–6 s.
  const overlay = page.locator('#warp-overlay');
  await expect(overlay).toBeVisible({ timeout: 5000 });
  await expect(overlay).toHaveCount(0, { timeout: 15000 });
  const elapsedMs = Date.now() - t0;
  expect(elapsedMs, `warp took ${elapsedMs} ms`).toBeGreaterThanOrEqual(3000);
  expect(elapsedMs, `warp took ${elapsedMs} ms`).toBeLessThanOrEqual(6000);

  // The world swap landed on the target system and built under budget.
  const swap = await expect
    .poll(
      () =>
        page.evaluate(() => {
          const w = window.__DRIFT__?.worldSwap;
          return w ? { systemId: w.systemId, buildMs: w.buildMs } : null;
        }),
      { timeout: 5000 },
    )
    .toEqual({
      systemId: targetSys,
      buildMs: expect.any(Number),
    });
  const buildMs = (await page.evaluate(() => window.__DRIFT__?.worldSwap?.buildMs)) ?? -1;
  expect(buildMs).toBeGreaterThan(0);
  expect(buildMs).toBeLessThan(300);
  void swap;

  // The HUD status line follows the ship into the target system.
  await expect(page.locator('#sys-id')).toContainText(`sys ${targetSys}`);

  // The target system's star renders at the canvas center (the WorldManager
  // camera centers on the system origin, where the star sits).
  expect(await canvasCenterLuminanceMean(page), 'star at canvas center').toBeGreaterThan(100);

  await page.screenshot({ path: path.join(__dirname, '../../../.ralph/screenshots/TASK-8-3.png') });

  assertClean();
  await context.close();
});
