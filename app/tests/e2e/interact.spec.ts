import path from 'node:path';
import WebSocket from 'ws';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';

/**
 * TASK-33 — E2E: the on-foot interaction happy path (browser = the REAL
 * client; the world is prepared server-side, the disembark.spec.ts pattern).
 *
 * Step 1 (server-side, raw REST + WS): claim → pad target → join/warp →
 * dev-teleport onto the pad → the pad machine docks the ship → disembark
 * over raw WS (the character entity arrives on the wire) → POST
 * /api/dev/deposit 1.5 m IN FRONT of the character (identity facing = +Z,
 * inside the 3 m / 30° cone) → close the raw client (the character persists
 * in the sim while the browser takes over).
 *
 * Step 2 (browser, the REAL interaction path): same token → the client
 * spawns on foot; the snapshot batch carries the deposit into the raycast's
 * target list → the per-frame raycast hits it → the bottom-center
 * '[E] Take ore' prompt appears (screenshot). Pressing E dispatches through
 * the InteractableRegistry → the server applies the v1 pickup (quantity 1 →
 * 0 → despawn) → within one 10 Hz snapshot the deposit leaves the target
 * list and the prompt hides. Console stays clean.
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
  onFoot?: boolean;
}

test('on foot: the prompt appears at a deposit, E mines it up, the prompt hides', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL, apiPort } = e2eServer;
  test.setTimeout(90_000);
  const callsign = uniqueCallsign('interact');

  // (a) Claim — raw REST, same shape the claim flow stores in localStorage.
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

  // (e) Disembark over raw WS → the character entity (SERVER position).
  send('exit_ship', { shipId: session.shipId });
  const charUpd = await client.next(
    (m) =>
      m.type === 'entity_update' &&
      ((m.payload as { entities: EntityState[] }).entities ?? []).some(
        (e) => e.kind === 'character' && e.callsign === session.callsign,
      ),
    'character entity_update',
    10_000,
  );
  const char = (charUpd.payload as { entities: EntityState[] }).entities.find(
    (e) => e.kind === 'character' && e.callsign === session.callsign,
  )!;
  expect(char.onFoot).toBe(true);

  // (f) A deposit 1.5 m IN FRONT of the character (identity facing = +Z):
  // inside the 3 m reach and the 30° cone — the prompt's raycast must hit it.
  const depRes = await fetch(`${baseURL}/api/dev/deposit`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ x: char.pos.x, y: char.pos.y, z: char.pos.z + 1.5, quantity: 1 }),
  });
  expect(depRes.status).toBe(200);
  const deposit = (await depRes.json()) as { ok: boolean; depositId: string };
  expect(deposit.ok).toBe(true);
  client.close(); // the character persists in the sim while the browser takes over

  console.log(`[interact] callsign=${session.callsign} deposit=${deposit.depositId}`);

  // (2) Browser: the REAL client goes on foot. The snapshot batch carries
  // the deposit into the raycast's target list → the per-frame raycast hits
  // it → the bottom-center prompt appears.
  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  await page.goto(baseURL);
  await page.evaluate((s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)), session);
  await page.goto(`${baseURL}/?sys=${target.systemId}`);

  // The prompt: 'Hold [E] to mine iron', bottom-center (TASK-38 hold-to-mine
  // replaced the v1 '[E] Take ore' single-press pickup).
  const prompt = page.locator('#interact-prompt');
  await expect(prompt).toBeVisible({ timeout: 20_000 });
  await expect(prompt).toHaveText('Hold [E] to mine iron');
  await page.waitForTimeout(800); // let the on-foot camera settle
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-33-1.png'),
  });

  // (3) HOLD E: the registry dispatches 'mine-start'; the server's 1.5 s
  // channel awards the single unit (quantity 1 → 0 → despawn). Release E
  // (mine-stop) and the deposit is gone from the target list → prompt hides.
  await page.keyboard.down('e');
  await expect(page.locator('#mining-hud')).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1_800); // one full 1.5 s channel tick → award
  await page.keyboard.up('e');
  await expect(prompt).toBeHidden({ timeout: 10_000 });

  assertClean();
  await context.close();
});
