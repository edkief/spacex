/**
 * TASK-76 — seeded system bodies e2e.
 *
 * The client derives the star + planets from the galaxy seed
 * (`GET /api/health`) and renders them; nothing about the bodies
 * travels over the wire. The assertions here are about that loop
 * being *closed* in a real browser:
 *
 *   1. After boot, `window.__driftRenderHost.bodyCount() >= 1` —
 *      the star the player is orbiting is on screen.
 *   2. The canvas readback (reused `sampleCanvasPixels` seam) shows
 *      a bright, contiguous, non-background region — a lit body,
 *      not just the starfield's point sprites.
 *   3. A warp rebuilds the layer with the *target* system's bodies
 *      and keeps at least the star.
 *   4. A fresh client that joins the same system reports the same
 *      body count — the seed-determinism promise, in-world.
 *
 * Screenshots land in `.ralph/screenshots/TASK-76-{1,2}.png`.
 */
import path from "node:path";

import { test, expect, sampleCanvasPixels, type Page } from "./fixtures.js";
import { ClaimPage } from "./pages/claim.js";

/** Screenshots land next to the other task evidence. */
const SHOTS_DIR = path.join(process.cwd(), "..", ".ralph", "screenshots");

/** Live body count off the render host (star + planets). */
async function bodyCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as unknown as { __driftRenderHost?: { bodyCount?: () => number } };
    return w.__driftRenderHost?.bodyCount?.() ?? -1;
  });
}

/** The system id the body layer is currently rendering. */
async function renderedSystemId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const w = window as unknown as { __driftSystemBodyLayer?: { systemId: string | null } };
    return w.__driftSystemBodyLayer?.systemId ?? null;
  });
}

/** Poll `bodyCount` until it reaches `min`, else return the last value. */
async function waitForBodies(page: Page, min: number, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    last = await bodyCount(page);
    if (last >= min) return last;
    await page.waitForTimeout(150);
  }
  return last;
}

/**
 * Read the canvas and report the brightest contiguous region: how
 * many pixels are "lit" (luminance well above the deep-navy clear
 * colour) plus the bounding box of those pixels. A starfield alone
 * yields a handful of tiny specks; a rendered star sphere yields a
 * large solid block.
 */
