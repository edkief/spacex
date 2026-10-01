import path from 'node:path';
import { expect, test } from './fixtures';
import { collectErrors } from './helpers';

/**
 * TASK-26.2 (AC4 + its "recorded" clause): the total surface triangles of
 * the 13-chunk default-LOD benchmark scene (resting player: 9 near + 4
 * mid) measured via a REAL WebGL renderer — `renderer.info.render.triangles`
 * — asserted under the 400k draw-distance budget.
 *
 * The dev-only `window.__STREAM__` hook (src/client/stream-debug.ts) does
 * the rendering; it reuses the server-provided seed from /api/health (the
 * same source `__DRIFT__` is fed), so the planet is Torolm (dev-seed
 * fixture, planet index 0) derived the same way as everywhere else.
 * Headless WebGL is already proven working in this harness — core-flow
 * pixel-samples the game canvas.
 */

// Mirror of SURFACE_TRIANGLE_BUDGET (src/client/world/chunks.ts): the
// Playwright runner does not resolve the app's tsconfig path aliases, so
// the spec cannot import it directly.
const SURFACE_TRIANGLE_BUDGET = 400_000;
// Per-chunk ring triangle counts (RING_TRIANGLES, chunk-geometry.ts).
const NEAR_TRIS_PER_CHUNK = 8192;
const MID_TRIS_PER_CHUNK = 2048;
const RESTING_ACTIVE_CHUNKS = 13;

// Cold vite transform of the app + three.js on first hit can eat seconds.
test.setTimeout(60_000);

test('draw-distance budget: 13-chunk default-LOD scene under 400k surface tris', async ({
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
    const hook = window.__STREAM__;
    if (!hook) throw new Error('__STREAM__ hook missing (dev-only; is this a DEV build?)');
    return hook.surfaceBenchmark();
  });

  // Recorded in the test output (AC4 "measured ... and recorded").
  console.log(
    `[TASK-26.2] renderer.info 13-chunk budget: totalTris=${result.totalTris} ` +
      `(budget ${SURFACE_TRIANGLE_BUDGET}) | per-ring: near=${result.perRing.near} ` +
      `mid=${result.perRing.mid} far=${result.perRing.far} mounted=${result.perRing.mounted} ` +
      `| readyChunks=${result.readyChunks}`,
  );

  expect(result.readyChunks).toBe(RESTING_ACTIVE_CHUNKS);
  expect(result.perRing.near).toBe(9 * NEAR_TRIS_PER_CHUNK);
  expect(result.perRing.mid).toBe(4 * MID_TRIS_PER_CHUNK);
  expect(result.totalTris).toBeLessThan(SURFACE_TRIANGLE_BUDGET);

  await page.screenshot({
    path: path.join(__dirname, '../../../.ralph/screenshots/TASK-26.2-1.png'),
  });
  assertClean();
  await context.close();
});
