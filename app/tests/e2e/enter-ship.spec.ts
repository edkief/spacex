import path from 'node:path';
import WebSocket from 'ws';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';

/**
 * TASK-35 — E2E: the full disembark → walk → re-enter cycle with the REAL
 * client (the walk.spec.ts / disembark.spec.ts pattern: the world is
 * prepared server-side, the browser owns the ship and the character).
 *
 * Step 1 (server-side, raw REST + WS): claim → pad target → join/warp →
 * dev-teleport onto the pad → the pad machine docks the ship → close the
 * raw client (the ship idles at the pad, state kept).
 *
 * Step 2 (browser, the REAL client both ways):
 * - DISSEMBARK: E sends 'exit_ship'; the character entity arrives, the
 *   docked HUD stubs clear (TASK-31, the reverse of this spec's end).
 * - TURN: the character spawns 2.5 m to the ship's SIDE facing +Z (the
 *   cone is ±30°), so spin right ('d' turns at 3 rad/s, ~2.1 s per
 *   revolution) until the ship enters the cone → the '[E] Enter ship'
 *   prompt appears within the 5 m enter radius (screenshot 1).
 * - WALK 10 m: holding W walks 3 u/s → ≥ 10 m from the start (the ship is
 *   behind at 7.5 m+ — beyond the 5 m radius, the prompt hides;
 *   screenshot 2).
 * - WALK BACK: holding S walks backward along the same line to within 0.6 m
 *   of the start, then the test WAITS FOR REST (the release coast carries
 *   the character another 0.3-1 m, which can stop it outside the 3 m
 *   sub-prompt boundary or on the 30° cone edge — E must land at rest) and
 *   closes the gap with the PROMPT AS SENSOR: 'Open cargo' → a short W
 *   burst (in the cone, W always approaches the ship), hidden → a bounded
 *   turn nudge toward the ship — until '[E] Enter ship' holds stable
 *   (screenshot 3).
 * - RE-ENTER: E dispatches through the InteractableRegistry → the
 *   'enter_ship' frame → the server removes the character, switches the
 *   active entity back to the ship, the docked HUD stubs reappear and the
 *   CameraRig runs the reverse 600 ms handoff (TASK-27) into the cockpit
 *   (screenshot 4). The capsule is disposed: the on-foot prompt is gone
 *   and never comes back.
 * Console stays clean through the whole cycle.
 */

const PROTOCOL_VERSION = 1; // mirrors @shared/protocol (Playwright does not resolve tsconfig aliases)

interface Envelope {
  v: number;
  type: string;
  payload: unknown;
}

/** Minimal raw WS client (mirrors walk.spec.ts — app/src is off-limits to the runner). */
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

type CharPos = { x: number; y: number; z: number };

/** Dock the player's ship at the seeded pad server-side (walk.spec.ts flow). */
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

/** The last SERVER-authoritative self-character position (dev hook, TASK-32). */
async function charPos(page: Page, minDist: number, from: CharPos): Promise<CharPos> {
  return page
    .waitForFunction(
      ({ s, d }: { s: { x: number; z: number }; d: number }) => {
        const p = window.__CHAR__?.pos;
        return p && Math.hypot(p.x - s.x, p.z - s.z) >= d ? p : null;
      },
      { s: { x: from.x, z: from.z }, d: minDist },
      { timeout: 15_000, polling: 100 },
    )
    .then((h) => h.jsonValue() as unknown as CharPos);
}

/**
 * Wait until the character has come to REST (server position via __CHAR__,
 * 10 Hz): no movement > 6 cm per 100 ms poll for 600 ms. The walk-back
 * releases S while the character is still moving (the release coast ends
 * 0.3-1 m past the stop point), and the re-enter prompt's boundaries (the
 * 3 m sub-prompt, the 30° cone) must be evaluated at rest — an E pressed
 * mid-coast races the coast across a boundary and silently no-ops (the
 * raycast resolves nothing on that frame).
 */
async function charSettled(page: Page): Promise<void> {
  type Settle = { x: number | null; z: number | null; t: number };
  await page.evaluate(() => {
    (window as unknown as { __settle?: Settle }).__settle = { x: null, z: null, t: 0 };
  });
  await page.waitForFunction(
    () => {
      const p = window.__CHAR__?.pos;
      const s = (window as unknown as { __settle?: Settle }).__settle;
      if (!p || !s) return null;
      const now = Date.now();
      if (s.x === null || s.z === null || Math.hypot(p.x - s.x, p.z - s.z) > 0.06) {
        s.x = p.x;
        s.z = p.z;
        s.t = now;
        return null;
      }
      return now - s.t >= 600 ? true : null;
    },
    null,
    { timeout: 15_000, polling: 100 },
  );
}

/** Walk until within `dist` of the start position (the return leg). */
async function charBack(page: Page, from: CharPos, dist: number): Promise<CharPos> {
  return page
    .waitForFunction(
      ({ s, d }: { s: { x: number; z: number }; d: number }) => {
        const p = window.__CHAR__?.pos;
        return p && Math.hypot(p.x - s.x, p.z - s.z) <= d ? p : null;
      },
      { s: { x: from.x, z: from.z }, d: dist },
      { timeout: 15_000, polling: 100 },
    )
    .then((h) => h.jsonValue() as unknown as CharPos);
}

