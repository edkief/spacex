import path from 'node:path';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { ClaimPage } from './pages/claim';

/**
 * TASK-85 — E2E: space cruise boost (Shift) for the 10 km legs between
 * planets.
 *
 * Flow: fresh player → tap W (undock) → teleport DEEP SPACE (4 km, the
 * spawn-side leg start) → nose at planet 0's anchor → hold W + SHIFT 8 s:
 * the SERVER-reported speed (our own inbound entity_update tap) must
 * exceed 300 u/s (scout cruise cap 480 = 120 × 4) and the HUD shows the
 * CRUISE tag. Release Shift, keep W 6 s: the 5 %/tick soft cap bleeds the
 * excess down to ≤ 121. Then teleport to 2 km from the anchor (inside the
 * 1 000 + 1 500 m no-cruise band): W + SHIFT does nothing (≤ 121) and the
 * HUD shows dimmed CRUISE BLOCKED. Finally the MEASURED leg time: from
 * deep space, cruising at the planet, until the server position crosses
 * the clearance boundary (recorded for the LOG entry).
 */

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface TapEntry {
  pos: Vec3;
  vel: Vec3;
  regime: string;
  t: number;
}

/** Deep space, spawn side: 10 770 u from planet 0's anchor (10 000, 0, 0). */
const DEEP_SPACE: Vec3 = { x: 0, y: 50, z: 4_000 };
/** Planet 0's sim anchor (planetAnchor(0)). */
const PLANET0: Vec3 = { x: 10_000, y: 0, z: 0 };
/** No-cruise band radius: 1 000 atmosphere + 1 500 clearance. */
const CLEARANCE = 2_500;
/** 2 km from the anchor — inside the band, still outside the atmosphere. */
const NEAR: Vec3 = { x: 8_000, y: 300, z: 0 };
/** Scout turn rate (rad/s) — the steering math must match the class. */
const TURN_RATE = 0.8;

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Tap the page's WebSocket: every entity_update carrying OUR ship lands in
 * `window.__shipUpdates` with a local receive timestamp (the server's own
 * 10 Hz broadcast — the observation surface, same as flight.spec.ts).
 */
function tapShipUpdates(callsign: string): void {
  const w = window as unknown as { __shipUpdates?: TapEntry[] };
  w.__shipUpdates = [];
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
                regime: string;
                callsign?: string;
              }>;
            };
          };
          if (m.type !== 'entity_update') return;
          const e = (m.payload?.entities ?? []).find(
            (t) => t.kind === 'ship' && t.callsign === callsign,
          );
          if (e)
            w.__shipUpdates?.push({
              pos: e.pos,
              vel: e.vel ?? { x: 0, y: 0, z: 0 },
              regime: e.regime,
              t: Date.now(),
            });
        } catch {
          // never break the page's networking from a tap
        }
      });
    }
  };
}

/** The last server-reported speed of our ship (u/s), -1 = no updates yet. */
const lastSpeed = (page: import('@playwright/test').Page): Promise<number> =>
  page.evaluate(() => {
    const ups = (window as unknown as { __shipUpdates?: TapEntry[] }).__shipUpdates ?? [];
    const u = ups[ups.length - 1];
    return u ? Math.hypot(u.vel.x, u.vel.y, u.vel.z) : -1;
  });

/** The signed yaw error (rad) between the nose and the anchor: + = target LEFT. */
const yawError = (page: import('@playwright/test').Page): Promise<number | null> =>
  page.evaluate((anchor: Vec3) => {
    const p = window.__SELF_SHIP__?.probe();
    if (!p?.pos || !p.rot) return null;
    // ship's forward (+Z rotated by the wire rot quat) — inlined: the
    // evaluate body runs in the PAGE, where module helpers do not exist.
    const { x, y, z, w } = p.rot;
    const nose = { x: 2 * (x * z + w * y), z: 1 - 2 * (x * x + y * y) };
    const tx = anchor.x - p.pos.x;
    const tz = anchor.z - p.pos.z;
    const nx = nose.x;
    const nz = nose.z;
    if (nx * nx + nz * nz < 1e-6) return null; // nose is vertical
    return Math.atan2(nz * tx - nx * tz, nx * tx + nz * tz);
  }, PLANET0);

/**
 * Nose at the anchor (±0.12 rad): one axis pressed at a time for the
 * computed time (|err| / turn rate), re-measured each pass (the 20 Hz
 * server absorbs the key pickup, so overshoot is corrected on the next
 * pass instead of calibrated).
 */
async function faceAnchor(page: import('@playwright/test').Page): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const err = await yawError(page);
    if (err !== null && Math.abs(err) < 0.12) return;
    if (Date.now() - t0 > 15_000) throw new Error(`never faced the anchor (err=${err})`);
    if (err === null) {
      await page.waitForTimeout(250);
      continue;
    }
    const key = err > 0 ? 'a' : 'd'; // +err = target to the LEFT = A (TASK-80)
    await page.keyboard.down(key);
    // A little over: the correction pass trims the overshoot.
    await page.waitForTimeout(Math.ceil((Math.abs(err) / TURN_RATE) * 1000) + 120);
    await page.keyboard.up(key);
  }
}

