import path from 'node:path';
import { expect, test } from './fixtures';
import { collectErrors } from './helpers';

/**
 * TASK-27 (AC "e2e smoke — test the rig standalone with a scripted
 * ship/character pair (Playwright + exposed test hook)"): the disembark /
 * re-enter flows land in TASK-31/35, so this drives the REAL CameraRig
 * through a full cockpit → on-foot handoff headlessly via the dev-only
 * `window.__CAMERA__` hook (src/client/camera/camera-debug.ts) — a
 * scripted ship + character, an analytic mesa the straight path must
 * clear, and a fixed 10 ms clock. It asserts the whole contract in-page
 * (single animation, 600 ms input-lock window, 5-sample nudged path that
 * never enters terrain, pitch clamp, constant FOV) and renders the final
 * on-foot view into #__camera-probe-canvas for the screenshot.
 */

// Mirrors pose-math.ts constants (the Playwright runner does not resolve
// the app's tsconfig path aliases, so the spec cannot import them).
const HANDOFF_DURATION_MS = 600;
const HANDOFF_SAMPLES = 5;
const PITCH_LIMIT_DEG = 80;
const CAMERA_FOV = 75;
const MESA_HEIGHT = 6;
const MESA_RADIUS = 5;
const MESA_CENTER_Z = 8;
const CLEARANCE_M = 1.5;

// Cold vite transform of the app + three.js on first hit can eat seconds.
test.setTimeout(60_000);

test('camera handoff: scripted cockpit → on-foot, one 600 ms animation, path never enters terrain', async ({
  browser,
  e2eServer,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);

  await page.goto(e2eServer.baseURL);
  // The hook installs at module load; it needs no server data, but the
  // app has to be up (same wait as the other hook specs).
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__CAMERA__)), {
      timeout: 15_000,
      message: '__CAMERA__ hook never installed (dev-only; is this a DEV build?)',
    })
    .toBe(true);

  const result = await page.evaluate(async () => {
    const hook = window.__CAMERA__;
    if (!hook) throw new Error('__CAMERA__ hook missing (dev-only; is this a DEV build?)');
    return hook.handoffProbe();
  });

  console.log(
    `[TASK-27] handoff: starts=${result.starts} ends=${result.ends} ` +
      `lockWindow=${result.lockWindowMs.to - result.lockWindowMs.from}ms ` +
      `nudges=${result.nudges} terrainClear=${result.terrainClear} ` +
      `pitchClamped=${result.pitchClampedDeg.toFixed(1)}° fov=${result.fov} ` +
      `rendered=${result.rendered}`,
  );

  // Exactly ONE animation per direction change, start + end each once.
  expect(result.starts).toBe(1);
  expect(result.ends).toBe(1);
  // The input lock lasts exactly the 600 ms handoff.
  expect(result.lockWindowMs.to - result.lockWindowMs.from).toBe(HANDOFF_DURATION_MS);
  // 5 precomputed samples; the nudge actually lifted samples; and NO
  // sample sits inside the mesa (position >= height + clearance).
  expect(result.path).toHaveLength(HANDOFF_SAMPLES);
  expect(result.nudges).toBeGreaterThan(0);
  expect(result.terrainClear).toBe(true);
  for (const p of result.path) {
    const d = Math.hypot(p.x, p.z - MESA_CENTER_Z);
    const h = d <= MESA_RADIUS ? MESA_HEIGHT : 0;
    expect(p.y).toBeGreaterThanOrEqual(h + CLEARANCE_M - 1e-6);
  }
  // Input: rejected in cockpit, rejected mid-animation, drift-free during
  // the lock, accepted after — and the +172° pitch demand clamps to +80°.
  expect(result.cockpitLookRejected).toBe(true);
  expect(result.midLookRejected).toBe(true);
  expect(result.midLookYawDrift).toBe(0);
  expect(result.unlockedAfter).toBe(true);
  expect(result.pitchClampedDeg).toBeCloseTo(PITCH_LIMIT_DEG, 3);
  // One camera, FOV 75 constant, no swap.
  expect(result.fov).toBe(CAMERA_FOV);
  // The handoff started on the settled cockpit pose and ended on-foot.
  expect(result.startPose.position.y).toBeGreaterThan(result.endPose.position.y);
  expect(result.rendered).toBe(true);

  // The probe rendered the final on-foot view into #__camera-probe-canvas.
  await expect(page.locator('#__camera-probe-canvas')).toBeVisible();

  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-27-1.png'),
  });
  assertClean();
  await context.close();
});
