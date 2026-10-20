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
import path from "node:path";

/**
 * Resolve the task-log screenshot dir the same way the other
 * specs do (`kill-feed.spec.ts`, etc.). The fixture spawns
 * the dev server from `app/`, so the project-root `.ralph/`
 * sits at `${cwd}/../.ralph/`.
 */
const SHOTS_DIR = path.join(process.cwd(), "..", ".ralph", "screenshots");

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
    return { hasStore: true };
  });
  expect(handles?.hasStore).toBe(true);

  // Drive a synthetic hazard_update: 0 exposure + 10 s recover.
  // The meter should switch to the SHIELD BURN label.
  //
  // Why freeze the ingress? The server's sim loop pushes a real
  // `hazard_update` frame every tick (20 Hz) and those frames
  // (a) reset exposure to 50 and (b) carry an empty `cells`
  // list for a system with no hazards. Racing them with a
  // setInterval made the badge + scope flaky in the capture.
  // Instead we wrap the store's own `applyHazardUpdate` with a
  // freeze flag, drop one synthetic frame in, and only unfreeze
  // after the screenshot. The store still receives exactly the
  // same payload the wire would have delivered.
  await page.evaluate(() => {
    const client = (window as unknown as { __driftClient?: { getHazardStore: () => unknown } })
      .__driftClient;
    if (!client) throw new Error("driftClient not mounted");
    const store = client.getHazardStore() as {
      applyHazardUpdate: (p: Record<string, unknown>, nowMs?: number) => void;
    };
    const original = store.applyHazardUpdate.bind(store);
    const holder = window as unknown as { __hazardFrozen?: boolean };
    holder.__hazardFrozen = false;
    store.applyHazardUpdate = (p: Record<string, unknown>, nowMs?: number) => {
      if (holder.__hazardFrozen) return;
      original(p, nowMs);
    };
    original({
      exposure: 0,
      recoveringUntilMs: Date.now() + 10_000,
      inHazard: false,
      // One of each hazard kind inside the 500 m scope so the
      // screenshot shows a storm disc + a rad-zone disc.
      cells: [
        { hazardId: "h-storm", kind: "storm", pos: [180, 0, -120], radius: 300, intensity: 2 },
        { hazardId: "h-rad", kind: "radzone", pos: [-140, 0, 90], radius: 220, intensity: 5 },
        { hazardId: "h-drones", kind: "drones", pos: [60, 0, 200], radius: 150, intensity: 0 },
      ],
      anchor: [0, 0, 0],
    });
    holder.__hazardFrozen = true;
  });

  // The exposure meter mounts with the SHIELD BURN badge.
  await expect(page.locator('[data-testid="drift-exposure-meter"]')).toBeVisible();
  // Wait briefly for React to commit the store-driven re-render
  // before asserting the badge appears. Without this, the very
  // first paint can race the React reconciliation cycle and the
  // badge mounts a tick after the meter.
  await page.waitForTimeout(100);
  await expect(page.locator('[data-testid="drift-exposure-recovering-badge"]')).toContainText(
    "SHIELD BURN",
  );

  // Screenshot for the task log — the store is frozen on the
  // synthetic state, so the SHIELD BURN badge + the hazard
  // scope's storm / rad-zone discs are guaranteed to be in the
  // capture.
  await page.waitForTimeout(50);
  await page.screenshot({
    path: path.join(SHOTS_DIR, "TASK-48-1.png"),
    fullPage: true,
  });

  // Unfreeze the store so the live server frames resume (the
  // page is torn down right after, but leaving the wrapper in
  // place would confuse a later assertion in the same worker).
  await page.evaluate(() => {
    (window as unknown as { __hazardFrozen?: boolean }).__hazardFrozen = false;
  });

  expect(callsign.length).toBeGreaterThan(0);
});

test("hazard scope draws a storm disc + rad-zone disc from the streamed cells", async ({
  page,
  driftServer: server,
}) => {
  const claim = new ClaimPage(page, server);
  await claim.bootAndWaitForOnline();

  // Feed the store a storm + rad-zone cell around the player, as
  // the server's `nearbyCellsFor` cull would. The ingress is
  // frozen first (see test 1) so the live 20 Hz frames can't
  // clear the cell list mid-assertion.
  await page.evaluate(() => {
    const client = (window as unknown as { __driftClient?: { getHazardStore: () => unknown } })
      .__driftClient;
    const store = client?.getHazardStore() as {
      applyHazardUpdate: (p: Record<string, unknown>, nowMs?: number) => void;
    };
    const original = store.applyHazardUpdate.bind(store);
    const holder = window as unknown as { __hazardFrozen?: boolean };
    holder.__hazardFrozen = true;
    store.applyHazardUpdate = (p: Record<string, unknown>, nowMs?: number) => {
      if (holder.__hazardFrozen) return;
      original(p, nowMs);
    };
    original({
      exposure: 32,
      recoveringUntilMs: 0,
      inHazard: true,
      cells: [
        { hazardId: "h-storm", kind: "storm", pos: [200, 0, -150], radius: 300, intensity: 2 },
        { hazardId: "h-rad", kind: "radzone", pos: [-160, 0, 120], radius: 220, intensity: 5 },
      ],
      anchor: [0, 0, 0],
    });
  });

  const scope = page.locator('[data-testid="drift-hazard-scope"]');
  await expect(scope).toBeVisible();
  // One storm disc (with its rotating swirl ring) + one rad disc.
  await expect(page.locator('[data-testid="drift-hazard-cell-storm"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="drift-hazard-cell-radzone"]')).toHaveCount(1);
  await expect(page.locator(".drift-hazard-swirl")).toHaveCount(1);
  // The player sits at the scope centre.
  await expect(page.locator('[data-testid="drift-hazard-self"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="drift-hazard-count"]')).toContainText("2");
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
