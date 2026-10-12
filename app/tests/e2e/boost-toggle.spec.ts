import path from 'node:path';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { ClaimPage } from './pages/claim';

/**
 * TASK-108 — E2E: the cruise boost TOGGLE (Shift).
 *
 * One Shift press (NO hold) engages the client boost toggle — the flight
 * loop sends the sustained 'boost' tag on every input frame (the server
 * just sees a held boost demand, the TASK-85 cruise rule). The ship
 * reaches the cruise cap (scout 120 × 4 = 480) and KEEPS speed > 100 m/s
 * for 5 s with NO keys held (boost persists without holding Shift). The
 * next Shift tap disengages: the speed decays back toward the normal class
 * cap (the TASK-81 SOFT_CAP_DECAY). The HUD CRUISE indicator follows the
 * TOGGLE (visible while on, hidden while off), and the __BOOST__ dev probe
 * mirrors the store.
 *
 * Setup mirrors cruise.spec.ts (TASK-85): fresh player at the home-dock
 * space spawn, a WS tap for the server-authoritative speed, and the dev
 * teleport to deep space (10 770 u from the nearest planet anchor — the
 * no-cruise band is 2 500 m, so the cruise stays allowed for the whole
 * test no matter which way the nose points).
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
  flightRegime: string;
  t: number;
}

/** Deep space, spawn side: 10 770 u from planet 0's anchor (10 000, 0, 0). */
const DEEP_SPACE: Vec3 = { x: 0, y: 50, z: 4_000 };

/**
 * Tap the page's WebSocket: every entity_update carrying OUR ship lands in
 * `window.__t108` (the server's own 10 Hz broadcast — the observation
 * surface, same as cruise.spec.ts).
 */
function tapShipUpdates(callsign: string): void {
  const w = window as unknown as { __t108?: TapEntry[] };
  w.__t108 = [];
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
            w.__t108?.push({
              pos: e.pos,
              vel: e.vel ?? { x: 0, y: 0, z: 0 },
              regime: e.regime ?? 'sublight',
              flightRegime: e.flightRegime ?? 'space',
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
    const ups = (window as unknown as { __t108?: TapEntry[] }).__t108 ?? [];
    const u = ups[ups.length - 1];
    return u ? Math.hypot(u.vel.x, u.vel.y, u.vel.z) : -1;
  });

/** True while the wire regime is still 'docked'. */
const isDocked = (page: import('@playwright/test').Page): Promise<boolean> =>
  page.evaluate(() => {
    const ups = (window as unknown as { __t108?: TapEntry[] }).__t108 ?? [];
    return (ups[ups.length - 1]?.regime ?? 'docked') === 'docked';
  });

/** The CRUISE indicator text (null while hidden). */
const cruiseTagText = (page: import('@playwright/test').Page): Promise<string | null> =>
  page.evaluate(() => document.querySelector('#ship-hud-cruise')?.textContent ?? null);

/** Teleport the self ship (dev assist) and wait for the server to confirm it. */
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
      async () => {
        const ups = (await page.evaluate(() => (window as unknown as { __t108?: TapEntry[] }).__t108)) ?? [];
        const u = ups[ups.length - 1];
        return u ? Math.hypot(u.pos.x - to.x, u.pos.y - to.y, u.pos.z - to.z) < 50 : false;
      },
      { timeout: 15_000, message: `server never confirmed the teleport to ${JSON.stringify(to)}` },
    )
    .toBe(true);
}

