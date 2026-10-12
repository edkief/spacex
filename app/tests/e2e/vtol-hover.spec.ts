import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { systemForId } from '../../src/shared/galaxy/system';
import { planetAnchor, planetAtmosphereRadius } from '../../src/shared/galaxy/planets';
import { generateSurfaceChunk, CELL_SIZE_M, CHUNK_SIZE } from '../../src/shared/galaxy/surface';
import type { Planet } from '../../src/shared/galaxy/types';

/**
 * TASK-107 — E2E: the VTOL hover TOGGLE (the client half of TASK-106's
 * shared 10 m altitude-hold).
 *
 * One Space press (the VTOL key, atmosphere scheme) TOGGLES the client-side
 * hover state — while ON the flight loop sends the shared 'hover' tag every
 * input frame and the ship settles to 10 m ± 2 m above the terrain (the
 * server-authoritative physics, TASK-106); the next press disables it and
 * the ship descends to the ground. The ship HUD shows a HOVER indicator
 * exactly while the toggle is on and allowed, and the store AUTO-DISENGAGES
 * when the wire regime leaves atmosphere/surface (the __HOVER__ dev probe,
 * the e2e's deterministic read of the client input state).
 *
 * Setup mirrors atmospheric-flight.spec.ts (TASK-98): claim a player whose
 * home system has a landable ATMOSPHERIC planet, boot the browser into the
 * home system, dev-teleport the ship to REST ~40 m above the terrain at the
 * planet anchor (inside the 1 km band, regime 'atmosphere').
 *
 * Observation: the browser's own inbound entity_updates (an init-script
 * WebSocket tap) — the server-authoritative pos + vel + flightRegime. The
 * terrain height under the ship is computed with the SAME shared surface
 * generator + bilinear sampling the server's TerrainContext uses (same
 * seed, same seam), so the altitude assertions are exact.
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
  const w = window as unknown as { __t107?: Tap[] };
  w.__t107 = [];
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
            w.__t107?.push({
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

/**
 * Deterministic terrain height (m) at world (x, z) — the SAME bilinear
 * sampling over the shared chunk generator the server's TerrainContext
 * uses (src/server/shard/terrain.ts heightAt: identical math, same seed).
 */
