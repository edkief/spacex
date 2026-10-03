import path from 'node:path';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { RawWsClient } from './raw-ws';

/**
 * TASK-40.1 — E2E: the full browser DOCK SELL loop (the real client; the
 * world is prepared server-side, the cargo.spec.ts / inventory.spec.ts
 * pattern). This is the FIRST browser run of the DockPanel + credits HUD
 * built in 3122ad1 — any client wiring bug it exposes is root-caused in
 * src/client/ (the server side is already covered by shard.sell + sell.ws).
 *
 * Step 1 (server-side, raw REST + WS): claim → pad target + terminal target
 * → join/warp → dev-teleport onto the pad (the pad machine docks the ship) →
 * POST /api/dev/give 5 iron → close the raw client (the ship AND its owner's
 * inventory persist in the shard; the browser spawns IN the docked ship).
 *
 * Step 2 (browser): the ship-HUD is visible (in-ship), the docked prompt is
 * up → press E to disembark (the character spawns ~15.5 m from the terminal,
 * past the 3 m interact AND 10 m sell range). POST /api/dev/teleport-char
 * parks the on-foot character 1.5 m from the terminal. Turn ('d', falling
 * back to 'a') until the ±30° cone sweeps the terminal → '[E] Dock terminal'
 * → press E. The server answers with the 'ui-open' {ui:'dock'} frame (the
 * hold + inventory ride it, so #dock-panel opens fully populated). The
 * #credits-counter is boot-seeded to 500 cr (GET /api/players/me). Click
 * 'sell all iron inv' → the 'sell' result frame re-renders the panel (the
 * inventory row empties) and the counter updates to 500 + 5×5 = 525 cr, plus
 * the '+25 cr' float. Screenshot. Console stays clean.
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

interface TerminalTarget {
  systemId: string;
  terminalId: string;
  pos: { x: number; y: number; z: number };
}

interface EntityState {
  id: string;
  kind: string;
  callsign?: string;
  regime?: string;
}

test('dock sell: sell the on-foot iron at the terminal, credits 500 cr → 525 cr', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL, apiPort } = e2eServer;
  test.setTimeout(150_000);
  const callsign = uniqueCallsign('sell');

  // (a) Claim — raw REST.
  const claimRes = await fetch(`${baseURL}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  expect(claimRes.status).toBe(201);
  const session = (await claimRes.json()) as ClaimResponse;
  const auth = { authorization: `Bearer ${session.token}` };

  // (b) The deterministic pad + station-terminal targets (same planet).
  const padRes = await fetch(`${baseURL}/api/dev/pad-target`, { headers: auth });
  expect(padRes.status).toBe(200);
  const pad = (await padRes.json()) as PadTarget;
  const termRes = await fetch(`${baseURL}/api/dev/terminal-target`, { headers: auth });
  expect(termRes.status).toBe(200);
  const term = (await termRes.json()) as TerminalTarget;

  // (c) Join home over raw WS; warp to the pad's system if needed.
  const client = new RawWsClient(`ws://127.0.0.1:${apiPort}/ws`);
  await client.open();
  const send = (type: string, payload: unknown): void =>
    client.send({ v: PROTOCOL_VERSION, type, payload });
  send('hello', { v: PROTOCOL_VERSION });
  send('auth', { token: session.token });
  send('join_system', { systemId: session.homeSystemId });
  await client.next((m) => m.type === 'enter_system', 'enter_system (home)');
  if (term.systemId !== session.homeSystemId) {
    send('warp', { destinationSystemId: term.systemId });
    await client.next((m) => m.type === 'warp_arrived', 'warp_arrived (pad system)', 10_000);
  }

  // (d) Teleport inside the pad's dock disc; the pad machine docks the ship.
  const teleRes = await fetch(`${baseURL}/api/dev/teleport`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ x: pad.pad.x, y: pad.pad.y + 5, z: pad.pad.z }),
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

  // (e) Grant 5 iron to the (in-ship) player, then hand the browser the
  // session. The on-foot inventory lives on the shard's player entity.
  const giveRes = await fetch(`${baseURL}/api/dev/give`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ resourceId: 'iron', amount: 5 }),
  });
  expect(giveRes.status).toBe(200);
  client.close();

  console.log(`[sell] callsign=${session.callsign} terminal=${term.terminalId}`);

  // (2) Browser: the REAL client spawns IN the docked ship.
  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  await page.goto(baseURL);
  await page.evaluate((s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)), session);
  await page.goto(`${baseURL}/?sys=${term.systemId}`);

  // (3) In-ship and DOCKED: the ship-HUD CARGO button is visible (in-ship)
  // and the 'E — LEAVE SHIP' prompt is up (a docked ship — the disembark
  // entry point). Both must be ready before we press E.
  const hudCargo = page.locator('#ship-hud-cargo');
  await expect(hudCargo).toBeVisible({ timeout: 20_000 });
  const leavePrompt = page.locator('#leave-ship-prompt');
  await expect(leavePrompt).toBeVisible({ timeout: 20_000 });

  // (4) Disembark: E (the LeaveShipPrompt path). The character spawns ~15.5 m
  // from the terminal — past BOTH the 3 m interact AND the 10 m sell range.
  await page.keyboard.press('e');
  const bar = page.locator('#weight-bar');
  await expect(bar).toBeVisible({ timeout: 20_000 }); // now on foot
  await expect(bar).toHaveText(/5\/40u/); // 5 iron (1 u each) in the pocket

  // (5) Server: park the on-foot character 1.5 m from the terminal (inside the
  // 3 m interact range AND the 10 m sell range). The disembark walk is skipped.
  const tpRes = await fetch(`${baseURL}/api/dev/teleport-char`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ x: term.pos.x + 1.5, y: term.pos.y, z: term.pos.z }),
  });
  expect(tpRes.status).toBe(200);

  // (6) Turn to face the terminal: 'd' yaws right at 3 rad/s (~2.1 s per
  // revolution), so one sweep must bring the ±30° cone across the 1.5 m
  // terminal → '[E] Dock terminal'. If that sweep somehow misses, turn the
  // other way ('a'). The character turns IN PLACE (no translation).
  const prompt = page.locator('#interact-prompt');
  const face = async (key: 'd' | 'a'): Promise<boolean> => {
    await page.keyboard.down(key);
    try {
      await expect(prompt).toContainText('[E] Dock terminal', { timeout: 15_000 });
      return true;
    } catch {
      return false;
    } finally {
      await page.keyboard.up(key);
    }
  };
  if (!(await face('d'))) {
    if (!(await face('a'))) throw new Error('could not face the dock terminal');
  }
  await page.waitForTimeout(200); // let the settled prompt + camera catch up

  // (7) Open the dock panel: E dispatches 'interact' → the server's 'ui-open'
  // {ui:'dock'} frame (the hold + inventory ride it — the panel opens fully
  // populated; there is NO cargo_open flow at the terminal).
  await page.keyboard.press('e');
  const panel = page.locator('#dock-panel');
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel).toContainText('STATION DOCK');
  await expect(panel).toContainText('hold 0 · inv 5'); // iron is in the pocket, not the hold
  await expect(panel).toContainText('5 cr/u'); // iron's catalog base price (TASK-37)

  // (8) The credits counter is boot-seeded to 500 cr (GET /api/players/me).
  const counter = page.locator('#credits-counter');
  await expect(counter).toBeVisible({ timeout: 15_000 });
  await expect(counter).toHaveText('500 cr');

  // (9) SELL ALL from the on-foot inventory: the client sends the 'sell'
  // frame; the server's 'sell' RESULT frame re-renders the panel (inv → 0,
  // the row empties to "Nothing to sell") AND updates the counter to
  // 500 + 5×5 = 525 cr within one frame.
  await panel.locator('button[aria-label="sell all iron inv"]').click();
  await expect(counter).toHaveText('525 cr');
  await expect(panel).toContainText('Nothing to sell');

  // (10) The '+25 cr' float pops at the terminal in the SAME frame
  // (CreditFloatLayer, 1100 ms rise-and-fade). Assert it appears, then grab a
  // screenshot while it is still up — showing the dock panel + the updated
  // counter + the float together.
  await expect(page.locator('.drift-credit-float')).toContainText('+25 cr', { timeout: 5_000 });
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-40-1.png'),
  });

  assertClean();
  await context.close();
});
