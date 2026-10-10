import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { ClaimPage } from './pages/claim';
import { RawWsClient } from './raw-ws';

/**
 * TASK-86 — E2E: a docked ship takes off on its FIRST real flight input.
 *
 * The bug: a ship docked at a landing pad (wire regime 'docked',
 * flightRegime 'surface') had its keys remapped to the CHARACTER scheme by
 * the regime manager, so holding W produced a zero flight demand and the
 * TASK-78 dock gate suppressed it as an idle frame — the server's
 * "first input = take-off" (shard.ts) never fired and the ship stayed
 * docked forever. The home-dock starter (flightRegime 'space') was
 * unaffected (flight.spec.ts undocks from spawn).
 *
 * Flow (pad dock, the repro): claim → join home over raw WS + warp to the
 * pad's system (the disembark.spec.ts setup: warp is the ONLY path that
 * persists position.systemId onto the ship row, and /api/dev/teleport
 * resolves the shard by that row — a browser boot straight into ?sys=
 * leaves the row on home, whose shard is not active → 409) → dev-teleport
 * onto the seeded station pad → DOCKED indicator → the ship is FROZEN while
 * idle (TASK-78 wire invariant: the client sends nothing while docked, so
 * the server integrates zero input on the settled ship) → hold SPACE (the
 * VTOL key — VTOL lift is the VERTICAL pad-takeoff channel; the main thrust
 * channel is the horizontal flight control in atmosphere/surface (TASK-98),
 * and TASK-86: full VTOL climbs on the 1.35×g margin, so it lifts the ship
 * off the pad) → within the budget the wire regime leaves 'docked' and the
 * server position moves → the indicator clears. A second test repeats the undock from the HOME dock
 * starter spawn (regime 'docked', NO padId, flightRegime 'space' — W
 * thrust takes that one off).
 *
 * Observation: the browser's own inbound entity_updates (a WebSocket tap,
 * the flight.spec.ts pattern) — the server-authoritative pos + regime
 * every in-system peer receives.
 */

const PROTOCOL_VERSION = 1; // mirrors @shared/protocol (Playwright does not resolve tsconfig aliases)

