import path from 'node:path';
import WebSocket from 'ws';
import { expect, test } from './fixtures';
import { canvasLuminanceVariance, collectErrors, uniqueCallsign } from './helpers';

/**
 * TASK-48.4 — E2E: the on-foot player is teleported into the seeded FIRST
 * storm cell (GET /api/dev/hazard-target) and the exposure pool DRAINS.
 *
 * The flow reuses the walk.spec.ts skeleton verbatim (inline RawWsClient,
 * claim → dockAtPad → browser → press E to disembark), then POST
 * /api/dev/teleport-char parks the on-foot character at the cell center.
 * The acceptance criterion is the METER + the DRAIN, not the knock-down:
 * the `#hazard-hud` panel (TASK-48.2) appears, and `window.__HAZARD__`
 * exposure (50 max, storm drains 2/s) goes < 50 within a few seconds.
 * We deliberately do NOT wait for the 25 s storm knock-down, and we never
 * assert drone kills here — the committed shard integration suite covers
 * those (players never die on foot: worst case is the 5 s RECOVERING).
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

interface HazardTarget {
  systemId: string;
  planetId: string;
  hazardId: string;
  pos: { x: number; y: number; z: number };
  radius: number;
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

test('on foot: a teleported storm cell drains the exposure pool (HUD + meter)', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL, apiPort } = e2eServer;
  test.setTimeout(120_000);
  const callsign = uniqueCallsign('hazard');

  const claimRes = await fetch(`${baseURL}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  expect(claimRes.status).toBe(201);
  const session = (await claimRes.json()) as ClaimResponse;
  const target = await dockAtPad(baseURL, apiPort, session);
  console.log(`[hazards] callsign=${session.callsign} padSystem=${target.systemId}`);

  // The FIRST storm cell in star order (the same seeded cell the shard
  // enforces — hazardsFor is a pure function of the galaxy seed). It sits
  // on the first landable-atmosphere planet, i.e. the disembark pad's planet.
  const auth = { authorization: `Bearer ${session.token}` };
  const hazardRes = await fetch(`${baseURL}/api/dev/hazard-target`, { headers: auth });
  expect(hazardRes.status).toBe(200);
  const hazard = (await hazardRes.json()) as HazardTarget;
  console.log(
    `[hazards] storm ${hazard.hazardId} at (${hazard.pos.x}, ${hazard.pos.z}) r=${hazard.radius}`,
  );

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

  // Park the on-foot character at the storm cell center (the pad itself is a
  // 300 m hazard-free safe zone — the walk would take far too long).
  const teleRes = await fetch(`${baseURL}/api/dev/teleport-char`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ x: hazard.pos.x, y: hazard.pos.y, z: hazard.pos.z }),
  });
  expect(teleRes.status).toBe(200);

  // The 10 Hz hazard frame lights the exposure HUD (unmounted while clear).
  await expect(page.locator('#hazard-hud')).toBeVisible({ timeout: 15_000 });

  // THE ACCEPTANCE CRITERION: the pool DRAINS inside the storm (50 max,
  // 2/s → well under 50 within a few seconds). Not the knock-down (25 s).
  const drained = (await page
    .waitForFunction(
      () => {
        const h = window.__HAZARD__ as { exposure: number; inside: string | null } | undefined;
        return h && h.inside === 'storm' && h.exposure < 49.5 ? h : null;
      },
      null,
      { timeout: 20_000, polling: 100 },
    )
    .then((h) => h.jsonValue())) as { exposure: number; inside: string | null };
  expect(drained.inside).toBe('storm');
  expect(drained.exposure).toBeLessThan(50);

  // Let the drain progress to ~5 s in (exposure ≈ 40) so the meter visibly
  // shrinks in the screenshot, then wait for the streamed terrain around the
  // cell to render (the teleport puts the character ~370 m from the pad —
  // the nearest chunks arrive a few seconds after arrival; a black canvas
  // would hide the storm disc).
  const settled = (await page
    .waitForFunction(
      () => {
        const h = window.__HAZARD__ as { exposure: number } | undefined;
        return h && h.exposure <= 40.5 ? h : null;
      },
      null,
      { timeout: 20_000, polling: 100 },
    )
    .then((h) => h.jsonValue())) as { exposure: number };
  expect(settled.exposure).toBeLessThan(50);
  for (let i = 0; i < 30; i++) {
    if ((await canvasLuminanceVariance(page)) > 1) break;
    await page.waitForTimeout(500);
  }

  // Screenshot: the storm disc (TASK-48.3) under the character + the
  // draining exposure meter (bottom-left HUD).
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-48-1.png'),
  });
  assertClean();
  await context.close();
});
