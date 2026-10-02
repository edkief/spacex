import path from 'node:path';
import WebSocket from 'ws';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';

/**
 * TASK-37 — E2E: seeded ore deposits render as ore rocks (the 500 m streaming
 * ring) + a dev-placed deposit appears in front of the on-foot character.
 *
 * Step 1 (server-side, raw WS — the walk.spec.ts/interact.spec.ts pattern):
 * claim → pad target → join/warp → dev-teleport onto the pad → the pad
 * machine docks the ship → disembark over raw WS (the character entity
 * arrives on the wire) → close the raw client (the character persists).
 *
 * Step 2 (browser, the REAL client): same token → the client spawns on foot
 * in the pad system; the deposit LIST is derived client-side from the same
 * seed the server uses (window.__DEPOSITS__, dev hook). The seeded rocks in
 * the character's 500 m ring render (screenshot 1); a dev-placed deposit
 * (POST /api/dev/deposit at the character's __CHAR__ position) streams in
 * within one 10 Hz snapshot and renders 1.5 m in front (screenshot 2).
 *
 * The seeded pad system is known (fixed seed) to carry seeded deposits
 * inside the pad's 500 m ring, so the "at least one seeded rock visible"
 * assertion is deterministic — and with ~60+ deposits scattered over a 2000 m
 * radius per planet, the "rocks beyond the ring are hidden" culling
 * assertion holds by construction.
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

test('on foot: seeded ore rocks render in the 500 m ring; a placed deposit streams in', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL, apiPort } = e2eServer;
  test.setTimeout(90_000);
  const callsign = uniqueCallsign('deposits');

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
        // The REAL pad dock (a stale 'docked' wire regime without a padId is
        // the home-dock rest, not a pad landing).
        (e) => e.callsign === session.callsign && e.regime === 'docked' && e.padId !== undefined,
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
  client.close(); // the character persists in the sim while the browser takes over

  console.log(`[deposits] callsign=${session.callsign} system=${target.systemId}`);

  // (2) Browser: the REAL client goes on foot in the pad system.
  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  await page.goto(baseURL);
  await page.evaluate((s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)), session);
  await page.goto(`${baseURL}/?sys=${target.systemId}`);

  // The on-foot character (server authoritative) + the derived deposit list
  // are both up (world swapped → ore rocks known).
  await page
    .waitForFunction(() => window.__CHAR__?.pos ?? null, null, { timeout: 20_000 })
    .catch(() => {
      throw new Error('on-foot character never appeared');
    });
  await expect
    .poll(async () => (await page.evaluate(() => window.__DEPOSITS__?.deposits() ?? [])).length, {
      timeout: 20_000,
      message: 'client-derived deposit list (__DEPOSITS__)',
    })
    .toBeGreaterThan(0);

  // Screenshot 1: walking on foot near ore rocks — first a short walk (the
  // seeded rocks of the pad planet's 500 m ring are live in the scene).
  await page.keyboard.down('w');
  await page.waitForTimeout(800);
  await page.keyboard.up('w');
  await page.waitForTimeout(400); // let the on-foot camera settle
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-37-1.png'),
  });

  // At least one SEEDED rock (id `${systemId}:${seq}` — never `deposit:dev*`)
  // inside the character's 500 m ring, and rocks beyond the ring hidden
  // (streamed, not rendered).
  const seeded = await page.evaluate(
    () =>
      window.__DEPOSITS__?.deposits().filter((d) => !d.depositId.startsWith('deposit:dev')) ?? [],
  );
  expect(seeded.length, 'seeded deposits derived client-side').toBeGreaterThan(0);
  expect(
    seeded.filter((d) => d.visible).length,
    'a seeded ore rock inside the 500 m ring',
  ).toBeGreaterThan(0);
  expect(
    seeded.filter((d) => !d.visible).length,
    'rocks beyond the 500 m ring are not rendered',
  ).toBeGreaterThan(0);

  // (3) Place a deposit 1.5 m IN FRONT of the character (identity facing
  // = +Z) at the character's LIVE position. Quantity 3 < 10 → the rock
  // pulses (the near-depletion emissive).
  const charPos = (await page.evaluate(() => window.__CHAR__?.pos)) as {
    x: number;
    y: number;
    z: number;
  } | null;
  expect(charPos, 'character position from __CHAR__').not.toBeNull();
  const depRes = await fetch(`${baseURL}/api/dev/deposit`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ x: charPos!.x, y: charPos!.y, z: charPos!.z + 1.5, quantity: 3 }),
  });
  expect(depRes.status).toBe(200);
  const deposit = (await depRes.json()) as { ok: boolean; depositId: string };
  expect(deposit.ok).toBe(true);

  // Within one 10 Hz snapshot the server's ring filter streams the dev
  // deposit's quantity → the client rock becomes visible with quantity 3.
  await expect
    .poll(
      async () =>
        await page.evaluate((id) => {
          const d = (window.__DEPOSITS__?.deposits() ?? []).find((x) => x.depositId === id);
          return d ? { visible: d.visible, quantity: d.quantity } : null;
        }, deposit.depositId),
      { timeout: 15_000, message: `dev deposit ${deposit.depositId} in __DEPOSITS__` },
    )
    .toEqual({ visible: true, quantity: 3 });

  await page.waitForTimeout(600); // let the emissive pulse + frame settle
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-37-2.png'),
  });

  assertClean();
  await context.close();
});
