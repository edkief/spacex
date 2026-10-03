import path from 'node:path';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { ClaimPage } from './pages/claim';

/**
 * TASK-43 — E2E: fire a laser in the browser and prove the flash was
 * server-driven. The e2eServer fixture boots the real dev server itself
 * (random ports, tmp sqlite, NODE_ENV=development — so the DEV-only
 * window.__FX__ hook exists); never run alongside npm run dev.
 *
 * The scout's only weapon is the laser, so a plain LMB click on the canvas
 * sends a 'fire' frame. The server re-derives the ray and, for EVERY
 * accepted fire, broadcasts a 'laser-fired' combat_event. window.__FX__
 * (fx-debug.ts) counts only server combat_event frames — a denied fire
 * produces no event and therefore no FX — so laserFlashes >= 1 alone
 * proves the server accepted the shot. Under dataset.fxSlow the 60 ms
 * laser flash is stretched to 500 ms so the screenshot catches the line.
 */

test('LMB fire: the laser flash arrives as a server combat event', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL } = e2eServer;
  test.setTimeout(150_000);

  // (1) Claim in the browser: the player spawns INSIDE the docked scout.
  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  const claim = new ClaimPage(page, baseURL);
  await claim.claim(uniqueCallsign('wep'));
  await expect(page.locator('#ship-hud-cargo')).toBeVisible({ timeout: 20_000 });

  // (2) Stretch the FX lifetimes (combat-fx.ts reads documentElement).
  await page.evaluate(() => {
    document.documentElement.dataset.fxSlow = '1';
  });

  // (3) The weapon HUD stub: the 'LASER' loadout + the full energy bar.
  const hud = page.locator('#weapon-hud');
  await expect(hud).toBeVisible({ timeout: 20_000 });
  await expect(hud).toContainText('LASER');
  await expect(hud).toContainText(/100\/100/);

  // (4) LMB at the canvas center: mousedown sends the 'fire' frame. The
  // server has no docked gate — the pad shot is accepted (energy 100).
  const box = await page.locator('#game-canvas').boundingBox();
  if (!box) throw new Error('no bounding box for #game-canvas');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.click(cx, cy);

  // (5) Poll the DEV hook: only server combat_event frames count. If the
  // first shot was swallowed (e.g. energy still materializing), re-fire
  // ONCE — the 333 ms cooldown allows it; do not over-engineer retries.
  const flashes = () => page.waitForFunction(
    () => (window.__FX__?.laserFlashes ?? 0) >= 1,
    undefined,
    { timeout: 5_000, polling: 50 },
  );
  try {
    await flashes();
  } catch {
    await page.mouse.click(cx, cy);
    await flashes();
  }

  // (6) The stretched (~500 ms) flash is in the frame.
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-43-1.png'),
  });

  assertClean();
  await context.close();
});
