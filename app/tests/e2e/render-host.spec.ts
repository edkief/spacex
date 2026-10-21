/**
 * TASK-73 — Real three.js render host.
 *
 * Verifies the client actually constructs a `THREE.WebGLRenderer`,
 * mounts a `THREE.Scene`, and ticks one `requestAnimationFrame`
 * loop driven by `FrameMonitor`. The harness boots the same
 * `bootAndWaitForOnline` path the render-smoke spec uses, then
 * reads the production debug seam `window.__driftRenderHost`.
 *
 * Why a separate spec (not an extension of `render-smoke.spec.ts`)?
 *   - The TASK-77 prod gate will gate on the exact assertions
 *     in this file, so a regression names the symptom directly
 *     in the failure report.
 *   - `render-smoke.spec.ts` only knows about the canvas id; it
 *     would need to grow significantly. Splitting the file keeps
 *     the regression report on one concept ("the renderer is
 *     live") instead of conflating "the canvas is non-black"
 *     with "the renderer is ticking".
 *
 * Acceptance contract (TASK-73 acceptance criteria + R-2):
 *   - After 1 s of idle waiting, `framesRendered` has increased
 *     from its initial sample (the rAF loop is alive).
 *   - `rendererInfo().drawCalls > 0` (the starfield is drawing).
 *   - `sceneChildCount >= 1` (the starfield mesh is parented).
 *   - The 2-D `sampleCanvasPixels` readback (used by
 *     `render-smoke.spec.ts` too) shows non-zero variance so the
 *     `preserveDrawingBuffer: true` flag is confirmed.
 */
import { test, expect, sampleCanvasPixels } from "./fixtures.js";
import { ClaimPage } from "./pages/claim.js";

test("real three.js render host ticks and frames a non-black starfield", async ({
  page,
  driftServer: server,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  const claim = new ClaimPage(page, server);
  await claim.bootAndWaitForOnline();

  // Read the prod debug seam. The render host installs it in the
  // useEffect that builds the renderer; `bootAndWaitForOnline`
  // already waits for the auth_ok handshake, which is fired
  // before the canvas mounts, so a small additional wait + poll
  // is required.
  const hostReady = await page.waitForFunction(
    () => {
      const w = window as unknown as {
        __driftRenderHost?: { framesRendered: number };
      };
      return w.__driftRenderHost !== undefined;
    },
    undefined,
    { timeout: 10_000 },
  );
  expect(hostReady).toBeTruthy();

  // Sample the per-frame info TWICE — once now, once after a
  // 1 s idle wait — and assert the renderer has advanced.
  const samples = await page.evaluate(async () => {
    const w = window as unknown as {
      __driftRenderHost?: {
        framesRendered: number;
        rendererInfo: () => { drawCalls: number; triangles: number };
        sceneChildCount: () => number;
      };
    };
    const host = w.__driftRenderHost;
    if (!host) throw new Error("missing __driftRenderHost");
    const first = host.framesRendered;
    // Wait one full second so the loop runs for ~60 frames.
    await new Promise((r) => setTimeout(r, 1_000));
    const second = host.framesRendered;
    return {
      first,
      second,
      info: host.rendererInfo(),
      sceneChildCount: host.sceneChildCount(),
    };
  });
  // eslint-disable-next-line no-console
  console.log(
    `[render-host] frames ${samples.first} -> ${samples.second} ` +
      `drawCalls=${samples.info.drawCalls} ` +
      `triangles=${samples.info.triangles} ` +
      `sceneChildCount=${samples.sceneChildCount}`,
  );

  expect(samples.first).toBeGreaterThan(0);
  expect(samples.second).toBeGreaterThan(samples.first);
  expect(samples.info.drawCalls).toBeGreaterThan(0);
  expect(samples.sceneChildCount).toBeGreaterThanOrEqual(1);

  // 2-D readback via the same seam the smoke spec uses — the
  // `preserveDrawingBuffer: true` flag is what makes the variance
  // > 0 here. A black canvas back would mean the flag is gone.
  const sample = await sampleCanvasPixels(page, 256);
  // eslint-disable-next-line no-console
  console.log(
    `[render-host] canvas ${sample.width}x${sample.height} ` +
      `variance=${sample.variance.toFixed(3)} ` +
      `starFraction=${sample.starFraction.toFixed(4)}`,
  );
  expect(
    sample.variance,
    "expected non-zero pixel variance (preserveDrawingBuffer must keep the swap chain readable)",
  ).toBeGreaterThan(0);

  await page.screenshot({
    path: "../.ralph/screenshots/TASK-73-render-host.png",
    fullPage: true,
  });

  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
});
