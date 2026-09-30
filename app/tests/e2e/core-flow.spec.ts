import path from 'node:path';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { ClaimPage } from './pages/claim';
import { GamePage } from './pages/game';

/**
 * TASK-70 core flow: claim callsign (form) → session established → join a
 * system → canvas renders the starfield (headless WebGL, pixel-sampled) →
 * player list shows the callsign.
 */
test('core flow: claim → session → join → starfield → player list', async ({
  browser,
  e2eServer,
}) => {
  const callsign = uniqueCallsign('dr');
  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  const claim = new ClaimPage(page, e2eServer.baseURL);
  const game = new GamePage(page, e2eServer.baseURL);

  // Claim via the form; the app opens the WS session and joins on its own.
  await claim.claim(callsign);
  await expect(page.locator('#sys-id')).toContainText('aboard');

  // Headless WebGL render smoke: the canvas must be drawn AND non-uniform.
  await expect
    .poll(() => game.canvasPixelVariance(), {
      timeout: 15_000,
      message: '#game-canvas is not rendering a non-uniform starfield',
    })
    .toBeGreaterThan(1);

  // Player list shows our own callsign with the "(you)" marker.
  await expect(game.playerList).toContainText(`${callsign} (you)`);

  await page.screenshot({
    path: path.join(__dirname, '../../../.agent/screenshots/TASK-70-1.png'),
  });
  assertClean();
  await context.close();
});
