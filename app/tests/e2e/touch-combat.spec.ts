import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { ClaimPage } from './pages/claim';
import { RawWsClient } from './raw-ws';

/**
 * TASK-92 — E2E: combat by touch fires through the IDENTICAL server pipeline
 * as the keyboard (PRD §4.13, SC-6).
 *
 * Two clients, like pvp-kill.spec.ts: A (the touch-emulated shooter) and B
 * (the victim). B warps into A's system via raw WS, both ships dev-teleport
 * to the 60 km space anchor 60 m apart (the proven pvp-kill geometry — no
 * terrain, clear LOS), then B's browser joins.
 *
 * A drives the combat half of the touch layout (all through the touchDebug
 * dev hook — functions can't cross the page boundary, so every drive is a
 * page.evaluate over window.__TOUCH__, the TASK-91 pattern):
 *  (1) LAYOUT: FIRE / LASER / MISSILE / TARGET visible in space; the
 *      touchDebug hook is installed with the combat passthrough.
 *  (2) FIRE via touchDebug.fire(): B's shields DROP (the same shield-drop
 *      tap weapons.spec.ts / pvp-kill.spec.ts rely on) — proving the touch
 *      fire went through the identical server pipeline (intent only; the
 *      server re-derives range/cooldown/aim). B (the witness client) also
 *      counts the laser-fired FX event in window.__FX__ — the C-clause.
 *  (3) FIRE via a REAL tap on the FIRE button: the shields drop again —
 *      the button is wired to the SAME fireWeapon path.
 *  (4) WEAPON SELECT: the touchDebug setter + the missile button's pressed
 *      accent change the active weapon (the shared '1'/'2' path).
 *  (5) TARGET: the TARGET button toggles the lock (the shared 'T' path) —
 *      the target card + touchDebug snapshot appear, then go away.
 *      Screenshot with the target card up.
 *
 * The e2eServer fixture boots the real dev server (NODE_ENV=development →
 * the DEV-only __TOUCH__ / __FX__ hooks exist); never run alongside npm run dev.
 */

const PROTOCOL_VERSION = 1; // mirrors @shared/protocol (Playwright does not resolve tsconfig aliases)

interface Session {
  token: string;
  callsign: string;
  homeSystemId: string;
}
interface ShieldTap {
  shields: number;
  hull: number;
  t: number;
}
interface TouchHook {
  fire: () => void;
  setWeapon: (w: string) => void;
  toggleTarget: () => void;
  state: { weapon: string; locked: boolean } | null;
}

/** Tap the self ship's entity_update frames (shields normalized 0..1). */
function tapShipShields(callsign: string): void {
  const w = window as unknown as { __t92?: ShieldTap[] };
  w.__t92 = [];
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
                callsign?: string;
                shields?: number;
                hull?: number;
              }>;
            };
          };
          if (m.type !== 'entity_update') return;
          const e = (m.payload?.entities ?? []).find(
            (t) => t.kind === 'ship' && t.callsign === callsign,
          );
          if (e) w.__t92?.push({ shields: e.shields ?? 1, hull: e.hull ?? 1, t: Date.now() });
        } catch {
          /* never break the page's networking from a tap */
        }
      });
    }
  };
}

/** The last SERVER-reported shields of our ship (normalized 0..1). */
const lastShields = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const ups = (window as unknown as { __t92?: ShieldTap[] }).__t92 ?? [];
    return ups.length > 0 ? ups[ups.length - 1].shields : -1;
  });

/**
 * Drive ONE action on the touchDebug hook INSIDE the page (functions cannot
 * cross the Playwright serialization boundary — the hook is a live page
 * object, not something to hand back). 'state' returns the { weapon, locked }
 * snapshot.
 */
type TouchAction = 'fire' | 'setWeapon' | 'toggleTarget' | 'state';
const touch = (page: Page, action: TouchAction, arg?: string): Promise<unknown> =>
  page.evaluate(
    ([a, w]) => {
      const hook = (window as unknown as { __TOUCH__?: TouchHook }).__TOUCH__;
      if (!hook) throw new Error('no __TOUCH__ hook');
      switch (a as TouchAction) {
        case 'fire':
          hook.fire();
          return null;
        case 'setWeapon':
          hook.setWeapon(w as string);
          return null;
        case 'toggleTarget':
          hook.toggleTarget();
          return null;
        case 'state':
          return hook.state;
      }
    },
    [action, arg] as [TouchAction, string | undefined],
  );

