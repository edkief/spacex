/**
 * TASK-70 — Headless WebGL smoke.
 *
 * Verifies the canvas is not a black screen in Playwright's
 * Chromium by sampling a 256×256 patch of pixels via
 * `getImageData` on a 2D scratch canvas. A non-uniform
 * luminance distribution (variance > 0) means the WebGL
 * starfield is actually drawing.
 *
 * Why 256×256?
 *   - The starfield is sparse: ~800 points scattered across a
 *     1280×720 canvas with ~6 px radius. A 32×32 patch centred
 *     on the canvas can randomly fall between them and read
 *     back uniform clear colour even when the starfield is
 *     fully drawn. A 256×256 patch guarantees enough points
 *     land inside the sample that variance is reliably > 0.
 *
 * If the assertion fails, the dev server is up but the
 * headless chromium can't reach a WebGL context — consult the
 * `playwright.config.ts` comment about `chromium` launch args
 * (we tested without flags; if a future sandbox needs
 * `--use-gl=angle --use-angle=swiftshader`, document it there).
 *
 * The test runs first (alphabetical `r` < `c`) so a
 * regression on the GL setup surfaces immediately rather than
 * after the heavier multiplayer specs.
 */
import { test, expect, sampleCanvasPixels } from "./fixtures.js";
import { ClaimPage } from "./pages/claim.js";

test("headless Chromium renders the WebGL starfield (canvas not black)", async ({
  page,
  driftServer: server,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  const claim = new ClaimPage(page, server);
  await claim.bootAndWaitForOnline();

  // Give the WebGL context one frame to draw the starfield.
  await page.waitForTimeout(250);

  // Read a 256×256 patch from the canvas centre. Default
  // size; pass it explicitly so the diagnostic log shows
  // the sample dimensions.
  const sample = await sampleCanvasPixels(page, 256);

  // Variance > 0 means at least two pixels differ — the
  // starfield is non-uniform. We log the numbers so a
  // flaky render can be diagnosed from the test report.
  // eslint-disable-next-line no-console
  console.log(
    `[render-smoke] canvas ${sample.width}x${sample.height} ` +
      `variance=${sample.variance.toFixed(3)} ` +
      `starFraction=${sample.starFraction.toFixed(4)}`,
  );
  expect(
    sample.variance,
    "expected non-zero pixel variance (canvas should be a starfield, not solid colour)",
  ).toBeGreaterThan(0);
  // Belt-and-braces: at least a tiny fraction of pixels must
  // be brighter than the clear colour. A solid-colour canvas
  // can produce variance > 0 via JPEG noise — this assertion
  // confirms the variance is coming from actual stars.
  expect(
    sample.starFraction,
    "expected some bright pixels (starfield should have visible stars)",
  ).toBeGreaterThan(0);

  // Save a screenshot of the live shell so the task log has a
  // visual reference of the rendered canvas.
  await page.screenshot({
    path: "../.ralph/screenshots/TASK-70-1.png",
    fullPage: true,
  });

  // Fail loudly on uncaught console errors (a missing WebGL
  // context emits one).
  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
});
