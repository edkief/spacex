import path from 'node:path';
import WebSocket from 'ws';
import { expect, test } from './fixtures';
import { canvasLuminanceVariance, collectErrors, uniqueCallsign } from './helpers';

/**
 * TASK-52 — E2E: the on-foot HUD — exposure meter + weight bar + the
 * ship/HUD mode switch.
 *
 * The flow reuses the hazards.spec.ts skeleton (inline RawWsClient, claim →
 * dockAtPad → browser → press E to disembark), then GET
 * /api/dev/hazard-target?kind=radzone + POST /api/dev/teleport-char park the
 * character in the FIRST rad zone (the same seeded cell the shard enforces).
 * Acceptance criteria covered:
 * - MODE COHERENCE: docked (in-ship) → the flight HUD elements are up and NO
 *   on-foot element renders; on foot → the exposure/weight/prompt elements
 *   are up and NO ship element renders (the switch is the active-entity
 *   frame — the same event as the camera handoff).
 * - The exposure meter (the #hazard-hud vertical bar, bottom-right above the
 *   weight bar) appears with the RADIATION icon while inside the rad zone
 *   and the pool DRAINS (rad zones drain 5/s — much faster than the storm's
 *   2/s, so the screenshot shows a visibly shrunk bar).
 */

const PROTOCOL_VERSION = 1; // mirrors @shared/protocol (Playwright does not resolve tsconfig aliases)

interface Envelope {
  v: number;
  type: string;
  payload: unknown;
}

/** Minimal raw WS client (mirrors hazards.spec.ts — app/src is off-limits to the runner). */
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
      (
        (m.payload as { entities: { callsign?: string; regime: string; padId?: string }[] })
          .entities ?? []
      ).some(
        (e) => e.callsign === session.callsign && e.regime === 'docked' && e.padId === target.padId,
      ),
    `docked entity_update for ${session.callsign}`,
    15_000,
  );
  client.close(); // the ship idles at the pad (state kept) while the browser takes over
  return target;
}

test('on-foot HUD: mode switch + exposure meter in a rad zone', async ({ browser, e2eServer }) => {
  const { baseURL, apiPort } = e2eServer;
  test.setTimeout(120_000);
  const callsign = uniqueCallsign('onfoot');

  const claimRes = await fetch(`${baseURL}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  expect(claimRes.status).toBe(201);
  const session = (await claimRes.json()) as ClaimResponse;
  const target = await dockAtPad(baseURL, apiPort, session);
  console.log(`[on-foot-hud] callsign=${session.callsign} padSystem=${target.systemId}`);

  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  await page.goto(baseURL);
  await page.evaluate((s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)), session);
  await page.goto(`${baseURL}/?sys=${target.systemId}`);
  await expect(page.locator('#docked-indicator')).toBeVisible({ timeout: 15_000 });

  // SHIP MODE (docked): the flight HUD elements are up and NO on-foot
  // element renders (the hard rule: one HUD mode at a time).
  await expect(page.locator('#ship-hud-block')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#ship-hud-cargo')).toBeVisible();
  await expect(page.locator('#weight-bar')).toBeHidden();
  await expect(page.locator('#hazard-hud')).toBeHidden();
  await expect(page.locator('#interact-prompt')).toBeHidden();

  // Disembark: E → the character entity arrives (the active-entity flip that
  // switches the HUD mode at the camera-handoff event).
  await page.keyboard.press('e');
  await expect(page.locator('#leave-ship-prompt')).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('#docked-indicator')).toBeHidden({ timeout: 15_000 });

  // ON-FOOT MODE: the on-foot elements are up…
  const bar = page.locator('#weight-bar');
  await expect(bar).toBeVisible({ timeout: 15_000 });
  // …and NO ship element lingers (mode coherence, AC).
  await expect(page.locator('#ship-hud-block')).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('#ship-hud-cargo')).toBeHidden();
  // The exposure meter is unmounted while clear (nothing is in range yet).
  await expect(page.locator('#hazard-hud')).toBeHidden();

  // THE FIRST rad zone in star order (the same seeded cell the shard
  // enforces — hazardsFor is a pure function of the galaxy seed). It sits
  // on the first landable planet, i.e. the disembark pad's planet (no warp).
  const auth = { authorization: `Bearer ${session.token}` };
  const hazardRes = await fetch(`${baseURL}/api/dev/hazard-target?kind=radzone`, { headers: auth });
  expect(hazardRes.status).toBe(200);
  const hazard = (await hazardRes.json()) as HazardTarget;
  console.log(
    `[on-foot-hud] radzone ${hazard.hazardId} at (${hazard.pos.x}, ${hazard.pos.z}) r=${hazard.radius}`,
  );

  const teleRes = await fetch(`${baseURL}/api/dev/teleport-char`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ x: hazard.pos.x, y: hazard.pos.y, z: hazard.pos.z }),
  });
  expect(teleRes.status).toBe(200);

  // The 10 Hz hazard frame lights the exposure meter (radiation icon —
  // the rad zone kind, NOT the storm icon).
  await expect(page.locator('#hazard-hud')).toBeVisible({ timeout: 15_000 });
  const drained = (await page
    .waitForFunction(
      () => {
        const h = window.__HAZARD__ as { exposure: number; inside: string | null } | undefined;
        return h && h.inside === 'radzone' && h.exposure < 49.5 ? h : null;
      },
      null,
      { timeout: 20_000, polling: 100 },
    )
    .then((h) => h.jsonValue())) as { exposure: number; inside: string };
  expect(drained.inside).toBe('radzone');
  expect(drained.exposure).toBeLessThan(50);

  // Rad zones drain 5/s: let the pool reach ~40 so the bar visibly shrinks,
  // then wait for the streamed terrain around the cell to render (a black
  // canvas would hide the rad-zone disc under the character).
  await page.waitForFunction(
    () => {
      const h = window.__HAZARD__ as { exposure: number } | undefined;
      return h && h.exposure <= 40.5;
    },
    null,
    { timeout: 20_000, polling: 100 },
  );
  for (let i = 0; i < 30; i++) {
    if ((await canvasLuminanceVariance(page)) > 1) break;
    await page.waitForTimeout(500);
  }

  // Screenshot: the on-foot HUD in the rad zone — the vertical exposure
  // meter (☢, bottom-right above the weight bar) + the weight bar, with NO
  // ship-HUD elements in frame.
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-52-1.png'),
  });
  assertClean();
  await context.close();
});
