import path from 'node:path';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { ClaimPage } from './pages/claim';

/**
 * TASK-51 e2e — the flight HUD: claim → join the seeded pad system →
 * dev-teleport the ship to THREE states and screenshot each:
 *
 * 1. mid-ATMOSPHERE (600 m over the pad): the HUD block shows a speed
 *    readout (m/s, 1 decimal), an 'ALT … m' altitude and the ATMOS regime
 *    tag (server authority), plus the nav readout toward the nearest
 *    station;
 * 2. in SPACE (3000 m, above the atmosphere enter radius): the altitude
 *    is '—' and the regime tag reads SPACE — the two screenshots differ in
 *    exactly the regime readout;
 * 3. DOCKED on the pad: the green 'DOCKED · <STATION>' tag appears in the
 *    HUD block (and the legacy bottom-center indicator, TASK-29.3).
 */

interface PadTarget {
  systemId: string;
  planetId: string;
  padId: string;
  pad: { x: number; y: number; z: number };
}

test('flight HUD: altitude + space + docked (two-regime screenshots)', async ({
  browser,
  e2eServer,
}) => {
  test.setTimeout(120_000);
  const callsign = uniqueCallsign('shud');
  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);

  // REST claim (bypasses the form so we can steer the join target).
  const claim = await page.request.post(`${e2eServer.baseURL}/api/callsigns`, {
    data: { callsign },
  });
  expect(claim.status()).toBe(201);
  const session = (await claim.json()) as {
    token: string;
    playerId: string;
    callsign: string;
    homeSystemId: string;
  };
  const auth = { authorization: `Bearer ${session.token}` };

  // The first seeded system with a landable atmospheric planet + its pad.
  const target = (await (
    await page.request.get(`${e2eServer.baseURL}/api/dev/pad-target`, { headers: auth })
  ).json()) as PadTarget;
  const teleport = async (x: number, y: number, z: number) => {
    const res = await page.request.post(`${e2eServer.baseURL}/api/dev/teleport`, {
      headers: auth,
      data: { x, y, z },
    });
    expect(res.status()).toBe(200);
  };

  // Boot the app straight into the pad system with a pre-seeded session.
  await page.goto(`${e2eServer.baseURL}/?sys=${target.systemId}`);
  await page.evaluate((s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)), session);
  await page.reload();
  const claimPage = new ClaimPage(page, e2eServer.baseURL);
  await expect(claimPage.playerList).toContainText(`${callsign} (you)`);

  // (1) Mid-ATMOSPHERE: the HUD block is up with speed, meters altitude
  // and the ATMOS tag; the nav readout points at the nearest station.
  await teleport(target.pad.x, target.pad.y + 600, target.pad.z);
  await expect(page.locator('#ship-hud-regime')).toHaveText('ATMOS', { timeout: 20_000 });
  await expect(page.locator('#ship-hud-speed')).toContainText(' m/s', { timeout: 20_000 });
  await expect(page.locator('#ship-hud-altitude')).toContainText(' m', { timeout: 20_000 });
  await expect(page.locator('#ship-hud-nav')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#ship-hud-vitals')).toContainText('%', { timeout: 20_000 });
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-51-1.png'),
  });

  // (2) SPACE: altitude is '—' and the regime tag flips to SPACE.
  await teleport(target.pad.x, target.pad.y + 3_000, target.pad.z);
  await expect(page.locator('#ship-hud-regime')).toHaveText('SPACE', { timeout: 20_000 });
  await expect(page.locator('#ship-hud-altitude')).toHaveText('—', { timeout: 20_000 });
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-51-2.png'),
  });

  // (3) DOCKED: settle on the pad center — the green DOCKED tag with the
  // station name appears in the HUD block.
  await teleport(target.pad.x, target.pad.y, target.pad.z);
  await expect(page.locator('#ship-hud-docked')).toContainText('DOCKED', { timeout: 30_000 });
  expect(await page.locator('#ship-hud-docked').textContent()).toContain('STATION');

  assertClean();
  await context.close();
});
