import path from 'node:path';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { ClaimPage } from './pages/claim';

/**
 * TASK-48.2 smoke (client hazard slice):
 *
 * 1. GET /api/dev/hazard-target returns the deterministic FIRST storm cell
 *    ({systemId, planetId, hazardId, pos, radius} — the same seeded scan the
 *    shard enforces) instead of 404;
 * 2. the app boots (in the ship, never in a hazard) and the dev-only
 *    `window.__HAZARD__` hook is LIVE with the clear default
 *    {exposure: 50, inside: null, recovering: false} (the read-through the
 *    TASK-48.4 in-storm e2e asserts on);
 * 3. #hazard-hud is unmounted while clear (radiation meter hidden).
 *
 * The full in-storm flow (warp → disembark → teleport-char → exposure < 50
 * → SHIELD BURN prompt) is the TASK-48.4 e2e; the HUD rendering itself is
 * covered by the unit tests (hazard-hud.test.tsx).
 */
test('hazard dev route + __HAZARD__ hook + hidden HUD when clear', async ({
  browser,
  e2eServer,
}) => {
  const callsign = uniqueCallsign('hz');
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

  // The deterministic first storm cell (same seeded scan as pad-target).
  const target = await page.request.get(`${e2eServer.baseURL}/api/dev/hazard-target`, {
    headers: auth,
  });
  expect(target.status()).toBe(200);
  const cell = (await target.json()) as {
    systemId: string;
    planetId: string;
    hazardId: string;
    pos: { x: number; y: number; z: number };
    radius: number;
  };
  expect(cell.systemId).toMatch(/^[0-9a-f]{16}$/);
  expect(cell.planetId).toBeTruthy();
  expect(cell.hazardId).toMatch(/:hz:\d+$/);
  expect(cell.pos).toEqual(
    expect.objectContaining({
      x: expect.any(Number),
      y: expect.any(Number),
      z: expect.any(Number),
    }),
  );
  expect(cell.radius).toBeGreaterThan(0);

  // Boot the app straight into the home system with a pre-seeded session.
  await page.goto(`${e2eServer.baseURL}/`);
  await page.evaluate((s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)), session);
  await page.reload();
  const claimPage = new ClaimPage(page, e2eServer.baseURL);
  await expect(claimPage.playerList).toContainText(`${callsign} (you)`);

  // The dev hook is LIVE (read-through over the store) with the clear
  // default — in the ship the hazard frames never arrive.
  const hazard = await page.waitForFunction(() => window.__HAZARD__, undefined, {
    timeout: 10_000,
  });
  const state = (await hazard.jsonValue()) as {
    exposure: number;
    inside: string | null;
    recovering: boolean;
  };
  expect(state).toEqual({ exposure: 50, inside: null, recovering: false });

  // Not in a hazard → the radiation meter is unmounted.
  await expect(page.locator('#hazard-hud')).toBeHidden();
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-48.2-1.png'),
  });
  assertClean();
  await context.close();
});
