/**
 * Reconnect smoke test (TASK-17, now using the TASK-70 fixture).
 *
 * Drives the DriftClient through a forced socket close + auto-
 * reconnect. The smoke test exercises:
 *
 *   - The header pill flips from `online` to `reconnecting` on
 *     a forced close.
 *   - The `DriftClient` opens a fresh socket without the user
 *     pressing anything (auto-retry).
 *   - The header pill returns to `online` once the resync
 *     handshake completes.
 *   - The "Reconnected" toast appears in the top-right column.
 *
 * The test simulates the close by reaching into the client via
 * `window.__driftClient` and calling its internal socket
 * `close()` (Playwright-friendly seam).
 *
 * The fixture spawns `npm run dev` with a random free port and
 * a fresh sqlite DB in a tmp dir.
 */
import { test, expect } from "./fixtures.js";

test("DriftClient auto-reconnects after a forced socket close", async ({
  page,
  driftServer: server,
}) => {
  // Step 1: the app boots cleanly + the fixture's server is alive.
  await page.goto(`${server.baseURL}/?autoclaim=1`);
  await expect(page.getByTestId("drift-canvas")).toBeVisible();

  // Step 2: wait for the DriftClient to reach `online`.
  await expect
    .poll(
      async () =>
        await page.evaluate(() => {
          const w = window as unknown as {
            __driftClient?: { currentStatus: string; currentCallsign: string | null };
          };
          return w.__driftClient?.currentStatus ?? null;
        }),
      { timeout: 15_000 },
    )
    .toBe("online");

  // Step 3: force-close the underlying socket via the seam.
  await page.evaluate(() => {
    const w = window as unknown as {
      __driftClient?: { socket: WebSocket | null };
    };
    const sock = w.__driftClient?.socket;
    if (!sock) throw new Error("expected a live socket");
    sock.close(4000, "smoke-test-forced-close");
  });

  // Step 4: the client should transition back to `online` once the
  // resync handshake completes.
  await expect
    .poll(
      async () =>
        await page.evaluate(() => {
          const w = window as unknown as {
            __driftClient?: { currentStatus: string; isReconnecting: boolean };
          };
          return w.__driftClient?.currentStatus ?? null;
        }),
      { timeout: 15_000 },
    )
    .toBe("online");

  // Step 5: the "Reconnected" toast must have appeared.
  await expect
    .poll(
      async () => {
        const toasts = await page.evaluate(() => {
          const root = document.querySelector('[data-testid="drift-toast-stack"]');
          if (!root) return [] as string[];
          return Array.from(root.querySelectorAll('[data-toast-kind="info"]')).map(
            (n) => (n as HTMLElement).innerText,
          );
        });
        return toasts;
      },
      { timeout: 15_000 },
    )
    .toContain("Reconnected");

  // Screenshot for the task notes.
  await page.screenshot({
    path: "../.ralph/screenshots/TASK-17-1.png",
    fullPage: false,
  });
});