async function brightRegion(
  page: Page,
  threshold = 90,
): Promise<{ bright: number; boxW: number; boxH: number; maxLuma: number }> {
  return page.evaluate((t) => {
    const source = document.getElementById("drift-canvas") as HTMLCanvasElement | null;
    if (source === null) throw new Error("missing #drift-canvas");
    // Centre crop (same trick as `sampleCanvasPixels`) so the patch
    // covers whatever the chase camera is looking at.
    const w = 384;
    const h = 384;
    const sx = Math.max(0, Math.floor((source.width - w) / 2));
    const sy = Math.max(0, Math.floor((source.height - h) / 2));
    const scratch = document.createElement("canvas");
    scratch.width = w;
    scratch.height = h;
    const ctx = scratch.getContext("2d");
    if (ctx === null) throw new Error("2D context unavailable");
    ctx.drawImage(source, sx, sy, w, h, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    let bright = 0;
    let maxLuma = 0;
    let minX = w;
    let maxX = -1;
    let minY = h;
    let maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        if (luma > maxLuma) maxLuma = luma;
        if (luma >= t) {
          bright += 1;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    return {
      bright,
      boxW: maxX < 0 ? 0 : maxX - minX + 1,
      boxH: maxY < 0 ? 0 : maxY - minY + 1,
      maxLuma,
    };
  }, threshold);
}

test("renders seeded star + planets, rebuilds on warp, and agrees across clients", async ({
  page,
  browser,
  driftServer: server,
}, testInfo) => {
  const claim = new ClaimPage(page, server);
  await claim.bootAndWaitForOnline();

  // ----- 1. the star is in the world right after boot.
  const homeSystemId = await claim.currentSystemId();
  expect(homeSystemId).toBeTruthy();
  const homeCount = await waitForBodies(page, 1, 15_000);
  expect(homeCount, "expected the star to be rendered after boot").toBeGreaterThanOrEqual(1);
  expect(await renderedSystemId(page)).toBe(homeSystemId);

  // ----- 2. a lit body covers real pixels (not one starfield point).
  const sample = await sampleCanvasPixels(page, 256);
  expect(sample.variance, "canvas readback must be non-uniform").toBeGreaterThan(0);
  const lit = await brightRegion(page);
  // eslint-disable-next-line no-console -- diagnostic in the Playwright report
  console.log(`[system-bodies] bodyCount=${homeCount} lit=${JSON.stringify(lit)}`);
  // Screenshot before the assertions so a failure still leaves evidence.
  await page.screenshot({ path: path.join(SHOTS_DIR, "TASK-76-1.png") });
  expect(lit.maxLuma, "a lit body should out-bright the starfield").toBeGreaterThan(120);
  expect(lit.bright, "expected a solid bright region, not isolated pixels").toBeGreaterThan(5_000);
  expect(Math.max(lit.boxW, lit.boxH)).toBeGreaterThan(30);

  await testInfo.attach("system-bodies-boot.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  // ----- 3. warp rebuilds the layer with the target system's bodies.
  // Use the chart UI (the proven warp path from warp.spec.ts) so the
  // swap is a real round-trip rather than a client-side poke.
  await page.keyboard.press("m");
  const chart = page.getByTestId("drift-star-chart");
  await expect(chart).toBeVisible({ timeout: 5_000 });
  const nodes = chart.locator('g[data-testid="drift-star-chart-node"]');
  await expect(nodes.first()).toBeVisible({ timeout: 5_000 });
  let clicked: string | null = null;
  for (let i = 0; i < (await nodes.count()); i++) {
    const id = await nodes.nth(i).getAttribute("data-system-id");
    if (id !== null && id !== homeSystemId) {
      await nodes.nth(i).locator("circle").last().click({ force: true });
      clicked = id;
      break;
    }
  }
  expect(clicked, "expected a non-current system node in the chart").toBeTruthy();
  // Read the chart's own selection (the halo circles overlap, so the
  // click can land on a neighbour) and warp to *that* system.
  const picked = await chart
    .locator('g[data-testid="drift-star-chart-node"][data-is-selected="true"]')
    .getAttribute("data-system-id");
  expect(picked, "expected the chart to report a selected system").toBeTruthy();
  await page.getByTestId("drift-star-chart-warp").click();

  await expect
    .poll(async () => claim.currentSystemId(), { timeout: 20_000 })
    .not.toBe(homeSystemId);
  const warpedSystemId = await claim.currentSystemId();
  expect(warpedSystemId).toBe(picked);
  // Let the warp animation finish so the screenshot shows the new
  // system, not the transition overlay.
  await expect(page.getByTestId("drift-warp-overlay")).toBeHidden({ timeout: 20_000 });
  // The chart stays open after a warp; close it so the screenshot
  // shows the new system's world.
  await page.keyboard.press("Escape");
  await expect(chart).toBeHidden({ timeout: 10_000 });
  const warpedCount = await waitForBodies(page, 1, 15_000);
  expect(warpedCount, "the layer must rebuild for the target system").toBeGreaterThanOrEqual(1);
  expect(await renderedSystemId(page)).toBe(warpedSystemId);
  const warpedLit = await brightRegion(page);
  // eslint-disable-next-line no-console -- diagnostic in the Playwright report
  console.log(
    `[system-bodies] warped=${warpedSystemId} count=${warpedCount} lit=${JSON.stringify(warpedLit)}`,
  );
  expect(warpedLit.maxLuma).toBeGreaterThan(120);
  await page.screenshot({ path: path.join(SHOTS_DIR, "TASK-76-2.png") });

  // ----- 4. a fresh client in the same system sees the same bodies.
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  try {
    const claimB = new ClaimPage(pageB, server);
    await claimB.bootAndWaitForOnline();
    await claimB.joinSystem(warpedSystemId ?? "");
    const countB = await waitForBodies(pageB, 1, 15_000);
    expect(countB, "fresh client body count").toBe(warpedCount);
    expect(await renderedSystemId(pageB)).toBe(warpedSystemId);
  } finally {
    await contextB.close();
  }
});
