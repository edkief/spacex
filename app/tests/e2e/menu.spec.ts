import path from 'node:path';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { RawWsClient } from './raw-ws';

/**
 * TASK-53 — E2E: the ESC menu shell happy path (the AC's e2e: open ESC menu
 * → Systems → close, with the menu screenshot) + the modal contract:
 *
 * - ESC opens the centered menu (Resume / Systems / Ships / Settings +
 *   the credits + callsign footer) in the docked-ship regime,
 * - game input is suppressed while it is open: M does NOT open the chart
 *   and E does NOT disembark,
 * - Systems opens the star chart ON TOP of the menu (the stack); ESC
 *   backs out ONE level (chart → menu), the next ESC closes the menu,
 * - with the menu closed, E disembarks (the suppression is transient),
 * - on foot, ESC opens the menu again and SHIPS opens the shared panel
 *   (the context-driven tab set) — ESC pops back to the menu.
 *
 * Setup mirrors cargo.spec.ts: claim → pad target → join → dev-teleport
 * onto the pad → the pad machine docks the ship → the browser spawns IN
 * the docked ship. Screenshot: .ralph/screenshots/TASK-53-1.png
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

test('ESC menu: open → Systems → ESC stack → modal suppression; SHIPS opens the shared panel', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL, apiPort } = e2eServer;
  test.setTimeout(150_000);
  const callsign = uniqueCallsign('menu');

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
  client.close();

  // (2) Browser: the REAL client spawns IN the docked ship.
  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  await page.goto(baseURL);
  await page.evaluate((s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)), session);
  await page.goto(`${baseURL}/?sys=${target.systemId}`);

  const menu = page.locator('#esc-menu');
  const chart = page.locator('#star-chart');
  const panel = page.locator('#ship-panel');

  // (3) Boot in the docked ship (the CARGO HUD button proves it).
  await expect(page.locator('#ship-hud-cargo')).toBeVisible({ timeout: 20_000 });

  // (4) ESC opens the centered menu: items + the credits/callsign footer.
  await page.keyboard.press('Escape');
  await expect(menu).toBeVisible();
  await expect(menu.getByText('RESUME')).toBeVisible();
  await expect(menu.getByText('SYSTEMS')).toBeVisible();
  await expect(menu.getByText('SHIPS')).toBeVisible();
  await expect(menu.getByText('SETTINGS')).toBeVisible();
  await expect(page.locator('#esc-menu-callsign')).toHaveText(callsign);
  await expect(page.locator('#esc-menu-credits')).toHaveText(/cr/);
  await expect(menu).toContainText('The world keeps moving');
  await page.waitForTimeout(400); // let the cockpit view settle behind the backdrop
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-53-1.png'),
  });

  // (5) MODAL: while the menu is open, M does NOT open the chart and E
  // does NOT disembark (game input suppressed — only ESC reaches the game).
  await page.keyboard.press('m');
  await expect(chart).toBeHidden();
  await page.keyboard.press('e');
  await expect(page.locator('#weight-bar')).toBeHidden(); // still docked

  // (6) Systems opens the star chart ON TOP of the menu (the stack).
  await menu.getByText('SYSTEMS').click();
  await expect(chart).toBeVisible();
  await expect(menu).toBeVisible(); // the menu is still underneath

  // (7) ESC backs out ONE level: chart → menu; the next ESC closes the menu.
  await page.keyboard.press('Escape');
  await expect(chart).toBeHidden();
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // (8) With the menu closed, E disembarks (the suppression was transient).
  await page.keyboard.press('e');
  const bar = page.locator('#weight-bar');
  await expect(bar).toBeVisible({ timeout: 20_000 }); // now on foot

  // (9) On foot, ESC opens the menu again (any regime, in or out of a ship);
  // SHIPS opens the shared panel (Overview first — the class stats of the
  // docked ship), ArrowRight switches to the Cargo tab, ESC pops back to
  // the menu, ESC closes it.
  await page.keyboard.press('Escape');
  await expect(menu).toBeVisible();
  await menu.getByText('SHIPS').click();
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Sparrow Scout'); // Overview: the class
  await panel.locator('#ship-panel-tab-overview').focus();
  await page.keyboard.press('ArrowRight');
  await expect(panel.locator('#ship-panel-tab-cargo')).toHaveAttribute('aria-pressed', 'true');
  await expect(panel).toContainText('No cargo data'); // hold needs the 'cargo' frame
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-53-2.png'),
  });
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(menu).toBeVisible(); // one level back: the menu
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  assertClean();
  await context.close();
});
