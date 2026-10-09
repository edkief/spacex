import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { systemForId } from '../../src/shared/galaxy/system';
import { planetAnchor } from '../../src/shared/galaxy/planets';

/**
 * TASK-91 — E2E: fly by touch (space + atmosphere), server-confirmed.
 *
 * The FIRST real gameplay wiring of the touch feature: a touch-emulated
 * browser (hasTouch → maxTouchPoints > 0 → the layout renders), the
 * TouchControls overlay up in the flight regimes, and the channels driven
 * through the touchDebug dev hook (window.__TOUCH__.setChannel — the
 * deterministic path; synthetic pointer-capture gestures are flaky in
 * headless). The ship loop itself is untouched (TASK-89's merged virtual-key
 * set is what flies the ship) — this proves touch → channels → virtual keys
 * → merged set → readSchemeInput → wire 'input' → server → state.
 *
 * Legs (fresh player, like cruise.spec.ts / flight.spec.ts):
 *  (1) SPACE: thrust=+1 for ~3 s → the SERVER-reported speed rises from
 *      rest; +boost (the BOOST button's channel) cruises past 300 u/s;
 *      release → the soft cap bleeds the speed back to ≤ 121 (decay).
 *  (2) SPACE: yaw=+1 for ~2 s → the nose turns toward the ship's RIGHT
 *      (dot(forward, initial right) > 0.2 — the TASK-80 convention, the
 *      same probe math as controls-direction.spec.ts).
 *  (3) ATMOSPHERE (teleport inside a home-system planet's band, the
 *      planet-approach pattern): vtol=+1 → the SERVER reports a positive
 *      vertical velocity / altitude gain.
 *  (4) Layout: both sticks present in both regimes; the BOOST button is
 *      visible in space and the VTOL button in atmosphere (asserted on the
 *      rendered labels). Screenshot of the layout over the space view.
 */

const SEED = 'DRIFT-SEED-0001';
/** Deep space, spawn side: > 2.5 km from every planet (cruise.spec's point). */
const DEEP_SPACE = { x: 0, y: 50, z: 4_000 };

interface Vec3 {
  x: number;
  y: number;
  z: number;
}
interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}
interface Tap {
  pos: Vec3;
  vel: Vec3;
  flightRegime: string;
  t: number;
}
interface ClaimResponse {
  token: string;
  playerId: string;
  callsign: string;
  homeSystemId: string;
  shipId: string;
}
interface TouchHook {
  channels: Record<string, unknown>;
  setChannel: (c: Record<string, unknown>) => void;
  clear: () => void;
}

/** Tap the self ship's entity_update frames (pos + vel + wire regime). */
function tapShipUpdates(callsign: string): void {
  const w = window as unknown as { __t91?: Tap[] };
  w.__t91 = [];
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
            w.__t91?.push({
              pos: e.pos,
              vel: e.vel ?? { x: 0, y: 0, z: 0 },
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

/** The last SERVER-reported speed (u/s) of our ship. */
const lastSpeed = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const ups = (window as unknown as { __t91?: Tap[] }).__t91 ?? [];
    const u = ups[ups.length - 1];
    return u ? Math.hypot(u.vel.x, u.vel.y, u.vel.z) : -1;
  });

/** The last SERVER-reported (pos, vel) — null until the first update. */
const lastState = (page: Page): Promise<Tap | null> =>
  page.evaluate(() => {
    const ups = (window as unknown as { __t91?: Tap[] }).__t91 ?? [];
    return ups[ups.length - 1] ?? null;
  });

/** The signed dot of the ship's CURRENT forward with the INITIAL right. */
const dotForwardRight0 = (page: Page, right0: Vec3): Promise<number> =>
  page.evaluate((r0: Vec3) => {
    const p = window.__SELF_SHIP__?.probe();
    if (!p?.pos || !p.rot) return Number.NaN;
    const { x, y, z, w } = p.rot;
    const fwd = { x: 2 * (x * z + w * y), y: 2 * (y * z - w * x), z: 1 - 2 * (x * x + y * y) };
    return fwd.x * r0.x + fwd.y * r0.y + fwd.z * r0.z;
  }, right0);

/** Rotate (−1,0,0) by the quat — the ship's RIGHT (the TASK-80 probe math). */
function initialRight(rot: Quat): Vec3 {
  const { x, y, z, w } = rot;
  const v = { x: -1, y: 0, z: 0 };
  const cx = y * v.z - z * v.y;
  const cy = z * v.x - x * v.z;
  const cz = x * v.y - y * v.x;
  return {
    x: v.x + w * (2 * cx) + (y * (2 * cz) - z * (2 * cy)),
    y: v.y + w * (2 * cy) + (z * (2 * cx) - x * (2 * cz)),
    z: v.z + w * (2 * cz) + (x * (2 * cy) - y * (2 * cx)),
  };
}

async function teleport(page: Page, baseURL: string, token: string, to: Vec3): Promise<void> {
  const res = await page.request.post(`${baseURL}/api/dev/teleport`, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    data: to,
  });
  expect(res.status(), `teleport response: ${await res.text()}`).toBe(200);
  await expect
    .poll(
      () =>
        page.evaluate((t: Vec3) => {
          const p = window.__SELF_SHIP__?.probe()?.pos;
          return p ? Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z) : 1e9;
        }, to),
      { timeout: 20_000, message: `rendered ship never reached ${JSON.stringify(to)}` },
    )
    .toBeLessThan(50);
}

