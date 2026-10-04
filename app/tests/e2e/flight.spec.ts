import path from 'node:path';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { RawWsClient } from './raw-ws';

/**
 * TASK-73 — E2E: the player can FLY. Before this task the ship input loop
 * never ran (readInput was never called, ClientShipPredictor never
 * instantiated) — the player spawned docked and could not move the ship.
 *
 * Flow: claim → raw WS joins the home system (the SERVER-authoritative
 * observation point — the 10 Hz entity_updates) → the browser authenticates
 * with the same token → the chase camera arms (TASK-72 hook) → hold W for
 * ~2 s. The client's flight loop streams 'input' frames (thrust +1); the
 * server integrates them and the ship's SERVER position moves forward
 * along its facing, and the docked state is not (re)asserted. Screenshot
 * mid-flight shows the ship from the chase camera.
 */

const PROTOCOL_VERSION = 1; // mirrors @shared/protocol (Playwright does not resolve tsconfig aliases)

interface ClaimResponse {
  token: string;
  playerId: string;
  callsign: string;
  homeSystemId: string;
  shipId: string;
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
  rot?: { x: number; y: number; z: number; w: number };
  regime: string;
  padId?: string;
  callsign?: string;
}

/** The ship's forward (+Z rotated by the wire rot quat). */
function quatForward(q: { x: number; y: number; z: number; w: number }): Vec3 {
  const { x, y, z, w } = q;
  return { x: 2 * (x * z + w * y), y: 2 * (y * z - w * x), z: 1 - 2 * (x * x + y * y) };
}

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

test('flight: holding W from spawn flies the ship forward (server position)', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL, apiPort } = e2eServer;
  test.setTimeout(90_000);
  const callsign = uniqueCallsign('flight');

  // (a) Claim + a RAW ws client — the server-authoritative observer (the
  // browser is a second connection in the same shard).
  const claimRes = await fetch(`${baseURL}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  expect(claimRes.status).toBe(201);
  const session = (await claimRes.json()) as ClaimResponse;

  const client = new RawWsClient(`ws://127.0.0.1:${apiPort}/ws`);
  await client.open();
  const send = (type: string, payload: unknown): void =>
    client.send({ v: PROTOCOL_VERSION, type, payload });
  send('hello', { v: PROTOCOL_VERSION });
  send('auth', { token: session.token });
  send('join_system', { systemId: session.homeSystemId });
  await client.next((m) => m.type === 'enter_system', 'enter_system (home)');

  // The spawn state (server side): the ship's position + facing before any
  // input. A fresh player's ship is docked at the home dock.
  const spawnMsg = await client.next(
    (m) =>
      m.type === 'entity_update' &&
      ((m.payload as { entities: EntityState[] }).entities ?? []).some(
        (e) => e.kind === 'ship' && e.callsign === callsign,
      ),
    'first self ship entity_update',
    10_000,
  );
  const spawn = (spawnMsg.payload as { entities: EntityState[] }).entities.find(
    (e) => e.kind === 'ship' && e.callsign === callsign,
  )!;
  const forward = quatForward(spawn.rot ?? IDENTITY);

  // (b) The browser: same token, home system (no warp — the e2e shard has
  // one system). Wait until the chase camera has the ship in view
  // (TASK-72 debug hook — the mesh exists and projects ahead of the rig).
  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  await page.goto(baseURL);
  await page.evaluate((s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)), session);
  await page.goto(baseURL);
  await expect
    .poll(() => page.evaluate(() => !!window.__SELF_SHIP__?.probe()?.screen), {
      timeout: 20_000,
      message: 'chase camera never acquired the self ship',
    })
    .toBe(true);

  // (c) HOLD W — the client's flight loop streams thrust frames; the server
  // takes the (docked) ship off on the first input and integrates it.
  // Assert on the SERVER position: it must move FORWARD along the spawn
  // facing (thrust is along +Z-of-quat), and the docked state must not
  // reassert (it stays off the pad).
  await page.keyboard.down('w');
  const movedMsg = await client.next(
    (m) => {
      if (m.type !== 'entity_update') return false;
      const entities = (m.payload as { entities: EntityState[] }).entities ?? [];
      const e = entities.find((t) => t.kind === 'ship' && t.callsign === callsign);
      if (!e || e.regime === 'docked') return false;
      const d =
        (e.pos.x - spawn.pos.x) * forward.x +
        (e.pos.y - spawn.pos.y) * forward.y +
        (e.pos.z - spawn.pos.z) * forward.z;
      return d > 5;
    },
    'ship moved forward along its facing (server position)',
    20_000,
  );
  const moved = (movedMsg.payload as { entities: EntityState[] }).entities.find(
    (e) => e.kind === 'ship' && e.callsign === callsign,
  )!;
  const travelled =
    (moved.pos.x - spawn.pos.x) * forward.x +
    (moved.pos.y - spawn.pos.y) * forward.y +
    (moved.pos.z - spawn.pos.z) * forward.z;
  expect(travelled).toBeGreaterThan(5);
  expect(moved.regime).not.toBe('docked');

  // The visual artifact: mid-flight, still holding W — the ship from the
  // chase camera (the mesh + camera are driven from the prediction at
  // render rate, so the ship sits ahead of a tracking camera, centred).
  const probe = await page.evaluate(() => {
    const p = window.__SELF_SHIP__?.probe() ?? null;
    return p
      ? {
          pos: p.pos,
          x: p.screen?.x ?? null,
          y: p.screen?.y ?? null,
          w: window.innerWidth,
          h: window.innerHeight,
        }
      : null;
  });
  expect(probe, 'self ship probe during flight').not.toBeNull();
  expect(probe!.x, 'ship in view during flight (x)').not.toBeNull();
  expect(probe!.y, 'ship in view during flight (y)').not.toBeNull();
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-73-1.png'),
  });
  await page.keyboard.up('w');

  console.log(
    `[TASK-73] callsign=${callsign} spawn=(${spawn.pos.x.toFixed(1)}, ${spawn.pos.y.toFixed(1)}, ${spawn.pos.z.toFixed(1)}) ` +
      `moved=(${moved.pos.x.toFixed(1)}, ${moved.pos.y.toFixed(1)}, ${moved.pos.z.toFixed(1)}) ` +
      `forward-travel=${travelled.toFixed(1)} u regime=${moved.regime}`,
  );

  assertClean();
  await context.close();
  client.close();
});
