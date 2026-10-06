import path from 'node:path';
import { expect, test } from './fixtures';
import { canvasRegionStats, collectErrors, uniqueCallsign } from './helpers';
import { RawWsClient } from './raw-ws';
// The e2e process re-derives the seeded galaxy with the SAME shared code the
// server uses (relative imports — the Playwright runner does not resolve the
// tsconfig aliases), so no seed value is hardcoded in this spec.
import { planetAnchor, planetAtmosphereDensity } from '../../src/shared/galaxy/planets';
import { CHUNK_SIZE, CELL_SIZE_M, generateSurfaceChunk } from '../../src/shared/galaxy/surface';
import { generateStars } from '../../src/shared/galaxy/stars';
import { generateSystem } from '../../src/shared/galaxy/system';
import type { Planet } from '../../src/shared/galaxy/types';
import { padsForSystem } from '../../src/shared/world/pads';

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
 * Target choice — why the DENSEST atmospheric planet, not the home pad:
 * pre-fix, the clipped region shows the skybox at opacity (1 − haze) over
 * the black clear, so the top band reads
 *   mean ≈ (1 − haze) × skyLuminance,  haze = (1 − alt/1000) × density/0.1.
 * A thin-atmosphere pad (the home system's ~0.06) caps the haze at ~0.6 —
 * the band still reads ~16, far above the "black" threshold of 5, and the
 * bug is invisible. The densest seeded planet (density → 0.1) at 60 u
 * altitude reaches haze ≈ 0.93: pre-fix the band reads ≈ 3 (black, the
 * assertion fails); post-fix the dome paints it at ≈ 140 (haze tint, it
 * passes). The scan is a pure function of the seed, so the spec stays
 * deterministic for whatever galaxy the server runs.
 *
 * Flow: raw REST claim → raw WS warp straight to that system (the
 * pvp-kill.spec.ts pattern — the router validates the warp target only
 * against the seed, not against the chart's neighbor list) → the browser
 * joins it with ?sys= → dev-teleport 600 u off the dome anchor at 60 u
 * LOCAL altitude → aim the nose at the anchor (the clipped cap lives
 * there) → assert the top band's mean luminance > 5.
 */

/** Mirrors src/server/env.ts — the e2eServer fixture never overrides the seed. */
const SEED = 'DRIFT-SEED-0001';
const PROTOCOL_VERSION = 1; // mirrors @shared/protocol

/**
 * The blackout band: a CENTRAL strip of the top 30 % (x 0.35-0.65), above
 * the ship. Why central and not full-width: pre-fix the clipped dome cap
 * (the black region) sits in the view centre and is surrounded by the
 * VISIBLE part of the dome (within the 1000 u far plane) as a bright-blue
 * ring that reaches the corners. A full-width band averages in that ring
 * and reads bright even while the bug is present. The central strip stays
 * inside the clipped cap (~67° from the nose, band spans only ~14-38°), so
 * pre-fix it shows the near-fully-faded skybox over the black clear
 * (luminance ~3, assertion fails) and post-fix the full dome haze
 * (luminance ~155, passes). The ship sits at ~y 0.6, the terrain at the
 * bottom, so the top strip is clear of both.
 */
const TOP_BAND = { x0: 0.35, y0: 0, x1: 0.65, y1: 0.3 };
/** Full-width top band, logged (not asserted) to record the ring's effect. */
const FULL_TOP_BAND = { x0: 0, y0: 0, x1: 1, y1: 0.3 };
/** Offsets from the pad, nearest to farthest (the dome anchor sits ~260 u off the pad). */
const OFFSETS = [600, 450, 300, 150];
/** Teleport altitude above the LOCAL terrain (u) — the AC's "60 u altitude". */
const ALT_OFFSET_U = 60;

interface Session {
  token: string;
  callsign: string;
  homeSystemId: string;
}

interface ShipUpdate {
  pos: { x: number; y: number; z: number };
  /** Flight regime inside sublight: 'space' | 'atmosphere' | 'surface'. */
  flightRegime: string;
}

/** The densest landable+atmospheric pad in the seeded galaxy (star order scan). */
function densestAtmosphericPad(seed: string): {
  systemId: string;
  planet: Planet;
  planetIndex: number;
  pad: { x: number; y: number; z: number };
  density: number;
} {
  let best: ReturnType<typeof densestAtmosphericPad> | null = null;
  for (const star of generateStars(seed)) {
    const system = generateSystem(seed, star.id);
    system.planets.forEach((planet, planetIndex) => {
      if (!planet.landable || !planet.hasAtmosphere) return;
      const pad = padsForSystem(seed, system).find((p) => p.planetId === planet.id);
      if (!pad) return;
      const density = planetAtmosphereDensity(planet);
      if (!best || density > best.density) {
        best = { systemId: system.systemId, planet, planetIndex, pad: pad.pos, density };
      }
    });
  }
  if (!best) throw new Error('no landable atmospheric planet in the seeded galaxy');
  return best;
}

/**
 * Terrain height at a world position (the same planet-wide field pads.ts
 * samples for the pad height) — lets the spec teleport at an exact LOCAL
 * altitude regardless of where the terrain undulates.
 */
function terrainY(seed: string, planet: Planet, x: number, z: number): number {
  const cellX = Math.floor(x / CELL_SIZE_M);
  const cellZ = Math.floor(z / CELL_SIZE_M);
  const cX = Math.floor(cellX / CHUNK_SIZE);
  const cZ = Math.floor(cellZ / CHUNK_SIZE);
  const chunk = generateSurfaceChunk(seed, planet, cX, cZ);
  return chunk.heightmap[(cellZ - cZ * CHUNK_SIZE) * CHUNK_SIZE + (cellX - cX * CHUNK_SIZE)];
}

/** Raw REST claim (the shape the browser claim flow stores). */
async function claim(baseURL: string, callsign: string): Promise<Session> {
  const res = await fetch(`${baseURL}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  const body = await res.text();
  expect(res.status, `claim: ${body}`).toBe(201);
  return JSON.parse(body) as Session;
}

/**
 * Warp the ship to `targetSystemId` via raw WS (join home → warp →
 * warp_arrived), then close — the ship ROW stays in the target system
 * while the browser joins it (the pvp-kill.spec.ts pattern).
 */
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
                flightRegime?: string;
              }>;
            };
          };
          if (m.type !== 'entity_update') return;
          const e = (m.payload?.entities ?? []).find(
            (t) => t.kind === 'ship' && t.callsign === callsign,
          );
          if (e?.pos) {
            w.__shipUpdates?.push({ pos: e.pos, flightRegime: e.flightRegime ?? '' });
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
  const { baseURL, apiPort } = e2eServer;
  test.setTimeout(150_000);

  // The repro target: the densest seeded atmosphere (haze → max at 60 u).
  const target = densestAtmosphericPad(SEED);
  console.log(
    `[TASK-76] target system=${target.systemId} density=${target.density.toFixed(4)} ` +
      `pad=(${target.pad.x.toFixed(0)}, ${target.pad.y.toFixed(1)}, ${target.pad.z.toFixed(0)})`,
  );

  const callsign = uniqueCallsign('atmosky');
  // Claim + warp BEFORE the browser: the ship row moves to the target
  // system (gate pose, flying) and the browser adopts it on join.
  const session = await claim(baseURL, callsign);
  await warpShip(apiPort, session, target.systemId);

  const context = await browser.newContext();
  // The tap must see the session WS from first open — install it pre-navigation.
  await context.addInitScript(installShipTap, callsign);
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  await page.goto(baseURL);
  await page.evaluate(
    (s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)),
    session,
  );
  await page.goto(`${baseURL}/?sys=${target.systemId}`);
  await expect(page.locator('#sys-id')).toBeVisible({ timeout: 20_000 });

  // Chase camera armed (TASK-72 hook): the self ship projects in front.
  await expect
    .poll(() => page.evaluate(() => !!window.__SELF_SHIP__?.probe()?.screen), {
      timeout: 20_000,
      message: 'chase camera never acquired the self ship',
    })
    .toBe(true);

  const auth = { authorization: `Bearer ${session.token}` };
  const anchor = planetAnchor(target.planetIndex); // dome centre (the pad sits ~260 u off it)

  // Teleport 600 u off the pad at 60 u LOCAL altitude — inside the dome,
  // high haze, far wall ~1.8 km away. Poll until the rendered ship is
  // there AND the server regime is 'atmosphere'; if a smaller offset is
  // needed to stay inside, reduce it (per spec).
  let usedOffset = -1;
  let lastRegime = '';
  let spot = { x: 0, y: 0, z: 0 };
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
    spot = {
      x: target.pad.x + offset,
      y: terrainY(SEED, target.planet, target.pad.x + offset, target.pad.z) + ALT_OFFSET_U,
      z: target.pad.z,
    };
    const tele = await page.request.post(`${baseURL}/api/dev/teleport`, {
      headers: { ...auth, 'content-type': 'application/json' },
      data: spot,
    });
    expect(tele.status(), `teleport response: ${await tele.text()}`).toBe(200);
    // Manual deadline loop (expect.poll is not thenable): the rendered ship
    // must arrive within 50 u AND the server regime must be 'atmosphere'.
    let ok = false;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const v = await state(spot);
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

  // --- Aim the nose at the dome ANCHOR ---------------------------------
  // Pre-fix the clipped cap is the FAR part of the dome, in the ANCHOR
  // direction from the ship: the top band (10-35° above the nose) only
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
  let a = await aimProbe(anchor.x, anchor.z);
  if (a && Math.abs(a.err) >= 0.15) {
    await press(['w', 'd'], 120);
    const b = await aimProbe(anchor.x, anchor.z);
    if (a && b) {
      let dh = b.h - a.h;
      while (dh > Math.PI) dh -= 2 * Math.PI;
      while (dh < -Math.PI) dh += 2 * Math.PI;
      dSign = dh >= 0 ? 1 : -1;
    }
  }
  for (let i = 0; i < 14; i++) {
    a = await aimProbe(anchor.x, anchor.z);
    if (!a || Math.abs(a.err) < 0.12) break;
    await press(['w', a.err * dSign > 0 ? 'd' : 'a'], Math.min(400, 80 + Math.abs(a.err) * 250));
  }
  console.log(
    `[TASK-76] aimed at the anchor: heading error ${a ? (a.err * 57.3).toFixed(1) : '?'}°`,
  );

  // --- Pin the measurement spot -----------------------------------------
  // The aim burns a couple of seconds of thrust — at 60 u that can drift
  // the ship toward the terrain. Re-teleport to the SAME spot (orientation
  // is untouched by the teleport) so the band is measured at exactly 60 u.
  const pin = await page.request.post(`${baseURL}/api/dev/teleport`, {
    headers: { ...auth, 'content-type': 'application/json' },
    data: spot,
  });
  expect(pin.status(), `re-pin teleport: ${await pin.text()}`).toBe(200);
  let pinned = false;
  const pinDeadline = Date.now() + 10_000;
  while (Date.now() < pinDeadline) {
    const v = await state(spot);
    lastRegime = v.regime || lastRegime;
    if (v.near && v.regime === 'atmosphere') {
      pinned = true;
      break;
    }
    await page.waitForTimeout(400);
  }
  expect(pinned, `ship never re-settled at the pin spot (regime: ${lastRegime})`).toBe(true);

  // The CENTRAL top band shows the dome haze color, never black (mean > 5).
  // (The full-width band is logged too: pre-fix it averages in the visible
  // blue dome ring and stays bright even while the cap in the middle is
  // clipped black — which is why the assertion targets the central strip.)
  const top = await canvasRegionStats(page, TOP_BAND);
  const fullTop = await canvasRegionStats(page, FULL_TOP_BAND);
  const haze =
    (1 - ALT_OFFSET_U / 1000) * Math.min(1, target.density / 0.1); // shared hazeFactor
  console.log(
    `[TASK-76] off-centre ${usedOffset} u from the pad (${(Math.hypot(
      spot.x - anchor.x,
      spot.z - anchor.z,
    ).toFixed(0))} u from the anchor), altitude ${ALT_OFFSET_U} u, ` +
      `haze≈${haze.toFixed(2)}, regime=${lastRegime}: ` +
      `central top band mean=${top.mean.toFixed(1)} bright=${top.bright}, ` +
      `full top band mean=${fullTop.mean.toFixed(1)}`,
  );
  expect(top.mean, 'top band must show the haze color, not black').toBeGreaterThan(5);

  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-76-1.png'),
  });
  assertClean();
  await context.close();
});
