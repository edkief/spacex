import path from 'node:path';
import WebSocket from 'ws';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';

/**
 * TASK-97 — E2E: touch for a PAD-DOCKED ship + the Off-lockout MENU.
 *
 * The owner-reported bug: on a touch device the overlay appears for ~1 s
 * (the client regime starts 'space' on load), then the first server
 * snapshot flips the wire regime to 'surface' for the pad-docked ship and
 * TouchControls unmounted the WHOLE overlay — no sticks, no VTOL, no MENU.
 * A touch-only player was stranded on the pad. This spec is the regression:
 *
 * Setup mirrors touch-onfoot.spec.ts: claim → pad target → raw WS dock
 * (dockAtPad) → the TOUCH-EMULATED browser (hasTouch → maxTouchPoints > 0)
 * takes over the same token. The ship taps + channel drives reuse the
 * touch-flight.spec.ts __t91 / __TOUCH__ helpers (the deterministic path).
 *
 *  (a) LAYOUT while pad-docked: #touch-controls + BOTH flight sticks + the
 *      VTOL button (the atmosphere scheme — dockedFlightScheme('surface')),
 *      NO BOOST, MENU visible. [Pre-fix: the overlay was gone here.]
 *  (b) TAKE-OFF BY TOUCH: setChannel({thrust: 1, vtol: 1}) → within ~3 s
 *      the SERVER wire regime leaves 'docked' and the ship's position
 *      changes (entity_update frames); the #docked-indicator clears.
 *  (c) MENU while pad-docked: the __TOUCH__.openMenu() passthrough (the
 *      SAME shared open/pop the Esc key calls — the touch-menu.spec.ts:99
 *      pattern) opens #esc-menu.
 *  (d) OFF-LOCKOUT: touch → ESC → SETTINGS → TOUCH CONTROLS = OFF (the
 *      exact touch path a stranded player needs) → a lone #touch-btn-menu
 *      is STILL rendered while #touch-stick-left is absent, the server row
 *      round-trips 'off', and openMenu() still opens #esc-menu. (The
 *      non-touch desktop Off → count-0 case is covered by
 *      touch-menu.spec.ts test 2 — not duplicated here.)
 *
 * The e2eServer fixture boots the real dev server (NODE_ENV=development →
 * the DEV-only __TOUCH__ hook exists); never run alongside npm run dev.
 */

const PROTOCOL_VERSION = 1; // mirrors @shared/protocol (Playwright does not resolve tsconfig aliases)

interface Envelope {
  v: number;
  type: string;
  payload: unknown;
}

/** Minimal raw WS client (mirrors touch-onfoot.spec.ts / walk.spec.ts). */
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

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface Tap {
  pos: Vec3;
  vel: Vec3;
  regime: string;
  flightRegime: string;
  t: number;
}

interface TouchHook {
  channels: Record<string, unknown>;
  setChannel: (c: Record<string, unknown>) => void;
  clear: () => void;
  openMenu: () => void;
}

/** Tap the self ship's entity_update frames (pos + regimes, touch-flight __t91). */
function tapShipUpdates(callsign: string): void {
  const w = window as unknown as { __t97?: Tap[] };
  w.__t97 = [];
  const Orig = window.WebSocket;
  window.WebSocket = class extends Orig {
    constructor(...args: ConstructorParameters<typeof Orig>) {
      super(...args);
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
                regime?: string;
                flightRegime?: string;
                callsign?: string;
              }>;
            };
          };
          if (m.type !== 'entity_update') return;
          const e = (m.payload?.entities ?? []).find(
            (t) => t.kind === 'ship' && t.callsign === callsign,
          );
          if (e)
            w.__t97?.push({
              pos: e.pos,
              vel: e.vel ?? { x: 0, y: 0, z: 0 },
              regime: e.regime ?? 'sublight',
              flightRegime: e.flightRegime ?? 'space',
              t: Date.now(),
            });
        } catch {
          /* never break the page's networking from a tap */
        }
      });
    }
  };
}

/** Drive a touch channel through the dev hook (the deterministic path). */
const setChannel = (page: Page, c: Record<string, unknown>): Promise<boolean> =>
  page.evaluate((ch) => {
    const hook = (window as unknown as { __TOUCH__?: TouchHook }).__TOUCH__;
    if (!hook) return false;
    hook.setChannel(ch);
    return true;
  }, c);

/** The last SERVER-reported (pos, regimes) tap — null until the first update. */
const lastState = (page: Page): Promise<Tap | null> =>
  page.evaluate(() => {
    const ups = (window as unknown as { __t97?: Tap[] }).__t97 ?? [];
    return ups[ups.length - 1] ?? null;
  });

/** Dock the player's ship at the seeded pad server-side (touch-onfoot flow). */
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
        (m.payload as { entities: Array<{ callsign?: string; regime?: string; padId?: string }> })
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

