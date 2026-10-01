import path from 'node:path';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { ClaimPage } from './pages/claim';

/**
 * TASK-29.3 smoke (client half of docking): claim → join the seeded pad
 * system → dev-teleport the ship onto its pad → the #docked-indicator node
 * appears (server docked → regime 'docked' + padId on the wire). The pad
 * ring itself is visible in the screenshot but not pixel-asserted.
 */
test('docked indicator appears when the ship is server-docked on a pad', async ({
  browser,
  e2eServer,
}) => {
  const callsign = uniqueCallsign('dk');
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
  ).json()) as { systemId: string; pad: { x: number; y: number; z: number } };

  // Boot the app straight into the pad system with a pre-seeded session.
  await page.goto(`${e2eServer.baseURL}/?sys=${target.systemId}`);
  await page.evaluate((s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)), session);
  await page.reload();
  const claimPage = new ClaimPage(page, e2eServer.baseURL);
  await expect(claimPage.playerList).toContainText(`${callsign} (you)`);
  await expect(page.locator('#docked-indicator')).toBeHidden();

  // Teleport onto the pad center: ground contact settles the ship
  // (vel.y → 0, altitude 0, surface regime) → the sim docks it.
  const tele = await page.request.post(`${e2eServer.baseURL}/api/dev/teleport`, {
    headers: auth,
    data: target.pad,
  });
  expect(tele.status()).toBe(200);

  await expect(page.locator('#docked-indicator')).toBeVisible({ timeout: 15_000 });
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-29.3-1.png'),
  });
  assertClean();
  await context.close();
});
