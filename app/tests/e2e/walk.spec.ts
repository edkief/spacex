import path from 'node:path';
import WebSocket from 'ws';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';

/**
 * TASK-32 — E2E: on-foot movement with the REAL client input path.
 *
 * The disembark.spec.ts flow gets the ship docked server-authoritatively
 * (raw WS, then closed — one connection per player), the browser takes
 * over and presses E to disembark. Then the FIRST browser input path in
 * the game: holding W sends 'input' frames (thrust 1 = walk forward) at
 * 20 Hz, the local CharacterPredictor drives the model every frame, and
 * the SERVER-authoritative position (last self character entity_update,
 * exposed dev-only on window.__CHAR__) must advance ≥ 4 m in ~2.5 s of
 * walking (walk = 3 u/s → ~7 m; the 4 m floor tolerates latency + the
 * first-frame ramp).
 */

const PROTOCOL_VERSION = 1; // mirrors @shared/protocol (Playwright does not resolve tsconfig aliases)

interface Envelope {
  v: number;
  type: string;
  payload: unknown;
}

/** Minimal raw WS client (mirrors disembark.spec.ts — app/src is off-limits to the runner). */
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

  async next(predicate: (m: Envelope) => boolean, what: string, ms = 8000): Promise<Envelope> {
    const deadline = Date.now() + ms;
    for (;;) {
      const idx = this.messages.findIndex(predicate);
      if (idx !== -1) return this.messages.splice(idx, 1)[0];
      if (this.closed || Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}`);
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

/** Dock the player's ship at the seeded pad server-side (disembark flow). */
async function dockAtPad(baseURL: string, apiPort: number, session: ClaimResponse) {
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
        (e) => e.callsign === session.callsign && e.regime === 'docked' && e.padId === target.padId,
      ),
    `docked entity_update for ${session.callsign}`,
    15_000,
  );
  client.close(); // the ship idles at the pad (state kept) while the browser takes over
  return target;
}

test('on foot: holding W walks the character forward (server-authoritative)', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL, apiPort } = e2eServer;
  test.setTimeout(120_000);
  const callsign = uniqueCallsign('walk');

  const claimRes = await fetch(`${baseURL}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  expect(claimRes.status).toBe(201);
  const session = (await claimRes.json()) as ClaimResponse;
  const target = await dockAtPad(baseURL, apiPort, session);
  console.log(`[walk] callsign=${session.callsign} padSystem=${target.systemId}`);

  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  await page.goto(baseURL);
  await page.evaluate((s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)), session);
  await page.goto(`${baseURL}/?sys=${target.systemId}`);
  await expect(page.locator('#docked-indicator')).toBeVisible({ timeout: 15_000 });

  // Disembark: E → the character entity arrives, the docked HUD stubs clear.
  await page.keyboard.press('e');
  await expect(page.locator('#leave-ship-prompt')).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('#docked-indicator')).toBeHidden({ timeout: 15_000 });

  // The dev hook exposes the last SERVER-authoritative self character state.
  const start = (await page
    .waitForFunction(() => window.__CHAR__?.pos ?? null, null, { timeout: 15_000 })
    .then((h) => h.jsonValue())) as { x: number; y: number; z: number };

  // HOLD W: the client sends 'input' frames at 20 Hz (thrust 1 = walk) and
  // the shared-model predictor drives the model; the server integrates the
  // same frames. ~2.5 s at 3 u/s → ≥ 4 m horizontal travel (latency-tolerant).
  await page.keyboard.down('w');
  await page.waitForTimeout(2_500);
  await page.keyboard.up('w');
  const end = (await page
    .waitForFunction(
      (s: { x: number; z: number }) => {
        const p = window.__CHAR__?.pos;
        return p && Math.hypot(p.x - s.x, p.z - s.z) >= 4 ? p : null;
      },
      { x: start.x, z: start.z },
      { timeout: 10_000, polling: 100 },
    )
    .then((h) => h.jsonValue())) as { x: number; y: number; z: number };
  expect(Math.hypot(end.x - start.x, end.z - start.z)).toBeGreaterThanOrEqual(4);

  // Walking keeps the character ON the pad plane (flat disc — no drift down).
  expect(Math.abs(end.y - start.y)).toBeLessThan(1);
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-32-1.png'),
  });
  assertClean();
  await context.close();
});