interface PadTarget {
  systemId: string;
  padId: string;
  pad: Vec3;
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface EntityState {
  id: string;
  kind: string;
  pos: Vec3;
  vel: Vec3;
  regime: string;
  padId?: string;
  callsign?: string;
}

/** Tap the page WebSocket: every entity_update carrying OUR ship lands in
 * `window.__shipUpdates` (wire pos + regime + padId). The client dials
 * through the global constructor, so subclassing in an init script sees
 * every frame without touching app code.
 */
function tapShipUpdates(callsign: string): void {
  const w = window as unknown as {
    __shipUpdates?: Array<{
      pos: Vec3;
      regime: string;
      padId?: string;
      flightRegime?: string;
    }>;
  };
  w.__shipUpdates = [];
  const Orig = window.WebSocket;
  window.WebSocket = class extends Orig {
    constructor(...args: ConstructorParameters<typeof Orig>) {
      super(...args);
      this.addEventListener('message', (ev: MessageEvent) => {
        try {
          const m = JSON.parse(String(ev.data)) as {
            type?: string;
            payload?: { entities?: EntityState[] };
          };
          if (m.type !== 'entity_update') return;
          const e = (m.payload?.entities ?? []).find(
            (t) => t.kind === 'ship' && t.callsign === callsign,
          );
          if (e)
            w.__shipUpdates?.push({
              pos: e.pos,
              regime: e.regime,
              padId: e.padId,
              flightRegime: (e as { flightRegime?: string }).flightRegime,
            });
        } catch {
          // never break the page's networking from a tap
        }
      });
    }
  };
}

/** The latest wire pos + regime for our ship (null before the first update). */
async function latestShip(page: Page) {
  return page.evaluate(() => {
    const ups =
      (window as unknown as { __shipUpdates?: Array<{ pos: Vec3; regime: string }> })
        .__shipUpdates ?? [];
    const last = ups[ups.length - 1];
    return last ? { pos: last.pos, regime: last.regime } : null;
  });
}

/** Distance (u) between two wire positions. */
function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Poll until the wire regime leaves 'docked' AND the ship moved > 5 u. */
async function pollUndock(
  page: Page,
  from: Vec3,
  key: string,
): Promise<{ pos: Vec3; regime: string }> {
  let last: { pos: Vec3; regime: string } = { pos: from, regime: 'docked' };
  await expect
    .poll(
      async () => {
        const now = (await latestShip(page))!;
        last = now;
        return now.regime !== 'docked' && dist(now.pos, from) > 5;
      },
      {
        timeout: 5_000,
        message: `wire regime never left docked (and moved) within 5 s of ${key}`,
      },
    )
    .toBe(true);
  return last;
}

/**
 * Claim-side pad docking (disembark.spec.ts setup): join the home system
 * over raw WS, warp to the pad's system if needed (warp writes the row's
 * position.systemId, so the dev teleport can resolve an active shard),
 * teleport onto the pad, and wait for the SERVER-authoritative docked
 * regime + padId before closing the raw client (the ship idles at the pad,
 * state kept, while the browser takes over).
 */
async function dockAtPad(
  page: Page,
  baseURL: string,
  apiPort: number,
  session: { token: string; callsign: string; homeSystemId: string },
): Promise<PadTarget> {
  const auth = { authorization: `Bearer ${session.token}` };
  const target = (await (
    await page.request.get(`${baseURL}/api/dev/pad-target`, { headers: auth })
  ).json()) as PadTarget;

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

  // Teleport 5 m ABOVE the pad center: ground contact settles the ship
  // (vel.y → 0, altitude 0, surface regime) → the pad machine docks it.
  const tele = await page.request.post(`${baseURL}/api/dev/teleport`, {
    headers: auth,
    data: { x: target.pad.x, y: target.pad.y + 5, z: target.pad.z },
  });
  expect(tele.status()).toBe(200);

  await client.next(
    (m) =>
      m.type === 'entity_update' &&
      ((m.payload as { entities?: EntityState[] }).entities ?? []).some(
        (e) =>
          e.kind === 'ship' &&
          e.callsign === session.callsign &&
          e.regime === 'docked' &&
          e.padId === target.padId,
      ),
    `docked entity_update for ${session.callsign}`,
    15_000,
  );
  client.close();
  return target;
}

/** Claim + boot the app straight into `systemId` with the seeded session. */
async function bootInSystem(
  page: Page,
  baseURL: string,
  session: { token: string; playerId: string; callsign: string; homeSystemId: string },
  systemId: string,
): Promise<void> {
  await page.goto(`${baseURL}/?sys=${systemId}`);
  await page.evaluate((s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)), session);
  await page.reload();
  const claimPage = new ClaimPage(page, baseURL);
  await expect(claimPage.playerList).toContainText(`${session.callsign} (you)`);
}

