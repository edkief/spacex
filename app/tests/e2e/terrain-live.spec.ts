import path from 'node:path';
import { expect, test } from './fixtures';
import {
  canvasLuminanceVariance,
  canvasMaxLuminance,
  collectErrors,
  uniqueCallsign,
} from './helpers';
import { RawWsClient } from './raw-ws';

/**
 * TASK-84 — E2E: the streamed terrain is MOUNTED in the live game, in the
 * server's world frame, and the pad sits flush with it.
 *
 * Before this task nothing in the live game instantiated the terrain
 * pipeline — players walked on an invisible flat plane under the haze while
 * the server collided them with real heights. This spec:
 *
 *  1. claims a fresh player, GET /api/dev/pad-target?systemId=<home> (TASK-76
 *     contract; when the home system has no landable atmospheric planet the
 *     first star-order pad is used and the ship warps there over raw WS, the
 *     landing.spec.ts pattern — the teleport acts on the ship's CURRENT
 *     system);
 *  2. teleports the ship to { pad.x + 300, pad.y + 150, pad.z } (inside the
 *     atmosphere, above terrain, well inside the 4 km mount range of the
 *     planet's anchor) and polls `window.__PLANETS__.terrain()` until the
 *     WorldManager has mounted >= 9 chunks of that planet's terrain;
 *  3. asserts the LOWER half of the canvas is non-uniform (luminance
 *     variance via the existing GL readPixels helper, lower-half regions
 *     only) — terrain is actually on screen, not just in the scene graph —
 *     and saves .ralph/screenshots/TASK-84-1.png;
 *  4. teleports into the pad's 20 m dock disc (the sim docks it), disembarks
 *     (E) and asserts the on-foot view: the character capsule is dead-center
 *     (max luminance, disembark.spec.ts pattern) AND the lower half is still
 *     non-uniform — the character stands ON visible terrain — saving
 *     .ralph/screenshots/TASK-84-2.png.
 */

const PROTOCOL_VERSION = 1; // mirrors @shared/protocol (Playwright does not resolve tsconfig aliases)

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

/**
 * The LOWER half of the canvas in GL coordinates (readPixels origin
 * bottom-left, 1280x720 viewport): y in [0, 360). Four spread 32x32 regions
 * — the terrain fills the whole lower half in both the flyover and the
 * on-foot view, so best-of-4 makes a flat-region false negative impossible.
 */
const LOWER_HALF: Array<[number, number]> = [
  [100, 80],
  [420, 200],
  [740, 100],
  [1040, 260],
];

/** Rendered self ship's distance from a world target (u); -1 if not spawned. */
function probeDistance(
  page: import('@playwright/test').Page,
  t: { x: number; y: number; z: number },
): Promise<number> {
  return page.evaluate((target) => {
    const p = window.__SELF_SHIP__?.probe()?.pos;
    if (!p) return -1;
    return Math.hypot(p.x - target.x, p.y - target.y, p.z - target.z);
  }, t);
}

/** The live terrain mount probe (null = nothing mounted). */
function terrainProbe(page: import('@playwright/test').Page): Promise<{
  planetId: string;
  mountedChunks: number;
} | null> {
  return page.evaluate(() => {
    const t = window.__PLANETS__?.terrain?.() ?? null;
    return t ? { planetId: t.planetId, mountedChunks: t.mountedChunks } : null;
  });
}