/** Raw REST claim (the shape the browser claim flow stores). */
async function claim(baseURL: string, callsign: string): Promise<Session> {
  const res = await fetch(`${baseURL}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Session;
}

/** Warp the caller's ship into `targetSystemId` via raw WS (pvp-kill pattern). */
async function warpShip(apiPort: number, session: Session, targetSystemId: string): Promise<void> {
  const client = new RawWsClient(`ws://127.0.0.1:${apiPort}/ws`);
  await client.open();
  const send = (type: string, payload: unknown): void =>
    client.send({ v: PROTOCOL_VERSION, type, payload });
  send('hello', { v: PROTOCOL_VERSION });
  send('auth', { token: session.token });
  send('join_system', { systemId: session.homeSystemId });
  await client.next((m) => m.type === 'enter_system', 'enter_system (home)');
  if (targetSystemId !== session.homeSystemId) {
    send('warp', { destinationSystemId: targetSystemId });
    await client.next(
      (m) =>
        m.type === 'warp_arrived' &&
        (m.payload as { systemId: string }).systemId === targetSystemId,
      `warp_arrived (${targetSystemId})`,
      10_000,
    );
  }
  client.close();
}

/** The dev-teleport assist (shard.teleportForTesting — e2e-only surface). */
async function teleport(
  baseURL: string,
  token: string,
  to: { x: number; y: number; z: number },
): Promise<void> {
  const res = await fetch(`${baseURL}/api/dev/teleport`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(to),
  });
  expect(res.status).toBe(200);
}

