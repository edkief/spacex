/**
 * TASK-15 Playwright smoke test — multi-context presence.
 *
 * Boots two browser contexts, opens the Drift app in each, and
 * verifies that:
 *
 *   1. Both contexts boot without console errors.
 *   2. After forcing both contexts to join the SAME system (the
 *      auto-claim picks a per-callsign home system that won't
 *      match), each context's player list renders a row for the
 *      other context's callsign (the "you" row is shown but the
 *      OTHER player's callsign is the one we assert on).
 *   3. The dev server's `/api/health` proxy is still reachable.
 *
 * The dev server must already be running (`npm run dev`) before this
 * test executes; playwright.config.ts's `webServer` block handles
 * that.
 *
 * Each browser context starts a fresh `DriftClient` so the callsign
 * claim generates a unique `Drift-<random>` callsign per context.
 * The test queries `/api/galaxy/health` for an empty shard and
 * drives both contexts into it via the `window.__driftClient`
 * debug seam exposed by the App shell.
 *
 * The test captures one screenshot per context and saves the first
 * one to `.ralph/screenshots/TASK-15-1.png` for the task log.
 */
import { test, expect } from "@playwright/test";

interface DriftClientDebug {
  presenceStore: {
    snapshot(): Array<{ callsign: string; isYou: boolean }>;
  };
  joinSystem(systemId: string): Promise<void>;
  currentCallsign: string | null;
  currentSystemId: string | null;
}

declare global {
  interface Window {
    __driftClient?: DriftClientDebug;
  }
}

test("two browser contexts see each other in the in-system player list", async ({
  browser,
  request,
}) => {
  // Build two isolated browser contexts. We don't share storage
  // state — each context generates its own callsign via the Drift
  // client's auto-claim path.
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

  // Sanity: the dev server proxy is alive.
  const health = await request.get("/api/health");
  expect(health.status()).toBe(200);
  expect(await health.json()).toMatchObject({ ok: true });

  // Find a clean system to drive both contexts into. The dev
  // server is shared across test runs, so leaked callsigns from
  // previous runs can pile up in the early systems. Pick a system
  // whose `/api/galaxy/health` shard row shows `players === 0`.
  // We claim a probe callsign first so the request is auth-gated;
  // the probe also lands in some system (populating one shard),
  // but we only need *some* empty shard id to drive the test.
  const probe = await request.post("/api/callsigns", {
    data: { callsign: `PROBE-${Math.random().toString(36).slice(2, 8)}` },
  });
  expect(probe.status(), `probe claim: ${await probe.text()}`).toBe(200);
  const probeToken = (await probe.json()).token as string;
  const galaxyHealth = await request.get("/api/galaxy/health", {
    headers: { authorization: `Bearer ${probeToken}` },
  });
  expect(galaxyHealth.status()).toBe(200);
  const galaxyBody = (await galaxyHealth.json()) as {
    shards: Array<{ systemId: string; players: number }>;
  };
  const sharedSystemId = galaxyBody.shards.find((s) => s.players === 0)?.systemId;
  expect(sharedSystemId, "could not find an empty system to use").toBeTruthy();

  // Boot the app in both contexts.
  await pageA.goto("/");
  await pageB.goto("/");
  await expect(pageA).toHaveTitle(/Drift/);
  await expect(pageB).toHaveTitle(/Drift/);

  // Wait until both contexts have a DriftClient + their first
  // system joined. The header pill updates to the callsign once
  // `auth_ok` lands.
  await expect(pageA.getByTestId("drift-header")).toContainText(/Drift-/, {
    timeout: 10_000,
  });
  await expect(pageB.getByTestId("drift-header")).toContainText(/Drift-/, {
    timeout: 10_000,
  });

  // Wait for the debug seam to be wired up by the App's effect.
  await pageA.waitForFunction(() => Boolean(window.__driftClient));
  await pageB.waitForFunction(() => Boolean(window.__driftClient));

  // Force both contexts into the same clean system. The WS layer
  // accepts a `join_system` frame at any time after `auth_ok`, so
  // the test can re-target each client post-boot. Joining a
  // different system mid-test is what TASK-8 (warp UI) will
  // surface to players; for the TASK-15 smoke test we drive it
  // directly through the debug seam.
  await pageA.evaluate((sysId) => window.__driftClient!.joinSystem(sysId), sharedSystemId);
  await pageB.evaluate((sysId) => window.__driftClient!.joinSystem(sysId), sharedSystemId);

  // Wait for both contexts' stores to converge on a 2-player roster.
  await expect
    .poll(
      async () =>
        pageA.evaluate(() =>
          window
            .__driftClient!.presenceStore.snapshot()
            .map((p) => p.callsign)
            .sort(),
        ),
      { timeout: 10_000 },
    )
    .toHaveLength(2);
  await expect
    .poll(
      async () =>
        pageB.evaluate(() =>
          window
            .__driftClient!.presenceStore.snapshot()
            .map((p) => p.callsign)
            .sort(),
        ),
      { timeout: 10_000 },
    )
    .toHaveLength(2);

  // Read the callsigns each player list sees so we can assert on
  // the DOM rendering (data-callsign attribute).
  const callsignA = await pageA.evaluate(() => window.__driftClient!.currentCallsign);
  const callsignB = await pageB.evaluate(() => window.__driftClient!.currentCallsign);
  expect(callsignA).toMatch(/^Drift-/);
  expect(callsignB).toMatch(/^Drift-/);
  expect(callsignA).not.toBe(callsignB);

  // Each list must render the OTHER context's callsign.
  await expect(
    pageA.locator(`[data-testid="drift-player-list-row"][data-callsign="${callsignB}"]`),
  ).toHaveCount(1);
  await expect(
    pageB.locator(`[data-testid="drift-player-list-row"][data-callsign="${callsignA}"]`),
  ).toHaveCount(1);

  // Each list also includes its own "(you)" row.
  const youA = pageA
    .locator(`[data-testid="drift-player-list"]`)
    .locator(`[data-is-you="true"]`)
    .first();
  const youB = pageB
    .locator(`[data-testid="drift-player-list"]`)
    .locator(`[data-is-you="true"]`)
    .first();
  await expect(youA).toBeVisible();
  await expect(youB).toBeVisible();

  // The list count should be 2 (self + the other context).
  await expect(pageA.getByTestId("drift-player-list-count")).toHaveText("2");
  await expect(pageB.getByTestId("drift-player-list-count")).toHaveText("2");

  // Capture the per-task screenshot. We snapshot contextA so the
  // log includes one full-page image of the live UI with the
  // toast stack + player list both populated.
  await pageA.screenshot({
    path: "../.ralph/screenshots/TASK-15-1.png",
    fullPage: true,
  });

  // Fail loudly on uncaught console errors.
  expect(consoleErrorsA, consoleErrorsA.join("\n")).toEqual([]);
  expect(consoleErrorsB, consoleErrorsB.join("\n")).toEqual([]);

  await contextA.close();
  await contextB.close();
});
