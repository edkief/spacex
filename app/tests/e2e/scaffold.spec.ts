/**
 * TASK-68 scaffold smoke test.
 *
 * Verifies the end-to-end dev pipeline: Vite serves the React shell on
 * :3000, the canvas placeholder is mounted, and the Fastify `/api/health`
 * endpoint reachable via the Vite proxy returns the expected payload.
 *
 * The dev server must already be running (`npm run dev`) before this test
 * executes; playwright.config.ts's `webServer` block handles that.
 */
import { test, expect } from "@playwright/test";

test("scaffold serves React shell with canvas + health proxy", async ({ page, request }) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });

  await page.goto("/");
  await expect(page).toHaveTitle(/Drift/);

  const canvas = page.getByTestId("drift-canvas");
  await expect(canvas).toBeVisible();

  const response = await request.get("/api/health");
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