test('boost toggle: one Shift press sustains the cruise, the next decays, the CRUISE tag follows', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL } = e2eServer;
  test.setTimeout(150_000);
  const callsign = uniqueCallsign('boost');

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

  // ---------- Phase A: ONE Shift tap (no hold) engages the toggle ----------
  // The ship is wire-docked at the home dock (space). The toggle makes the
  // flight loop send a boost frame — a real demand that beats the TASK-78
  // idle-frame gate and takes the ship off (the server's first-input
  // contract) with the cruise engaging at the same time.
  await page.keyboard.press('Shift');
  expect(await page.evaluate(() => window.__BOOST__?.on ?? null), 'toggle ON after one Shift tap').toBe(
    true,
  );
  // The CRUISE indicator follows the TOGGLE: lit (the home dock is > 10 km
  // from any planet anchor, far outside the 2.5 km no-cruise band).
  await expect(page.locator('#ship-hud-cruise')).toBeVisible({ timeout: 10_000 });
  expect(await cruiseTagText(page), 'HUD cruise tag after the toggle').toBe('CRUISE');
  // The first boost frame undocked the server ship.
  await expect
    .poll(() => isDocked(page), {
      timeout: 10_000,
      message: 'wire regime never left docked after the toggle-off frame',
    })
    .toBe(false);

  // ---------- Phase B: thrust W to the cruise cap, then RELEASE everything ----------
  await teleport(page, baseURL, DEEP_SPACE);
  await page.keyboard.down('w');
  await expect
    .poll(() => lastSpeed(page), {
      timeout: 15_000,
      message: 'server speed never exceeded 300 (scout cruise cap 480) with W + the boost toggle',
    })
    .toBeGreaterThan(300);
  // Visual artifact: the CRUISE indicator lit while the toggle sustains the
  // cruise (chase camera has the ship in view).
  await expect(page.locator('#ship-hud-cruise')).toBeVisible();
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-108-1.png'),
  });

  // Release W: NO keys are held at all (Shift was never held). The sustained
  // 'boost' tag keeps the cruise engaged — the speed must stay > 100 u/s for
  // a full 5 s (in space there is no drag; the effective max stays 480).
  await page.keyboard.up('w');
  let minSpeed = Number.POSITIVE_INFINITY;
  let samples = 0;
  const holdT0 = Date.now();
  while (Date.now() - holdT0 < 5_000) {
    await page.waitForTimeout(100);
    const s = await lastSpeed(page);
    if (s > 0) {
      minSpeed = Math.min(minSpeed, s);
      samples += 1;
    }
  }
  expect(samples, 'got server speed samples during the 5 s hold').toBeGreaterThanOrEqual(20);
  expect(minSpeed, 'speed stayed > 100 u/s for 5 s with NO keys held (boost persists)').toBeGreaterThan(
    100,
  );

  // ---------- Phase C: the next Shift tap disengages; the speed decays ----------
  await page.keyboard.press('Shift');
  expect(await page.evaluate(() => window.__BOOST__?.on ?? null), 'toggle OFF after the second tap').toBe(
    false,
  );
  await expect(page.locator('#ship-hud-cruise')).toBeHidden();
  // The SOFT_CAP_DECAY (5 %/tick, TASK-81) bleeds the excess above the
  // normal class cap (120) within ~10 s.
  const decayT0 = Date.now();
  await expect
    .poll(() => lastSpeed(page), {
      timeout: 10_000,
      message: 'speed never decayed to ≤ 121 after disengaging the boost toggle',
    })
    .toBeLessThanOrEqual(121);
  const decayMs = Date.now() - decayT0;

  // ---------- Phase D: the legacy press-hold path is untouched ----------
  // With the toggle OFF, a LONG W+Shift press produces the exact pre-change
  // demand: the speed climbs past the normal cap again (the legacy
  // held-key boost — boost raises the cap + acceleration, the thrust is the
  // force, so the legacy combo is W+Shift). The press is long
  // (> BOOST_TAP_MAX_MS), so it must NEVER arm the toggle: the store stays
  // off.
  await page.keyboard.down('w');
  await page.keyboard.down('Shift');
  await expect
    .poll(() => lastSpeed(page), {
      timeout: 10_000,
      message: 'W+Shift press-hold with the toggle off never boosted past the normal cap (legacy path broken)',
    })
    .toBeGreaterThan(121);
  await page.keyboard.up('Shift');
  await page.keyboard.up('w');
  expect(
    await page.evaluate(() => window.__BOOST__?.on ?? null),
    'the long press never armed the toggle',
  ).toBe(false);

  console.log(
    `[TASK-108] callsign=${callsign} 5s-hold min speed=${minSpeed.toFixed(1)} u/s (no keys held) ` +
      `decay to ≤ 121 in ${decayMs} ms; legacy W+Shift press-hold verified (store untouched)`,
  );

  assertClean();
  await context.close();
});
