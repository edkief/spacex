import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { systemForId } from '../../src/shared/galaxy/system';
import { planetAnchor, planetAtmosphereRadius } from '../../src/shared/galaxy/planets';
import { generateSurfaceChunk, CELL_SIZE_M, CHUNK_SIZE } from '../../src/shared/galaxy/surface';
import type { Planet } from '../../src/shared/galaxy/types';

/**
 * TASK-98 — E2E: on an ATMOSPHERIC planet the ship can MOVE and can LEAVE.
 *
 * The owner-reported bug: once on a planet the ship doesn't accelerate
 * anymore — the shared flight model applied the main thruster ONLY in the
 * 'space' branch, so on a planet W/S did nothing, gravity grounded the ship
 * and the only escape was a drag-limited VTOL crawl (minutes to clear the
 * 1 km band) — effectively inescapable. The fix puts the forward-axis thrust
 * (with the TASK-81 clamp) into the shared atmosphere/surface branch, so the
 * server tick, the client predictor and the AI all gain real atmospheric
 * flight.
 *
 * Target: a landable ATMOSPHERIC planet in the player's home system (claim
 * players until one has one — ~90% of the seeded systems do, so the first
 * claim almost always hits; same pattern as planet-approach.spec.ts).
 *
 * Phase A "can move": the ship is dev-teleported to REST (velocity 0) ~200 u
 * above the terrain at the planet anchor (inside the 1 km band, regime
 * 'atmosphere'); holding W (forward thrust) must raise the SERVER-reported
 * speed above 5 u/s within ~10 s (pre-fix it stayed ~0 — the bug).
 *
 * Phase B "can leave": re-teleport to REST ~200 u above the terrain (so the
 * horizontal speed is 0 and the VTOL lift is allowed); holding the VTOL key
 * (Space) must climb the ship out of the 1.05×1000 u exit radius — the wire
 * flightRegime becomes 'space' (the ship left the planet) within a generous
 * ~90 s (the near-surface climb is drag-limited for a scout).
 *
 * Observation: the browser's own inbound entity_updates (an init-script
 * WebSocket tap, the flight.spec.ts pattern) — the server-authoritative
 * pos + vel + flightRegime every in-system peer receives.
 */

const SEED = 'DRIFT-SEED-0001'; // mirrors src/server/env.ts — the fixture never overrides it

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
}

interface ClaimResponse {
  token: string;
  playerId: string;
  callsign: string;
  homeSystemId: string;
  shipId: string;
}

/** Tap the self ship's entity_update frames (pos + vel + wire regimes). */
function tapShipUpdates(callsign: string): void {
  const w = window as unknown as { __t98?: Tap[] };
  w.__t98 = [];
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
            w.__t98?.push({
              pos: e.pos,
              vel: e.vel ?? { x: 0, y: 0, z: 0 },
              regime: e.regime ?? 'sublight',
              flightRegime: e.flightRegime ?? 'space',
            });
        } catch {
          /* never break the page */
        }
      });
    }
  };
}

