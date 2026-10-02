import path from 'node:path';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { RawWsClient } from './raw-ws';

/**
 * TASK-39 — E2E: the ship cargo hold happy path (browser = the REAL client;
 * the world is prepared server-side, the inventory.spec.ts pattern).
 *
 * Step 1 (server-side, raw REST + WS): claim → pad target → join/warp →
 * dev-teleport onto the pad → the pad machine docks the ship → POST
 * /api/dev/give 10 iron → close the raw client (the ship AND its owner's
 * inventory persist in the shard; the browser spawns IN the docked ship).
 *
 * Step 2 (browser): the ship-HUD 'CARGO' button opens the panel with the
 * hold ONLY (no inventory side in the cockpit — the in-flight hint shows).
 * Screenshot. Esc closes it. Press E to disembark (the character spawns
 * 2.5 m to the ship's side). Turning toward the ship, the bottom-center
 * prompt shows '[E] Enter ship' (near zone); walking back puts the character
 * in the 3–5 m far zone where the prompt becomes '[E] Open cargo'. E opens
 * the panel with BOTH columns; 'Move All' loads the 10 iron into the hold
 * (the server's 'cargo' frame re-renders: INVENTORY 'empty', CARGO HOLD
 * 'iron x10', 10 / 40 u). Console stays clean.
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
}

test('docked ship: CARGO button opens the hold; on foot [E] Open cargo loads the ore', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL, apiPort } = e2eServer;
  test.setTimeout(150_000);
  const callsign = uniqueCallsign('cargo');

  // (a) Claim — raw REST.
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

  // (e) Grant 10 iron to the (in-ship) player, then hand the browser the
  // session. The inventory lives on the shard's player entity.
  const giveRes = await fetch(`${baseURL}/api/dev/give`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ resourceId: 'iron', amount: 10 }),
  });
  expect(giveRes.status).toBe(200);
  client.close();

  console.log(`[cargo] callsign=${session.callsign}`);

  // (2) Browser: the REAL client spawns IN the docked ship.
  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  await page.goto(baseURL);
  await page.evaluate((s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)), session);
  await page.goto(`${baseURL}/?sys=${target.systemId}`);

  // (3) In-ship: the ship-HUD CARGO button opens the panel with the hold
  // ONLY — no inventory column, the on-foot hint below.
  const hudCargo = page.locator('#ship-hud-cargo');
  await expect(hudCargo).toBeVisible({ timeout: 20_000 });
  await hudCargo.click();
  const panel = page.locator('#cargo-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('CARGO HOLD');
  await expect(panel).not.toContainText('INVENTORY');
  await expect(panel).toContainText('Transfers need you on foot');
  await expect(panel).toContainText('0 / 40 u');
  await page.waitForTimeout(800); // let the docked cockpit view settle
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-39-1.png'),
  });
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();

  // (4) Disembark: E at the docked ship (the LeaveShipPrompt path).
  await page.keyboard.press('e');
  const bar = page.locator('#weight-bar');
  await expect(bar).toBeVisible({ timeout: 20_000 }); // now on foot
  await expect(bar).toHaveText(/10\/40u/);

  // (5) Turn toward the ship (full 360° scan, one direction — the ship's
  // 5 m reach + 30° cone is crossed within a second or two). The near zone
  // (2.5 m spawn offset ≤ 3 m) shows '[E] Enter ship'.
  const prompt = page.locator('#interact-prompt');
  await page.keyboard.down('d');
  await expect(prompt).toContainText('[E] Enter ship', { timeout: 25_000 });
  await page.keyboard.up('d');

  // (6) Walk back into the far zone (3–5 m): the prompt becomes the
  // TASK-39 sub-prompt '[E] Open cargo'.
  await page.keyboard.down('s');
  await expect(prompt).toContainText('[E] Open cargo', { timeout: 15_000 });
  await page.keyboard.up('s');

  // (7) Open the cargo panel ON FOOT: both columns, the ore in the pocket.
  await page.keyboard.press('e');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('INVENTORY');
  await expect(panel).toContainText('CARGO HOLD');
  await expect(panel).toContainText('iron x10');
  await expect(panel).not.toContainText('Transfers need you on foot');

  // (8) MOVE ALL: the client's REAL transfer path — the server's 'cargo'
  // frame re-renders the panel (INVENTORY 'empty', CARGO HOLD 10 / 40 u).
  await panel.locator('button[aria-label="move all iron"]').click();
  await expect(panel).toContainText('empty');
  await expect(panel).toContainText('10 / 40 u');
  await expect(panel.locator('[aria-label="weight 10 of 40"]')).toHaveCount(1);
  await expect(panel.locator('[aria-label="weight 0 of 40"]')).toHaveCount(1);
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-39-2.png'),
  });

  assertClean();
  await context.close();
});