test('touch combat: fire / weapon select / target lock (server-confirmed)', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL, apiPort } = e2eServer;
  test.setTimeout(180_000);

  // (1) A claims in the BROWSER with a TOUCH-EMULATED context (hasTouch →
  //     maxTouchPoints > 0 → the combat cluster renders); B claims raw REST
  //     and warps into A's system (the pvp-kill order).
  const aCallsign = uniqueCallsign('t92-a');
  const bCallsign = uniqueCallsign('t92-b');
  const contextA = await browser.newContext({ hasTouch: true });
  const pageA = await contextA.newPage();
  const { assertClean: assertCleanA } = collectErrors(pageA);
  const claimA = new ClaimPage(pageA, baseURL);
  await claimA.claim(aCallsign);
  const sysId = await claimA.systemId();
  const sessionA = await pageA.evaluate(() => {
    const raw = localStorage.getItem('drift.session.v1');
    if (!raw) throw new Error('no session in localStorage');
    return JSON.parse(raw) as Session;
  });

  const b = await claim(baseURL, bCallsign);
  console.log(`[TASK-92] A=${aCallsign} B=${bCallsign} system=${sysId} Bhome=${b.homeSystemId}`);
  await warpShip(apiPort, b, sysId);

  // (2) Deep space, 60 m apart on +x (the pvp-kill anchor — no terrain, no
  //     LOS obstruction). Then B's browser joins A's system with the SAME
  //     token, tapping B's shields from the 10 Hz entity feed.
  await teleport(baseURL, sessionA.token, { x: 60_000, y: 60_000, z: 0 });
  await teleport(baseURL, b.token, { x: 60_060, y: 60_000, z: 0 });

  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  const { assertClean: assertCleanB } = collectErrors(pageB);
  await pageB.addInitScript(tapShipShields, bCallsign);
  await pageB.goto(baseURL);
  await pageB.evaluate((s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)), b);
  await pageB.goto(`${baseURL}/?sys=${sysId}`);
  await expect(pageB.locator('#sys-id')).toBeVisible({ timeout: 20_000 });

  // A's aim assist needs B in its remote-ship list (10 Hz batches).
  await pageA.waitForTimeout(1_500);

  // (3) LAYOUT: the touch device opens the gate; the combat cluster is up.
  expect(await pageA.evaluate(() => navigator.maxTouchPoints), 'touch device').toBeGreaterThan(0);
  expect(await touch(pageA, 'state'), 'touchDebug combat snapshot').not.toBeNull();
  await expect(pageA.locator('#touch-controls')).toBeVisible();
  await expect(pageA.locator('#touch-btn-fire')).toContainText('FIRE');
  await expect(pageA.locator('#touch-btn-weapon-laser')).toContainText('LASER');
  await expect(pageA.locator('#touch-btn-weapon-missile')).toContainText('MISSILE');
  await expect(pageA.locator('#touch-btn-target')).toContainText('TARGET');

  // (4) WEAPON SELECT (the shared '1'/'2' path): laser is active to start.
  expect(await touch(pageA, 'state'), 'combat snapshot present').toEqual({
    weapon: 'laser',
    locked: false,
  });
  await touch(pageA, 'setWeapon', 'missile');
  expect(((await touch(pageA, 'state')) as { weapon: string }).weapon).toBe('missile');
  // The buttons mirror the active weapon (the pressed accent).
  await expect(pageA.locator('#touch-btn-weapon-missile div[role="button"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(pageA.locator('#touch-btn-weapon-laser div[role="button"]')).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  // Back to the laser (the scout's only weapon) for the firing legs.
  await touch(pageA, 'setWeapon', 'laser');
  expect(((await touch(pageA, 'state')) as { weapon: string }).weapon).toBe('laser');
  await expect(pageA.locator('#weapon-hud')).toContainText('LASER');

  // (5) B's shield baseline: the full scout shield (normalized 1.0).
  await expect
    .poll(() => lastShields(pageB), {
      timeout: 15_000,
      message: 'no B shield tap from the 10 Hz feed',
    })
    .toBeGreaterThanOrEqual(0.99);
  const baseline = await lastShields(pageB);

  // (6) FIRE via the touchDebug passthrough: B's shields must DROP — the
  //     touch fire went through the identical server pipeline.
  await touch(pageA, 'fire');
  await expect
    .poll(() => lastShields(pageB), {
      timeout: 15_000,
      message: 'B shields never dropped after touchDebug.fire() (touch fire pipeline)',
    })
    .toBeLessThan(baseline);
  const afterHookFire = await lastShields(pageB);

  // The WITNESS client (B) sees the FX event for the shot (the C-clause:
  // window.__FX__ counts only SERVER combat_event frames).
  await expect
    .poll(
      () =>
        pageB.evaluate(
          () =>
            (window as unknown as { __FX__?: { laserFlashes: number } }).__FX__?.laserFlashes ?? 0,
        ),
      { timeout: 10_000, message: 'B never saw the laser-fired FX event (witness)' },
    )
    .toBeGreaterThanOrEqual(1);

  // (7) FIRE via a REAL tap on the FIRE button: the SAME fireWeapon path,
  //     one-shot per press — the shields drop again.
  await pageA.locator('#touch-btn-fire').tap();
  await expect
    .poll(() => lastShields(pageB), {
      timeout: 15_000,
      message: 'B shields never dropped after a real tap on the FIRE button',
    })
    .toBeLessThan(afterHookFire);

  // (8) TARGET: spawn the dev dummy 200 m dead ahead (the targeting.spec
  //     pattern — inside the 500 m / 30° cone by construction) and toggle
  //     the lock through the TARGET button (the shared 'T' path). A
  //     no-pick press sends nothing, so the retry loop is safe.
  const dummyRes = await fetch(`${baseURL}/api/dev/dummy-target`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionA.token}` },
    body: JSON.stringify({ distance: 200 }),
  });
  expect(dummyRes.status).toBe(200);
  const box = pageA.locator('#target-box');
  let locked = false;
  for (let i = 0; i < 10 && !locked; i++) {
    await touch(pageA, 'toggleTarget');
    locked = await box
      .waitFor({ state: 'visible', timeout: 1_500 })
      .then(() => true)
      .catch(() => false);
  }
  expect(locked, 'TARGET button locked the dummy').toBe(true);
  expect(((await touch(pageA, 'state')) as { locked: boolean }).locked).toBe(true);

  // The target card + the combat touch layout (the screenshot evidence).
  await pageA.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-92-1.png'),
  });

  // Toggle back: the card goes away and the snapshot clears.
  await touch(pageA, 'toggleTarget');
  await expect(box).toBeHidden({ timeout: 3_000 });
  expect(((await touch(pageA, 'state')) as { locked: boolean }).locked).toBe(false);

  console.log(
    `[TASK-92] callsign=${aCallsign} baseline=${baseline.toFixed(2)} ` +
      `afterHookFire=${afterHookFire.toFixed(2)} (both drops server-confirmed)`,
  );

  assertCleanA();
  assertCleanB();
  await contextA.close();
  await contextB.close();
});