/** Deterministic terrain height (m) at world (x, z) — the shared chunk generator. */
function terrainHeightAt(planet: Planet, x: number, z: number): number {
  const gx = Math.floor(x / CELL_SIZE_M);
  const gz = Math.floor(z / CELL_SIZE_M);
  const chunk = generateSurfaceChunk(
    SEED,
    planet,
    Math.floor(gx / CHUNK_SIZE),
    Math.floor(gz / CHUNK_SIZE),
  );
  const lx = ((gx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  const lz = ((gz % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  return chunk.heightmap[lz * CHUNK_SIZE + lx];
}

/** Server tap: the latest entity_update frame for our ship. */
const lastTap = (page: Page): Promise<Tap | null> =>
  page.evaluate(() => {
    const ups = (window as unknown as { __t98?: Tap[] }).__t98 ?? [];
    return ups[ups.length - 1] ?? null;
  });

/** Dev-teleport (velocity 0 by default) + wait for the SERVER to confirm it. */
async function teleportRest(page: Page, baseURL: string, token: string, to: Vec3): Promise<void> {
  const res = await page.request.post(`${baseURL}/api/dev/teleport`, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    data: to,
  });
  expect(res.status(), `teleport response: ${await res.text()}`).toBe(200);
  // The dev route hard-sets the server state synchronously; the 10 Hz
  // broadcast carries it on the next frame.
  await expect
    .poll(
      async () => {
        const t = await lastTap(page);
        return t ? Math.hypot(t.pos.x - to.x, t.pos.y - to.y, t.pos.z - to.z) < 50 : false;
      },
      {
        timeout: 10_000,
        message: `server never confirmed the REST teleport to ${JSON.stringify(to)}`,
      },
    )
    .toBe(true);
}

test('atmospheric planet: the ship can move (W) and can leave (VTOL climb to space)', async ({
  browser,
  e2eServer,
}) => {
  test.setTimeout(180_000);
  const { baseURL } = e2eServer;
  const callsign = uniqueCallsign('t98');

  // (a) Claim a fresh player whose home system has a landable ATMOSPHERIC
  // planet (~90% of systems do — the first claim almost always hits).
  let session: ClaimResponse | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    const cs = attempt === 0 ? callsign : uniqueCallsign('t98b');
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
    if (hasAtmo) {
      session = cand;
      break;
    }
  }
  expect(session, 'claimed a player with a landable atmospheric home planet').toBeTruthy();

  // (b) Deterministic target: the first landable atmospheric planet.
  const system = systemForId(SEED, session!.homeSystemId);
  expect(system, 'home system exists').toBeTruthy();
  const idx = system!.planets.findIndex((p) => p.landable && p.hasAtmosphere);
  const planet = system!.planets[idx];
  const anchor = planetAnchor(idx);
  const atmoR = planetAtmosphereRadius(planet);
  expect(atmoR).toBeGreaterThan(0);
  // Phase A point: ~200 u above the terrain AT the anchor (inside the band).
  const groundA = terrainHeightAt(planet, anchor.x, anchor.z);
  const pointA = { x: anchor.x, y: groundA + 200, z: anchor.z };
  // Phase B point: ~200 u above the terrain 300 u east of the anchor — still
  // in the band (|Δ| = 360 u < 1 km) and clear of where phase A ends, so the
  // REST re-teleport is unambiguous.
  const pointBx = anchor.x + 300;
  const groundB = terrainHeightAt(planet, pointBx, anchor.z);
  const pointB = { x: pointBx, y: groundB + 200, z: anchor.z };
  const s = session!;
  console.log(
    `[TASK-98] player=${s.playerId} sys=${s.homeSystemId} planet=${planet.id} idx=${idx} ` +
      `class=${planet.class} anchor=${JSON.stringify(anchor)} A=${JSON.stringify(pointA)} B=${JSON.stringify(pointB)}`,
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

  // ---------- Phase A: can MOVE (forward thrust works in the atmosphere) ----------
  await teleportRest(page, baseURL, s.token, pointA);

  // The REST ship is wire-docked (starter home dock) until the FIRST input;
  // the tapped frames carry regime 'docked' — the speed assertion excludes
  // them. Hold W (forward thrust) and the SERVER-reported speed must rise
  // above 5 u/s within ~10 s. Pre-fix the thrust was ignored in atmosphere:
  // the speed stayed ~0 (gravity + drag only) — the bug.
  await page.keyboard.down('w');
  const wDownAt = Date.now();
  await expect
    .poll(
      async () => {
        const ups = await page.evaluate(() => (window as unknown as { __t98?: Tap[] }).__t98 ?? []);
        let best = 0;
        for (const u of ups) {
          if (u.regime === 'docked') continue;
          best = Math.max(best, Math.hypot(u.vel.x, u.vel.y, u.vel.z));
        }
        return best;
      },
      {
        timeout: 10_000,
        message: 'server speed never rose above 5 u/s while holding W in the atmosphere (the bug)',
      },
    )
    .toBeGreaterThan(5);
  const moveMs = Date.now() - wDownAt;

  // The visual artifact: mid-move, still holding W — the ship is IN THE AIR
  // (not on the ground) with the atmosphere HUD up.
  const probe = await page.evaluate(() => {
    const p = window.__SELF_SHIP__?.probe() ?? null;
    return p ? { pos: p.pos, screen: p.screen ? { x: p.screen.x, y: p.screen.y } : null } : null;
  });
  expect(probe, 'self ship probe during the atmospheric move').not.toBeNull();
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-98-1.png'),
  });
  await page.keyboard.up('w');
  console.log(
    `[TASK-98] A: move — speed > 5 u/s in ${moveMs} ms of W (server tap, non-docked frames)`,
  );

  // ---------- Phase B: can LEAVE (VTOL climb out of the band to 'space') ----------
  await teleportRest(page, baseURL, s.token, pointB);

  // At REST the horizontal speed is 0, so the VTOL lift is allowed (the
  // hSpeed < 5 gate). Hold Space (the VTOL key) and poll the wire
  // flightRegime: it must climb from 'atmosphere' to 'space' — past the
  // 1.05×1000 u exit radius, i.e. the ship LEFT the planet. The near-surface
  // climb is drag-limited (~10–30 u/s for a scout), so the budget is
  // generous (~90 s).
  await page.keyboard.down(' ');
  const spaceDownAt = Date.now();
  let finalRegime = '';
  await expect
    .poll(
      async () => {
        const t = await lastTap(page);
        finalRegime = t?.flightRegime ?? '';
        return finalRegime === 'space';
      },
      {
        timeout: 90_000,
        message: `wire flightRegime never reached 'space' within 90 s of VTOL (last: ${finalRegime})`,
      },
    )
    .toBe(true);
  const climbMs = Date.now() - spaceDownAt;

  // The visual artifact: after the regime flipped to 'space' — the ship
  // above the atmosphere dome.
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-98-2.png'),
  });
  await page.keyboard.up(' ');
  console.log(
    `[TASK-98] B: leave — wire flightRegime reached 'space' in ${climbMs} ms of VTOL ` +
      `(out of the ${Math.round(atmoR * 1.05)} u exit radius)`,
  );

  assertClean();
  await context.close();
});
