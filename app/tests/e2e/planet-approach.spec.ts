import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { canvasRegionStats, collectErrors, uniqueCallsign } from './helpers';
import { systemForId } from '../../src/shared/galaxy/system';
import { planetAnchor, planetAtmosphereRadius } from '../../src/shared/galaxy/planets';

/**
 * TASK-87 — E2E: a real space → planet approach ends ON the planet's surface
 * (no tunnel-through), the wire regime reaches 'surface', and the streamed
 * terrain renders.
 *
 * The owner-reported bug: holding W at a planet, the wire regime stayed
 * 'space' the whole way and the ship passed through the planet body. That
 * happens for AIRLESS planets (atmosphereRadius 0 → the regime machine never
 * left 'space' and the flight model applied no ground collision in space).
 *
 * Target is picked from the player's home system: a landable AIRLESS
 * planet when the system has one (the bug case — proves the fix), else a
 * landable atmospheric planet (the contract case). The home system derives
 * from the player UUID, so the spec claims a few (cheap REST-only) players
 * and keeps the first whose home system has a landable AIRLESS planet —
 * ~55% of the seeded systems do, so the bug case runs most times. The ship
 * teleports to ground level OUTSIDE the planet, aims at its anchor, and
 * holds W (+ Shift cruise on the leg). On an atmospheric home the ship
 * DEADSTICKS once the wire regime flips to 'atmosphere' (TASK-98: the main
 * thruster works in the band, so holding W would keep it above the 5 u/s
 * surface threshold and it would never settle); the airless home keeps
 * thrusting (the space-disc friction grinds it to the surface). Assertions:
 *  - the wire flightRegime sequence reaches 'surface' (space→atmosphere→surface
 *    for atmospheric; space→surface for airless — never 'atmosphere' there);
 *  - the ship's wire position is never below the surface (never inside the
 *    body) at any poll;
 *  - the ship ENDS inside the planet's 2 km surface disc (it landed, it did
 *    not tunnel through to the far side);
 *  - on 'surface', the streamed terrain mounts (≥ 9 chunks) and the LOWER
 *    half of the canvas is non-uniform (terrain is on screen), saving
 *    .ralph/screenshots/TASK-87-1.png.
 */

const SEED = 'DRIFT-SEED-0001';
const SURFACE_DISC_RADIUS = 2_000;

interface Vec3 {
  x: number;
  y: number;
  z: number;
}
interface Tap {
  pos: Vec3;
  flightRegime: string;
}

interface ClaimResponse {
  token: string;
  playerId: string;
  callsign: string;
  homeSystemId: string;
  shipId: string;
}

/** Tap the self ship's entity_update frames (pos + wire flightRegime). */
function tapShipUpdates(callsign: string): void {
  const w = window as unknown as { __t87?: Tap[] };
  w.__t87 = [];
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
                flightRegime?: string;
                callsign?: string;
              }>;
            };
          };
          if (m.type !== 'entity_update') return;
          const e = (m.payload?.entities ?? []).find(
            (t) => t.kind === 'ship' && t.callsign === callsign,
          );
          if (e) w.__t87?.push({ pos: e.pos, flightRegime: e.flightRegime ?? 'space' });
        } catch {
          /* never break the page */
        }
      });
    }
  };
}

/** Signed yaw error (rad) between the ship nose and the anchor; null if not spawned. */
const yawError = (page: Page, anchor: Vec3): Promise<number | null> =>
  page.evaluate((a: Vec3) => {
    const p = window.__SELF_SHIP__?.probe();
    if (!p?.pos || !p.rot) return null;
    const { x, y, z, w } = p.rot;
    const nose = { x: 2 * (x * z + w * y), z: 1 - 2 * (x * x + y * y) };
    const tx = a.x - p.pos.x;
    const tz = a.z - p.pos.z;
    if (nose.x * nose.x + nose.z * nose.z < 1e-6) return null;
    return Math.atan2(nose.z * tx - nose.x * tz, nose.x * tx + nose.z * tz);
  }, anchor);

const TURN_RATE = 0.8;
/** Closed-loop aim: turn toward the anchor until the yaw error < 0.12 rad. */
async function faceAnchor(page: Page, anchor: Vec3): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const err = await yawError(page, anchor);
    if (err !== null && Math.abs(err) < 0.12) return;
    if (Date.now() - t0 > 20_000) throw new Error(`never faced the anchor (err=${err})`);
    if (err === null) {
      await page.waitForTimeout(250);
      continue;
    }
    const key = err > 0 ? 'a' : 'd';
    const pressS = Math.max(0.1, Math.abs(err) / TURN_RATE - 0.2);
    await page.keyboard.down(key);
    await page.waitForTimeout(Math.ceil(pressS * 1000));
    await page.keyboard.up(key);
    await page.waitForTimeout(400);
  }
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
      { timeout: 20_000, message: 'teleported ship never reached the start point' },
    )
    .toBeLessThan(50);
}

