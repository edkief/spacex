import path from 'node:path';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { ClaimPage } from './pages/claim';
import { RawWsClient } from './raw-ws';

/**
 * TASK-29.3 smoke (client half of docking): claim → join home over raw WS +
 * warp to the pad's system (warp is the ONLY path that persists
 * position.systemId onto the ship row, and /api/dev/teleport resolves the
 * shard by that row — a browser boot straight into ?sys= leaves the row on
 * home, whose shard is not active → 409) → dev-teleport the ship onto its
 * pad → the #docked-indicator node appears (server docked → regime 'docked'
 * + padId on the wire). The pad ring itself is visible in the screenshot but
 * not pixel-asserted.
 */
const PROTOCOL_VERSION = 1; // mirrors @shared/protocol (Playwright does not resolve tsconfig aliases)

test('docked indicator appears when the ship is server-docked on a pad', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL, apiPort } = e2eServer;
  const callsign = uniqueCallsign('dk');
  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);

  // REST claim (bypasses the form so we can steer the join target).
  const claim = await page.request.post(`${baseURL}/api/callsigns`, {
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
    await page.request.get(`${baseURL}/api/dev/pad-target`, { headers: auth })
  ).json()) as { systemId: string; padId: string; pad: { x: number; y: number; z: number } };

  // Server-side dock: raw WS join home, warp to the pad's system if needed,
  // teleport 5 m above the pad center (ground contact settles the ship → the
  // pad machine docks it), and wait for the SERVER-authoritative docked
  // regime + padId before the browser takes over.
  const client = new RawWsClient(`ws://127.0.0.1:${apiPort}/ws`);
  await client.open();
  const send = (type: string, payload: unknown): void =>
    client.send({ v: PROTOCOL_VERSION, type, payload });
  send('hello', { v: PROTOCOL_VERSION });
  send('auth', { token: session.token });
  send('join_system', { systemId: session.homeSystemId });
  await client.next((m) => m.type === 'enter_system', 'enter_system (home)');
  if (target.systemId !== session.homeSystemId) {
    send('warp', { destinationSystemId: target.systemId });
    const arrived = await client.next(
      (m) => m.type === 'warp_arrived',
      'warp_arrived (pad system)',
      10_000,
    );
    expect((arrived.payload as { systemId: string }).systemId).toBe(target.systemId);
  }
  const tele = await page.request.post(`${baseURL}/api/dev/teleport`, {
    headers: auth,
    data: { x: target.pad.x, y: target.pad.y + 5, z: target.pad.z },
  });
  expect(tele.status()).toBe(200);
  await client.next(
    (m) =>
      m.type === 'entity_update' &&
      ((m.payload as { entities?: Array<{ kind?: string; callsign?: string; regime?: string; padId?: string }> }).entities ?? []).some(
        (e) =>
          e.kind === 'ship' &&
          e.callsign === session.callsign &&
          e.regime === 'docked' &&
          e.padId === target.padId,
      ),
    `docked entity_update for ${callsign}`,
    15_000,
  );
  client.close();

  // Browser: same token, the pad's system — the docked ship renders the HUD stub.
  await page.goto(`${baseURL}/?sys=${target.systemId}`);
  await page.evaluate((s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)), session);
  await page.reload();
  const claimPage = new ClaimPage(page, baseURL);
  await expect(claimPage.playerList).toContainText(`${callsign} (you)`);
  await expect(page.locator('#docked-indicator')).toBeVisible({ timeout: 15_000 });
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-29.3-1.png'),
  });
  assertClean();
  await context.close();
});
