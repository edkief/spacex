import path from 'node:path';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { RawWsClient } from './raw-ws';
import { installMouseEventGuard, keyboardWarp, sweepUntil } from './keyboard-only.spec';

/**
 * TASK-59 — the mobile rendering floor, e2e:
 *
 * (1) THE OVERRIDE FLOW: the settings panel's DEVICE PROFILE row (Auto /
 *     Desktop / Mobile). With a stored 'mobile' row the boot RESTORES the
 *     mobile pipeline (the dev hook `__STREAM__.lodRadii()` shows the
 *     mobile 512/3000/3000 radii — draw distance 3 km, not the desktop
 *     8 km). Clicking DESKTOP fires the 'Profile applied — re-entering
 *     system' toast + the warp transition, the world RE-LOADS with the
 *     desktop pipeline (8 km radii), and the choice persists.
 *
 * (2) THE REDUCED-FX LOOP: with the Mobile profile FORCED (a PUT before the
 *     browser boots), the keyboard-only gameplay loop of TASK-54 runs end
 *     to end — claim → warp → dock → disembark → mine → re-enter — with
 *     ZERO mouse events, no console errors, and every gameplay state
 *     intact (docked indicator, weight bar, mining HUD, ship HUD). The
 *     mobile profile is a rendering floor: fewer FX, never missing state.
 *
 * Screenshots: .ralph/screenshots/TASK-59-1.png / -2.png
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
  quality: string;
  deviceProfile: string;
  sensitivity: number;
  'reduced-motion': boolean;
}

interface Overview {
  systems: Array<{ systemId: string; neighbors: Array<{ to: string }> }>;
}

/** The live LOD radii the chunk streamer is reading (dev hook). */
async function streamRadii(
  page: import('@playwright/test').Page,
): Promise<{ nearMaxM: number; midMaxM: number; farMaxM: number }> {
  return page.evaluate(() =>
    (
      window as {
        __STREAM__?: { lodRadii(): { nearMaxM: number; midMaxM: number; farMaxM: number } };
      }
    ).__STREAM__!.lodRadii(),
  );
}

