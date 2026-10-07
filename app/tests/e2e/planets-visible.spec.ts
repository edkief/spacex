import path from 'node:path';
import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
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

/** Wrap a signed angle (rad) to [-π, π] — the shortest arc. */
function wrapAngle(a: number): number {
  let r = a % (2 * Math.PI);
  if (r > Math.PI) r -= 2 * Math.PI;
  if (r < -Math.PI) r += 2 * Math.PI;
  return r;
}

/**
 * The ship's world YAW (rad): forward = rot·(0,0,1), φ = atan2(fx, fz). The
 * nose is +Z in the ship's local frame (ship-mesh.ts), so a +Y rotation
 * carries +Z → +X and φ = +π/2 reads "facing +X". Null until the ship spawns.
 */
function shipYaw(page: import('@playwright/test').Page): Promise<number | null> {
  return page.evaluate(() => {
    const p = window.__SELF_SHIP__?.probe();
    if (!p?.rot) return null;
    const { x, y, z, w } = p.rot;
    const fx = 2 * (y * w + z * x);
    const fz = 1 - 2 * (x * x + y * y);
    return Math.atan2(fx, fz);
  });
}

/**
 * ATOMIC planet-visibility sample: in ONE evaluate, read planet 0's anchor
 * screen point and, if it sits comfortably inside the canvas (≥ margin px),
 * sample the mean luminance of a `size`×`size` GL region there AND of the top
 * sky band — so the point and the sample can never disagree on pose. Returns
 * null while the anchor is out of the safe box (still converging / at the
 * edge); the caller polls until non-null. Sampling in the same frame is what
 * kills the read→sample race (a separate read of the screen point can land on
 * one side of the viewport boundary while the sample lands on the other).
 */
