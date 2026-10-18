/**
 * TASK-70 — Multi-context chat smoke.
 *
 * Two browser contexts boot, join the same system, and verify
 * chat round-trips within 2 s:
 *
 *   1. A message sent from context A appears in context B's
 *      chat store within 2 s (acceptance: "message from context
 *      A appears in context B within 2 s").
 *   2. The XSS payload `<img src=x onerror=alert(1)>` survives
 *      the wire AND renders without an `<img>` element injected
 *      into the DOM (sanitization + React auto-escape).
 *
 * The test uses the harness fixture's worker-scoped server so
 * it runs against a fresh per-worker DB.
 */
import { test, expect } from "./fixtures.js";
import { ClaimPage } from "./pages/claim.js";

test("chat: two contexts see each other's messages within 2 s", async ({
  browser,
  request,
  driftServer: server,
}) => {
  // Pick a shared system. The probe claim below puts us in
  // some home system; we then drive both contexts into that
  // shard.
  const probe = await request.post(`${server.apiURL}/api/callsigns`, {
    data: { callsign: `PROBE-${Date.now().toString(36)}` },
  });
  expect(probe.status()).toBe(200);
  const probeBody = (await probe.json()) as { homeSystemId: string };
  const sharedSystemId = probeBody.homeSystemId;

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

  await Promise.all([claimA.joinSystem(sharedSystemId), claimB.joinSystem(sharedSystemId)]);

  // Both chat panels are visible.
  await expect(claimA.chatLog).toBeVisible();
  await expect(claimB.chatLog).toBeVisible();

  // Send a chat from A → B and verify it lands within 2 s
  // (acceptance: 2 s SLA).
  const sentAt = Date.now();
  await claimA.sendChat("hello from A");
  await expect
    .poll(
      async () => (await claimB.chatSnapshot()).map((e) => e.text),
      { timeout: 2_000 },
    )
    .toContain("hello from A");
  const elapsed = Date.now() - sentAt;
  expect(elapsed, `expected chat to land within 2 s (got ${elapsed} ms)`).toBeLessThanOrEqual(2_000);

  // XSS payload — survives the wire as text, no `<img>` injected.
  await claimA.sendChat("<img src=x onerror=alert(1)>");
  await expect
    .poll(
      async () => (await claimA.chatSnapshot()).map((e) => e.text),
      { timeout: 5_000 },
    )
    .toContain("<img src=x onerror=alert(1)>");

  const imgCount = await claimA.chatLogScroll.locator("img").count();
  expect(imgCount, "expected no <img> element injected into the chat log").toBe(0);

  // Capture a screenshot.
  await pageA.screenshot({
    path: "../.ralph/screenshots/TASK-70-4.png",
    fullPage: true,
  });

  // No uncaught console errors.
  expect(consoleErrorsA, consoleErrorsA.join("\n")).toEqual([]);
  expect(consoleErrorsB, consoleErrorsB.join("\n")).toEqual([]);

  await contextA.close();
  await contextB.close();
});