import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { RawWsClient } from './raw-ws';

/**
 * TASK-104 — E2E: sustained touch input/fire must NEVER trip the server's
 * 20 msg/s inbound bucket (the touch-disconnect bug).
 *
 * The owner-reported bug: ANY screen touch on mobile made the server drop
 * the socket (4009 'flooded') and the TASK-17 auto-reconnect re-joined.
 * Root cause (client-only, CONFIRMED): two mobile-only paths streamed WS
 * messages at FRAME rate (60-120+ msg/s) into the per-connection token
 * bucket (MESSAGE_RATE = 20 msg/s, MESSAGE_BURST = 40). The fix (client
 * only) caps the input cadence to a pure 66 ms period (≈15.2 msg/s) and
 * paces the touch FIRE hold to one intent per 333 ms (≈3 msg/s) — worst
 * case ≈18.2 msg/s < 20.
 *
 * This spec drives a touch-emulated browser through the touchDebug dev hook
 * (the deterministic path) and asserts, over sustained legs, that NO 4009
 * close occurs, the TASK-17 'reconnecting…' indicator is NEVER visible, and
 * the measured on-the-wire rate stays under the bucket. A NET tap
 * (context.addInitScript — installed BEFORE the page's session code runs)
 * counts the client's OUTBOUND 'input'/'fire' messages by type and records
 * every WebSocket close {code, reason}.
 *
 * Legs (fresh player, uniqueCallsign('t104')):
 *  (A) FLIGHT STICK JITTER (home system at spawn, no teleport): an 8 s
 *      driver at 33 Hz flips thrust 0.5/0.6 + yaw ±0.3 — a NEW input key
 *      every 30 ms (pre-fix this streams ≈60 msg/s into the bucket).
 *      Asserts: no 4009, zero reconnect hits, ≤85 input over a 5 s mid
 *      sub-window (≤17 msg/s; post-fix ≈76), and the server STILL applies
 *      input (server speed > 5 u/s at the end). Screenshot mid-jitter.
 *  (B) FIRE HOLD + THRUST (5 s): fireHold(true) + thrust=1. Asserts: no
 *      4009, zero reconnect hits, ≤17 'fire' messages over the 5 s
 *      (post-fix = 16; pre-fix the per-frame loop fires ~300 → RED alone).
 *  (C) ON-FOOT MOVE JITTER (dock-at-pad + disembark, walk.spec.ts flow):
 *      a 5 s 33 Hz `move({thrust, yaw})` jitter. Asserts: no 4009, zero
 *      reconnect hits, ≤85 input over the 5 s window.
 *
 * RED pre-fix: legs (A)/(B) must FAIL on the unfixed client (a 4009 close
 * and/or a 'reconnecting…' DOM hit inside the window). Post-fix: green.
 */

const PROTOCOL_VERSION = 1; // mirrors @shared/protocol (Playwright cannot resolve tsconfig aliases)

