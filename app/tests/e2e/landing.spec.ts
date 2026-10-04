import path from 'node:path';
import WebSocket from 'ws';
import { expect, test } from './fixtures';
import { canvasLuminanceVariance, collectErrors, uniqueCallsign } from './helpers';

/**
 * TASK-29.4 — E2E: land a ship at the station (settlement) pad.
 *
 * Step 1 (server-side, raw REST + WS in the Node context, the claim/join/warp
 * pattern from src/server/galaxy/warp.ws.test.ts): claim → GET the seeded pad
 * target → join the home system; if the pad lives in a DIFFERENT system, warp
 * over WS first (/api/dev/teleport acts on the ship's CURRENT system, so the
 * warp MUST precede the teleport) → dev-teleport the ship into the pad's 20 m
 * dock disc a few metres up. The committed flat-pad + surface-regime logic
 * settles it and the sim docks it; we prove it SERVER-authoritatively by
 * polling the ship's entity_update for regime 'docked' + the pad's id.
 *
 * Step 2 (browser): re-authenticate with the SAME token (the localStorage
 * session key the claim flow stores) and load the pad's system. The
 * client-rendered #docked-indicator (TASK-29.3) appears — the DOM half of the
 * acceptance criterion — the canvas is asserted non-uniform (not a black
 * screen), and a screenshot of the docked state is saved.
 */

const PROTOCOL_VERSION = 1; // mirrors @shared/protocol (Playwright does not resolve tsconfig aliases)

interface Envelope {
  v: number;
  type: string;
  payload: unknown;
}

/** Minimal raw WS client (mirrors WsTestClient — app/src modules are off-limits to the runner). */
class RawWsClient {
  readonly messages: Envelope[] = [];
  closed = false;
  private ws: WebSocket;
  private wake: Array<() => void> = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('error', () => {
      // Tolerated: teardown terminates sockets the client no longer uses.
    });
    this.ws.on('message', (data) => {
      this.messages.push(JSON.parse(String(data)) as Envelope);
      for (const w of this.wake.splice(0)) w();
    });
    this.ws.on('close', () => {
      this.closed = true;
      for (const w of this.wake.splice(0)) w();
    });
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.once('open', () => resolve());
      this.ws.once('close', () => reject(new Error('socket closed before open')));
    });
  }

  send(envelope: Envelope): void {
    this.ws.send(JSON.stringify(envelope));
  }

  /** Consume the first unmatched message matching the predicate. */
  async next(predicate: (m: Envelope) => boolean, what: string, ms = 8000): Promise<Envelope> {
    const deadline = Date.now() + ms;
    for (;;) {
      const idx = this.messages.findIndex(predicate);
      if (idx !== -1) return this.messages.splice(idx, 1)[0];
      if (this.closed || Date.now() > deadline) {
        throw new Error(
          `timed out waiting for ${what} (closed=${this.closed}, got: ${this.messages
            .map((m) => m.type)
            .join(',')})`,
        );
      }
      await new Promise<void>((resolve) => {
        this.wake.push(resolve);
        setTimeout(resolve, 10);
      });
    }
  }

  close(): void {
    this.ws.close();
  }
}

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
  regime: string;
  flightRegime?: string;
  padId?: string;
  callsign?: string;
}

test('land at the station pad: server-docked, then #docked-indicator in the browser', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL, apiPort } = e2eServer;
  test.setTimeout(60_000);
  const callsign = uniqueCallsign('land');

  // (a) Claim — raw REST, same shape the claim flow stores in localStorage.
  const claimRes = await fetch(`${baseURL}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  expect(claimRes.status).toBe(201);
  const session = (await claimRes.json()) as ClaimResponse;
  const auth = { authorization: `Bearer ${session.token}` };

  // (b) The deterministic pad target (first star-order system with a landable
  // atmospheric planet — generally NOT the player's home system).
  const targetRes = await fetch(`${baseURL}/api/dev/pad-target`, { headers: auth });
  expect(targetRes.status).toBe(200);
  const target = (await targetRes.json()) as PadTarget;

  // (c) Join the home system over raw WS; warp to the pad's system if needed
  // (the ship ROW + entity must live in the pad's system before the teleport).
  const client = new RawWsClient(`ws://127.0.0.1:${apiPort}/ws`);
  await client.open();
  const send = (type: string, payload: unknown): void =>
    client.send({ v: PROTOCOL_VERSION, type, payload });
  send('hello', { v: PROTOCOL_VERSION });
  send('auth', { token: session.token });
  send('join_system', { systemId: session.homeSystemId });
  await client.next((m) => m.type === 'enter_system', 'enter_system (home)');
  let warped = false;
  if (target.systemId !== session.homeSystemId) {
    send('warp', { destinationSystemId: target.systemId });
    const arrived = await client.next(
      (m) => m.type === 'warp_arrived',
      'warp_arrived (pad system)',
      10_000,
    );
    expect((arrived.payload as { systemId: string }).systemId).toBe(target.systemId);
    warped = true;
  }

  // (d) Teleport INSIDE the pad's 20 m dock disc, a few metres above the pad
  // height: the committed flat-pad surface regime settles the ship (ground
  // clamp zeroes vel.y) and the sim docks it — no long real-physics approach.
  const teleRes = await fetch(`${baseURL}/api/dev/teleport`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ x: target.pad.x, y: target.pad.y + 5, z: target.pad.z }),
  });
  expect(teleRes.status).toBe(200);
  expect(((await teleRes.json()) as { systemId: string }).systemId).toBe(target.systemId);

  // (e) SERVER-authoritative proof: poll the ship's entity_update until the
  // regime is 'docked' with the pad's id.
  await client.next(
    (m) =>
      m.type === 'entity_update' &&
      ((m.payload as { entities: EntityState[] }).entities ?? []).some(
        (e) => e.callsign === session.callsign && e.regime === 'docked' && e.padId === target.padId,
      ),
    `docked entity_update for ${session.callsign}`,
    15_000,
  );
  client.close(); // the ship idles at the pad (state kept) while the browser takes over

  console.log(
    `[landing] callsign=${session.callsign} padSystem=${target.systemId} warped=${warped}`,
  );

  // (2) Browser: same token → the client joins the pad's system as the landed
  // player and renders its own docked state.
  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  await page.goto(baseURL);
  await page.evaluate((s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)), session);
  await page.goto(`${baseURL}/?sys=${target.systemId}`);
  await expect(page.locator('#docked-indicator')).toBeVisible({ timeout: 15_000 });

  // The screenshot must show a rendered world, not a black screen.
  // Chase-camera framing (TASK-72): the docked ship sits at screen centre in
  // ship-local space (stable on every run), but the 4 DEFAULT 32x32 sample
  // regions all land in flat areas of this composition (dark background and
  // the unlit planet disc), so sample the ship hull/wings + atmosphere ring
  // explicitly — GL coords, origin bottom-left (page y 720 − glY).
  const variance = await canvasLuminanceVariance(page, [
    [624, 261], // ship hull (grey on black planet)
    [530, 261], // gold left wing
    [700, 261], // gold right wing
    [130, 250], // teal atmosphere ring, left of the planet
  ]);
  expect(variance, 'canvas luminance variance (rendered, non-uniform)').toBeGreaterThan(1);
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-29.4-1.png'),
  });
  assertClean();
  await context.close();
});
