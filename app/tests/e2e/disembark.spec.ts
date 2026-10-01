import path from 'node:path';
import WebSocket from 'ws';
import { expect, test } from './fixtures';
import { canvasMaxLuminance, collectErrors, uniqueCallsign } from './helpers';

/**
 * TASK-31 — E2E: full flow from flight to standing on the pad.
 *
 * Step 1 (server-side, raw REST + WS — the landing.spec.ts pattern): claim
 * → GET the seeded pad target → join home; warp to the pad's system if
 * needed → dev-teleport into the pad's 20 m dock disc → the committed pad
 * machine docks the ship (polled SERVER-authoritatively: regime 'docked' +
 * padId) → close the raw client (the ship idles at the pad, state kept).
 *
 * Step 2 (browser, the REAL client disembark path): re-authenticate with the
 * SAME token, load the pad's system. The docked ship renders the DOCKED
 * indicator AND the new "E — LEAVE SHIP" prompt. Pressing E sends the
 * 'exit_ship' frame; the next 10 Hz entity_update carries the character
 * entity (kind 'character', the player's callsign) → the client spawns the
 * placeholder capsule, the docked store flips (both HUD stubs disappear),
 * and the CameraRig hands off to the on-foot view (TASK-27). The screenshot
 * is the on-foot view standing on the pad.
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
  kind: string;
  pos: { x: number; y: number; z: number };
  regime: string;
  padId?: string;
  callsign?: string;
}

test('docked ship: press E, disembark to the on-foot character on the pad', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL, apiPort } = e2eServer;
  test.setTimeout(90_000);
  const callsign = uniqueCallsign('exit');

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

  // (c) Join the home system over raw WS; warp to the pad's system if needed.
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

  // (d) Teleport INSIDE the pad's 20 m dock disc; the pad machine docks it.
  const teleRes = await fetch(`${baseURL}/api/dev/teleport`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ x: target.pad.x, y: target.pad.y + 5, z: target.pad.z }),
  });
  expect(teleRes.status).toBe(200);

  // (e) SERVER-authoritative: docked regime + padId before the browser takes over.
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
    `[disembark] callsign=${session.callsign} padSystem=${target.systemId} ship=${session.shipId}`,
  );

  // (2) Browser: same token → the docked ship renders the HUD stubs.
  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  await page.goto(baseURL);
  await page.evaluate((s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)), session);
  await page.goto(`${baseURL}/?sys=${target.systemId}`);
  await expect(page.locator('#docked-indicator')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#leave-ship-prompt')).toBeVisible({ timeout: 10_000 });

  // (3) DISSEMBARK: E sends the 'exit_ship' frame; the character entity
  // arrives in the next entity_update and the client goes on foot — the
  // docked HUD stubs disappear (the player's own entity is the character).
  await page.keyboard.press('e');
  await expect(page.locator('#leave-ship-prompt')).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('#docked-indicator')).toBeHidden({ timeout: 15_000 });

  // (4) The 600 ms camera handoff (TASK-27) settles into the on-foot view:
  // standing on the pad beside the (still docked) ship. The bright cyan
  // character capsule is dead-center in the third-person frame (GL origin is
  // bottom-left; the 1280x720 viewport center is 640,360). A flat-colored
  // object has ZERO internal variance, so prove the capsule with the MAX
  // luminance of the center region: the capsule reads ~190, the dark
  // sky/terrain ~35 — a flat/black screen would be well under 120.
  await page.waitForTimeout(1_500);
  const maxLum = await canvasMaxLuminance(page, 624, 344);
  expect(maxLum, 'center-screen capsule luminance (on-foot view rendered)').toBeGreaterThan(120);
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-31-1.png'),
  });
  assertClean();
  await context.close();
});
