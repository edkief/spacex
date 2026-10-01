import path from 'node:path';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { ClaimPage } from './pages/claim';
import { GamePage } from './pages/game';

/**
 * TASK-28.1 atmosphere view: live-wiring smoke. The new path is exercised
 * the moment a session is in-system: the WorldManager constructor now builds
 * the dome and marks the sky transparent, and every 10 Hz self
 * entity_update calls setAtmosphereView through the useGameSession callback.
 * In space the dome is hidden and the skybox is untouched, so the canvas
 * must keep rendering non-uniformly with a CLEAN console (a TDZ or material
 * regression would show up as a pageerror or a flat/black canvas).
 * The pixel-level dome probe is TASK-28.3.
 */
test('atmosphere view: in-system wiring runs with a clean console and live skybox', async ({
  browser,
  e2eServer,
}) => {
  const callsign = uniqueCallsign('atmo');
  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  const claim = new ClaimPage(page, e2eServer.baseURL);
  const game = new GamePage(page, e2eServer.baseURL);

  // Claim + join: the app opens the WS session and the self entity_update
  // stream (10 Hz) starts driving setAtmosphereView immediately.
  await claim.claim(callsign);

  // First: the canvas renders a non-uniform world (dome hidden in space —
  // the skybox must not have been blacked out by the new transparent sky).
  await expect
    .poll(() => game.canvasPixelVariance(), {
      timeout: 15_000,
      message: '#game-canvas is not rendering a non-uniform world',
    })
    .toBeGreaterThan(1);

  // Keep the session alive so MANY 10 Hz self snapshots flow through the new
  // wiring (space → null planet → dome.set(0) + sky opacity 1 — idempotent),
  // then confirm the sky still renders non-uniformly.
  await page.waitForTimeout(1_500);
  const variance = await game.canvasPixelVariance();
  expect(
    variance,
    'skybox must still render non-uniformly after 10 Hz atmosphere updates',
  ).toBeGreaterThan(1);

  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-28.1-1.png'),
  });
  assertClean();
  await context.close();
});