/** The live terrain mount probe (null = nothing mounted). */
function terrainProbe(page: Page): Promise<{ planetId: string; mountedChunks: number } | null> {
  return page.evaluate(() => {
    const t = window.__PLANETS__?.terrain?.() ?? null;
    return t ? { planetId: t.planetId, mountedChunks: t.mountedChunks } : null;
  });
}

test('space → planet approach lands on the surface (no tunnel-through)', async ({
  browser,
  e2eServer,
}) => {
  test.setTimeout(180_000);
  const { baseURL } = e2eServer;
  const callsign = uniqueCallsign('t87');

  // (a) Claim a fresh player whose home system has a landable AIRLESS planet
  // (the owner's bug). The home system derives from the player UUID (~55% of
  // systems have an airless planet), so claim a few cheap REST-only players
  // and keep the first airless-home one; fall back to the first claim.
  let session: ClaimResponse | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    const cs = attempt === 0 ? callsign : uniqueCallsign('t87b');
    const claimRes = await fetch(`${baseURL}/api/callsigns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callsign: cs }),
    });
    expect(claimRes.status).toBe(201);
    const cand = (await claimRes.json()) as ClaimResponse;
    const hasAirless =
      systemForId(SEED, cand.homeSystemId)?.planets.some((p) => p.landable && !p.hasAtmosphere) ??
      false;
    if (attempt === 0 || hasAirless) {
      session = cand;
      break;
    }
  }
  expect(session, 'claimed a player').toBeTruthy();

  // (b) Deterministic target from the home system: a landable AIRLESS planet
  // (the owner's bug) when present, else a landable atmospheric planet.
  const system = systemForId(SEED, session!.homeSystemId);
  expect(system, 'home system exists').toBeTruthy();
  const planets = system!.planets;
  const airlessIdx = planets.findIndex((p) => p.landable && !p.hasAtmosphere);
  const atmoIdx = planets.findIndex((p) => p.landable && p.hasAtmosphere);
  const idx = airlessIdx >= 0 ? airlessIdx : atmoIdx;
  expect(idx, 'home system has a landable planet').toBeGreaterThanOrEqual(0);
  const airless = !planets[idx].hasAtmosphere;
  const anchor = { ...planetAnchor(idx), y: 0 };
  const atmoR = planetAtmosphereRadius(planets[idx]);
  // Airless: start 600 u outside the 2 km disc (at the cruise boundary).
  // Atmospheric: start 600 u outside the 1 km atmosphere.
  const startX = airless ? anchor.x + SURFACE_DISC_RADIUS + 600 : anchor.x + atmoR + 600;
  const s = session!;
  console.log(
    `[TASK-87] player=${s.playerId} sys=${s.homeSystemId} planet idx=${idx} ` +
      `airless=${airless} anchor=${JSON.stringify(anchor)} startX=${startX}`,
  );

  // (c) Browser: join the home system, arm the chase camera.
  const context = await browser.newContext();
  await context.addInitScript(tapShipUpdates, s.callsign);
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  await page.goto(baseURL);
  await page.evaluate((ss) => localStorage.setItem('drift.session.v1', JSON.stringify(ss)), s);
  await page.goto(`${baseURL}/?sys=${s.homeSystemId}`);
  await expect(page.locator('#sys-id')).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => page.evaluate(() => !!window.__SELF_SHIP__?.probe()?.screen), {
      timeout: 20_000,
      message: 'chase camera never acquired the self ship',
    })
    .toBe(true);

  // First input undocks a docked ship — tap W once BEFORE the teleport so the
  // hard-set lands on an in-flight ship (terrain-live.spec.ts pattern).
  await page.keyboard.press('w');

  // (d) Teleport to ground level OUTSIDE the planet, on the +X side of the
  // anchor (the ship approaches along −X).
  await teleport(page, baseURL, s.token, { x: startX, y: 0, z: anchor.z });

  // (e) Aim at the anchor.
  await faceAnchor(page, anchor);

  // (f) Hold W (+ Shift cruise on the leg) and observe the wire regime.
  await page.keyboard.down('w');
  await page.keyboard.down('Shift');
  const t0 = Date.now();
  const seen: string[] = [];
  let minDist = Infinity;
  let minY = Infinity;
  let lastSample: Tap | null = null;
  let landed = false;
  // TASK-98: the main thruster now works inside the band — holding W there
  // keeps the ship above the 5 u/s surface threshold and it would never
  // settle to 'surface'. DEADSTICK into the band on an atmospheric home:
  // release W + Shift the moment the wire regime flips to 'atmosphere' and
  // let drag + gravity carry the landing. The airless path never sees
  // 'atmosphere' (space → surface via the 2 km disc), so keep thrusting
  // there (the SURFACE_FRICTION grind-stop lands it).
  let deadstickArmed = !airless;
  while (Date.now() - t0 < 120_000) {
    const taps = await page.evaluate(() => (window as unknown as { __t87?: Tap[] }).__t87 ?? []);
    lastSample = taps[taps.length - 1] ?? lastSample;
    if (lastSample) {
      const p = lastSample.pos;
      minDist = Math.min(minDist, Math.hypot(p.x - anchor.x, p.y - anchor.y, p.z - anchor.z));
      minY = Math.min(minY, p.y);
      const r = lastSample.flightRegime;
      if (seen[seen.length - 1] !== r) seen.push(r);
      if (deadstickArmed && r === 'atmosphere') {
        deadstickArmed = false;
        await page.keyboard.up('w');
        await page.keyboard.up('Shift');
      }
      if (r === 'surface') {
        landed = true;
        // A beat for the regime to settle before sampling the final position.
        await page.waitForTimeout(1_500);
        const taps2 = await page.evaluate(
          () => (window as unknown as { __t87?: Tap[] }).__t87 ?? [],
        );
        lastSample = taps2[taps2.length - 1] ?? lastSample;
        break;
      }
      // Tunnel-through: passed beyond the anchor to the far side without landing.
      if (p.x < anchor.x - SURFACE_DISC_RADIUS && minDist < SURFACE_DISC_RADIUS) break;
    }
    await page.waitForTimeout(200);
  }
  await page.keyboard.up('Shift');
  await page.keyboard.up('w');
  console.log(
    `[TASK-87] airless=${airless} flightRegime=${seen.join(' -> ')} minDist=${minDist.toFixed(1)} ` +
      `minY=${minY.toFixed(1)} last=${JSON.stringify(lastSample)}`,
  );

  expect(landed, `ship never reached 'surface' (sequence: ${seen.join(' -> ')})`).toBe(true);

  // (1) The wire regime sequence reaches 'surface'.
  expect(seen).toContain('surface');
  if (airless) {
    // Airless bodies have no atmosphere band — the sequence is space → surface.
    expect(seen).not.toContain('atmosphere');
    expect(seen).toEqual(['space', 'surface']);
  } else {
    expect(seen).toEqual(['space', 'atmosphere', 'surface']);
  }

  // (2) The ship is never below the surface (never inside the planet body):
  // it approaches at ground level and the ground clamp keeps it at/above the
  // terrain (the island slab top sits at y = -2).
  expect(minY, `ship sank below the surface (minY=${minY.toFixed(1)})`).toBeGreaterThanOrEqual(-5);

  // (3) The ship ENDS inside the planet's 2 km surface disc — it landed, it
  // did not tunnel through to the far side.
  const final = lastSample!.pos;
  const finalDist = Math.hypot(final.x - anchor.x, final.z - anchor.z);
  expect(
    finalDist,
    `ship ended ${finalDist.toFixed(1)} u from the anchor (outside the 2 km disc = tunnel)`,
  ).toBeLessThan(SURFACE_DISC_RADIUS);

  // (4) On 'surface', the streamed terrain mounts (≥ 9 chunks — the 3x3 near
  // ring) and belongs to the target planet.
  await expect
    .poll(async () => (await terrainProbe(page))?.mountedChunks ?? -1, {
      timeout: 90_000,
      message: 'terrain never mounted 9+ chunks on the surface',
    })
    .toBeGreaterThanOrEqual(9);
  const terrain = (await terrainProbe(page)) as { planetId: string; mountedChunks: number };
  const targetPlanetId = planets[idx].id;
  expect(terrain.planetId, 'mounted terrain belongs to the approached planet').toBe(targetPlanetId);

  // (5) The LOWER band of the canvas is a solid, bright GROUND fill (the
  // streamed terrain under the ship), NOT a dark starfield with a hole where
  // the planet was. The ship can land on a FLAT biome (uniform grey ground —
  // a 32x32 variance check reads ~0 there and flakes), so the robust
  // ground-vs-space discriminator is MEAN luminance: grey terrain ≈ 120–160,
  // a starfield is dark (≈ 20–40). canvasRegionStats over the DOM lower band
  // (y > 0.6). Polled: right after landing the terrain can still be filling
  // the draw buffer under SwiftShader, so a single unrendered frame would
  // flake the check (best-of over ~5 s).
  const tGround = Date.now();
  let groundMean = -1;
  while (groundMean < 60 && Date.now() - tGround < 5_000) {
    groundMean = Math.max(
      groundMean,
      (await canvasRegionStats(page, { x0: 0, y0: 0.6, x1: 1, y1: 1 })).mean,
    );
    if (groundMean < 60) await page.waitForTimeout(500);
  }
  expect(
    groundMean,
    'lower-band mean luminance (ground on screen, not a starfield)',
  ).toBeGreaterThanOrEqual(60);
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-87-1.png'),
  });
  console.log(
    `[TASK-87] ON SURFACE planet=${terrain.planetId} chunks=${terrain.mountedChunks} ` +
      `groundMean=${groundMean.toFixed(1)} airless=${airless}`,
  );

  assertClean();
  await context.close();
});