test('touch flight: thrust + yaw in space, VTOL in atmosphere (server-confirmed)', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL } = e2eServer;
  test.setTimeout(150_000);

  // (a) Claim a fresh player whose home system has a landable ATMOSPHERIC
  // planet (the VTOL leg). The home system derives from the player UUID
  // (~91% of seeded systems have one), so claim a few cheap REST-only
  // players and keep the first atmospheric-home one.
  let session: ClaimResponse | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    const cs = attempt === 0 ? uniqueCallsign('t91') : uniqueCallsign('t91b');
    const claimRes = await fetch(`${baseURL}/api/callsigns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callsign: cs }),
    });
    expect(claimRes.status).toBe(201);
    const cand = (await claimRes.json()) as ClaimResponse;
    const hasAtmo =
      systemForId(SEED, cand.homeSystemId)?.planets.some((p) => p.landable && p.hasAtmosphere) ??
      false;
    if (attempt === 0 || hasAtmo) {
      session = cand;
      break;
    }
  }
  const s = session!;
  expect(s, 'claimed a player').toBeTruthy();
  const system = systemForId(SEED, s.homeSystemId);
  expect(system, 'home system exists').toBeTruthy();
  const atmoIdx = system!.planets.findIndex((p) => p.landable && p.hasAtmosphere);
  expect(atmoIdx, 'home system has a landable atmospheric planet').toBeGreaterThanOrEqual(0);
  const anchor = { ...planetAnchor(atmoIdx), y: 0 };
  console.log(
    `[TASK-91] player=${s.playerId} sys=${s.homeSystemId} atmo-planet idx=${atmoIdx} anchor=${JSON.stringify(anchor)}`,
  );

  // (b) The touch-emulated browser (hasTouch → maxTouchPoints > 0 → the
  // enablement gate opens and the layout renders).
  const context = await browser.newContext({ hasTouch: true });
  await context.addInitScript(tapShipUpdates, s.callsign);
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  await page.goto(baseURL);
  await page.evaluate((ss) => localStorage.setItem('drift.session.v1', JSON.stringify(ss)), s);
  await page.goto(baseURL);
  await expect(page.locator('#sys-id')).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => page.evaluate(() => !!window.__SELF_SHIP__?.probe()?.screen), {
      timeout: 20_000,
      message: 'chase camera never acquired the self ship',
    })
    .toBe(true);

  // The touch device is what opens the gate — assert the premise.
  expect(await page.evaluate(() => navigator.maxTouchPoints), 'touch device').toBeGreaterThan(0);
  // The dev hook is installed (DEV build) and reports the empty channels.
  expect(
    await page.evaluate(() => !!window.__TOUCH__?.setChannel),
    'touchDebug hook installed',
  ).toBe(true);

  // (1) LAYOUT, space: dual sticks + the BOOST button, no VTOL.
  await expect(page.locator('#touch-controls')).toBeVisible();
  await expect(page.locator('#touch-stick-left')).toBeVisible();
  await expect(page.locator('#touch-stick-right')).toBeVisible();
  await expect(page.locator('#touch-btn-boost')).toContainText('BOOST');
  expect(await page.locator('#touch-btn-vtol').count(), 'no VTOL button in space').toBe(0);

  // (2) THRUST: channel up from rest → the server speed rises (the first
  // input also takes the docked ship off).
  expect(await setChannel(page, { thrust: 1 }), 'thrust channel set').toBe(true);
  await expect
    .poll(() => lastState(page).then((u) => u?.flightRegime ?? 'none'), {
      timeout: 15_000,
      message: 'server never reported a non-docked regime after touch thrust',
    })
    .not.toBe('docked');
  await expect
    .poll(() => lastSpeed(page), {
      timeout: 15_000,
      message: 'server speed never rose above 0 with thrust=+1 (touch)',
    })
    .toBeGreaterThan(0);
  const s1 = await lastSpeed(page);
  await page.waitForTimeout(2_000);
  const s2 = await lastSpeed(page);
  expect(
    s2,
    `speed not rising under sustained touch thrust (t0=${s1.toFixed(1)}, +2 s=${s2.toFixed(1)}`,
  ).toBeGreaterThan(s1);
  // The visual artifact: the flight touch layout over the space view.
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-91-1.png'),
  });
  expect(await setChannel(page, { thrust: 0 }), 'thrust released').toBe(true);

  // (3) BOOST (the BOOST button's channel): teleport DEEP SPACE (the cruise
  // clearance band needs > 2.5 km from every planet), cruise past the 120
  // u/s cap, then release everything → the soft cap bleeds the excess back
  // down (the "speed decays" half of the spec).
  await teleport(page, baseURL, s.token, DEEP_SPACE);
  expect(await setChannel(page, { thrust: 1, boost: 1 }), 'thrust+boost channels set').toBe(true);
  await expect
    .poll(() => lastSpeed(page), {
      timeout: 20_000,
      message: 'server speed never exceeded 300 with thrust+boost (touch cruise)',
    })
    .toBeGreaterThan(300);
  const topSpeed = await lastSpeed(page);
  expect(await setChannel(page, { thrust: 0, boost: 0 }), 'channels released').toBe(true);
  await expect
    .poll(() => lastSpeed(page), {
      timeout: 20_000,
      message: 'server speed never decayed to ≤ 121 after releasing touch thrust+boost',
    })
    .toBeLessThanOrEqual(121);

  // (4) YAW: the nose must turn toward the ship's RIGHT (TASK-80 convention,
  // probe math from controls-direction.spec.ts). 2 s × 0.8 rad/s = 1.6 rad.
  const probe0 = await page.evaluate(() => window.__SELF_SHIP__!.probe()!);
  const right0 = initialRight(probe0.rot as Quat);
  expect(await setChannel(page, { yaw: 1 }), 'yaw channel set').toBe(true);
  await page.waitForTimeout(2_000);
  expect(await setChannel(page, { yaw: 0 }), 'yaw channel released').toBe(true);
  const dotD = await dotForwardRight0(page, right0);
  expect(
    dotD,
    `yaw=+1 for 2 s: dot(forward, initial right) = ${dotD.toFixed(3)} (must be > 0.2 — turns right)`,
  ).toBeGreaterThan(0.2);

  // (5) ATMOSPHERE: teleport inside the home planet's band (the
  // planet-approach pattern) and let the wire regime settle there.
  const atmoPos = { x: anchor.x + 700, y: 400, z: anchor.z };
  await teleport(page, baseURL, s.token, atmoPos);
  await expect
    .poll(() => lastState(page).then((u) => u?.flightRegime ?? 'none'), {
      timeout: 20_000,
      message: 'server regime never reached atmosphere after the teleport',
    })
    .toBe('atmosphere');
  // The regime-gated button follows: VTOL visible, BOOST gone.
  await expect(page.locator('#touch-btn-vtol')).toContainText('VTOL');
  expect(await page.locator('#touch-btn-boost').count(), 'no BOOST button in atmosphere').toBe(0);

  // (6) VTOL: the lift must beat gravity (TASK-86's 1.35× margin) — the
  // server reports a positive vertical velocity / an altitude gain.
  const before = (await lastState(page))!;
  expect(await setChannel(page, { vtol: 1 }), 'vtol channel set').toBe(true);
  await expect
    .poll(() => lastState(page).then((u) => u?.vel.y ?? 0), {
      timeout: 15_000,
      message: 'server vel.y never went positive with vtol=+1 in atmosphere',
    })
    .toBeGreaterThan(2);
  await expect
    .poll(() => lastState(page).then((u) => u?.pos.y ?? 0), {
      timeout: 15_000,
      message: 'altitude never gained with vtol=+1 in atmosphere',
    })
    .toBeGreaterThan(before.pos.y + 5);
  const vtolState = (await lastState(page))!;
  expect(await setChannel(page, { vtol: 0 }), 'vtol channel released').toBe(true);

  console.log(
    `[TASK-91] callsign=${s.callsign} thrust ${s1.toFixed(1)} → ${s2.toFixed(1)} u/s (rising) ` +
      `cruise-top=${topSpeed.toFixed(1)} u/s (≤121 after release) yaw-dot=${dotD.toFixed(3)} ` +
      `vtol vel.y=${vtolState.vel.y.toFixed(1)} u/s (altitude ${before.pos.y.toFixed(0)} → ${vtolState.pos.y.toFixed(0)})`,
  );

  assertClean();
  await context.close();
});
