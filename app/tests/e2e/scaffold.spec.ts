/**
 * TASK-68 scaffold smoke test (now using the TASK-70 fixture).
 *
 * Verifies the end-to-end dev pipeline: Vite serves the React
 * shell on the random fixture port, the canvas placeholder is
 * mounted, and the Fastify `/api/health` endpoint reachable
 * via the Vite proxy returns the expected payload.
 *
 * The fixture spawns `npm run dev` with a random free port and
 * a fresh sqlite DB in a tmp dir; teardown is automatic on
 * worker completion.
 */
import { test, expect } from "./fixtures.js";

test("scaffold serves React shell with canvas + health proxy", async ({
  page,
  request,
  driftServer: server,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  await page.goto(`${server.baseURL}/?autoclaim=1`);
  await expect(page).toHaveTitle(/Drift/);

  const canvas = page.getByTestId("drift-canvas");
  await expect(canvas).toBeVisible();

  const response = await request.get(`${server.apiURL}/api/health`);
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { ok: boolean; galaxySeed: string };
  expect(body.ok).toBe(true);
  expect(body.galaxySeed.length).toBeGreaterThan(0);

  // Capture for the per-task screenshot log.
  await page.screenshot({
    path: "../.ralph/screenshots/TASK-68-1.png",
    fullPage: true,
  });

  // Fail loudly on uncaught console errors (dev server / hydration bugs).
  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
});
