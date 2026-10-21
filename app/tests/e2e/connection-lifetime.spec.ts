/**
 * TASK-72 — connection lifetime regression spec.
 *
 * The bug this spec pins:
 *
 *   - Pressing `M` (star chart), `Escape` (ESC menu), or any other
 *     menu-surface toggle used to re-render the host App with a
 *     fresh `shell` value object, which made the
 *     client-wiring effect re-run, which called `client.stop()`
 *     in its cleanup, which closed the WS session. `useFirstLaunch`'s
 *     `startedRef` then refused to restart it.
 *   - Concretely: pressing `M` flipped `__driftClient.currentStatus`
 *     from `online` to `disconnected` immediately, and the warp
 *     flow could never complete because the chart's Warp button
 *     was still ticking but the underlying socket was already
 *     dead.
 *
 * ## What this spec asserts
 *
 *   1. After the initial handshake completes (baseline), the
 *      client's status is `online` and its systemId matches the
 *      value reported by `/api/players/me`.
 *   2. Pressing `m` opens the chart but does NOT flip the status,
 *      does NOT change the systemId, and does NOT push a `left`
 *      toast for the own callsign.
 *   3. Pressing `Escape` from the chart pops back to the game; the
 *      status + systemId are still intact.
 *   4. Pressing `Escape` again opens the ESC menu; closing the
 *      menu with another `Escape` keeps the session alive.
 *   5. Across the whole sequence no console error surfacing
 *      "DriftClient: sendWarp requires an open socket" (the
 *      production error message from the regression).
 *
 * @see app/src/client/hooks/useClientWiring.ts for the hook that
 *      closed the regression (the spec that scans dep-array
 *      invariants is in `useClientWiring.test.tsx`).
 */
import { test, expect } from "./fixtures.js";
import { ClaimPage } from "./pages/claim.js";
import path from "node:path";

/**
 * `.ralph/screenshots/` is the canonical harness screenshot dir.
 * Saving under `TASK-72-connection-lifetime.png` keeps the
 * screenshot next to the bug-spec entry so a human can eyeball
 * the regression without running the suite.
 */
const SHOTS_DIR = path.join(process.cwd(), "..", ".ralph", "screenshots");

test.describe("connection lifetime across menu surfaces (TASK-72)", () => {
  test.setTimeout(60_000);

  test("star chart and ESC menu keep the WS session online", async ({
    page,
    driftServer: server,
  }) => {
    // Capture every console message so the regression's "sendWarp
    // requires an open socket" error surfaces as a hard assertion
    // failure instead of just a degraded UI.
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    const claim = new ClaimPage(page, server);
    await claim.bootAndWaitForOnline();

    // Baseline: the client reached `online` and holds a system.
    const baselineStatus = await page.evaluate(() => {
      const w = window as unknown as { __driftClient?: { currentStatus: string } };
      return w.__driftClient?.currentStatus ?? null;
    });
    expect(baselineStatus).toBe("online");
    const baselineSystemId = await claim.currentSystemId();
    expect(baselineSystemId).toBeTruthy();
    const baselineCallsign = await claim.currentCallsign();
    expect(baselineCallsign).toBeTruthy();

    /**
     * Read the live status + systemId + a snapshot of the player
     * list (so a "left" toast for the own callsign would surface
     * as an empty roster). Used after each menu interaction.
     */
    const snapshot = async (): Promise<{
      status: string | null;
      systemId: string | null;
      presence: Array<{ callsign: string }>;
    }> => {
      return page.evaluate(() => {
        const w = window as unknown as {
          __driftClient?: {
            currentStatus: string;
            currentSystemId: string | null;
            presenceStore: {
              snapshot(): Array<{ callsign: string }>;
            };
          };
        };
        const c = w.__driftClient;
        return {
          status: c?.currentStatus ?? null,
          systemId: c?.currentSystemId ?? null,
          presence: c?.presenceStore.snapshot() ?? [],
        };
      });
    };

    // -------------------------------------------------------------
    // Step A: open the star chart (`m`).
    // -------------------------------------------------------------
    await page.keyboard.press("m");
    const chart = page.getByTestId("drift-star-chart");
    await expect(chart).toBeVisible({ timeout: 5_000 });
    // Wait for at least one node to render so the chart definitely
    // settled (the overview fetch is in flight before then).
    await expect(chart.locator('g[data-testid="drift-star-chart-node"]').first()).toBeVisible({
      timeout: 5_000,
    });
    const afterChart = await snapshot();
    expect(afterChart.status).toBe("online");
    expect(afterChart.systemId).toBe(baselineSystemId);
    // The own callsign stays listed in the presence store — the
    // regression's "left" toast for self fires when this is empty.
    expect(afterChart.presence.find((p) => p.callsign === baselineCallsign)).toBeTruthy();

    // -------------------------------------------------------------
    // Step B: close the star chart (`Escape`).
    // -------------------------------------------------------------
    await page.keyboard.press("Escape");
    await expect(chart).toBeHidden({ timeout: 5_000 });
    const afterChartClose = await snapshot();
    expect(afterChartClose.status).toBe("online");
    expect(afterChartClose.systemId).toBe(baselineSystemId);
    expect(afterChartClose.presence.find((p) => p.callsign === baselineCallsign)).toBeTruthy();

    // -------------------------------------------------------------
    // Step C: open the ESC menu (`Escape`).
    // -------------------------------------------------------------
    await page.keyboard.press("Escape");
    const menu = page.getByTestId("drift-menu-panel");
    await expect(menu).toBeVisible({ timeout: 5_000 });
    const afterMenuOpen = await snapshot();
    expect(afterMenuOpen.status).toBe("online");
    expect(afterMenuOpen.systemId).toBe(baselineSystemId);
    expect(afterMenuOpen.presence.find((p) => p.callsign === baselineCallsign)).toBeTruthy();

    // -------------------------------------------------------------
    // Step D: close the ESC menu (`Escape`).
    // -------------------------------------------------------------
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden({ timeout: 5_000 });
    const afterMenuClose = await snapshot();
    expect(afterMenuClose.status).toBe("online");
    expect(afterMenuClose.systemId).toBe(baselineSystemId);
    expect(afterMenuClose.presence.find((p) => p.callsign === baselineCallsign)).toBeTruthy();

    // The regression's most visible symptom — a console error
    // asking the Warp button to retry because the socket was
    // closed — must NEVER appear.
    const fatalErrors = consoleErrors.filter(
      (e) =>
        !e.includes("ResizeObserver") &&
        !e.includes("WebSocket") && // benign WS noise from the dev seam teardown
        !e.includes("AbortError") &&
        !e.includes("Failed to load resource"),
    );
    expect(fatalErrors, `console errors: ${fatalErrors.join("\n")}`).toHaveLength(0);

    // Screenshot the final "everything still online" state so a
    // human can eyeball the regression target.
    await page.screenshot({
      path: path.join(SHOTS_DIR, "TASK-72-connection-lifetime.png"),
    });
  });
});
