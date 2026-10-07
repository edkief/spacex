import path from 'node:path';
import { expect, test } from './fixtures';
import { canvasRegionStats, canvasScreenRegionMean, collectErrors, uniqueCallsign } from './helpers';
import { ClaimPage } from './pages/claim';

/**
 * TASK-83 — E2E: a planet is visible from 6 km, at its sim anchor.
 *
 * Before this task nothing marked where the planets were (TASK-82 removed the
 * miniature orrery and the sim places planet i as a flat region of the y = 0
 * plane at `planetAnchor(i) = ((i + 1) × 10 000, 0, 0)` — 10–60 km from the
 * camera, far beyond the 4000 u far plane). This spec teleports the self ship
 * 6 km short of planet 0's anchor (outside every atmosphere), turns the ship
 * around (D = right turn) until the anchor's projected screen point is in the
 * viewport, and asserts that the 12×12 region around it differs from the sky
 * band (mean luminance diff > 10) — the island slab is VISIBLE at 6 km, drawn
 * as a scaled proxy (exact direction + angular size, never far-clipped).
 *
 * We join a FIXED system (the first star of the default seed, DRIFT-SEED-0001)
 * so planet 0 is deterministic (terran, WITH an atmosphere) — the outer dome
 * is therefore guaranteed visible in the TASK-83-2 screenshot, which the AC
 * requires. All systems share the same anchor layout, so planet 0 is at
 * (10 000, 0, 0) whichever system is rendered.
 */

/** The first star of the default seed; its system's planet 0 is terran+atmo. */
const SYSTEM_ID = '7df0ed2af70ae07a';
/** Planet 0's sim anchor: ((0 + 1) × 10 000, 0, 0). */
const ANCHOR0 = { x: 10_000, y: 0, z: 0 };
/** 6 km short of the anchor, 400 m up — outside every 1 km atmosphere. */
const FAR_POINT = { x: ANCHOR0.x - 6_000, y: 400, z: 0 };
/** 1 500 m from the anchor (still outside the ~1 010 m dome) for the near shot. */
const NEAR_POINT = { x: ANCHOR0.x - 1_500, y: 400, z: 0 };
/** The sky reference band: the top 30 % of the canvas, above ship + planet. */
const TOP_BAND = { x0: 0, y0: 0, x1: 1, y1: 0.3 };

/** Rendered self ship's distance from a world target (u); -1 if not spawned. */
function probeDistance(page: import('@playwright/test').Page, t: { x: number; y: number; z: number }): Promise<number> {
  return page.evaluate((target) => {
    const p = window.__SELF_SHIP__?.probe()?.pos;
    if (!p) return -1;
    return Math.hypot(p.x - target.x, p.y - target.y, p.z - target.z);
  }, t);
}

/**
 * Planet 0's anchor screen point (CSS px, canvas-relative) when it is in
 * front of the camera and inside the canvas — null otherwise. This is the
 * SCALED-PROXY-exact point: the proxy sits on the camera→anchor ray, so the
 * anchor projects to the proxy's screen position.
 */
function planetAnchorScreen(page: import('@playwright/test').Page): Promise<{ x: number; y: number; dist: number } | null> {
  return page.evaluate(() => {
    const probe = window.__PLANETS__?.probe?.();
    if (!probe || probe.length === 0) return null;
    const s = probe[0].screen;
    if (!s) return null; // behind the camera
    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
    const w = canvas?.clientWidth || window.innerWidth;
    const h = canvas?.clientHeight || window.innerHeight;
    if (s.x < 0 || s.x > w || s.y < 0 || s.y > h) return null;
    return { x: s.x, y: s.y, dist: s.dist };
  });
}