/** Teleport the self ship (dev assist) and wait for the rendered ship to land. */
async function teleport(page: import('@playwright/test').Page, baseURL: string, to: Vec3) {
  const token = await page.evaluate(() => localStorage.getItem('drift.token'));
  expect(token, 'session token in localStorage').toBeTruthy();
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

const cruiseTagText = (page: import('@playwright/test').Page): Promise<string | null> =>
  page.evaluate(() => document.querySelector('#ship-hud-cruise')?.textContent ?? null);

test('cruise: Shift boosts in deep space, bleeds off on release, blocks near planets', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL } = e2eServer;
  test.setTimeout(150_000);
  const callsign = uniqueCallsign('cruise');

  const context = await browser.newContext();
  await context.addInitScript(tapShipUpdates, callsign);
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  const claim = new ClaimPage(page, baseURL);
  await claim.claim(callsign);
  await expect(page.locator('#sys-id')).toBeVisible({ timeout: 20_000 });

  // Chase camera armed (the self ship projects in front).
  await expect
    .poll(() => page.evaluate(() => !!window.__SELF_SHIP__?.probe()?.screen), {
      timeout: 20_000,
      message: 'chase camera never acquired the self ship',
    })
    .toBe(true);

  // The first input undocks — tap W before the first teleport.
  await page.keyboard.press('w');

  // (1) DEEP SPACE: nose at planet 0, then HOLD W + SHIFT for 8 s.
  await teleport(page, baseURL, DEEP_SPACE);
  await faceAnchor(page);
  const cruiseStart = Date.now();
  await page.keyboard.down('w');
  await page.keyboard.down('Shift');
  await expect
    .poll(lastSpeed(page), {
      timeout: 15_000,
      message: 'server speed never exceeded 300 while holding W+Shift in deep space',
    })
    .toBeGreaterThan(300);
  const topSpeed = await lastSpeed(page);
  // The HUD shows the CRUISE tag (held + allowed at the predicted position).
  expect(await cruiseTagText(page), 'HUD cruise tag mid-cruise').toBe('CRUISE');
  await page.waitForTimeout(8_000 - Math.max(0, Date.now() - cruiseStart));
  const speedAt8s = await lastSpeed(page);
  // Visual artifact: mid-cruise, the planet proxies ahead if we face them
  // (.ralph/screenshots/TASK-85-1.png).
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-85-1.png'),
  });

  // (2) RELEASE Shift, keep W: the soft cap bleeds the excess to ≤ 121.
  await page.keyboard.up('Shift');
  await page.waitForTimeout(6_000);
  await expect
    .poll(lastSpeed(page), {
      timeout: 15_000,
      message: 'speed never decayed to ≤ 121 after releasing Shift (6 s in)',
    })
    .toBeLessThanOrEqual(121);

  // (3) NEAR THE PLANET (2 km out, inside the 2.5 km no-cruise band):
  // W + SHIFT does nothing to the ship, and the HUD says why.
  await teleport(page, baseURL, NEAR);
  await page.keyboard.down('w');
  await page.keyboard.down('Shift');
  await page.waitForTimeout(2_000);
  expect(await cruiseTagText(page), 'HUD tag in the clearance band').toBe('CRUISE BLOCKED');
  await page.waitForTimeout(4_000); // 6 s total of W+Shift
  const nearTop = await page.evaluate(() => {
    const ups = (window as unknown as { __shipUpdates?: TapEntry[] }).__shipUpdates ?? [];
    // speed over the near-planet run (after the last teleport = vel zeroed)
    let top = 0;
    for (let i = ups.length - 1; i >= 0; i--) {
      if (dist(ups[i].pos, NEAR) > 900) break; // updates from the run so far
      top = Math.max(top, Math.hypot(ups[i].vel.x, ups[i].vel.y, ups[i].vel.z));
    }
    return top;
  });
  expect(nearTop, 'no boost inside the clearance band').toBeLessThanOrEqual(121);
  await page.keyboard.up('w');
  await page.keyboard.up('Shift');

  // (4) MEASURED LEG TIME: deep space → planet 0's clearance boundary,
  // cruising the whole way (the spec's 10 km leg, spawn side).
  await teleport(page, baseURL, DEEP_SPACE);
  const legStart = Date.now();
  await page.keyboard.down('w');
  await page.keyboard.down('Shift');
  await expect
    .poll(
      () =>
        page.evaluate((a: Vec3) => {
          const p = window.__SELF_SHIP__?.probe()?.pos;
          return p ? Math.hypot(p.x - a.x, p.y - a.y, p.z - a.z) : 1e9;
        }, PLANET0),
      {
        timeout: 45_000,
        message: 'cruising ship never reached the planet-0 clearance boundary',
      },
    )
    .toBeLessThanOrEqual(CLEARANCE);
  const legMs = Date.now() - legStart;
  await page.keyboard.up('w');
  await page.keyboard.up('Shift');

  console.log(
    `[TASK-85] callsign=${callsign} cruise-top=${topSpeed.toFixed(1)} u/s ` +
      `(8 s hold, scout cap 120 × 4 = 480) speed-at-8s=${speedAt8s.toFixed(1)} u/s ` +
      `post-release=${(await lastSpeed(page)).toFixed(1)} u/s (≤ 121) ` +
      `near-planet-top=${nearTop.toFixed(1)} u/s (≤ 121) ` +
      `measured leg (deep space → 2.5 km clearance boundary) = ${(legMs / 1000).toFixed(1)} s`,
  );

  assertClean();
  await context.close();
});