test('streamed terrain mounts in the live game; the pad is flush with the ground', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL, apiPort } = e2eServer;
  test.setTimeout(180_000);
  const callsign = uniqueCallsign('terr');

  // (a) Claim — raw REST, same shape the claim flow stores in localStorage.
  const claimRes = await fetch(`${baseURL}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  expect(claimRes.status).toBe(201);
  const session = (await claimRes.json()) as ClaimResponse;
  const auth = { authorization: `Bearer ${session.token}` };

  // (b) The pad target, scoped to the HOME system (TASK-76 contract). The
  // home system has a landable atmospheric planet only for some seeds — when
  // it does not (404), fall back to the first star-order pad and warp the
  // ship there over raw WS (the teleport acts on the ship's CURRENT system).
  const homeRes = await fetch(`${baseURL}/api/dev/pad-target?systemId=${session.homeSystemId}`, {
    headers: auth,
  });
  let target: PadTarget;
  if (homeRes.status === 200) {
    target = (await homeRes.json()) as PadTarget;
  } else {
    expect(homeRes.status).toBe(404);
    const anyRes = await fetch(`${baseURL}/api/dev/pad-target`, { headers: auth });
    expect(anyRes.status).toBe(200);
    target = (await anyRes.json()) as PadTarget;
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
      await client.next(
        (m) => m.type === 'warp_arrived',
        'warp_arrived (pad system)',
        10_000,
      );
    }
    client.close();
  }

  // (c) Browser: same token → join the pad's system.
  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  await page.goto(baseURL);
  await page.evaluate((s) => localStorage.setItem('drift.session.v1', JSON.stringify(s)), session);
  await page.goto(`${baseURL}/?sys=${target.systemId}`);
  await expect(page.locator('#sys-id')).toBeVisible({ timeout: 20_000 });

  // Chase camera armed (TASK-72 hook): the self ship projects in front.
  await expect
    .poll(() => page.evaluate(() => !!window.__SELF_SHIP__?.probe()?.screen), {
      timeout: 20_000,
      message: 'chase camera never acquired the self ship',
    })
    .toBe(true);

  // The first input undocks a docked ship — tap W once BEFORE the teleport so
  // the hard-set lands on an in-flight ship (planets-visible.spec.ts pattern).
  await page.keyboard.press('w');

  // (1) Teleport inside the atmosphere, 300 m horizontally off the pad, 150 m
  // above it — deep inside the 4 km mount range of the planet's anchor.
  const flyPoint = { x: target.pad.x + 300, y: target.pad.y + 150, z: target.pad.z };
  let tele = await page.request.post(`${baseURL}/api/dev/teleport`, {
    headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' },
    data: flyPoint,
  });
  expect(tele.status(), `teleport response: ${await tele.text()}`).toBe(200);
  await expect
    .poll(() => probeDistance(page, flyPoint), {
      timeout: 20_000,
      message: 'teleported ship never reached the flyover point',
    })
    .toBeLessThan(50);

  // (2) The WorldManager MOUNTED this planet's streamed terrain: the
  // __PLANETS__.terrain() probe reports the planet's id and >= 9 mounted
  // chunks (the 3x3 ring around the feed — the 4 ms/frame budget fills it in
  // seconds; allow a long settle for the software-GL e2e VM).
  await expect
    .poll(async () => (await terrainProbe(page))?.mountedChunks ?? -1, {
      timeout: 90_000,
      message: 'terrain never mounted 9+ chunks in the live game',
    })
    .toBeGreaterThanOrEqual(9);
  const terrain = (await terrainProbe(page)) as { planetId: string; mountedChunks: number };
  expect(terrain.planetId, 'mounted terrain belongs to the pad planet').toBe(target.planetId);
  expect(terrain.mountedChunks, 'at least the 3x3 near ring is mounted').toBeGreaterThanOrEqual(9);

  // (3) The LOWER half of the canvas is non-uniform — terrain is on screen.
  const lower = await canvasLuminanceVariance(page, LOWER_HALF);
  expect(lower, 'lower-half canvas luminance variance (terrain rendered)').toBeGreaterThan(1);
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-84-1.png'),
  });
  console.log(
    `[TASK-84] flyover terrain planet=${terrain.planetId} chunks=${terrain.mountedChunks} ` +
      `lowerVariance=${lower.toFixed(1)}`,
  );

  // (4) LAND: teleport into the pad's 20 m dock disc; the pad machine docks
  // the ship and the client renders #docked-indicator.
  tele = await page.request.post(`${baseURL}/api/dev/teleport`, {
    headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' },
    data: { x: target.pad.x, y: target.pad.y + 5, z: target.pad.z },
  });
  expect(tele.status(), `dock teleport response: ${await tele.text()}`).toBe(200);
  await expect(page.locator('#docked-indicator')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#leave-ship-prompt')).toBeVisible({ timeout: 10_000 });

  // (5) DISSEMBARK: E sends the 'exit_ship' frame; the client goes on foot.
  await page.keyboard.press('e');
  await expect(page.locator('#leave-ship-prompt')).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('#docked-indicator')).toBeHidden({ timeout: 15_000 });

  // (6) The 600 ms camera handoff settles into the on-foot view: the cyan
  // character capsule dead-center (max luminance ~190, flat screen << 120)
  // AND the lower half still non-uniform — the character stands ON visible
  // terrain, the pad flush with it.
  await page.waitForTimeout(1_500);
  const maxLum = await canvasMaxLuminance(page, 624, 344);
  expect(maxLum, 'on-foot capsule luminance (character rendered)').toBeGreaterThan(120);
  const onFoot = await canvasLuminanceVariance(page, LOWER_HALF);
  expect(onFoot, 'on-foot lower-half variance (terrain under the character)').toBeGreaterThan(1);
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-84-2.png'),
  });
  console.log(
    `[TASK-84] on-foot capsule=${maxLum.toFixed(1)} lowerVariance=${onFoot.toFixed(1)} ` +
      `padSystem=${target.systemId}`,
  );

  assertClean();
  await context.close();
});
