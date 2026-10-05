import path from 'node:path';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { RawWsClient } from './raw-ws';

/**
 * TASK-55 — E2E: the settings panel happy path (the AC's e2e: change quality
 * to Low and verify the streaming pipeline re-tuned LIVE via the dev hook
 * `window.__STREAM__.lodRadii()`, plus persistence through the API).
 *
 * Setup mirrors menu.spec.ts: claim → pad target → join → dev-teleport onto
 * the pad → the pad machine docks the ship → the browser spawns IN the
 * docked ship → ESC → SETTINGS. Flow:
 *
 * - the panel renders its four sections + reset,
 * - clicking LOW re-points the live LOD radii to 384/1024/4000 (no reload —
 *   `__STREAM__.lodRadii().farMaxM === 4000`) and the button gets
 *   `aria-pressed`,
 * - the server row round-trips: GET /api/players/settings shows `low`
 *   (the "restart restores Low" AC's persistence half — the session/boot
 *   restore path is covered by the players.settings.api unit suite),
 * - the sensitivity slider (debounced 300 ms) persists 1.5 after the drag
 *   settles and the panel label reads "1.5x".
 *
 * Screenshot: .ralph/screenshots/TASK-55-1.png
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

interface PlayerSettings {
  quality: 'high' | 'medium' | 'low';
  sensitivity: number;
  'reduced-motion': boolean;
}

test('settings: Low preset re-tunes the live LOD radii and persists (dev-hook read)', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL, apiPort } = e2eServer;
  test.setTimeout(150_000);
  const callsign = uniqueCallsign('settings');

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

  // (3) Boot in the docked ship (the CARGO HUD button proves it).
  await expect(page.locator('#ship-hud-cargo')).toBeVisible({ timeout: 20_000 });

  // (4) ESC → SETTINGS opens the four-section panel.
  await page.keyboard.press('Escape');
  await expect(page.locator('#esc-menu')).toBeVisible();
  await page.locator('#esc-menu-settings').click();
  const panel = page.locator('#settings-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('#settings-quality')).toBeVisible();
  await expect(panel.locator('#settings-sensitivity')).toBeVisible();
  await expect(panel.locator('#reduced-motion-toggle')).toBeVisible();
  await expect(panel.locator('#settings-keybinds')).toContainText('WASD + mouse');
  await expect(panel.locator('#settings-keybinds')).toContainText('F3');
  await expect(panel.locator('#settings-reset')).toBeVisible();

  // (5) THE ACCEPTANCE CRITERION: clicking LOW re-points the LIVE LOD radii
  // (384/1024/4000) — no reload; the dev hook reads the pipeline's live ref.
  await page.locator('#settings-quality-low').click();
  await expect
    .poll(() => page.locator('#settings-quality-low').getAttribute('aria-pressed'), {
      timeout: 5_000,
    })
    .toBe('true');
  await expect
    .poll(
      async () => {
        const radii = await page.evaluate(() =>
          (window.__STREAM__ as { lodRadii(): { farMaxM: number } }).lodRadii(),
        );
        return radii.farMaxM;
      },
      { timeout: 5_000 },
    )
    .toBe(4000);

  // (6) Persistence round trip: the server row now says low (immediate PUT).
  const getSettings = async (): Promise<PlayerSettings> => {
    const res = await fetch(`${baseURL}/api/players/settings`, { headers: auth });
    expect(res.status).toBe(200);
    return (await res.json()) as PlayerSettings;
  };
  expect((await getSettings()).quality).toBe('low');

  // Screenshot: the settings panel with LOW active, behind the ESC menu.
  await page.waitForTimeout(400); // let the view settle behind the backdrop
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-55-1.png'),
  });

  // (7) The slider (debounced 300 ms) persists after the drag settles:
  // set 1.5 via the native setter + input event, wait past the debounce.
  await page.locator('#settings-sensitivity-slider').evaluate((el) => {
    const input = el as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!;
    setter.call(input, '1.5');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect
    .poll(async () => (await page.locator('#settings-sensitivity-value').textContent()) ?? '', {
      timeout: 5_000,
    })
    .toBe('1.5x');
  await page.waitForTimeout(600); // past the 300 ms debounce
  const after = await getSettings();
  expect(after.sensitivity).toBe(1.5);
  expect(after.quality).toBe('low'); // both keys persist together

  assertClean();
  await context.close();
});
