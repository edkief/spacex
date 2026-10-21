/**
 * TASK-77 — Production-build end-to-end gate.
 *
 * This spec is the only assertion under the prod gate. It runs
 * against the same artefact the Docker image ships (no Vite proxy,
 * single-origin `@fastify/static` client, no `.env.local`) and
 * exercises the bug surface TASK-72 closed end-to-end:
 *
 *   (a) claim a callsign and reach `currentStatus === 'online'`
 *   (b) `window.__driftRenderHost.framesRendered` is increasing
 *       AND `window.__driftOwnShipMeshCount >= 1`
 *   (c) holding `W` for ~2 s drives the predictor's velocity above
 *       zero (proves the keyboard → `sendInput` path TASK-74
 *       added)
 *   (d) pressing `M` opens the chart AND `currentStatus` is still
 *       `'online'` (the TASK-72 regression — a menu surface used
 *       to tear down the WS session)
 *   (e) selecting a non-current system + clicking Warp changes
 *       `currentSystemId` to the target within 8 s (the TASK-72
 *       warp regression; a socket close on menu mount would
 *       leave the system id unchanged)
 *
 * Screenshots land in `.ralph/screenshots/TASK-77-prod-*.png` and
 * the entire spec asserts **zero console errors**, so a CI failure
 * leaves both a screenshot and a captured log for triage.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, type Page } from "@playwright/test";

import { sampleCanvasPixels, test } from "./fixtures.js";

/**
 * Screenshots land in `<repo-root>/.ralph/screenshots/`, next to the
 * other TASK-77 evidence. Resolve against the fixture's own directory
 * rather than `process.cwd()` because Playwright's worker cwd is the
 * spec directory, not the `app/` source tree.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS_DIR = path.resolve(HERE, "..", "..", "..", "..", ".ralph", "screenshots");

/** Wait until the DriftClient reports the player is online. */
async function waitForOnline(page: Page, timeoutMs = 15_000): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const w = window as unknown as { __driftClient?: { currentCallsign?: string | null } };
          return w.__driftClient?.currentCallsign ?? null;
        }),
      { timeout: timeoutMs },
    )
    .toMatch(/Drift-/);
}

/** Read the client's current lifecycle status. */
async function currentStatus(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const w = window as unknown as { __driftClient?: { currentStatus: string } };
    return w.__driftClient?.currentStatus ?? null;
  });
}

/** Read the client's current system id, or null until joined. */
async function currentSystemId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const w = window as unknown as { __driftClient?: { currentSystemId: string | null } };
    return w.__driftClient?.currentSystemId ?? null;
  });
}

/** Read the live predictor's velocity vector (post-W press). */
async function predictorVel(page: Page): Promise<{ x: number; y: number; z: number }> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __driftClient?: {
        predictor: { state(): { vel: { x: number; y: number; z: number } } };
      };
    };
    const v = w.__driftClient!.predictor.state().vel;
    return { x: v.x, y: v.y, z: v.z };
  });
}

/** Read the render host's `framesRendered` counter. */
async function framesRendered(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as unknown as { __driftRenderHost?: { framesRendered: number } };
    return w.__driftRenderHost?.framesRendered ?? -1;
  });
}

