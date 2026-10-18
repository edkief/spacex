/**
 * TASK-70 — Multi-context presence smoke.
 *
 * Two browser contexts boot the Drift app in parallel, force
 * each into the same clean system, and assert that:
 *
 *   1. Both contexts reach `online` (auto-claim + handshake).
 *   2. Each context's `presenceStore` snapshot includes the
 *      OTHER context's callsign.
 *   3. The DOM-rendered player list shows the other callsign.
 *
 * Acceptance:
 *   "Two-context test: two browser contexts in one system see
 *    each other in the presence list"
 *
 * The test claims a probe callsign first so the auth-gated
 * `/api/galaxy/health` endpoint can return the canonical roster.
 * We then pick a system with `players < 16` (the cap) and
 * drive both clients into it.
 */
import { test, expect } from "./fixtures.js";
import { ClaimPage } from "./pages/claim.js";

test("two contexts see each other in the in-system player list", async ({
  browser,
  request,
  driftServer: server,
}) => {
  // Claim a probe callsign just to learn a galaxy systemId we
  // can drive both contexts into. The probe never joins the
  // shard (it's a pure HTTP claim) so the shard stays empty
  // until the two contexts arrive — we expect the player list
  // to converge on exactly the two contexts (no phantom third).
  const probe = await request.post(`${server.apiURL}/api/callsigns`, {
    data: { callsign: `PROBE-${Date.now().toString(36)}` },
  });
  expect(probe.status()).toBe(200);
  const probeBody = (await probe.json()) as { homeSystemId: string };
  const sharedSystemId = probeBody.homeSystemId;
  expect(sharedSystemId, "expected a system id to drive both contexts into").toBeTruthy();

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  const consoleErrorsA: string[] = [];
  const consoleErrorsB: string[] = [];
  pageA.on("console", (msg) => {
    if (msg.type() === "error") consoleErrorsA.push(msg.text());
  });
  pageB.on("console", (msg) => {
    if (msg.type() === "error") consoleErrorsB.push(msg.text());
  });

  const claimA = new ClaimPage(pageA, server);
  const claimB = new ClaimPage(pageB, server);
  await Promise.all([claimA.bootAndWaitForOnline(), claimB.bootAndWaitForOnline()]);

  const callsignA = await claimA.currentCallsign();
  const callsignB = await claimB.currentCallsign();
  expect(callsignA).toMatch(/^Drift-/);
  expect(callsignB).toMatch(/^Drift-/);
  expect(callsignA).not.toBe(callsignB);

  // Drive both clients into the same system.
  await Promise.all([claimA.joinSystem(sharedSystemId!), claimB.joinSystem(sharedSystemId!)]);

  // Each context's store should converge on 2 players.
  await expect
    .poll(async () => claimA.playerListCount.textContent(), { timeout: 10_000 })
    .toBe("2");
  await expect
    .poll(async () => claimB.playerListCount.textContent(), { timeout: 10_000 })
    .toBe("2");

  // Each list must render the OTHER context's callsign.
  await expect(
    pageA.locator(`[data-testid="drift-player-list-row"][data-callsign="${callsignB}"]`),
  ).toHaveCount(1);
  await expect(
    pageB.locator(`[data-testid="drift-player-list-row"][data-callsign="${callsignA}"]`),
  ).toHaveCount(1);

  // Each list also includes its own "(you)" row.
  await expect(
    pageA.locator(`[data-testid="drift-player-list"]`).locator("[data-is-you='true']"),
  ).toHaveCount(1);
  await expect(
    pageB.locator(`[data-testid="drift-player-list"]`).locator("[data-is-you='true']"),
  ).toHaveCount(1);

  // Capture a screenshot for the task log.
  await pageA.screenshot({
    path: "../.ralph/screenshots/TASK-70-3.png",
    fullPage: true,
  });

  // No uncaught console errors on either context.
  expect(consoleErrorsA, consoleErrorsA.join("\n")).toEqual([]);
  expect(consoleErrorsB, consoleErrorsB.join("\n")).toEqual([]);

  await contextA.close();
  await contextB.close();
});
