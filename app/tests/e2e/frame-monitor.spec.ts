import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { ClaimPage } from './pages/claim';

/**
 * TASK-57 e2e (happy path): the dev-mode frame monitor on the live
 * SwiftShader-rendered scene (TASK-70 harness). Claim → F3 toggles the
 * top-right overlay on (hidden by default), the stats update from the live
 * render loop (draw calls / triangles non-zero, entity count present), and
 * F3 again hides it. Screenshots: .ralph/screenshots/TASK-57-{1,2}.png
 */
test('frame monitor: F3 toggles the dev overlay with live stats', async ({
  browser,
  e2eServer,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  const claim = new ClaimPage(page, e2eServer.baseURL);

  await claim.claim(uniqueCallsign('perf'));
  const overlay = page.locator('#frame-monitor');

  // Hidden by default (dev build, never mounted in prod).
  await expect(overlay).toHaveCount(0);

  // F3 shows the overlay; the live render loop feeds it real stats.
  await page.keyboard.press('F3');
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText(/FPS \d+/);
  // Draw calls + triangles come from renderer.info of the live world render.
  await expect(overlay).toContainText(/DRAWS \d+ · TRIS \d+/);
  await expect(overlay).toContainText(/ENTITIES \d+/);
  await page.screenshot({ path: '../.ralph/screenshots/TASK-57-1.png' });

  // Values update at 2 Hz: the frame-time percentiles are rendered live.
  await expect(overlay).toContainText(/FRAME p50\/p95\/p99 \d+\.\d+ \/ \d+\.\d+ \/ \d+\.\d+ ms/);
  await page.screenshot({ path: '../.ralph/screenshots/TASK-57-2.png' });

  // F3 again hides it.
  await page.keyboard.press('F3');
  await expect(overlay).toHaveCount(0);

  assertClean();
});
