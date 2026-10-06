import path from 'node:path';
import { expect, test } from './fixtures';
import { canvasRegionStats, collectErrors, uniqueCallsign } from './helpers';
import { ClaimPage } from './pages/claim';

/**
 * TASK-75 — E2E regression: deep space is never black.
 *
 * Before this task the sky (inverted 420 u sphere) and the stars (150–200 u
 * shell) were anchored at the WORLD ORIGIN. Holding W from spawn, the ship
 * flew past the star shell in ~3 s and left the sky sphere in ~5 s — the
 * whole 3D view went black (measured frame luminance 23 → 0.1) while the
 * DOM HUD kept drawing. The fix re-centres both on the camera every frame.
 *
 * This spec teleports the self ship 3000 u from the origin (far beyond
 * every radius involved) via POST /api/dev/teleport and asserts on the
 * TOP band of the canvas (above the chase-camera ship, whose bright hull
 * would mask a blackout in whole-canvas stats): mean luminance > 5 and at
 * least 10 star-bright pixels — before AND after 2 s of thrust.
 */

/** The blackout band: the top 30 % of the canvas, above the ship. */
const TOP_BAND = { x0: 0, y0: 0, x1: 1, y1: 0.3 };
/** Deep space: 3000 u from the origin, far from every planet anchor. */
const DEEP_SPACE = { x: 0, y: 50, z: 3000 };

/** Distance of the rendered self ship from the teleport target (u). */
function probeDistance(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate((t) => {
    const p = window.__SELF_SHIP__?.probe()?.pos;
    if (!p) return -1;
    return Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z);
  }, DEEP_SPACE);
}

test('deep space: sky + stars stay visible at 3000 u from the origin', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL } = e2eServer;
  test.setTimeout(120_000);

  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  const claim = new ClaimPage(page, baseURL);
  // Callsign schema caps at 16 chars: keep the prefix short enough for the
  // 8-char unique suffix (a longer one gets truncated server-side).
  await claim.claim(uniqueCallsign('space'));
  await expect(page.locator('#sys-id')).toBeVisible({ timeout: 20_000 });

  // Chase camera armed (TASK-72 hook): the self ship projects in front.
  await expect
    .poll(() => page.evaluate(() => !!window.__SELF_SHIP__?.probe()?.screen), {
      timeout: 20_000,
      message: 'chase camera never acquired the self ship',
    })
    .toBe(true);

  // (1) Baseline at spawn: the top band is not black.
  const atSpawn = await canvasRegionStats(page, TOP_BAND);
  expect(atSpawn.mean, 'top band mean at spawn').toBeGreaterThan(5);

  // The first input undocks a docked ship — tap W once BEFORE the
  // teleport so the hard-set lands on an in-flight ship.
  await page.keyboard.press('w');

  // (2) Teleport FAR from the origin (dev assist, bearer from the claim).
  const token = await page.evaluate(() => localStorage.getItem('drift.token'));
  expect(token, 'session token in localStorage').toBeTruthy();
  const tele = await page.request.post(`${baseURL}/api/dev/teleport`, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    data: DEEP_SPACE,
  });
  expect(tele.status(), `teleport response: ${await tele.text()}`).toBe(200);

  // Wait for the rendered ship to arrive (the big diff reconciles as a
  // rewind within a 10 Hz snapshot; the server broadcasts 3000 u out).
  await expect
    .poll(() => probeDistance(page), {
      timeout: 20_000,
      message: 'teleported ship never reached deep space (3000 u)',
    })
    .toBeLessThan(50);

  // (3) Far from the origin the top band is NOT black: the sky gradient is
  // visible (mean > 5) and stars are drawn (>= 10 bright pixels).
  const atDeep = await canvasRegionStats(page, TOP_BAND);
  expect(atDeep.mean, 'top band mean at 3000 u from the origin').toBeGreaterThan(5);
  expect(
    atDeep.bright,
    'top band bright (star) pixels at 3000 u from the origin',
  ).toBeGreaterThanOrEqual(10);

  // Visual artifact: stars + the blue sky gradient around the ship, far
  // from the origin (.ralph/screenshots/TASK-75-1.png).
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-75-1.png'),
  });

  // (4) Hold W for 2 s — flying FURTHER from the origin must not black out.
  await page.keyboard.down('w');
  await page.waitForTimeout(2000);
  await page.keyboard.up('w');
  const afterThrust = await canvasRegionStats(page, TOP_BAND);
  expect(afterThrust.mean, 'top band mean after 2 s of thrust').toBeGreaterThan(5);
  expect(
    afterThrust.bright,
    'top band bright (star) pixels after 2 s of thrust',
  ).toBeGreaterThanOrEqual(10);

  console.log(
    `[TASK-75] top band mean/bright: spawn=${atSpawn.mean.toFixed(1)}/${atSpawn.bright} ` +
      `deep=${atDeep.mean.toFixed(1)}/${atDeep.bright} ` +
      `after-thrust=${afterThrust.mean.toFixed(1)}/${afterThrust.bright}`,
  );

  assertClean();
  await context.close();
});
