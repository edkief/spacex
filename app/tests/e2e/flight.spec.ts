import path from 'node:path';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { RawWsClient } from './raw-ws';

/**
 * TASK-73 — E2E: the player can FLY. Before this task the ship input loop
 * never ran (readInput was never called, ClientShipPredictor never
 * instantiated) — the player spawned docked and could not move the ship.
 *
 * Flow: claim → raw WS joins the home system and captures the SPAWN state
 * (position + facing) → the browser authenticates with the same token and
 * joins the same system → the chase camera arms (TASK-72 hook) → hold W.
 * The client's flight loop streams 'input' frames (thrust +1); the server
 * takes the (docked) ship off on the first input and integrates it.
 *
 * Observation: the shard registers ONE connection per player — when the
 * browser joins, its connection SUPERSEDES the raw one (TASK-17), so the
 * raw client goes deaf. The server-authoritative position is therefore read
 * from the browser's OWN inbound entity_updates (an init-script tap), which
 * are the same 10 Hz broadcast buffer every in-system peer receives.
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

/**
 * Tap the page's WebSocket so every entity_update carrying OUR ship lands in
 * `window.__shipUpdates` (pos + regime). The client dials through the global
 * constructor (src/client/net/session.ts), so subclassing it in an init
 * script sees every frame without touching app code.
 */
function tapShipUpdates(callsign: string): void {
  const w = window as unknown as {
    __shipUpdates?: Array<{ pos: Vec3; vel: Vec3; regime: string }>;
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
              vel: e.vel ?? { x: 0, y: 0, z: 0 },
              regime: e.regime,
            });
        } catch {
          // never break the page's networking from a tap
        }
      });
    }
  };
}

test('flight: holding W from spawn flies the ship forward (server position)', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL, apiPort } = e2eServer;
  test.setTimeout(90_000);
  const callsign = uniqueCallsign('flight');

  // (a) Claim + a RAW ws client that captures the SPAWN state before the
  // browser joins (once the browser joins, the raw conn is superseded —
  // TASK-17 — and the observation moves to the browser's inbound tap).
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
  // one system). The init-script tap records the server's entity_updates
  // for our ship; wait until the chase camera has the ship in view
  // (TASK-72 debug hook — the mesh exists and projects ahead of the rig).
  const context = await browser.newContext();
  await context.addInitScript(tapShipUpdates, callsign);
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
  // Assert on the SERVER position (the browser's own inbound entity_update
  // broadcast): it must move FORWARD along the spawn facing (thrust is
  // along +Z-of-quat), and the docked state must not reassert.
  await page.keyboard.down('w');
  const wDownAt = Date.now();
  // Forward-travel of the ship per the SERVER's own entity_update broadcast
  // (the tap records every update; a SINGLE arg — bundle the constants).
  const bestTravelled = (): Promise<number> =>
    page.evaluate(
      ({ sp, fw }: { sp: Vec3; fw: Vec3 }) => {
        const ups =
          (window as unknown as { __shipUpdates?: Array<{ pos: Vec3; regime: string }> })
            .__shipUpdates ?? [];
        let best = 0;
        for (const u of ups) {
          if (u.regime === 'docked') continue;
          const d = (u.pos.x - sp.x) * fw.x + (u.pos.y - sp.y) * fw.y + (u.pos.z - sp.z) * fw.z;
          if (d > best) best = d;
        }
        return best;
      },
      { sp: spawn.pos, fw: forward },
    );
  await expect
    .poll(() => bestTravelled(), {
      timeout: 20_000,
      message: 'server position never moved forward while holding W',
    })
    .toBeGreaterThan(5);
  const travelled = await bestTravelled();

  // TASK-81: thrust is not a top speed. After 8 s of full W the
  // SERVER-reported speed |vel| must stay under the scout's maxVelocity
  // (120) + 1 u/s — pre-fix the soft cap bled 5 %/tick while thrust added
  // a·dt/tick, so the ship settled at ~160 u/s.
  await expect
    .poll(() => page.evaluate((since: number) => Date.now() - since, wDownAt), {
      timeout: 15_000,
      message: '8 s of W elapsed',
    })
    .toBeGreaterThanOrEqual(8_000);
  const topSpeed = await page.evaluate(() => {
    const ups =
      (
        window as unknown as {
          __shipUpdates?: Array<{ vel: Vec3; regime: string }>;
        }
      ).__shipUpdates ?? [];
    let top = 0;
    for (const u of ups) {
      if (u.regime === 'docked') continue;
      top = Math.max(top, Math.hypot(u.vel.x, u.vel.y, u.vel.z));
    }
    return top;
  });
  expect(topSpeed, 'server-reported speed while holding W (8 s)').toBeLessThanOrEqual(121);
  expect(topSpeed, 'the ship actually flew').toBeGreaterThan(5);

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
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-81-1.png'),
  });
  await page.keyboard.up('w');

  console.log(
    `[TASK-73/81] callsign=${callsign} spawn=(${spawn.pos.x.toFixed(1)}, ${spawn.pos.y.toFixed(1)}, ${spawn.pos.z.toFixed(1)}) ` +
      `forward-travel=${travelled.toFixed(1)} u (server entity_update, non-docked) ` +
      `top-speed=${topSpeed.toFixed(1)} u/s (scout maxVelocity 120)`,
  );

  assertClean();
  await context.close();
  client.close();
});
