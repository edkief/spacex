import path from 'node:path';
import { expect, test } from './fixtures';
import { canvasRegionStats, collectErrors, uniqueCallsign } from './helpers';
import { keyboardWarp } from './keyboard-helpers';
import { ClaimPage } from './pages/claim';

/**
 * TASK-76 — E2E regression: inside an atmosphere, low and OFF-CENTRE, the
 * sky is the dome — and the camera's far plane must reach the dome's far
 * wall.
 *
 * The TASK-28.1 crossfade fades the skybox + stars OUT as haze rises
 * (opacity = 1 - haze) and the atmosphere dome (a BackSide sphere of
 * radius 1000 × 1.01 u centred on the planet anchor) paints the sky
 * instead. But the old camera far plane was 1000 u: from anywhere but
 * the dome's exact centre the far wall is farther than that (up to
 * 2 × 1010 u), so the part of the dome beyond the far plane was clipped
 * and the black clear color showed through the nearly-transparent sky.
 *
 * This spec finds a landable atmospheric pad through GET
 * /api/dev/pad-target (the e2e specs cannot import @shared code — the
 * Playwright runner does not resolve the tsconfig aliases), teleports
 * the ship 600 u OFF the pad's anchor (the dome centre) at 60 u
 * altitude — inside the dome, high haze, far wall ~1610 u away — and
 * asserts the TOP band of the canvas shows the haze color (mean
 * luminance > 5), never black.
 */

/** The blackout band: the top 30 % of the canvas, above the ship. */
const TOP_BAND = { x0: 0, y0: 0, x1: 1, y1: 0.3 };
/** Horizontal offset from the pad (dome anchor) in u: the AC's "off-centre". */
const OFFSETS = [600, 450, 300, 150];
/**
 * Teleport altitude above the PAD height (u). The spec's "60 u altitude"
 * intent — low, high haze — is measured above the LOCAL ground: the
 * terrain undulates by tens of u over a 600 u offset (amplitudeM), so the
 * pad-relative altitude leaves a comfortable band (still < 300 u → haze
 * boundary factor ≥ 0.7) while keeping the ship in flight for several
 * seconds of free fall.
 */
const ALT_OFFSET_U = 200;

interface PadTarget {
  systemId: string;
  planetId: string;
  padId: string;
  pad: { x: number; y: number; z: number };
}

interface ShipUpdate {
  pos: { x: number; y: number; z: number };
  /** Ship-level regime (docked/sublight/warp). */
  regime: string;
  /** Flight regime inside sublight: 'space' | 'atmosphere' | 'surface'. */
  flightRegime: string;
}

/**
 * Tap the page's WebSocket (init script, flight.spec.ts pattern) so every
 * entity_update carrying OUR ship lands in window.__shipUpdates.
 */
function installShipTap(callsign: string): void {
  const w = window as unknown as { __shipUpdates?: ShipUpdate[] };
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
                kind?: string;
                callsign?: string;
                pos?: ShipUpdate['pos'];
                regime?: string;
                flightRegime?: string;
              }>;
            };
          };
          if (m.type !== 'entity_update') return;
          const e = (m.payload?.entities ?? []).find(
            (t) => t.kind === 'ship' && t.callsign === callsign,
          );
          if (e?.pos && e.regime) {
            w.__shipUpdates?.push({
              pos: e.pos,
              regime: e.regime,
              flightRegime: e.flightRegime ?? '',
            });
          }
        } catch {
          // never break the page's networking from a tap
        }
      });
    }
  };
}

