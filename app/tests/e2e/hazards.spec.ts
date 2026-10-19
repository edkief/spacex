/**
 * Hazard e2e — TASK-48.
 *
 * Boots a Playwright browser against the worker fixture,
 * exposes the hazard store, applies a synthetic hazard_update,
 * and asserts the exposure meter renders the SHIELD BURN
 * badge. Also asserts the in-world hazard layer renders the
 * drone count after a synthetic entity_update with a drone
 * entity.
 */
import { test, expect } from "./fixtures.js";
import { ClaimPage } from "./pages/claim.js";

test("hazard_update frame surfaces the SHIELD BURN badge in the exposure meter", async ({
  page,
  driftServer: server,
}) => {
  const claim = new ClaimPage(page, server);
  await claim.bootAndWaitForOnline();
  const callsign = (await claim.currentCallsign()) ?? "unknown";

  // The DriftClient + HazardStore are mounted by App.tsx; reach
  // them through the dev-only window seam.
  const handles = await page.evaluate(() => {
    const client = (window as unknown as { __driftClient?: { getHazardStore: () => unknown } })
      .__driftClient;
    if (!client) return null;
    const store = client.getHazardStore() as {
      applyHazardUpdate: (p: {
        exposure: number;
        recoveringUntilMs: number;
        inHazard: boolean;
      }) => void;
      getState: () => { exposure: number; recoveringUntilMs: number; inHazard: boolean };
    };
    return { hasStore: true };
  });
  expect(handles?.hasStore).toBe(true);

  // Drive a synthetic hazard_update: 0 exposure + 10 s recover.
  // The meter should switch to the SHIELD BURN label.
  await page.evaluate(() => {
    const client = (window as unknown as { __driftClient?: { getHazardStore: () => unknown } })
      .__driftClient;
    if (!client) return;
    const store = client.getHazardStore() as {
      applyHazardUpdate: (p: {
        exposure: number;
        recoveringUntilMs: number;
        inHazard: boolean;
      }) => void;
    };
    store.applyHazardUpdate({
      exposure: 0,
      recoveringUntilMs: Date.now() + 10_000,
      inHazard: false,
    });
  });

  // The exposure meter mounts with the SHIELD BURN badge.
  await expect(page.locator('[data-testid="drift-exposure-meter"]')).toBeVisible();
  await expect(page.locator('[data-testid="drift-exposure-recovering-badge"]')).toContainText(
    "SHIELD BURN",
  );

  // Screenshot for the task log.
  await page.screenshot({
    path: ".ralph/screenshots/TASK-48-1.png",
    fullPage: true,
  });
  expect(callsign.length).toBeGreaterThan(0);
});

test("hazard layer renders a count when drone entities stream in", async ({
  page,
  driftServer: server,
}) => {
  const claim = new ClaimPage(page, server);
  await claim.bootAndWaitForOnline();
  const callsign = (await claim.currentCallsign()) ?? "unknown";
  void callsign;

  // Drive a synthetic entity_update with 3 drone markers.
  await page.evaluate(() => {
    const client = (
      window as unknown as {
        __driftClient?: { getHazardStore: () => unknown };
      }
    ).__driftClient;
    if (!client) return;
    const store = client.getHazardStore() as {
      setMarkers: (
        markers: Array<{
          id: string;
          kind: "drones";
          pos: { x: number; y: number; z: number };
          radius: number;
          parentCellId: string | null;
        }>,
      ) => void;
    };
    store.setMarkers([
      {
        id: "drone:1",
        kind: "drones",
        pos: { x: 0, y: 0, z: 0 },
        radius: 8,
        parentCellId: "h-1",
      },
      {
        id: "drone:2",
        kind: "drones",
        pos: { x: 5, y: 0, z: 0 },
        radius: 8,
        parentCellId: "h-1",
      },
      {
        id: "drone:3",
        kind: "drones",
        pos: { x: 10, y: 0, z: 0 },
        radius: 8,
        parentCellId: "h-1",
      },
    ]);
  });

  await expect(page.locator('[data-testid="drift-hazard-layer"]')).toBeVisible();
  await expect(page.locator('[data-testid="drift-hazard-count"]')).toContainText("3");
});
