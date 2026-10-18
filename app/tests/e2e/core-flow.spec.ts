/**
 * TASK-70 — Core multiplayer flow smoke.
 *
 * End-to-end exercise of the Drift shell:
 *
 *   1. The auto-claim hands the player a `Drift-<random>` callsign.
 *   2. The session establishes (callsign claim → hello → auth →
 *      join_system).
 *   3. The client joins a system (its home system).
 *   4. The canvas is non-uniform (delegated to render-smoke; here
 *      we just confirm the canvas is present + non-zero size).
 *   5. The player list shows the callsign + a "(you)" marker.
 *
 * Acceptance:
 *   "Core flow test: claim callsign (form) → session established →
 *    join a system → canvas renders the starfield → player list
 *    shows the callsign"
 */
import { test, expect } from "./fixtures.js";
import { ClaimPage } from "./pages/claim.js";

test("core flow: auto-claim → handshake → join → canvas + player list", async ({
  page,
  request,
  driftServer: server,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  // Sanity: the Fastify health endpoint is reachable directly
  // on `server.apiURL` (bypassing the Vite proxy). The fixture
  // allocated the port so a request to `apiURL` hits the
  // booted server.
  const health = await request.get(`${server.apiURL}/api/health`);
  expect(health.status()).toBe(200);
  const healthBody = (await health.json()) as { ok: boolean };
  expect(healthBody.ok).toBe(true);

  const claim = new ClaimPage(page, server);
  await claim.bootAndWaitForOnline();

  // Canvas is visible + has non-zero painted pixels.
  await expect(claim.canvas).toBeVisible();
  const canvasBox = await claim.canvas.boundingBox();
  expect(canvasBox).not.toBeNull();
  expect(canvasBox!.width).toBeGreaterThan(0);
  expect(canvasBox!.height).toBeGreaterThan(0);

  // Player list shows the callsign + a "(you)" marker.
  const callsign = await claim.currentCallsign();
  expect(callsign, "callsign should be set after auth_ok").toMatch(/^Drift-/);
  await expect(
    claim.playerList.locator(`[data-callsign="${callsign}"]`),
  ).toHaveCount(1);
  const youRow = claim.playerList.locator("[data-is-you='true']");
  await expect(youRow).toBeVisible();
  await expect(youRow).toContainText(callsign);

  // The roster count reads `1` (just ourselves).
  await expect(claim.playerListCount).toHaveText("1");

  // The system is known — read it from the debug seam.
  const systemId = await claim.currentSystemId();
  expect(systemId, "expected a systemId after enter_system").toBeTruthy();

  // Capture a screenshot for the task log.
  await page.screenshot({
    path: "../.ralph/screenshots/TASK-70-2.png",
    fullPage: true,
  });

  // No uncaught console errors.
  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
});