import path from 'node:path';
import { expect, test } from './fixtures';
import { collectErrors } from './helpers';

/**
 * TASK-28.3 (the density AC "in a render test"): the shared math already
 * proves two planets of the seeded galaxy differ by > 20% mid-boundary haze
 * (planets.test.ts). This is the RENDER counterpart: the dev-only
 * window.__ATMO__ hook (src/client/atmosphere-debug.ts) drives the real
 * atmosphere dome with those same shared numbers through a REAL WebGL
 * renderer (headless), and this spec asserts the density scaling is visible
 * in the rendered pixels — AND that the rendered color is exactly the
 * shared-math mix lerp(sky, atmo, hazeMid).
 *
 * The seed arrives unauthenticated from /api/health (the __DRIFT__ source);
 * no login needed. Headless WebGL is already proven in this harness
 * (core-flow / camera-handoff / streaming-budget).
 */

// Mirror of ATMOSPHERE_BOUNDARY_M (src/shared/physics/atmosphere.ts): the
// Playwright runner does not resolve the app's tsconfig path aliases, so
// the spec cannot import it directly.
const ATMOSPHERE_BOUNDARY_M = 1000;

// Cold vite transform of the app + three.js on first hit can eat seconds.
test.setTimeout(60_000);

test('atmosphere dome: density scaling visible in rendered pixels (min vs max haze > 20%)', async ({
  browser,
  e2eServer,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);

  await page.goto(e2eServer.baseURL);
  // The hook installs at module load; the seed arrives with /api/health.
  await expect
    .poll(() => page.evaluate(() => window.__DRIFT__?.seed ?? null), {
      timeout: 15_000,
      message: '__DRIFT__ server seed never arrived',
    })
    .not.toBeNull();

  const result = await page.evaluate(async () => {
    const hook = window.__ATMO__;
    if (!hook) throw new Error('__ATMO__ hook missing (dev-only; is this a DEV build?)');
    return hook.midBoundaryComparison();
  });

  // Recorded in the test output (the spec's "measured" clause).
  console.log(
    `[TASK-28.3] mid-boundary (${ATMOSPHERE_BOUNDARY_M / 2} m) dome probe: ` +
      `seed=${result.seed} systemsScanned=${result.systemsScanned}\n` +
      `  a (min haze): ${result.a.planetClass} ${result.a.planetId} ` +
      `density=${result.a.density.toFixed(4)} hazeMid=${result.a.hazeMid.toFixed(4)} ` +
      `pixel=[${result.a.pixel.join(',')}] ` +
      `expected=[${result.a.expected.map((v) => v.toFixed(1)).join(',')}] ` +
      `err=${result.a.pixelError.toFixed(2)}\n` +
      `  b (max haze): ${result.b.planetClass} ${result.b.planetId} ` +
      `density=${result.b.density.toFixed(4)} hazeMid=${result.b.hazeMid.toFixed(4)} ` +
      `pixel=[${result.b.pixel.join(',')}] ` +
      `expected=[${result.b.expected.map((v) => v.toFixed(1)).join(',')}] ` +
      `err=${result.b.pixelError.toFixed(2)}`,
  );

  // The density AC: a thin-atmosphere planet is visibly less hazy — the
  // mid-boundary haze factor of the two seeded planets differs by > 20%.
  expect(result.hazeDiff, 'min/max mid-boundary haze must differ by > 20%').toBeGreaterThan(0.2);
  // The rendered dome center pixel matches the shared-math mix
  // lerp(sky, atmo, hazeMid) within 3/255 per channel (the density scaling
  // is visibly IN the pixels).
  expect(
    result.pixelError,
    'rendered center pixel must match the shared-math mix within 3/255',
  ).toBeLessThanOrEqual(3);
  // And the two planets' sampled pixels visibly differ.
  const pixelGap = Math.max(
    Math.abs(result.a.pixel[0] - result.b.pixel[0]),
    Math.abs(result.a.pixel[1] - result.b.pixel[1]),
    Math.abs(result.a.pixel[2] - result.b.pixel[2]),
  );
  expect(pixelGap, 'the two sampled dome pixels must visibly differ (> 5/255)').toBeGreaterThan(5);

  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-28.3-1.png'),
  });
  assertClean();
  await context.close();
});
