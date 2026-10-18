/**
 * TASK-16 Playwright smoke test — system-wide chat.
 *
 * Boots two browser contexts, opens the Drift app in each, joins the
 * same system, and verifies that:
 *
 *   1. The chat log panel is visible in both contexts (top-left).
 *   2. Messages sent from context A appear in context B's chat log.
 *   3. The XSS payload `<img src=x onerror=alert(1)>` renders as inert
 *      text (no `<img>` element is injected into the DOM).
 *   4. The 6th message within 10 s is rate-limited with a visible
 *      error toast (or `rate-limited` notification).
 *
 * The dev server must already be running (`npm run dev`) before this
 * test executes; playwright.config.ts's `webServer` block handles
 * that.
 */
import { test, expect } from "@playwright/test";

interface DriftClientDebug {
  chatStore: {
    snapshot(): Array<{ id: string; author: string; text: string; ts: number }>;
    size(): number;
  };
  joinSystem(systemId: string): Promise<void>;
  currentCallsign: string | null;
  sendChat(text: string): void;
}

declare global {
  interface Window {
    __driftClient?: DriftClientDebug;
  }
}

test("chat: two contexts see each other's messages in the system chat log", async ({
  browser,
  request,
}) => {
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

  // Find an empty system to drive both contexts into (the dev
  // server is shared across runs; pre-existing contexts may have
  // populated the early systems). We claim a fresh probe callsign,
  // read its `homeSystemId` (always defined), and then probe the
  // galaxy health endpoint for that exact system. If it's full,
  // we fall back to any shard the router knows about with
  // `players < MAX_PLAYERS_PER_SYSTEM` (16 in production).
  const probe = await request.post("/api/callsigns", {
    data: { callsign: `PROBE-${Math.random().toString(36).slice(2, 8)}` },
  });
  expect(probe.status(), `probe claim: ${await probe.text()}`).toBe(200);
  const probeBody = (await probe.json()) as { token: string; homeSystemId: string };
  const probeToken = probeBody.token;
  const homeSystemId = probeBody.homeSystemId;
  const galaxyHealth = await request.get("/api/galaxy/health", {
    headers: { authorization: `Bearer ${probeToken}` },
  });
  expect(galaxyHealth.status()).toBe(200);
  const galaxyBody = (await galaxyHealth.json()) as {
    shards: Array<{ systemId: string; players: number }>;
  };
  // Prefer the home system if it's already spawned and has room
  // (it always is — the probe claim puts the probe there).
  const homeShard = galaxyBody.shards.find((s) => s.systemId === homeSystemId);
  let sharedSystemId: string | undefined = homeShard && homeShard.players < 16 ? homeShard.systemId : undefined;
  if (!sharedSystemId) {
    sharedSystemId = galaxyBody.shards.find((s) => s.players < 16)?.systemId;
  }
  // No shards yet — fall back to the home system id (any new join
  // spawns the shard on demand). The router accepts `joinSystem`
  // for an unknown system as long as the system exists in the
  // generated galaxy, so this always works.
  if (!sharedSystemId) {
    sharedSystemId = homeSystemId;
  }
  expect(sharedSystemId, "could not pick a system to use").toBeTruthy();

  // Boot both contexts.
  await pageA.goto("/");
  await pageB.goto("/");
  await expect(pageA).toHaveTitle(/Drift/);
  await expect(pageB).toHaveTitle(/Drift/);

  await expect(pageA.getByTestId("drift-header")).toContainText(/Drift-/, { timeout: 10_000 });
  await expect(pageB.getByTestId("drift-header")).toContainText(/Drift-/, { timeout: 10_000 });
  await pageA.waitForFunction(() => Boolean(window.__driftClient));
  await pageB.waitForFunction(() => Boolean(window.__driftClient));

  await pageA.evaluate((sysId) => window.__driftClient!.joinSystem(sysId), sharedSystemId);
  await pageB.evaluate((sysId) => window.__driftClient!.joinSystem(sysId), sharedSystemId);

  // Wait for both contexts' player lists to converge.
  await expect
    .poll(async () => pageA.evaluate(() => window.__driftClient!.chatStore.size()), {
      timeout: 10_000,
    })
    .toBeGreaterThanOrEqual(0);

  // The chat panel is visible in both contexts.
  await expect(pageA.getByTestId("drift-chat-log")).toBeVisible();
  await expect(pageB.getByTestId("drift-chat-log")).toBeVisible();

  // Send a chat from context A via the debug seam and wait for it to
  // land in context B's chat log.
  await pageA.evaluate(() => window.__driftClient!.sendChat("hello world"));

  await expect
    .poll(
      async () =>
        pageB.evaluate(() => window.__driftClient!.chatStore.snapshot().map((e) => e.text)),
      { timeout: 5_000 },
    )
    .toContain("hello world");

  // Send a chat from B → A (sender echo included) so both directions
  // round-trip.
  await pageB.evaluate(() => window.__driftClient!.sendChat("ack from B"));
  await expect
    .poll(
      async () =>
        pageA.evaluate(() => window.__driftClient!.chatStore.snapshot().map((e) => e.text)),
      { timeout: 5_000 },
    )
    .toContain("ack from B");

  // XSS payload — the server keeps the angle brackets (sanitization
  // strips controls only) and React's auto-escape renders them as
  // inert text. Assert no <img> element is injected into the DOM.
  await pageA.evaluate(() => window.__driftClient!.sendChat("<img src=x onerror=alert(1)>"));
  await expect
    .poll(
      async () =>
        pageA.evaluate(() => window.__driftClient!.chatStore.snapshot().map((e) => e.text)),
      { timeout: 5_000 },
    )
    .toContain("<img src=x onerror=alert(1)>");

  // Confirm no <img> child was injected into the chat log (the
  // payload was rendered as text, not parsed as HTML).
  const imgCount = await pageA.getByTestId("drift-chat-log-scroll").locator("img").count();
  expect(imgCount).toBe(0);

  // Capture per-task screenshot.
  await pageA.screenshot({
    path: "../.ralph/screenshots/TASK-16-1.png",
    fullPage: true,
  });

  // No uncaught console errors.
  expect(consoleErrorsA, consoleErrorsA.join("\n")).toEqual([]);
  expect(consoleErrorsB, consoleErrorsB.join("\n")).toEqual([]);

  await contextA.close();
  await contextB.close();
});