test('device profile: stored mobile row restores the mobile pipeline; override re-enters (desktop)', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL, apiPort } = e2eServer;
  test.setTimeout(180_000);
  const callsign = uniqueCallsign('mobilep');
  void apiPort;

  // (a) Claim + dock the ship at the pad, all server-side (raw REST/WS).
  const claimRes = await fetch(`${baseURL}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  expect(claimRes.status).toBe(201);
  const session = (await claimRes.json()) as ClaimResponse;
  const auth = { authorization: `Bearer ${session.token}` };

  const targetRes = await fetch(`${baseURL}/api/dev/pad-target`, { headers: auth });
  expect(targetRes.status).toBe(200);
  const target = (await targetRes.json()) as PadTarget;

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

  // (b) Force the mobile profile BEFORE the browser boots (PUT — the boot
  // settings fetch restores it; the world load then applies the row).
  const putRes = await fetch(`${baseURL}/api/players/settings`, {
    method: 'PUT',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceProfile: 'mobile' }),
  });
  expect(putRes.status).toBe(200);

  // (2) Browser: the REAL client spawns IN the docked ship.
  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  await page.goto(baseURL);
  await page.evaluate((s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)), session);
  await page.goto(`${baseURL}/?sys=${target.systemId}`);
  await expect(page.locator('#ship-hud-cargo')).toBeVisible({ timeout: 20_000 });

  // (3) THE MOBILE PIPELINE IS ACTIVE: the live LOD radii are the mobile
  // row (512/3000/3000 — draw distance 3 km), not the desktop 8 km row.
  await expect.poll(async () => (await streamRadii(page)).farMaxM, { timeout: 10_000 }).toBe(3_000);

  // (4) The panel shows the DEVICE PROFILE row with the restored choice.
  await page.keyboard.press('Escape');
  await expect(page.locator('#esc-menu')).toBeVisible();
  await page.locator('#esc-menu-settings').click();
  const panel = page.locator('#settings-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('#settings-device-profile-heading')).toBeVisible();
  await expect(panel.locator('#settings-device-profile-auto')).toBeVisible();
  await expect(panel.locator('#settings-device-profile-desktop')).toBeVisible();
  await expect(panel.locator('#settings-device-profile-mobile')).toBeVisible();
  await expect(panel.locator('#settings-device-profile-mobile')).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Screenshot: the settings panel, DEVICE PROFILE row, MOBILE active.
  await page.waitForTimeout(400);
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-59-1.png'),
  });

  // (5) THE OVERRIDE: clicking DESKTOP fires the toast + the warp
  // transition; the world RE-LOADS with the desktop pipeline.
  await page.locator('#settings-device-profile-desktop').click();
  await expect(page.getByText('Profile applied — re-entering system')).toBeVisible({
    timeout: 5_000,
  });
  await expect(page.locator('#warp-overlay')).toBeVisible({ timeout: 5_000 });
  // The re-entry round trip is the warp transition (2 s in + load + 2 s out).
  await expect.poll(async () => (await streamRadii(page)).farMaxM, { timeout: 30_000 }).toBe(8_000);
  await expect(page.locator('#warp-overlay')).toHaveCount(0, { timeout: 30_000 });
  // The world came back (still the same system, the ship HUD is up).
  await expect(page.locator('#ship-hud-cargo')).toBeVisible({ timeout: 20_000 });

  // (6) Persistence: the server row says desktop now.
  const getRes = await fetch(`${baseURL}/api/players/settings`, { headers: auth });
  expect(getRes.status).toBe(200);
  expect(((await getRes.json()) as PlayerSettings).deviceProfile).toBe('desktop');

  assertClean();
  await context.close();
});

test('mobile profile forced: the keyboard-only gameplay loop runs (reduced FX, no missing state)', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL } = e2eServer;
  test.setTimeout(240_000);
  const callsign = uniqueCallsign('kbmob');

  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  await installMouseEventGuard(page);
  await page.goto(baseURL);

  // (1) CLAIM — form + Enter (keyboard).
  await page.fill('#callsign-input', callsign);
  await page.keyboard.press('Enter');
  await expect(page.locator('#player-list')).toContainText(`${callsign} (you)`, {
    timeout: 15_000,
  });

  // (2) FORCE MOBILE — PUT on the just-claimed session, then reload: the
  // boot settings fetch restores the mobile row, the world load applies it.
  const session = await page.evaluate(
    () => JSON.parse(localStorage.getItem('drift.session.v1') ?? 'null') as ClaimResponse | null,
  );
  expect(session?.token, 'session stored by the claim flow').toBeTruthy();
  const auth = { authorization: `Bearer ${session!.token}` };
  const rest = (url: string, init?: RequestInit): Promise<unknown> =>
    fetch(baseURL + url, { ...init, headers: { ...auth, ...(init?.headers ?? {}) } }).then((res) =>
      res.json(),
    );
  const putRes = await fetch(`${baseURL}/api/players/settings`, {
    method: 'PUT',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceProfile: 'mobile' }),
  });
  expect(putRes.status).toBe(200);
  await page.reload();
  await expect(page.locator('#player-list')).toContainText(`${callsign} (you)`, {
    timeout: 20_000,
  });
  // THE MOBILE PIPELINE IS ACTIVE after the reload (3 km draw distance).
  await expect.poll(async () => (await streamRadii(page)).farMaxM, { timeout: 15_000 }).toBe(3_000);

  // (3) WHERE IS THE PAD? Neighbors first, home last (the TASK-54 flow).
  const me = (await rest('/api/players/me')) as { homeSystemId: string };
  const overview = (await rest(`/api/galaxy/overview?home=${me.homeSystemId}`)) as Overview;
  const neighbors = overview.systems
    .find((s) => s.systemId === me.homeSystemId)!
    .neighbors.map((n) => n.to);
  let pad: PadTarget | null = null;
  for (const sys of [...neighbors, me.homeSystemId]) {
    const p = (await rest(`/api/dev/pad-target?systemId=${sys}`)) as unknown;
    const isPad = (x: unknown): x is PadTarget =>
      typeof x === 'object' && x !== null && 'pad' in (x as Record<string, unknown>);
    if (isPad(p)) {
      pad = p;
      break;
    }
  }
  expect(pad, 'no system in {home, neighbors} has a landable atmospheric pad').not.toBeNull();

  // (4) WARP — keyboard only (chart M → node focus+Enter → WARP focus+Enter).
  if (pad!.systemId !== me.homeSystemId) {
    await keyboardWarp(page, pad!.systemId, me.homeSystemId);
  }
  // Still on the mobile pipeline after the warp arrival (world load re-applies).
  await expect.poll(async () => (await streamRadii(page)).farMaxM, { timeout: 15_000 }).toBe(3_000);

  // (5) DOCK — dev-teleport into the pad disc; the pad machine docks it.
  const tele = (await rest('/api/dev/teleport', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ x: pad!.pad.x, y: pad!.pad.y + 5, z: pad!.pad.z }),
  })) as { ok?: boolean };
  expect(tele.ok).toBe(true);
  await expect(page.locator('#docked-indicator')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#leave-ship-prompt')).toBeVisible({ timeout: 20_000 });

  // (6) DISSEMBARK — E (on foot).
  await page.keyboard.press('e');
  await expect(page.locator('#leave-ship-prompt')).toBeHidden({ timeout: 20_000 });
  const weightBar = page.locator('#weight-bar');
  await expect(weightBar).toBeVisible({ timeout: 20_000 });

  // (7) MINE — a dev deposit 1.5 m ahead; hold E (2 iron, 2/40u).
  const charPos = (await page
    .waitForFunction(
      () => (window as { __CHAR__?: { pos: unknown } }).__CHAR__?.pos ?? null,
      null,
      {
        timeout: 20_000,
      },
    )
    .then(() =>
      page.evaluate(() => (window as { __CHAR__?: { pos: unknown } }).__CHAR__?.pos),
    )) as { x: number; y: number; z: number };
  const dep = (await rest('/api/dev/deposit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ x: charPos.x, y: charPos.y, z: charPos.z + 1.5, quantity: 5 }),
  })) as { ok: boolean };
  expect(dep.ok).toBe(true);
  await expect(page.locator('#interact-prompt')).toContainText('Hold [E] to mine iron', {
    timeout: 20_000,
  });
  await page.keyboard.down('e');
  await expect(page.locator('#mining-hud')).toBeVisible({ timeout: 10_000 });
  await expect(weightBar).toHaveText(/2\/40u/, { timeout: 20_000 });
  await page.keyboard.up('e');
  await expect(page.locator('#mining-hud')).toBeHidden({ timeout: 10_000 });

  // (8) RE-ENTER — sweep the facing until '[E] Enter ship', then E.
  await sweepUntil(page, '[E] Enter ship');
  const promptText = async (): Promise<string | null> =>
    page
      .locator('#interact-prompt')
      .isVisible()
      .then((v) => (v ? page.locator('#interact-prompt').textContent() : null))
      .catch(() => null);
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.keyboard.press('e');
    await page.waitForTimeout(1_000);
    if (!(await weightBar.isVisible().catch(() => false))) break;
    if ((await promptText()) !== '[E] Enter ship') break;
  }
  await expect(weightBar).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('#ship-hud-cargo')).toBeVisible({ timeout: 20_000 });

  // Screenshot: the mobile pipeline in-system (3 km draw distance).
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-59-2.png'),
  });

  // THE PROOF: the whole loop ran without a single mouse/pointer event.
  const mouseLog = await page.evaluate(() => {
    const w = window as unknown as { __MOUSE_EVENTS__: number; __MOUSE_LOG__: unknown[] };
    return { n: w.__MOUSE_EVENTS__, log: w.__MOUSE_LOG__ };
  });
  expect(
    mouseLog.n,
    `keyboard-only mobile loop must not dispatch mouse events (log: ${JSON.stringify(mouseLog.log)})`,
  ).toBe(0);

  assertClean();
  await context.close();
});