interface Vec3 {
  x: number;
  y: number;
  z: number;
}
interface Tap {
  pos: Vec3;
  vel: Vec3;
  t: number;
}
interface NetTap {
  sent: { input: number; fire: number; total: number };
  closes: Array<{ code: number; reason: string }>;
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

/**
 * The combined NET + ship-update tap. Installed via addInitScript so the
 * WebSocket prototype is wrapped BEFORE the page's session code creates its
 * first socket — patching after goto would miss the first connection and
 * the pre-fix 4009 would land before the tap exists.
 */
function tapNetAndShip(callsign: string): void {
  const w = window as unknown as { __NET__?: NetTap; __t91?: Tap[] };
  w.__NET__ = { sent: { input: 0, fire: 0, total: 0 }, closes: [] };
  w.__t91 = [];
  const Orig = window.WebSocket;
  window.WebSocket = class extends Orig {
    constructor(...args: ConstructorParameters<typeof Orig>) {
      super(...args);
      const origSend = this.send.bind(this);
      // Count OUTBOUND 'input' / 'fire' messages by type.
      this.send = (data: string): void => {
        try {
          const m = JSON.parse(data) as { type?: string };
          if (w.__NET__) {
            w.__NET__.sent.total += 1;
            if (m.type === 'input') w.__NET__.sent.input += 1;
            else if (m.type === 'fire') w.__NET__.sent.fire += 1;
          }
        } catch {
          /* non-JSON sends are not counted */
        }
        origSend(data);
      };
      // Record every close (a 4009 'flooded' kick is the bug signature).
      this.addEventListener('close', (ev: CloseEvent) => {
        w.__NET__?.closes.push({ code: ev.code, reason: ev.reason });
      });
      // Tap the self ship's entity_update frames (server pos/vel).
      this.addEventListener('message', (ev: MessageEvent) => {
        try {
          const m = JSON.parse(String(ev.data)) as {
            type?: string;
            payload?: {
              entities?: Array<{
                id: string;
                kind: string;
                pos: Vec3;
                vel?: Vec3;
                callsign?: string;
              }>;
            };
          };
          if (m.type !== 'entity_update') return;
          const e = (m.payload?.entities ?? []).find(
            (t) => t.kind === 'ship' && t.callsign === callsign,
          );
          if (e)
            w.__t91?.push({
              pos: e.pos,
              vel: e.vel ?? { x: 0, y: 0, z: 0 },
              t: Date.now(),
            });
        } catch {
          /* never break the page's networking from a tap */
        }
      });
    }
  };
}

const netSent = (page: Page): Promise<NetTap['sent']> =>
  page.evaluate(() => {
    const n = (window as unknown as { __NET__?: NetTap }).__NET__;
    return n ? { ...n.sent } : { input: 0, fire: 0, total: 0 };
  });

const netCloses = (page: Page): Promise<NetTap['closes']> =>
  page.evaluate(() =>
    ((window as unknown as { __NET__?: NetTap }).__NET__?.closes ?? []).map((c) => ({ ...c })),
  );

/** The last SERVER-reported speed (u/s) of our ship. */
const lastSpeed = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const ups = (window as unknown as { __t91?: Tap[] }).__t91 ?? [];
    const u = ups[ups.length - 1];
    return u ? Math.hypot(u.vel.x, u.vel.y, u.vel.z) : -1;
  });

/** A 500 ms poll of the TASK-17 'reconnecting…' indicator; accumulates hits. */
function makeReconnectWatcher(page: Page): { hits: () => number; stop: () => void } {
  let active = true;
  let hits = 0;
  const timer = setInterval(() => {
    if (!active) return;
    page
      .locator('text=reconnecting')
      .count()
      .then((c) => {
        if (c > 0) hits += c;
      })
      .catch(() => {
        /* page closed */
      });
  }, 500);
  return {
    hits: () => hits,
    stop: () => {
      active = false;
      clearInterval(timer);
    },
  };
}

/** Dock the player's ship at the seeded pad server-side (walk.spec.ts flow). */
async function dockAtPad(
  baseURL: string,
  apiPort: number,
  session: ClaimResponse,
): Promise<PadTarget> {
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
  const EntityState = { callsign: session.callsign, padId: target.padId };
  await client.next(
    (m) =>
      m.type === 'entity_update' &&
      (
        (m.payload as { entities: Array<{ callsign?: string; regime?: string; padId?: string }> })
          .entities ?? []
      ).some(
        (e) =>
          e.callsign === EntityState.callsign &&
          e.regime === 'docked' &&
          e.padId === EntityState.padId,
      ),
    `docked entity_update for ${session.callsign}`,
    15_000,
  );
  client.close(); // the ship idles at the pad (state kept) while the browser takes over
  return target;
}

