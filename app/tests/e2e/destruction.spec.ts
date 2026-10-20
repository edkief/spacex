/**
 * TASK-49 acceptance — Playwright e2e for the destruction loop.
 *
 * Drives the client presentation half of "wreck, loss, and
 * recovery" under the production React shell:
 *
 *   1. Boots the dev server (worker-scoped fixture) + claims a
 *      callsign so the HUD mounts.
 *   2. Feeds a `combat_event { kind: 'destroyed', respawn }` frame
 *      into the client's destruction store through the same
 *      accessor the WS layer uses (`__driftClient.getDestruction()`).
 *   3. Asserts the 2 s "SHIP LOST" moment renders the callsign,
 *      the killer, and "Respawning at <nearest dock>", that the
 *      explosion flash / shockwave / 8 debris shards mount, and
 *      that the cosmetic time scale dips to 0.3 for 1 s.
 *   4. Asserts the moment clears after 2 s and that a nearby
 *      wreck renders its `▸ <killer>` marker within 200 m (and
 *      not beyond it).
 *   5. Screenshots the moment to `.ralph/screenshots/TASK-49-1.png`
 *      and the respawned scout to `TASK-49-2.png`.
 *
 * The authoritative half (cargo loss, wreck spawn, respawn at the
 * nearest dock, docked invulnerability, TTL expiry) is proven by
 * `src/server/shard/destruction.test.ts`; this spec covers the
 * React layer + the store's clock.
 */
import { expect, test } from "./fixtures.js";
import { ClaimPage } from "./pages/claim.js";
import path from "node:path";

const RESPAWN = {
  wreckId: "wreck:entity:ship-bravo",
  padId: "pad-7f3a",
  planetId: "planet-2",
  callsign: "BRAVO",
  killer: "ALPHA",
  cargoLost: { iron: 40, copper: 12 },
};

test.describe("destruction (TASK-49)", () => {
  test("explosion + SHIP LOST moment + respawn", async ({ browser, driftServer: server }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const claim = new ClaimPage(page, server);
    await claim.bootAndWaitForOnline();
    await page.waitForTimeout(500);
    expect(errors, errors.join("\n")).toEqual([]);

    // Wreck markers: one inside the 200 m radius, one outside.
    await page.evaluate((respawn) => {
      const w = window as unknown as {
        __driftClient?: {
          getDestruction?: () => {
            applyCombatEvent: (evt: unknown) => boolean;
            applyWrecks: (
              wrecks: readonly unknown[],
              pos: { x: number; y: number; z: number },
            ) => void;
            snapshot: () => { timeScale: number };
          };
        };
      };
      const store = w.__driftClient?.getDestruction?.();
      if (store === undefined) throw new Error("destruction seam missing");
      store.applyWrecks(
        [
          { id: "wreck:near", x: 120, y: 0, z: 0, killerCallsign: "ALPHA" },
          { id: "wreck:far", x: 5_000, y: 0, z: 0, killerCallsign: "CHARLIE" },
        ],
        { x: 0, y: 0, z: 0 },
      );
      store.applyCombatEvent({
        kind: "destroyed",
        target: "entity:ship-bravo",
        source: { kind: "player", id: "ALPHA" },
        tick: 42,
        respawn,
      });
    }, RESPAWN);

    // Slow-mo dips to 0.3 (cosmetic only — the sim keeps running).
    const slow = await page.evaluate(() => {
      const w = window as unknown as {
        __driftClient?: { getDestruction: () => { snapshot: () => { timeScale: number } } };
      };
      return w.__driftClient!.getDestruction().snapshot().timeScale;
    });
    expect(slow).toBeCloseTo(0.3, 5);

    // Explosion layers + the SHIP LOST moment.
    await expect(page.locator('[data-testid="explosion-flash"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="explosion-shockwave"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="explosion-debris"]')).toHaveCount(8);
    const overlay = page.locator('[data-testid="ship-lost-overlay"]');
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText("SHIP LOST");
    await expect(overlay).toContainText("BRAVO");
    await expect(overlay).toContainText("Destroyed by ALPHA");
    await expect(overlay).toContainText("Respawning at pad-7f3a");
    // Only the in-range wreck carries a marker.
    await expect(page.locator('[data-testid="wreck-marker"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="wreck-marker"]').first()).toContainText("ALPHA");

    const shotsDir = path.join(process.cwd(), "..", ".ralph", "screenshots");
    const shot1 = path.join(shotsDir, "TASK-49-1.png");
    await page.screenshot({ path: shot1 });

    // The moment is 2 s server-side presentation: after it clears
    // the respawned scout cockpit is what remains.
    await expect(overlay).toHaveCount(0, { timeout: 4_000 });
    const restored = await page.evaluate(() => {
      const w = window as unknown as {
        __driftClient?: { getDestruction: () => { snapshot: () => { timeScale: number } } };
      };
      return w.__driftClient!.getDestruction().snapshot().timeScale;
    });
    expect(restored).toBe(1);
    await expect(page.locator("canvas").first()).toBeVisible();
    const shot2 = path.join(shotsDir, "TASK-49-2.png");
    await page.screenshot({ path: shot2 });

    expect(errors, errors.join("\n")).toEqual([]);
    await ctx.close();
  });
});