test('pad-docked ship: flight touch layout + touch take-off + Off-lockout MENU', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL, apiPort } = e2eServer;
  test.setTimeout(180_000);
  const callsign = uniqueCallsign('t97');

  const claimRes = await fetch(`${baseURL}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  expect(claimRes.status).toBe(201);
  const session = (await claimRes.json()) as ClaimResponse;
  const target = await dockAtPad(baseURL, apiPort, session);
  console.log(`[TASK-97] callsign=${session.callsign} padSystem=${target.systemId}`);

  // The TOUCH-EMULATED browser (hasTouch → maxTouchPoints > 0 → the gate
  // opens and the layout renders).
  const context = await browser.newContext({ hasTouch: true });
  await context.addInitScript(tapShipUpdates, session.callsign);
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  await page.goto(baseURL);
  await page.evaluate((s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)), session);
  await page.goto(`${baseURL}/?sys=${target.systemId}`);
  await expect(page.locator('#docked-indicator')).toBeVisible({ timeout: 15_000 });

  expect(await page.evaluate(() => navigator.maxTouchPoints), 'touch device').toBeGreaterThan(0);
  expect(
    await page.evaluate(() => !!window.__TOUCH__?.setChannel),
    'touchDebug hook installed',
  ).toBe(true);

  // (a) LAYOUT while PAD-DOCKED: the wire regime is 'surface' and the
  //     player is IN the ship → the FLIGHT layout must be UP (the pre-fix
  //     failure: the regime flip unmounted the whole overlay, no MENU).
  const dockedTap = (await lastState(page))!;
  expect(dockedTap.regime, 'wire-docked at the pad').toBe('docked');
  await expect(page.locator('#touch-controls')).toBeVisible();
  await expect(page.locator('#touch-stick-left')).toBeVisible();
  await expect(page.locator('#touch-stick-right')).toBeVisible();
  await expect(page.locator('#touch-btn-vtol')).toContainText('VTOL');
  expect(await page.locator('#touch-btn-boost').count(), 'no BOOST button pad-docked').toBe(0);
  await expect(page.locator('#touch-btn-menu')).toContainText('MENU');

  // The visual artifact: the flight touch layout over the pad-docked ship.
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-97-1.png'),
  });

  // (b) TAKE-OFF BY TOUCH: thrust + VTOL (the ' ' lift — the 1.35·g margin,
  //     TASK-86) → within ~3 s the SERVER wire regime leaves 'docked' and
  //     the ship moves (the entity_update frames prove it server-side).
  expect(await setChannel(page, { thrust: 1, vtol: 1 }), 'thrust+vtol channels set').toBe(true);
  const t0 = Date.now();
  await expect
    .poll(() => lastState(page).then((u) => (u && u.regime !== 'docked' ? u.regime : 'docked')), {
      timeout: 10_000,
      message: 'server wire regime never left "docked" after touch thrust+VTOL',
    })
    .not.toBe('docked');
  const takeoffMs = Date.now() - t0;
  await expect
    .poll(
      () =>
        lastState(page).then((u) =>
          u
            ? Math.hypot(
                u.pos.x - dockedTap.pos.x,
                u.pos.y - dockedTap.pos.y,
                u.pos.z - dockedTap.pos.z,
              )
            : 0,
        ),
      { timeout: 10_000, message: 'ship position never changed after touch take-off' },
    )
    .toBeGreaterThanOrEqual(5);
  const lifted = (await lastState(page))!;
  await expect(page.locator('#docked-indicator')).toBeHidden();
  expect(lifted.flightRegime, `wire flight regime after take-off (${takeoffMs} ms)`).not.toBe(
    'docked',
  );
  console.log(
    `[TASK-97] take-off in ${Math.round(takeoffMs)} ms: regime=${lifted.regime}/${lifted.flightRegime} ` +
      `lifted ${Math.hypot(lifted.pos.x - dockedTap.pos.x, lifted.pos.y - dockedTap.pos.y, lifted.pos.z - dockedTap.pos.z).toFixed(1)} u`,
  );
  expect(await setChannel(page, { thrust: 0, vtol: 0 }), 'channels released').toBe(true);

  // (c) MENU while pad-docked / just lifted: the SAME shared open/pop the
  //     Esc key calls (the touch-menu.spec.ts:99 passthrough) opens the
  //     ESC menu — a touch-only player is no longer stranded.
  await page.evaluate(() => (window as unknown as { __TOUCH__: TouchHook }).__TOUCH__.openMenu());
  await expect(page.locator('#esc-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#esc-menu')).toBeHidden({ timeout: 5_000 });

  // (d) OFF-LOCKOUT: touch → ESC → SETTINGS → TOUCH CONTROLS = OFF (the
  //     exact path a stranded player walks). A lone MENU button must stay
  //     rendered (the re-enable path), the sticks must be gone, and the
  //     server row must round-trip 'off'.
  await page.keyboard.press('Escape');
  await expect(page.locator('#esc-menu')).toBeVisible();
  await page.locator('#esc-menu-settings').click();
  await expect(page.locator('#settings-panel')).toBeVisible();
  await page.locator('#settings-controls-off').click();
  const getTouch = async (): Promise<string> => {
    const res = await fetch(`${baseURL}/api/players/settings`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { touchControls: string }).touchControls;
  };
  await expect.poll(getTouch, { timeout: 5_000, message: 'settings PUT round trip' }).toBe('off');

  // The lone MENU: the overlay container stays up, the sticks are gone.
  await expect(page.locator('#touch-controls')).toBeVisible();
  await expect(page.locator('#touch-btn-menu')).toBeVisible();
  expect(await page.locator('#touch-stick-left').count(), 'no sticks while Off').toBe(0);
  expect(await page.locator('#touch-stick-right').count(), 'no sticks while Off').toBe(0);

  // The visual artifact: the lone MENU button in the Off state.
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-97-2.png'),
  });

  // And the lone MENU still opens the ESC menu (the re-enable path works):
  // close the menu first (the action is the SAME open/pop as Esc — an
  // open stack pops, a closed one opens), then drive the lone button.
  await page.keyboard.press('Escape');
  await expect(page.locator('#esc-menu')).toBeHidden({ timeout: 5_000 });
  await page.evaluate(() => (window as unknown as { __TOUCH__: TouchHook }).__TOUCH__.openMenu());
  await expect(page.locator('#esc-menu')).toBeVisible();

  console.log(`[TASK-97] off-lockout: lone MENU rendered, #esc-menu reachable, row=off`);

  assertClean();
  await context.close();
});