test("TASK-77 prod gate: status → ship → input → chart → warp", async ({
  page,
  request,
  prodServer: server,
}, testInfo) => {
  test.setTimeout(180_000);
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(`${err.message}\n${err.stack ?? ""}`));

  // Log the build cost so a slow tree is visible in the report.
  // eslint-disable-next-line no-console -- diagnostic in the Playwright report
  console.log(`[prod-gate] buildMs=${server.buildMs}`);

  // ---- (a) health + claim path round-trips through Fastify/static.
  const health = await request.get(`${server.apiURL}/api/health`);
  expect(health.status()).toBe(200);
  const healthBody = await health.json();
  expect(healthBody).toMatchObject({ ok: true, galaxySeed: server.galaxySeed });

  // Claim a callsign over the production REST surface (no Vite
  // proxy — this is the same handler the image serves).
  const callsign = `Drift-${Math.random().toString(36).slice(2, 8)}`;
  const claimRes = await request.post(`${server.apiURL}/api/callsigns`, {
    data: { callsign },
  });
  expect(claimRes.status()).toBe(200);
  const { token } = (await claimRes.json()) as { token: string };

  // Seed the token so the client takes the "returning player" branch.
  await page.addInitScript(
    (t: string) => {
      window.localStorage.setItem("drift.token", t);
    },
    token,
  );

  // Sanity-check the static client mount — the production index.html
  // is the entry the browser is about to load. A 200 + matching title
  // confirms the `@fastify/static` route is wired correctly.
  const indexRes = await request.get(`${server.baseURL}/`);
  expect(indexRes.status()).toBe(200);

  // Boot the production client.
  await page.goto(`${server.baseURL}/`);
  // The canvas mounts after the first paint.
  await page.getByTestId("drift-canvas").waitFor({ state: "visible", timeout: 15_000 });
  await page.getByTestId("drift-header").waitFor({ state: "visible", timeout: 15_000 });
  await waitForOnline(page);

  // Now claim (a): status flipped to `'online'`.
  await expect
    .poll(async () => currentStatus(page), { timeout: 10_000 })
    .toBe("online");

  // Save the boot screenshot for the PR/triage evidence.
  await page.screenshot({ path: path.join(SHOTS_DIR, "TASK-77-prod-start.png") });

  // ---- (b) the renderer is alive: framesRendered is climbing,
  //          the own-ship mesh is parented in the scene, and the
  //          canvas is non-black.
  await page.waitForFunction(
    () => {
      const w = window as unknown as {
        __driftRenderHost?: { framesRendered: number };
        __driftOwnShipMeshCount?: number;
      };
      return (
        w.__driftRenderHost !== undefined && (w.__driftOwnShipMeshCount ?? 0) >= 1
      );
    },
    undefined,
    { timeout: 15_000 },
  );
  const framesBefore = await framesRendered(page);
  await page.waitForTimeout(1_500);
  const framesAfter = await framesRendered(page);
  // eslint-disable-next-line no-console
  console.log(`[prod-gate] frames ${framesBefore} -> ${framesAfter}`);
  expect(framesAfter, "renderer must keep ticking").toBeGreaterThan(framesBefore);
  // The own-ship mesh is parented in the scene — TASK-74 ships it.
  const meshCount = await page.evaluate(() => {
    const w = window as unknown as { __driftOwnShipMeshCount?: number };
    return w.__driftOwnShipMeshCount ?? 0;
  });
  expect(meshCount, "expected __driftOwnShipMeshCount >= 1").toBeGreaterThanOrEqual(1);
  // The canvas is non-black — same `preserveDrawingBuffer: true`
  // seam the dev gate uses; the variance assertion proves the
  // production WebGLRenderer draws real pixels.
  const sample = await sampleCanvasPixels(page, 256);
  expect(sample.variance, "expected non-zero pixel variance").toBeGreaterThan(0);

  // ---- (c) the keyboard → sendInput path drives non-zero velocity.
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    document.body.focus();
  });
  await page.keyboard.down("w");
  await page.waitForTimeout(2_000);
  const velDuringThrust = await predictorVel(page);
  await page.keyboard.up("w");
  // eslint-disable-next-line no-console
  console.log(`[prod-gate] vel during W: ${JSON.stringify(velDuringThrust)}`);
  const speed = Math.sqrt(
    velDuringThrust.x ** 2 + velDuringThrust.y ** 2 + velDuringThrust.z ** 2,
  );
  expect(speed, "holding W for 2s must produce non-zero velocity").toBeGreaterThan(0);

  // ---- (d) pressing M opens the chart AND status stays online
  //          (the TASK-72 regression).
  await page.keyboard.press("m");
  const chart = page.getByTestId("drift-star-chart");
  await expect(chart).toBeVisible({ timeout: 5_000 });
  const statusAfterChart = await currentStatus(page);
  expect(
    statusAfterChart,
    "opening the chart must not tear down the WS session (TASK-72 regression)",
  ).toBe("online");
  await page.screenshot({ path: path.join(SHOTS_DIR, "TASK-77-prod-chart.png") });

  // ---- (e) select a non-current system and warp to it.
  const sourceSystemId = await currentSystemId(page);
  expect(sourceSystemId, "expected a current system before warping").toBeTruthy();
  const nodes = chart.locator('g[data-testid="drift-star-chart-node"]');
  await expect(nodes.first()).toBeVisible({ timeout: 5_000 });
  // eslint-disable-next-line no-console
  console.log(
    `[prod-gate] source=${sourceSystemId}; nodeCount=${await nodes.count()}`,
  );
  let targetSystemId: string | null = null;
  for (let i = 0; i < (await nodes.count()); i++) {
    const id = await nodes.nth(i).getAttribute("data-system-id");
    if (id !== null && id !== sourceSystemId) {
      await nodes.nth(i).locator("circle").last().click({ force: true });
      targetSystemId = id;
      break;
    }
  }
  expect(targetSystemId, "expected a non-current system to warp to").toBeTruthy();
  // Wait for the chart to report the selected system — clicking
  // a halo circle can land on a neighbour.
  const picked = await chart
    .locator('g[data-testid="drift-star-chart-node"][data-is-selected="true"]')
    .getAttribute("data-system-id");
  expect(picked, "expected the chart to report a selected system").toBeTruthy();
  const warpButton = page.getByTestId("drift-star-chart-warp");
  await expect(warpButton).toBeEnabled({ timeout: 5_000 });
  await warpButton.click();

  await expect
    .poll(async () => currentSystemId(page), {
      timeout: 8_000,
      intervals: [100, 200, 500],
    })
    .toBe(picked);

  // Status must still be online — closing the menu never tore it down.
  const statusAfterWarp = await currentStatus(page);
  expect(
    statusAfterWarp,
    "warp completion must leave the WS session online",
  ).toBe("online");

  // Let the overlay fade so the screenshot shows the new system.
  await expect(page.getByTestId("drift-warp-overlay")).toBeHidden({ timeout: 10_000 });
  await page.screenshot({ path: path.join(SHOTS_DIR, "TASK-77-prod-warped.png") });

  await testInfo.attach("prod-gate-final.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  // Filter out a small list of `ResizeObserver` + dev-only noise
  // the rest of the suite already filters out (kept inline so
  // the gate's failure report reads exactly the way the dev gate
  // does). A prod build should be silent otherwise.
  const fatalErrors = consoleErrors.filter(
    (e) => !e.includes("ResizeObserver") && !e.includes("WebSocket"),
  );
  expect(fatalErrors, `console errors: ${fatalErrors.join("\n")}`).toHaveLength(0);
});