test('docked ship: disembark, walk 10 m, walk back, re-enter the cockpit', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL, apiPort } = e2eServer;
  test.setTimeout(120_000);
  const callsign = uniqueCallsign('enter');

  const claimRes = await fetch(`${baseURL}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  expect(claimRes.status).toBe(201);
  const session = (await claimRes.json()) as ClaimResponse;
  const target = await dockAtPad(baseURL, apiPort, session);
  console.log(`[enter-ship] callsign=${session.callsign} padSystem=${target.systemId}`);

  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  await page.goto(baseURL);
  await page.evaluate((s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)), session);
  await page.goto(`${baseURL}/?sys=${target.systemId}`);
  await expect(page.locator('#docked-indicator')).toBeVisible({ timeout: 15_000 });

  // (2) DISSEMBARK: E sends 'exit_ship'; the character arrives, the docked
  // HUD stubs clear — the player is on foot 2.5 m beside the docked ship.
  await page.keyboard.press('e');
  await expect(page.locator('#leave-ship-prompt')).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('#docked-indicator')).toBeHidden({ timeout: 15_000 });
  const start = (await page
    .waitForFunction(() => window.__CHAR__?.pos ?? null, null, { timeout: 15_000 })
    .then((h) => h.jsonValue())) as CharPos;

  // (3) TURN toward the ship: it is on the character's SIDE (the ±30° cone
  // misses it at spawn); 'd' turns right at 3 rad/s — the first revolution
  // must sweep the cone across the 2.5 m hull → '[E] Enter ship' (5 m
  // enter radius, TASK-35). Bounded 100 ms bursts (≈ 17° each), NOT one
  // long hold + release: on the software-GL page the main thread is busy
  // (60 fps rAF + the prompt's boundary flicker), so a held key's RELEASE
  // event can be queued for hundreds of ms — the character then keeps
  // turning, overshoots the ship's bearing and parks OUTSIDE the cone,
  // where the prompt hides and the text assertion fails. A burst loop that
  // re-reads the prompt AT REST after each burst cannot overshoot: it stops
  // the instant the facing settles inside the cone (24 × 17° covers the
  // full revolution either side of the bearing).
  const prompt = page.locator('#interact-prompt');
  const promptText = async (): Promise<string | null> =>
    prompt
      .isVisible()
      .then((v) => (v ? prompt.textContent() : null))
      .catch(() => null);
  for (let i = 0; i < 24; i++) {
    await page.keyboard.down('d');
    await page.waitForTimeout(100);
    await page.keyboard.up('d');
    await page.waitForTimeout(400); // rest: the raycast settles (the release
    // event can lag the main thread; a 400 ms wait absorbs a ~21° tail)
    if ((await promptText()) === '[E] Enter ship') break;
  }
  await expect(prompt).toHaveText('[E] Enter ship', { timeout: 5_000 });
  await page.waitForTimeout(800); // let the on-foot camera settle
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-35-1.png'),
  });

  // (4) WALK 10 m AWAY: the ship ends up 7.5 m+ BEHIND — beyond the 5 m
  // enter radius → the prompt hides (server-authoritative distance via
  // __CHAR__).
  await page.keyboard.down('w');
  const far = await charPos(page, 10, start);
  await page.keyboard.up('w');
  await expect(prompt).toBeHidden({ timeout: 10_000 });
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-35-2.png'),
  });
  void far;

  // (5) WALK BACK: backward along the same line (facing kept) to within
  // 0.6 m of the start, release, and WAIT FOR REST. The coast after the
  // release parks the character 0.3-1 m further — sometimes OUTSIDE the
  // 3 m sub-prompt boundary ('Open cargo') or on the 30° cone edge — so
  // the prompt is the sensor for the final approach: while it does not
  // read '[E] Enter ship', close the gap (W burst in the far zone — in
  // the cone, forward always approaches the ship; a bounded turn nudge
  // when hidden — the ship sits to the character's right: the TURN step
  // stopped turning as the ship entered the cone from the right, and no
  // later input rotates the facing) and settle again.
  await page.keyboard.down('s');
  const back = await charBack(page, start, 0.6);
  await page.keyboard.up('s');
  void back;
  await charSettled(page);
  for (let i = 0; i < 5; i++) {
    const text = await promptText();
    if (text === '[E] Enter ship') break;
    if (text === '[E] Open cargo') {
      await page.keyboard.down('w');
      await page.waitForTimeout(250);
      await page.keyboard.up('w');
    } else {
      // hidden (cone edge): alternate nudge direction — 'd' recenters in
      // the common case (ship right of facing), 'a' covers the deflected
      // facing that leaves the ship left.
      await page.keyboard.down(i % 2 === 0 ? 'd' : 'a');
      await page.waitForTimeout(150);
      await page.keyboard.up(i % 2 === 0 ? 'd' : 'a');
    }
    await charSettled(page);
  }
  await expect(prompt).toHaveText('[E] Enter ship', { timeout: 15_000 });
  await page.waitForTimeout(400); // stability: the prompt must HOLD (no
  await expect(prompt).toHaveText('[E] Enter ship'); // boundary flicker)
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-35-3.png'),
  });

  // (6) RE-ENTER: E dispatches 'enter_ship' through the registry; the
  // server removes the character and re-activates the ship → the docked
  // HUD stubs come back, the interact prompt is dead (no on-foot state),
  // and the 600 ms reverse handoff (TASK-27) ends in the cockpit.
  await page.keyboard.press('e');
  await expect(prompt).toBeHidden({ timeout: 10_000 });
  await expect(page.locator('#docked-indicator')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#leave-ship-prompt')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1_500); // the 600 ms handoff settles
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-35-4.png'),
  });

  assertClean();
  await context.close();
});