test('touch flood: sustained touch input/fire never trips the 20 msg/s bucket', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL, apiPort } = e2eServer;
  test.setTimeout(240_000);

  const callsign = uniqueCallsign('t104');
  const claimRes = await fetch(`${baseURL}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  expect(claimRes.status).toBe(201);
  const session = (await claimRes.json()) as ClaimResponse;
  console.log(`[TASK-104] player=${session.playerId} sys=${session.homeSystemId}`);

  const context = await browser.newContext({ hasTouch: true });
  // Installed BEFORE the page's session code runs (the pre-fix 4009 must be caught).
  await context.addInitScript(tapNetAndShip, session.callsign);
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  await page.goto(baseURL);
  await page.evaluate(
    (ss) => localStorage.setItem('drift.session.v1', JSON.stringify(ss)),
    session,
  );
  await page.goto(baseURL);
  await expect(page.locator('#sys-id')).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => page.evaluate(() => !!window.__SELF_SHIP__?.probe()?.screen), {
      timeout: 20_000,
      message: 'chase camera never acquired the self ship',
    })
    .toBe(true);
  expect(await page.evaluate(() => navigator.maxTouchPoints), 'touch device').toBeGreaterThan(0);
  expect(
    await page.evaluate(() => !!window.__TOUCH__?.setChannel),
    'touchDebug hook installed',
  ).toBe(true);

  const watcher = makeReconnectWatcher(page);
  const no4009 = async (what: string): Promise<void> => {
    const closes = await netCloses(page);
    const flooded = closes.filter((c) => c.code === 4009);
    expect(
      flooded,
      `${what}: a 4009 'flooded' close means the touch stream tripped the bucket: ${JSON.stringify(closes)}`,
    ).toEqual([]);
    expect(closes, `${what}: no unexpected socket close`).toEqual([]);
  };

  // ------------------------------------------------------------------
  // (A) FLIGHT STICK JITTER — 8 s at 33 Hz, a NEW input key every 30 ms.
  // ------------------------------------------------------------------
  await page.evaluate(() => {
    let i = 0;
    const id = setInterval(() => {
      const h = (window as unknown as { __TOUCH__?: { setChannel: (c: unknown) => void } })
        .__TOUCH__;
      h?.setChannel({ thrust: 0.5 + (i % 2) * 0.1, yaw: i % 2 ? 0.3 : -0.3 });
      i++;
    }, 30);
    (window as unknown as { __t104done?: boolean }).__t104done = false;
    setTimeout(() => {
      clearInterval(id);
      (window as unknown as { __t104done?: boolean }).__t104done = true;
    }, 8_000);
  });
  // 5 s mid sub-window: measure the on-the-wire input rate there.
  await page.waitForTimeout(1_500);
  const inStart = (await netSent(page)).input;
  // Mid-jitter screenshot (the touch layout over the space view).
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-104-1.png'),
  });
  await page.waitForTimeout(2_500); // t = 4.0 s
  const inEnd = (await netSent(page)).input;
  await page.waitForTimeout(1_500); // t = 5.5 s (window ends at 8 s)
  await expect
    .poll(
      () =>
        page.evaluate(() => (window as unknown as { __t104done?: boolean }).__t104done === true),
      {
        timeout: 5_000,
        message: 'the 8 s jitter driver never finished',
      },
    )
    .toBe(true);
  const inDelta = inEnd - inStart;
  console.log(`[TASK-104] leg A: input over 5 s sub-window = ${inDelta} (≤ 85 ≈ 17 msg/s)`);
  expect(
    inDelta,
    `input over a 5 s sub-window = ${inDelta} (must be ≤ 85 ≈ 17 msg/s; post-fix ≈76)`,
  ).toBeLessThanOrEqual(85);
  await expect
    .poll(() => lastSpeed(page), {
      timeout: 10_000,
      message: 'server speed never exceeded 5 u/s — input not being applied',
    })
    .toBeGreaterThan(5);
  await no4009('leg A (flight stick jitter)');
  expect(watcher.hits(), 'leg A: the reconnecting indicator must never show').toBe(0);
  await page.evaluate(() =>
    (window as unknown as { __TOUCH__?: { clear: () => void } }).__TOUCH__?.clear(),
  );

  // ------------------------------------------------------------------
  // (B) FIRE HOLD + THRUST — 5 s. Pre-fix the per-frame loop fires ~300
  //     'fire' msgs → this leg is RED on its own.
  // ------------------------------------------------------------------
  await page.evaluate(() => {
    const h = (
      window as unknown as {
        __TOUCH__?: { setChannel: (c: unknown) => void; fireHold: (on: boolean) => void };
      }
    ).__TOUCH__;
    h?.setChannel({ thrust: 1 });
    h?.fireHold(true);
  });
  const fireStart = (await netSent(page)).fire;
  await page.waitForTimeout(5_000);
  const fireEnd = (await netSent(page)).fire;
  await page.evaluate(() => {
    const h = (
      window as unknown as { __TOUCH__?: { clear: () => void; fireHold: (on: boolean) => void } }
    ).__TOUCH__;
    h?.fireHold(false);
    h?.clear();
  });
  const fireDelta = fireEnd - fireStart;
  console.log(`[TASK-104] leg B: fire intents over 5 s = ${fireDelta} (≤ 17 ≈ 3.4 msg/s)`);
  expect(
    fireDelta,
    `fire intents over 5 s = ${fireDelta} (must be ≤ 17 ≈ 3.4 msg/s; post-fix = 16)`,
  ).toBeLessThanOrEqual(17);
  await no4009('leg B (fire hold + thrust)');
  expect(watcher.hits(), 'leg B: the reconnecting indicator must never show').toBe(0);

  // ------------------------------------------------------------------
  // (C) ON-FOOT MOVE JITTER — dock at the pad + disembark, then a 5 s
  //     33 Hz `move({thrust, yaw})` jitter (the on-foot loop's flood path).
  // ------------------------------------------------------------------
  // Close the leg A/B page first so the raw dock client is the sole
  // connection for this player; a fresh page re-joins the pad system.
  await page.close();
  const target = await dockAtPad(baseURL, apiPort, session);
  console.log(`[TASK-104] leg C pad system=${target.systemId}`);

  const page2 = await context.newPage();
  const { assertClean: assertClean2 } = collectErrors(page2);
  await page2.goto(baseURL);
  await page2.evaluate(
    (ss) => localStorage.setItem('drift.session.v1', JSON.stringify(ss)),
    session,
  );
  await page2.goto(`${baseURL}/?sys=${target.systemId}`);
  await expect(page2.locator('#docked-indicator')).toBeVisible({ timeout: 15_000 });
  await page2.keyboard.press('e');
  await expect(page2.locator('#leave-ship-prompt')).toBeHidden({ timeout: 15_000 });
  await expect(page2.locator('#docked-indicator')).toBeHidden({ timeout: 15_000 });
  await page2.waitForFunction(
    () => (window as unknown as { __CHAR__?: { pos?: unknown } }).__CHAR__?.pos ?? null,
    null,
    {
      timeout: 15_000,
    },
  );

  const watcher2 = makeReconnectWatcher(page2);
  await page2.evaluate(() => {
    let i = 0;
    const id = setInterval(() => {
      const h = (window as unknown as { __TOUCH__?: { move: (c: unknown) => void } }).__TOUCH__;
      h?.move({ thrust: 0.5 + (i % 2) * 0.2, yaw: i % 2 ? 0.4 : -0.4 });
      i++;
    }, 30);
    setTimeout(() => clearInterval(id), 5_000);
  });
  const cinStart = (await netSent(page2)).input;
  await page2.waitForTimeout(5_000);
  const cinEnd = (await netSent(page2)).input;
  const cinDelta = cinEnd - cinStart;
  console.log(`[TASK-104] leg C: on-foot input over 5 s = ${cinDelta} (≤ 85 ≈ 17 msg/s)`);
  expect(
    cinDelta,
    `on-foot input over 5 s = ${cinDelta} (must be ≤ 85 ≈ 17 msg/s)`,
  ).toBeLessThanOrEqual(85);
  const closes2 = await netCloses(page2);
  const flooded2 = closes2.filter((c) => c.code === 4009);
  expect(
    flooded2,
    `leg C (on-foot jitter): a 4009 'flooded' close means the touch stream tripped the bucket: ${JSON.stringify(closes2)}`,
  ).toEqual([]);
  expect(closes2, 'leg C: no unexpected socket close').toEqual([]);
  expect(watcher2.hits(), 'leg C: the reconnecting indicator must never show').toBe(0);
  watcher2.stop();

  watcher.stop();
  assertClean();
  assertClean2();
  await context.close();
});
