/**
 * TASK-56 — first-launch headline e2e.
 *
 * Two flows:
 *
 *   1. **Fresh-claim flow.** Open a fresh browser context (no
 *      `localStorage` for `drift.token`), navigate to the app,
 *      fill in `TEST-PILOT` on the claims screen, click Claim,
 *      and assert the player lands on the dock with the
 *      guidance step 1 visible. Screenshot for the task log.
 *   2. **Refresh-restore flow.** Reload the page and assert
 *      the player lands straight into the game (no claims
 *      screen, no auto-claim handshake).
 *
 * The same browser context drives both phases so the second
 * re-uses the persisted token from the first claim.
 */
import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures.js";

const TEST_CALLSIGN = "TEST-PILOT";

/** Wait until the DriftClient reports the player is online. */
async function waitForOnline(page: Page, timeoutMs = 15_000): Promise<void> {
  await expect
    .poll(
      async () => {
        return page.evaluate(() => {
          const w = window as unknown as { __driftClient?: { currentCallsign?: string | null } };
          return w.__driftClient?.currentCallsign ?? null;
        });
      },
      { timeout: timeoutMs },
    )
    .toMatch(/TEST-PILOT/);
}

test("first-launch: claim → dock spawn → guidance → refresh", async ({
  page,
  driftServer: server,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  // Phase 1 — claim flow. Fresh context starts with no token in
  // localStorage, so the app should show the claims screen on
  // mount.
  await page.goto(`${server.baseURL}/`);
  const claimPanel = page.getByTestId("drift-claims-panel");
  await expect(claimPanel).toBeVisible({ timeout: 15_000 });
  // Screenshot of the claims screen itself — the first thing a new
  // player sees (title, intro carousel, callsign input).
  await page.screenshot({
    path: "../.ralph/screenshots/TASK-56-2.png",
    fullPage: true,
  });

  // Type into the callsign input. The chip should flip from
  // "idle" → "checking" → "available" after the 500 ms debounce +
  // the server probe.
  const callsignInput = page.getByTestId("drift-claims-callsign-input");
  await callsignInput.fill(TEST_CALLSIGN);
  // Wait for the availability probe (500 ms debounce + a fetch
  // round-trip).
  await expect
    .poll(
      async () => {
        return (await page.getByTestId("drift-claims-chip").getAttribute("data-state")) ?? null;
      },
      { timeout: 4_000 },
    )
    .toBe("available");
  await expect(page.getByTestId("drift-claims-claim-button")).toBeEnabled();

  // Click Claim. The screen disappears once the WS lands and the
  // game tree mounts.
  await page.getByTestId("drift-claims-claim-button").click();
  await claimPanel.waitFor({ state: "detached", timeout: 15_000 });
  await waitForOnline(page);

  // The player has joined the home system — the spawn the task
  // calls out is the home-system dock, not a random system.
  // `enter_system` lands a beat after `auth_ok`, so poll for the
  // system id before reading the spawn triple.
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const w = window as unknown as { __driftClient?: { currentSystemId: string | null } };
          return w.__driftClient?.currentSystemId ?? null;
        }),
      { timeout: 15_000 },
    )
    .not.toBeNull();
  const spawn = await page.evaluate(() => {
    const w = window as unknown as {
      __driftClient?: { currentSystemId: string | null; homeSystemId: string | null };
    };
    return {
      system: w.__driftClient?.currentSystemId ?? null,
      home: w.__driftClient?.homeSystemId ?? null,
    };
  });
  expect(spawn.system, "player should be joined to a system").not.toBeNull();
  expect(spawn.system, "spawn should be the home system").toBe(spawn.home);

  // The roster shows
  // `(you)` next to the callsign — proves the WS handshake
  // landed and presence was received.
  await expect(page.getByTestId("drift-player-list").locator("[data-is-you='true']")).toBeVisible({
    timeout: 8_000,
  });
  await expect(page.getByTestId("drift-player-list").locator("[data-is-you='true']")).toContainText(
    TEST_CALLSIGN,
  );

  // Guidance hint renders the STEP_FLY copy for the very first
  // frame after auth_ok lands (the spawn is the home-system
  // dock but the predictor's `onPad` is null until the player
  // presses E at a real pad — so the docked-transition event
  // hasn't fired yet).
  await expect(page.getByTestId("drift-guidance-hint")).toBeVisible({
    timeout: 4_000,
  });
  await expect(page.getByTestId("drift-guidance-hint-text")).toContainText(/Hold W to fly/i);

  // Screenshot of the in-game view with the claims screen gone
  // + the guidance hint visible.
  await page.screenshot({
    path: "../.ralph/screenshots/TASK-56-1.png",
    fullPage: true,
  });

  // No uncaught console errors during phase 1.
  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);

  // Phase 2 — refresh restore. Reload the page; the boot session
  // should read the persisted token from `localStorage`, validate
  // it via `/api/session`, and resume straight into the game.
  await page.reload();
  // The claims screen must NOT appear — the boot session went
  // straight to `authenticated`/`ready` from the stored token.
  await expect(page.getByTestId("drift-claims-panel")).not.toBeVisible({
    timeout: 10_000,
  });
  await waitForOnline(page);

  // The guidance hint should still be visible (persistence via
  // localStorage carries across the reload — the player is back
  // on step 0 because no further events have fired yet).
  await expect(page.getByTestId("drift-guidance-hint")).toBeVisible({
    timeout: 5_000,
  });
});