function samplePlanet(
  page: import('@playwright/test').Page,
  opts: { size?: number; margin?: number } = {},
): Promise<{ x: number; y: number; planetMean: number; skyMean: number; dist: number } | null> {
  const size = opts.size ?? 12;
  const margin = opts.margin ?? 90;
  return page.evaluate(
    ({ size, margin, band }) => {
      const probe = window.__PLANETS__?.probe?.();
      const s = probe && probe.length > 0 ? probe[0].screen : null;
      if (!s) return null; // behind the camera
      const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
      const gl = (canvas?.getContext('webgl2') ??
        canvas?.getContext('webgl')) as WebGLRenderingContext | null;
      if (!canvas || !gl) return null;
      const w = canvas.clientWidth || canvas.width;
      const h = canvas.clientHeight || canvas.height;
      if (s.x < margin || s.x > w - margin || s.y < margin || s.y > h - margin) return null;
      // Mean of a size×size GL region centred on a CSS-px (top-left) point.
      const regionMean = (cx: number, cy: number) => {
        const sx = canvas.width / (canvas.clientWidth || canvas.width);
        const sy = canvas.height / (canvas.clientHeight || canvas.height);
        const gx = Math.round(cx * sx) - (size >> 1);
        const gy = canvas.height - Math.round(cy * sy) - (size >> 1);
        if (gx < 0 || gy < 0 || gx + size > canvas.width || gy + size > canvas.height) return -1;
        const buf = new Uint8Array(size * size * 4);
        gl.readPixels(gx, gy, size, size, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        let sum = 0;
        for (let i = 0; i < size * size; i++)
          sum += (buf[i * 4] + buf[i * 4 + 1] + buf[i * 4 + 2]) / 3;
        return sum / (size * size);
      };
      // The top sky band (DOM fractions, top-left origin) — GL y is flipped.
      const bw = Math.ceil(band.x1 * canvas.width);
      const bh = Math.ceil(band.y1 * canvas.height);
      const bbuf = new Uint8Array(bw * bh * 4);
      gl.readPixels(0, canvas.height - bh, bw, bh, gl.RGBA, gl.UNSIGNED_BYTE, bbuf);
      let bsum = 0;
      for (let i = 0; i < bw * bh; i++)
        bsum += (bbuf[i * 4] + bbuf[i * 4 + 1] + bbuf[i * 4 + 2]) / 3;
      return {
        x: s.x,
        y: s.y,
        planetMean: regionMean(s.x, s.y),
        skyMean: bsum / (bw * bh),
        dist: s.dist,
      };
    },
    { size, margin, band: TOP_BAND },
  );
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

  // (2) Face planet 0's anchor. On arrival the ship faces −X (the sun) and
  // the anchor sits at +X — dead behind it. We steer by the ship's ACTUAL
  // nose yaw, not a blind timed hold: a timed D-hold races the anchor's
  // ~0.2 s transit through the viewport (it leaves before the key release
  // lands). Instead read the nose bearing, probe D for one short burst to
  // learn which key closes the angle, then hold THAT key until the nose is
  // within ~14° of the anchor bearing. Polling the YAW (a wide, monotonic
  // signal) — not the anchor's narrow in-viewport window — is what kills the
  // race: the instant the nose is close we release, the ship is stationary,
  // and the island (a ~37° disc at 6 km) sits well inside the ~107° FOV.
  const targetYaw = Math.atan2(ANCHOR0.x - FAR_POINT.x, ANCHOR0.z - FAR_POINT.z);
  const y0 = await shipYaw(page);
  if (y0 === null) throw new Error('ship yaw probe was null before the turn');
  // Learn D's sign: a short burst, then compare the bearing change. (400 ms
  // hold + 400 ms settle — the rendered pose lags the input behind the 10 Hz
  // snapshot reconcile, so a longer burst gives a clean, signed bearing move.)
  await page.keyboard.down('d');
  await page.waitForTimeout(400);
  await page.keyboard.up('d');
  await page.waitForTimeout(400); // let the predictor + chase camera settle
  const y1 = await shipYaw(page);
  if (y1 === null) throw new Error('ship yaw probe was null after the D probe');
  const dSign = Math.sign(wrapAngle(y1 - y0));
  const key = Math.sign(wrapAngle(targetYaw - y1)) === dSign ? 'd' : 'a';
  // Hold the chosen key until the nose is within ~14° of the anchor bearing.
  await page.keyboard.down(key);
  await expect
    .poll(
      async () => {
        const s = await shipYaw(page);
        return s !== null && Math.abs(wrapAngle(targetYaw - s)) < 0.25;
      },
      { timeout: 15_000, message: 'ship never turned within 14° of planet 0' },
    )
    .toBe(true);
  await page.keyboard.up(key);
  // The rendered pose lags the key release (the ship PREDICTOR reconciles
  // against 10 Hz server snapshots, so a few frames of server-side coast +
  // the CHASE_ROT_K camera slerp keep the pose micro-shifting). Settle, then
  // poll the ATOMIC sampler — it returns a point + region + sky mean all in
  // ONE frame, and only when the anchor is ≥ 90px clear of every edge, so a
  // pose change can never split the read from the sample.
  await page.waitForTimeout(900);
  let sample: { x: number; y: number; planetMean: number; skyMean: number; dist: number } | null =
    null;
  const settleT0 = Date.now();
  while (sample === null && Date.now() - settleT0 < 8_000) {
    sample = await samplePlanet(page);
    if (sample === null) await page.waitForTimeout(120);
  }
  if (sample === null) {
    throw new Error(
      'planet 0 anchor was never comfortably in-viewport (turn did not settle on target)',
    );
  }
  const screen = { x: sample.x, y: sample.y, dist: sample.dist };

  // (3) The island is VISIBLE at 6 km: the 12×12 region around the anchor
  // differs from the sky band by more than 10 in mean luminance.
  const planetMean = sample.planetMean;
  const skyMean = sample.skyMean;
  expect(planetMean, 'planet region should be sampled (not off-canvas)').toBeGreaterThan(0);
  expect(
    Math.abs(planetMean - skyMean),
    `planet(${planetMean.toFixed(1)}) vs sky(${skyMean.toFixed(1)}) must differ by > 10 at 6 km`,
  ).toBeGreaterThan(10);

  // Visual artifact: the terran island (+ outer dome) from 6 km, as a proxy
  // (.ralph/screenshots/TASK-83-1.png).
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-83-1.png'),
  });

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
  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-83-2.png'),
  });

  console.log(
    `[TASK-83] planet@6km mean=${planetMean.toFixed(1)} sky=${skyMean.toFixed(1)} ` +
      `diff=${Math.abs(planetMean - skyMean).toFixed(1)} anchorScreen=(${screen.x.toFixed(0)},${screen.y.toFixed(0)})`,
  );

  assertClean();
  await context.close();
});