test('planet 0 is visible at its sim anchor from 6 km (scaled proxy)', async ({
  browser,
  e2eServer,
}) => {
  const { baseURL } = e2eServer;
  test.setTimeout(150_000);

  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  const claim = new ClaimPage(page, baseURL);
  // Join the FIXED system so planet 0 is terran+atmo (dome guaranteed).
  await claim.claim(uniqueCallsign('planet'), SYSTEM_ID);
  await expect(page.locator('#sys-id')).toBeVisible({ timeout: 20_000 });

  // Chase camera armed (TASK-72 hook): the self ship projects in front.
  await expect
    .poll(() => page.evaluate(() => !!window.__SELF_SHIP__?.probe()?.screen), {
      timeout: 20_000,
      message: 'chase camera never acquired the self ship',
    })
    .toBe(true);

  // The first input undocks a docked ship — tap W once BEFORE the teleport so
  // the hard-set lands on an in-flight ship.
  await page.keyboard.press('w');

  // (1) Teleport 6 km short of planet 0's anchor (dev assist, bearer token).
  const token = await page.evaluate(() => localStorage.getItem('drift.token'));
  expect(token, 'session token in localStorage').toBeTruthy();
  let tele = await page.request.post(`${baseURL}/api/dev/teleport`, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    data: FAR_POINT,
  });
  expect(tele.status(), `teleport response: ${await tele.text()}`).toBe(200);

  await expect
    .poll(() => probeDistance(page, FAR_POINT), {
      timeout: 20_000,
      message: 'teleported ship never reached the 6 km point',
    })
    .toBeLessThan(50);

  // (2) The ship faces −X (the sun) on arrival; planet 0 is at +X, behind it.
  // Hold D (right turn) until the anchor's screen point is in the viewport.
  await page.keyboard.down('d');
  await expect
    .poll(() => planetAnchorScreen(page) !== null, {
      timeout: 10_000,
      message: 'planet 0 anchor never entered the viewport while turning (D)',
    })
    .toBe(true);
  await page.keyboard.up('d');
  const screen = await planetAnchorScreen(page);
  if (screen === null) throw new Error('planet 0 anchor screen point was null after the turn');

  // (3) The island is VISIBLE at 6 km: the 12×12 region around the anchor
  // differs from the sky band by more than 10 in mean luminance.
  const planetMean = await canvasScreenRegionMean(page, screen.x, screen.y, 12);
  const skyMean = (await canvasRegionStats(page, TOP_BAND)).mean;
  expect(planetMean, 'planet region should be sampled (not off-canvas)').toBeGreaterThan(0);
  expect(
    Math.abs(planetMean - skyMean),
    `planet(${planetMean.toFixed(1)}) vs sky(${skyMean.toFixed(1)}) must differ by > 10 at 6 km`,
  ).toBeGreaterThan(10);

  // Visual artifact: the terran island (+ outer dome) from 6 km, as a proxy
  // (.ralph/screenshots/TASK-83-1.png).
  await page.screenshot({ path: path.join(__dirname, '../../../.ralph/screenshots/TASK-83-1.png') });

  // (4) Close in to 1 500 m from the anchor — island + dome clearly visible
  // (.ralph/screenshots/TASK-83-2.png). The ship still faces the planet.
  tele = await page.request.post(`${baseURL}/api/dev/teleport`, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    data: NEAR_POINT,
  });
  expect(tele.status(), `near teleport response: ${await tele.text()}`).toBe(200);
  await expect
    .poll(() => probeDistance(page, NEAR_POINT), {
      timeout: 20_000,
      message: 'teleported ship never reached the 1 500 m point',
    })
    .toBeLessThan(50);
  // Let the chase camera settle on the new pose before the shot.
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(__dirname, '../../../.ralph/screenshots/TASK-83-2.png') });

  console.log(
    `[TASK-83] planet@6km mean=${planetMean.toFixed(1)} sky=${skyMean.toFixed(1)} ` +
      `diff=${Math.abs(planetMean - skyMean).toFixed(1)} anchorScreen=(${screen.x.toFixed(0)},${screen.y.toFixed(0)})`,
  );

  assertClean();
  await context.close();
});