function terrainHeightAt(planet: Planet, x: number, z: number): number {
  const fx = x / CELL_SIZE_M;
  const fz = z / CELL_SIZE_M;
  const cx = Math.floor(fx);
  const cz = Math.floor(fz);
  const tx = fx - cx;
  const tz = fz - cz;
  const cell = (cellX: number, cellZ: number): number => {
    const chunkX = Math.floor(cellX / CHUNK_SIZE);
    const chunkZ = Math.floor(cellZ / CHUNK_SIZE);
    const chunk = generateSurfaceChunk(SEED, planet, chunkX, chunkZ);
    const lx = ((cellX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const lz = ((cellZ % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    return chunk.heightmap[lz * CHUNK_SIZE + lx];
  };
  const h00 = cell(cx, cz);
  const h10 = cell(cx + 1, cz);
  const h01 = cell(cx, cz + 1);
  const h11 = cell(cx + 1, cz + 1);
  const top = h00 + (h10 - h00) * tx;
  const bottom = h01 + (h11 - h01) * tx;
  return top + (bottom - top) * tz;
}

/** Server tap: the latest entity_update frame for our ship. */
const lastTap = (page: Page): Promise<Tap | null> =>
  page.evaluate(() => {
    const ups = (window as unknown as { __t107?: Tap[] }).__t107 ?? [];
    return ups[ups.length - 1] ?? null;
  });

/** Altitude (m) of a tap above the deterministic terrain under it. */
function altitudeOf(t: Tap, planet: Planet): number {
  return t.pos.y - terrainHeightAt(planet, t.pos.x, t.pos.z);
}

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

test('VTOL hover: one Space press toggles the 10 m hold, the next descends, space auto-offers', async ({
  browser,
  e2eServer,
}) => {
  test.setTimeout(180_000);
  const { baseURL } = e2eServer;
  const callsign = uniqueCallsign('t107');

  // (a) Claim a fresh player whose home system has a landable ATMOSPHERIC
  // planet (~90% of systems do — the first claim almost always hits).
  let session: ClaimResponse | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    const cs = attempt === 0 ? callsign : uniqueCallsign('t107b');
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
  const s = session!;

  // (b) Deterministic target: the first landable atmospheric planet.
  const system = systemForId(SEED, s.homeSystemId);
  expect(system, 'home system exists').toBeTruthy();
  const idx = system!.planets.findIndex((p) => p.landable && p.hasAtmosphere);
  const planet = system!.planets[idx];
  const anchor = planetAnchor(idx);
  const atmoR = planetAtmosphereRadius(planet);
  expect(atmoR).toBeGreaterThan(0);
  const groundA = terrainHeightAt(planet, anchor.x, anchor.z);
  // REST ~40 m above the terrain at the anchor (inside the band, atmosphere).
  const pointA = { x: anchor.x, y: groundA + 40, z: anchor.z };
  console.log(
    `[TASK-107] player=${s.playerId} sys=${s.homeSystemId} planet=${planet.id} idx=${idx} ` +
      `anchor=${JSON.stringify(anchor)} A=${JSON.stringify(pointA)}`,
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

  await teleportRest(page, baseURL, s.token, pointA);

  // ---------- Phase A: one Space press (NO hold) engages the 10 m hold ----------
  // The first input also takes the (wire-docked) ship off — the 'hover'
  // frame is a non-zero demand that beats the TASK-78 idle-frame gate.
  await page.keyboard.press(' ');
  const hoverOnAt = Date.now();
  await expect
    .poll(
      async () => {
        const t = await lastTap(page);
        if (!t || t.regime === 'docked') return false;
        return Math.abs(altitudeOf(t, planet) - 10) <= 2 && Math.abs(t.vel.y) < 0.5;
      },
      {
        timeout: 15_000,
        message: 'ship never settled to 10 m ± 2 m above the terrain within 15 s of the toggle',
      },
    )
    .toBe(true);
  const settleMs = Date.now() - hoverOnAt;

  // The HUD HOVER indicator is lit while the toggle is on (atmosphere).
  await expect(page.locator('#ship-hud-hover')).toBeVisible();
  // The pad DOCKED indicator is gone (the ship left the home dock).
  await expect(page.locator('#docked-indicator')).toBeHidden();

  // The visual artifact: hovering 10 m over the surface — the chase camera
  // has the ship in view (terrain below).
  const probe = await page.evaluate(() => {
    const p = window.__SELF_SHIP__?.probe() ?? null;
    return p ? { x: p.screen?.x ?? null, y: p.screen?.y ?? null } : null;
  });
  expect(probe, 'self ship probe while hovering').not.toBeNull();
  expect(probe!.x, 'ship in view (x)').not.toBeNull();
  expect(probe!.y, 'ship in view (y)').not.toBeNull();
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-107-1.png'),
  });

  // STAYS there for 5 s (± 2 m, |vel.y| < 0.5 u/s — the settled hover).
  let worstAlt = 0;
  let worstVel = 0;
  const holdT0 = Date.now();
  while (Date.now() - holdT0 < 5_000) {
    const t = await lastTap(page);
    if (t && t.regime !== 'docked') {
      worstAlt = Math.max(worstAlt, Math.abs(altitudeOf(t, planet) - 10));
      worstVel = Math.max(worstVel, Math.abs(t.vel.y));
    }
    await page.waitForTimeout(100);
  }
  expect(worstAlt, '5 s hold: altitude stayed within ± 2 m of 10 m').toBeLessThan(2);
  expect(worstVel, '5 s hold: |vel.y| stayed < 0.5 u/s').toBeLessThan(0.5);
  console.log(
    `[TASK-107] A: settled in ${settleMs} ms (10 m ± 2 m, |vel.y| < 0.5); 5 s hold worst ` +
      `Δalt=${worstAlt.toFixed(2)} m vel.y=${worstVel.toFixed(3)} u/s`,
  );

  // ---------- Phase B: the next press disengages; the ship descends ----------
  await page.keyboard.press(' ');
  const offAt = Date.now();
  await expect(page.locator('#ship-hud-hover')).toBeHidden();
  await expect
    .poll(
      async () => {
        const t = await lastTap(page);
        if (!t || t.regime === 'docked') return false;
        return altitudeOf(t, planet) <= 1.5; // grounded (the terrain clamp)
      },
      {
        timeout: 15_000,
        message: 'ship never descended to the ground within 15 s of the toggle-off',
      },
    )
    .toBe(true);
  const descendMs = Date.now() - offAt;
  console.log(`[TASK-107] B: descended to the ground in ${descendMs} ms of toggle-off`);

  // The dev probe agrees with the store (hover off after the second press).
  expect(await page.evaluate(() => window.__HOVER__?.on ?? null)).toBe(false);

  // ---------- Phase D: leave the atmosphere → the store auto-offers ----------
  // Re-engage the hover (the ship lifts back to the 10 m hold), then put
  // the ship OUTSIDE the atmosphere with the dev teleport (the deterministic
  // way to flip the wire regime to 'space' while the toggle is ON — the
  // hover controller itself holds the ship at 10 m, so a real climb is
  // impossible with the toggle on).
  await page.keyboard.press(' ');
  await expect
    .poll(
      async () => {
        const t = await lastTap(page);
        if (!t || t.regime === 'docked') return false;
        return Math.abs(altitudeOf(t, planet) - 10) <= 2 && Math.abs(t.vel.y) < 0.5;
      },
      {
        timeout: 15_000,
        message: 'ship never re-settled at 10 m after the re-engage',
      },
    )
    .toBe(true);
  expect(await page.evaluate(() => window.__HOVER__?.on ?? null), 'hover re-engaged').toBe(true);
  await expect(page.locator('#ship-hud-hover')).toBeVisible();

  // Above the exit radius (atmoR × 1.05 = 1050 in world-y) → wire 'space'.
  // (planetAnchor has no y — base the altitude on the terrain height, which
  // adds margin over the 1050 boundary.)
  const spacePoint = { x: anchor.x, y: groundA + atmoR * 1.2, z: anchor.z };
  await teleportRest(page, baseURL, s.token, spacePoint);
  await expect
    .poll(
      async () => (await lastTap(page))?.flightRegime ?? '',
      {
        timeout: 15_000,
        message: "wire flightRegime never reached 'space' after the teleport",
      },
    )
    .toBe('space');

  // The wire regime left atmosphere/surface → the store AUTO-OFFERED
  // (within the next 10 Hz entity_update the main.tsx handler force-offers).
  await expect
    .poll(async () => (await page.evaluate(() => window.__HOVER__?.on ?? null)) === false, {
      timeout: 5_000,
      message: 'hover store never auto-offered after the regime left the atmosphere',
    })
    .toBe(true);
  await expect(page.locator('#ship-hud-hover')).toBeHidden();
  console.log('[TASK-107] D: hover auto-offered on the space regime flip (probe + HUD)');

  assertClean();
  await context.close();
});