test('inside atmosphere, low and off-centre: the top band shows haze, never black', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL } = e2eServer;
  test.setTimeout(150_000);
  const callsign = uniqueCallsign('atmosky');

  const context = await browser.newContext();
  // The tap must see the session WS from first open — install it pre-navigation.
  await context.addInitScript(installShipTap, callsign);
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  const claim = new ClaimPage(page, baseURL);
  await claim.claim(callsign);
  await expect(page.locator('#sys-id')).toBeVisible({ timeout: 20_000 });

  // Chase camera armed (TASK-72 hook): the self ship projects in front.
  await expect
    .poll(() => page.evaluate(() => !!window.__SELF_SHIP__?.probe()?.screen), {
      timeout: 20_000,
      message: 'chase camera never acquired the self ship',
    })
    .toBe(true);

  const { token, homeSystemId } = (await page.evaluate(() => {
    const session = JSON.parse(localStorage.getItem('drift.session.v1') ?? 'null');
    return {
      token: localStorage.getItem('drift.token') ?? '',
      homeSystemId: session?.homeSystemId ?? '',
    };
  })) as { token: string; homeSystemId: string };
  expect(token, 'session token in localStorage').toBeTruthy();
  const auth = { authorization: `Bearer ${token}` };

  // The landable atmospheric pad: home system first (no warp needed),
  // otherwise the first star-order pad — warp there with the keyboard
  // chart (the pad target is home's neighbor, same as keyboard-only.spec).
  let res = await page.request.get(
    `${baseURL}/api/dev/pad-target?systemId=${homeSystemId}`,
    { headers: auth },
  );
  if (res.status() === 404) {
    res = await page.request.get(`${baseURL}/api/dev/pad-target`, { headers: auth });
    expect(res.status(), 'no landable atmospheric pad in the seeded galaxy').toBe(200);
  }
  const target = (await res.json()) as PadTarget;
  if (target.systemId !== homeSystemId) {
    await keyboardWarp(page, target.systemId, homeSystemId);
    await expect
      .poll(async () => (await page.locator('#sys-id').textContent())?.trim(), {
        timeout: 30_000,
        message: `#sys-id never switched to the pad system ${target.systemId}`,
      })
      .toBe(target.systemId);
  }

  // The first input undocks a docked ship — tap W right before the
  // teleport so the hard-set lands on an in-flight ship.
  await page.keyboard.press('w');

  // Teleport 600 u off the pad's anchor at low altitude (the dome is
  // centred on the anchor and the pad sits on it). Poll until the rendered
  // ship is there AND the server regime is 'atmosphere'; if a smaller
  // offset is needed to stay inside, reduce it (per spec).
  let usedOffset = -1;
  let lastRegime = '';
  const state = (t: { x: number; y: number; z: number }): Promise<{
    near: boolean;
    regime: string;
  }> =>
    page.evaluate((tg: { x: number; y: number; z: number }) => {
      const p = window.__SELF_SHIP__?.probe()?.pos;
      const near = !!p && Math.hypot(p.x - tg.x, p.y - tg.y, p.z - tg.z) < 50;
      const updates = (
        window as unknown as { __shipUpdates?: ShipUpdate[] }
      ).__shipUpdates;
      return { near, regime: updates?.at(-1)?.flightRegime ?? '' };
    }, t);
  for (const offset of OFFSETS) {
    const t = { x: target.pad.x + offset, y: target.pad.y + ALT_OFFSET_U, z: target.pad.z };
    const tele = await page.request.post(`${baseURL}/api/dev/teleport`, {
      headers: { ...auth, 'content-type': 'application/json' },
      data: t,
    });
    expect(tele.status(), `teleport response: ${await tele.text()}`).toBe(200);
    // Manual deadline loop (expect.poll is not thenable): the rendered ship
    // must arrive within 50 u AND the server regime must be 'atmosphere'.
    let ok = false;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const v = await state(t);
      lastRegime = v.regime || lastRegime;
      if (v.near && v.regime === 'atmosphere') {
        ok = true;
        break;
      }
      await page.waitForTimeout(500);
    }
    if (ok) {
      usedOffset = offset;
      break;
    }
  }
  expect(
    usedOffset,
    `ship never reached atmosphere regime (last server regime: ${lastRegime})`,
  ).toBeGreaterThan(0);

  // --- Aim the nose at the dome anchor ---------------------------------
  // The clipped cap (pre-fix) is the FAR part of the dome, in the ANCHOR
  // direction from the ship: the top band (15-35° above the nose) only
  // covers it once the ship faces the anchor. Closed-loop yaw on the world
  // heading; the 'd'/'a' turn sign is calibrated empirically with one 120 ms
  // press (no assumption about the flight model's rotation sign) and W is
  // held while turning to keep altitude.
  const aimProbe = (ax: number, az: number): Promise<{ err: number; h: number } | null> =>
    page.evaluate((t: { ax: number; az: number }) => {
      const p = (window as unknown as {
        __SELF_SHIP__?: {
          probe: () => {
            pos: { x: number; y: number; z: number } | null;
            rot: { x: number; y: number; z: number; w: number } | null;
          };
        };
      }).__SELF_SHIP__?.probe();
      const rot = p?.rot;
      const pos = p?.pos;
      if (!rot || !pos) return null;
      // Ship forward = local +Z under the ship quat (pose-math convention).
      const fx = 2 * (rot.x * rot.z + rot.y * rot.w);
      const fz = 1 - 2 * (rot.x * rot.x + rot.y * rot.y);
      const h = Math.atan2(fz, fx);
      let err = Math.atan2(t.az - pos.z, t.ax - pos.x) - h;
      while (err > Math.PI) err -= 2 * Math.PI;
      while (err < -Math.PI) err += 2 * Math.PI;
      return { err, h };
    }, { ax, az });
  const press = async (keys: string[], ms: number): Promise<void> => {
    for (const k of keys) await page.keyboard.down(k);
    await page.waitForTimeout(ms);
    for (const k of keys) await page.keyboard.up(k);
  };
  let dSign = 1;
  let a = await aimProbe(target.pad.x, target.pad.z);
  if (a && Math.abs(a.err) >= 0.15) {
    await press(['w', 'd'], 120);
    const b = await aimProbe(target.pad.x, target.pad.z);
    if (a && b) {
      let dh = b.h - a.h;
      while (dh > Math.PI) dh -= 2 * Math.PI;
      while (dh < -Math.PI) dh += 2 * Math.PI;
      dSign = dh >= 0 ? 1 : -1;
    }
  }
  for (let i = 0; i < 14; i++) {
    a = await aimProbe(target.pad.x, target.pad.z);
    if (!a || Math.abs(a.err) < 0.12) break;
    await press(['w', a.err * dSign > 0 ? 'd' : 'a'], Math.min(400, 80 + Math.abs(a.err) * 250));
  }
  console.log(`[TASK-76] aimed at the anchor: heading error ${a ? (a.err * 57.3).toFixed(1) : '?'}°`);

  // The top band shows the dome haze color, never black (mean > 5).
  const top = await canvasRegionStats(page, TOP_BAND);
  console.log(
    `[TASK-76] off-centre ${usedOffset} u from the dome anchor, ` +
      `pad-relative altitude ${ALT_OFFSET_U} u, regime=${lastRegime}: ` +
      `top band mean=${top.mean.toFixed(1)} bright=${top.bright}`,
  );
  expect(top.mean, 'top band must show the haze color, not black').toBeGreaterThan(5);

  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-76-1.png'),
  });
  assertClean();
  await context.close();
});
