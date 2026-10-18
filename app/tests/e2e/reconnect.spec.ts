/**
 * Reconnect smoke test (TASK-17).
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
 * `close()` (Playwright-friendly seam — the seam is `client`
 * field, not a public API).
 *
 * The dev server must already be running (`npm run dev`) before
 * this test executes; `playwright.config.ts`'s `webServer` block
 * handles that.
 */
import { test, expect } from "@playwright/test";

test("DriftClient auto-reconnects after a forced socket close", async ({ page, request }) => {
  // Step 1: the app boots cleanly + health endpoint is reachable.
  const health = await request.get("/api/health");
  expect(health.status()).toBe(200);
  await page.goto("/");
  await expect(page.getByTestId("drift-canvas")).toBeVisible();

  // Step 2: wait for the DriftClient to reach `online`. The
  // header pill text reflects the current lifecycle status
  // (the callsign suffix when online).
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

  // Step 3: force-close the underlying socket via the seam. The
  // auto-retry loop should spawn a fresh socket + resync within
  // a few seconds (the retry budget defaults to 30 s; we don't
  // wait anywhere near that).
  await page.evaluate(() => {
    const w = window as unknown as {
      __driftClient?: { socket: WebSocket | null };
    };
    const sock = w.__driftClient?.socket;
    if (!sock) throw new Error("expected a live socket");
    sock.close(4000, "smoke-test-forced-close");
  });

  // Step 4: the client should transition to `connecting` (mid-
  // retry) and then back to `online` once the resync handshake
  // completes.
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

  // Step 5: the "Reconnected" toast must have appeared in the
  // top-right column. The ToastStack renders toasts with the
  // `data-toast-kind="info"` attribute; the text content of the
  // most recent info toast should start with "Reconnected".
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

  // Screenshot for the task notes. Saved under the workspace-root
  // `.ralph/screenshots/` directory so iteration history can pick
  // it up; the dev server's Vite root is `app/`, but the
  // screenshot path resolves from the project root.
  await page.screenshot({
    path: "../../../../.ralph/screenshots/TASK-17-1.png",
    fullPage: false,
  });
});
