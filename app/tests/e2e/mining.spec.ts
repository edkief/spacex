import path from 'node:path';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { RawWsClient } from './raw-ws';

/**
 * TASK-38 — E2E: mine 2 units at a deposit (browser = the REAL client; the
 * world is prepared server-side, the deposits.spec.ts pattern).
 *
 * Step 1 (server-side, raw REST + WS): claim → pad target → join/warp →
 * dev-teleport onto the pad → the pad machine docks the ship → disembark
 * over raw WS → close the raw client (the character persists in the shard).
 *
 * Step 2 (browser, the REAL mining path): on foot, a dev deposit (quantity
 * 5, default iron) appears 1.5 m in front of the character (identity facing
 * = +Z, inside the 30° cone) → the prompt reads 'Hold [E] to mine iron' →
 * HOLD E: the radial #mining-hud appears (server-driven progress, screenshot
 * mid-channel) → two 1.5 s server ticks award 2 units: #weight-bar reads
 * 2/40u → release E: the channel ends and the HUD hides. Console stays clean.
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

test('on foot: hold E to mine a deposit — the radial HUD tracks 2 server awards', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL, apiPort } = e2eServer;
  test.setTimeout(120_000);
  const callsign = uniqueCallsign('mine');

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
  client.close(); // the character persists in the sim while the browser takes over

  console.log(`[mining] callsign=${session.callsign} system=${target.systemId}`);

  // (2) Browser: the REAL client goes on foot in the pad system.
  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  await page.goto(baseURL);
  await page.evaluate((s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)), session);
  await page.goto(`${baseURL}/?sys=${target.systemId}`);

  // The on-foot character (server authoritative) is up before we target it.
  await page
    .waitForFunction(() => window.__CHAR__?.pos ?? null, null, { timeout: 20_000 })
    .catch(() => {
      throw new Error('on-foot character never appeared');
    });

  // (3) Place a deposit 1.5 m IN FRONT of the character (identity facing =
  // +Z, inside the 30° cone). Quantity 5 (default iron).
  const charPos = (await page.evaluate(() => window.__CHAR__?.pos)) as {
    x: number;
    y: number;
    z: number;
  } | null;
  expect(charPos, 'character position from __CHAR__').not.toBeNull();
  const depRes = await fetch(`${baseURL}/api/dev/deposit`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ x: charPos!.x, y: charPos!.y, z: charPos!.z + 1.5, quantity: 5 }),
  });
  expect(depRes.status).toBe(200);
  const deposit = (await depRes.json()) as { ok: boolean; depositId: string };
  expect(deposit.ok).toBe(true);

  // Within one 10 Hz snapshot the ring filter streams the dev deposit → the
  // client rock is visible and the hold-to-mine prompt names the resource.
  await expect
    .poll(
      async () =>
        await page.evaluate((id) => {
          const d = (window.__DEPOSITS__?.deposits() ?? []).find((x) => x.depositId === id);
          return d ? d.visible : false;
        }, deposit.depositId),
      { timeout: 15_000, message: `dev deposit ${deposit.depositId} visible` },
    )
    .toBe(true);
  const prompt = page.locator('#interact-prompt');
  await expect(prompt).toBeVisible({ timeout: 15_000 });
  await expect(prompt).toContainText('Hold [E] to mine iron');

  // (4) HOLD E: the client sends mine-start; the server echoes the private
  // 'mining' frame → the radial #mining-hud appears mid-channel.
  await page.keyboard.down('e');
  const hud = page.locator('#mining-hud');
  await expect(hud).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(700); // mid-channel: the ring is partway, not full
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-38-1.png'),
  });

  // Two 1.5 s SERVER ticks award 2 iron (2u of the 40u cap): the snapshot
  // stream brings #weight-bar to 2/40u. Real time: ~3.2 s, give it 15 s.
  const bar = page.locator('#weight-bar');
  await expect(bar).toHaveText(/2\/40u/, { timeout: 15_000 });

  // (5) RELEASE E: the channel ends (reason 'stopped'); the HUD hides and
  // the deposit is still standing (3 left).
  await page.keyboard.up('e');
  await expect(hud).toBeHidden({ timeout: 10_000 });
  await expect
    .poll(
      async () =>
        await page.evaluate((id) => {
          const d = (window.__DEPOSITS__?.deposits() ?? []).find((x) => x.depositId === id);
          return d ? d.quantity : null;
        }, deposit.depositId),
      { timeout: 10_000, message: `deposit ${deposit.depositId} quantity after 2 units` },
    )
    .toBe(3);
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-38-2.png'),
  });

  assertClean();
  await context.close();
});
