import path from 'node:path';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { RawWsClient } from './raw-ws';

/**
 * TASK-34 — E2E: the on-foot inventory happy path (browser = the REAL
 * client; the world is prepared server-side, the interact.spec.ts pattern).
 *
 * Step 1 (server-side, raw REST + WS): claim → pad target → join/warp →
 * dev-teleport onto the pad → the pad machine docks the ship → disembark
 * over raw WS (the character entity arrives on the wire) → POST
 * /api/dev/give 8 iron (the weight bar needs units before TASK-38's
 * mining path lands) → close the raw client (the character AND its
 * inventory persist in the shard while the browser takes over).
 *
 * Step 2 (browser, the REAL inventory path): same token → the client
 * spawns on foot; the self entity_update carries the inventory onto the
 * character entity → the #weight-bar HUD appears bottom-right showing
 * '8/40u'. Hovering lists the stacks ('iron x8 (8u)' — item counts on
 * hover). Pressing Q drops one unit (the client's REAL drop path): the
 * server re-validates + spawns the ground item + the snapshot stream
 * brings the bar to '7/40u' within one 10 Hz tick. Console stays clean.
 */

const PROTOCOL_VERSION = 1; // mirrors @shared/protocol (Playwright does not resolve tsconfig aliases)

interface ClaimResponse {
  token: string;
  playerId: string;
  callsign: string;
  homeSystemId: string;
  shipId: string;
}

interface PadTarget {
  systemId: string;
  planetId: string;
  padId: string;
  pad: { x: number; y: number; z: number };
}

interface EntityState {
  id: string;
  kind: string;
  callsign?: string;
  regime?: string;
  onFoot?: boolean;
}

test('on foot: the weight bar shows the granted weight, Q drops a unit', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL, apiPort } = e2eServer;
  test.setTimeout(90_000);
  const callsign = uniqueCallsign('inv');

  // (a) Claim — raw REST, same shape the claim flow stores in localStorage.
  const claimRes = await fetch(`${baseURL}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  expect(claimRes.status).toBe(201);
  const session = (await claimRes.json()) as ClaimResponse;
  const auth = { authorization: `Bearer ${session.token}` };

  // (b) The deterministic pad target (landable atmospheric planet).
  const targetRes = await fetch(`${baseURL}/api/dev/pad-target`, { headers: auth });
  expect(targetRes.status).toBe(200);
  const target = (await targetRes.json()) as PadTarget;

  // (c) Join home over raw WS; warp to the pad's system if needed.
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
    await client.next((m) => m.type === 'warp_arrived', 'warp_arrived (pad system)', 10_000);
  }

  // (d) Teleport inside the pad's dock disc; the pad machine docks the ship.
  const teleRes = await fetch(`${baseURL}/api/dev/teleport`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ x: target.pad.x, y: target.pad.y + 5, z: target.pad.z }),
  });
  expect(teleRes.status).toBe(200);
  await client.next(
    (m) =>
      m.type === 'entity_update' &&
      ((m.payload as { entities: EntityState[] }).entities ?? []).some(
        (e) => e.callsign === session.callsign && e.regime === 'docked',
      ),
    `docked entity_update for ${session.callsign}`,
    15_000,
  );

  // (e) Disembark over raw WS (the character entity arrives on the wire).
  send('exit_ship', { shipId: session.shipId });
  await client.next(
    (m) =>
      m.type === 'entity_update' &&
      ((m.payload as { entities: EntityState[] }).entities ?? []).some(
        (e) => e.kind === 'character' && e.callsign === session.callsign,
      ),
    'character entity_update',
    10_000,
  );

  // (f) Grant 8 iron (8u of the 40u cap) to the on-foot player, then hand
  // the browser the session. The inventory lives on the shard's player
  // entity, so it persists across the raw client's disconnect.
  const giveRes = await fetch(`${baseURL}/api/dev/give`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ resourceId: 'iron', amount: 8 }),
  });
  expect(giveRes.status).toBe(200);
  client.close(); // the character + inventory persist while the browser takes over

  console.log(`[inventory] callsign=${session.callsign}`);

  // (2) Browser: the REAL client goes on foot. The self entity_update
  // carries the inventory → the #weight-bar HUD appears bottom-right.
  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  await page.goto(baseURL);
  await page.evaluate((s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)), session);
  await page.goto(`${baseURL}/?sys=${target.systemId}`);

  const bar = page.locator('#weight-bar');
  await expect(bar).toBeVisible({ timeout: 20_000 });
  await expect(bar).toHaveText(/8\/40u/); // 8 iron x 1u, of the 40u cap
  await page.waitForTimeout(800); // let the on-foot camera settle
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-34-1.png'),
  });

  // (3) Hover: item counts on hover ('iron x8 (8u)').
  await bar.hover();
  await expect(bar).toContainText('iron x8 (8u)');

  // (4) PRESS Q: the client's REAL drop path sends {resourceId, amount: 1};
  // the server re-validates + spawns the ground item + the next 10 Hz
  // snapshot brings the bar to 7/40u.
  await page.keyboard.press('q');
  await expect(bar).toHaveText(/7\/40u/, { timeout: 10_000 });
  await bar.hover();
  await expect(bar).toContainText('iron x7 (7u)');
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-34-2.png'),
  });

  assertClean();
  await context.close();
});