test('pad dock: idle-frozen while docked, VTOL (Space) takes the ship off the pad', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL, apiPort } = e2eServer;
  test.setTimeout(90_000);
  const callsign = uniqueCallsign('undk');
  const context = await browser.newContext();
  await context.addInitScript(tapShipUpdates, callsign);
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);

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

  // Dock the ship on the station pad BEFORE the browser boots (the raw-WS
  // setup that keeps the dev teleport's row→shard resolution valid).
  const target = await dockAtPad(page, baseURL, apiPort, session);

  await bootInSystem(page, baseURL, session, target.systemId);
  await expect(page.locator('#docked-indicator')).toBeVisible({ timeout: 15_000 });

  // (b) Idle-frozen: no input → the settled ship stays put (TASK-78: the
  // client sends NOTHING while docked, so the server integrates zero input
  // on a ship at rest) — wire regime 'docked' and pos unchanged across the
  // 2 s window, sampled every 100 ms.
  const idleStart = (await latestShip(page))!;
  expect(idleStart.regime).toBe('docked');
  const idleT0 = Date.now();
  while (Date.now() - idleT0 < 2_000) {
    const now = (await latestShip(page))!;
    expect(now.regime, 'regime stayed docked during the idle window').toBe('docked');
    expect(dist(now.pos, idleStart.pos), 'ship frozen during the idle window').toBeLessThanOrEqual(
      0.01,
    );
    await page.waitForTimeout(100);
  }

  // (c) FIRST real input (SPACE held — the VTOL key): within the budget the
  // wire regime leaves 'docked' AND the server position moves off the pad
  // (the 1.35×g VTOL margin lifts the ship clear: the pad machine releases
  // it once |vel.y| crosses 2 u/s and the climb continues).
  const padPos = (await latestShip(page))!;
  await page.keyboard.down(' ');
  const keyDownAt = Date.now();
  const afterKey = await pollUndock(page, padPos.pos, 'Space (VTOL)');
  const takeoffMs = Date.now() - keyDownAt;
  expect(afterKey.regime, 'wire regime left docked').not.toBe('docked');
  expect(dist(afterKey.pos, padPos.pos), 'server position moved off the pad').toBeGreaterThan(5);

  // (d) The DOCKED indicator cleared (wire 'docked' ⇒ isDocked false).
  await expect(page.locator('#docked-indicator')).toBeHidden();

  // The visual artifact: mid-flight, off the pad, still holding VTOL — the
  // chase camera has the ship in view (the screenshot shows the ship IN THE
  // AIR, not on the pad).
  const probe = await page.evaluate(() => {
    const p = window.__SELF_SHIP__?.probe() ?? null;
    return p ? { pos: p.pos, x: p.screen?.x ?? null, y: p.screen?.y ?? null } : null;
  });
  expect(probe, 'self ship probe during flight').not.toBeNull();
  expect(probe!.x, 'ship in view during flight (x)').not.toBeNull();
  expect(probe!.y, 'ship in view during flight (y)').not.toBeNull();
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-86-1.png'),
  });
  await page.keyboard.up(' ');

  console.log(
    `[TASK-86 pad] callsign=${callsign} pad=(${padPos.pos.x.toFixed(1)}, ${padPos.pos.y.toFixed(1)}, ${padPos.pos.z.toFixed(1)}) ` +
      `moved=${dist(afterKey.pos, padPos.pos).toFixed(1)} u takeoff=${takeoffMs} ms regime=${afterKey.regime}`,
  );
  assertClean();
  await context.close();
});

test('home dock: the starter scout takes off on W (regime docked, no padId)', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL } = e2eServer;
  test.setTimeout(90_000);
  const callsign = uniqueCallsign('undkh');
  const context = await browser.newContext();
  await context.addInitScript(tapShipUpdates, callsign);
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);

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

  // Fresh claim: the starter scout spawns docked at the HOME dock (no pad).
  await page.goto(baseURL);
  await page.evaluate((s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)), session);
  await page.goto(baseURL);
  await expect
    .poll(() => page.evaluate(() => !!window.__SELF_SHIP__?.probe()?.screen), {
      timeout: 20_000,
      message: 'chase camera never acquired the self ship',
    })
    .toBe(true);

  const spawn = (await latestShip(page))!;
  expect(spawn.regime, 'starter ship is wire-docked at spawn').toBe('docked');

  // W: the first real flight input takes the (space-docked) ship off
  // (home dock, flightRegime 'space' — the main thrust channel applies).
  await page.keyboard.down('w');
  const wDownAt = Date.now();
  const afterW = await pollUndock(page, spawn.pos, 'W');
  const takeoffMs = Date.now() - wDownAt;
  expect(afterW.regime, 'wire regime left docked').not.toBe('docked');
  expect(dist(afterW.pos, spawn.pos), 'server position moved').toBeGreaterThan(5);
  await page.keyboard.up('w');

  console.log(
    `[TASK-86 home] callsign=${callsign} spawn=(${spawn.pos.x.toFixed(1)}, ${spawn.pos.y.toFixed(1)}, ${spawn.pos.z.toFixed(1)}) ` +
      `moved=${dist(afterW.pos, spawn.pos).toFixed(1)} u takeoff=${takeoffMs} ms regime=${afterW.regime}`,
  );
  assertClean();
  await context.close();
});
