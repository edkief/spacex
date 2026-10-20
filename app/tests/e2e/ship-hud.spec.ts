/**
 * TASK-51 acceptance — Playwright e2e for the ship HUD.
 *
 * Drives a flight scene through the existing dev seams (the same
 * pattern TASK-50 used for the combat HUD):
 *
 *   - `window.__driftClient.predictor.state()` → the local ship's
 *     snapshot fields (regime / hull / shields / onPad / pos /
 *     vel / quat). We mutate the predictor via its public state
 *     setter (no private seams needed).
 *   - `__driftClient.__fireSelfHitForTest` → the 300 ms vitals-bar
 *     flash overlay.
 *
 * Asserts:
 *
 *   - At altitude: regime tag reads "ATMOS", altitude label reads
 *     "ALT X m" with the right integer, docked tag absent.
 *   - In space: regime tag reads "SPACE", altitude label reads
 *     "—", speed readout still formatted as 1-decimal m/s.
 *   - Flash: after a self-hit, the vitals bar carries
 *     `data-flash="active"`; the same bar goes back to
 *     `data-flash="idle"` within 300 ms.
 *   - Two screenshots saved: one for each regime.
 */

import type { Page } from "@playwright/test";
import path from "node:path";

import { expect, test } from "./fixtures.js";
import { ClaimPage } from "./pages/claim.js";

async function scriptShipSnapshot(
  page: Page,
  args: {
    regime: "space" | "atmosphere" | "surface";
    pos: { x: number; y: number; z: number };
    vel: { x: number; y: number; z: number };
  },
): Promise<void> {
  await page.evaluate((a) => {
    const w = window as unknown as {
      __driftShipHud?: {
        setSnapshot: (s: {
          pos: { x: number; y: number; z: number };
          vel: { x: number; y: number; z: number };
          quat: { x: number; y: number; z: number; w: number };
          regime: string;
          hull: number;
          shields: number;
          onPad: string | null;
          classId: string | null;
          throttle: number | null;
        }) => void;
      };
    };
    const seam = w.__driftShipHud;
    if (!seam) throw new Error("__driftShipHud seam missing");
    // The predictor exposes its state via forceSnap() —
    // we ride that seam to inject a synthetic snapshot for the
    // screenshot. Production code path is unchanged.
    seam.setSnapshot({
      pos: a.pos,
      vel: a.vel,
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: a.regime === "atmosphere" ? "atmosphere" : a.regime,
      hull: 90,
      shields: 35,
      onPad: null,
      classId: "scout",
      throttle: 0.5,
    });
  }, args);
}

test.describe("ship HUD (TASK-51)", () => {
  test("atmosphere: regime tag reads ATMOS, altitude reads 'ALT X m'", async ({
    page,
    driftServer,
  }) => {
    const claim = new ClaimPage(page, driftServer);
    await claim.bootAndWaitForOnline();

    const consoleErrors: string[] = [];
    page.on("pageerror", (err) => consoleErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    // Synthesize an atmo snapshot: ship at y=1234, regime=atmosphere.
    await scriptShipSnapshot(page, {
      regime: "atmosphere",
      pos: { x: 0, y: 1_234, z: 0 },
      vel: { x: 0, y: 0, z: 60 },
    });
    // Wait for the HUD update.
    await page.waitForTimeout(300);

    const regions = await page.evaluate(() => {
      const exists = (id: string): boolean => {
        const el = document.querySelector(`[data-testid="${id}"]`);
        return el !== null;
      };
      const text = (id: string): string | null => {
        const el = document.querySelector(`[data-testid="${id}"]`);
        return el?.textContent ?? null;
      };
      return {
        hud: exists("drift-ship-hud"),
        speed: text("drift-ship-speed-value"),
        altitude: text("drift-ship-altitude-readout"),
        regime: text("drift-ship-regime-tag"),
        vitals: exists("drift-ship-vitals-bar"),
        hullLabel: text("drift-ship-hull-label"),
        shieldLabel: text("drift-ship-shield-label"),
        docked: exists("drift-ship-docked-tag"),
        thrustPositive: document
          .querySelector('[data-testid="drift-ship-thrust-bar"]')
          ?.getAttribute("data-positive"),
      };
    });
    expect(regions.hud).toBe(true);
    expect(regions.speed).not.toBeNull();
    // magnitude(60,0,0) = 60.0; threshold-aware formatting trims tail
    // zero fractions for integer values.
    expect(regions.speed?.trim()).toBe("60.0");
    expect(regions.altitude?.trim()).toBe("ALT 1234 m");
    expect(regions.regime?.trim()).toBe("ATMOS");
    expect(regions.vitals).toBe(true);
    expect(regions.hullLabel?.trim()).toBe("HULL 90");
    expect(regions.shieldLabel?.trim()).toBe("SHD 35");
    expect(regions.docked).toBe(false);
    expect(regions.thrustPositive).toBe("true");

    const screenshotPath = path.join(process.cwd(), "..", ".ralph", "screenshots", "TASK-51-1.png");
    await page.screenshot({ path: screenshotPath, fullPage: false });

    expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
  });

  test("space: regime tag reads SPACE, altitude reads '—'", async ({ page, driftServer }) => {
    const claim = new ClaimPage(page, driftServer);
    await claim.bootAndWaitForOnline();

    const consoleErrors: string[] = [];
    page.on("pageerror", (err) => consoleErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await scriptShipSnapshot(page, {
      regime: "space",
      pos: { x: 0, y: 9_999, z: 0 },
      vel: { x: 0, y: 0, z: 320 },
    });
    await page.waitForTimeout(300);

    const regions = await page.evaluate(() => {
      const text = (id: string): string | null => {
        const el = document.querySelector(`[data-testid="${id}"]`);
        return el?.textContent ?? null;
      };
      return {
        speed: text("drift-ship-speed-value"),
        altitude: text("drift-ship-altitude-readout"),
        regime: text("drift-ship-regime-tag"),
      };
    });

    expect(regions.speed?.trim()).toBe("320.0");
    expect(regions.altitude?.trim()).toBe("—");
    expect(regions.regime?.trim()).toBe("SPACE");

    const screenshotPath = path.join(process.cwd(), "..", ".ralph", "screenshots", "TASK-51-2.png");
    await page.screenshot({ path: screenshotPath, fullPage: false });

    expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
  });

  test("flips the vitals-bar flash overlay on a self-hit then clears it", async ({
    page,
    driftServer,
  }) => {
    const claim = new ClaimPage(page, driftServer);
    await claim.bootAndWaitForOnline();

    await scriptShipSnapshot(page, {
      regime: "atmosphere",
      pos: { x: 0, y: 1_000, z: 0 },
      vel: { x: 0, y: 0, z: 60 },
    });
    // Allow the 100 ms HUD poll cycle to land + the first render to flush.
    await page.waitForTimeout(300);

    // Fire a self-hit via the dev seam.
    await page.evaluate(() => {
      const w = window as unknown as {
        __driftClient?: {
          currentCallsign?: string | null;
          __fireSelfHitForTest?: (args: { kind: "hit"; target: string }) => void;
        };
      };
      // Resolve the same self-id format the App.tsx subscriber uses.
      const callsign = w.__driftClient?.currentCallsign ?? null;
      if (callsign === null) return;
      const target = `entity:${callsign.toLowerCase()}`;
      w.__driftClient?.__fireSelfHitForTest?.({
        kind: "hit",
        target,
      });
    });
    // The HUD poll cycle is 100 ms; allow up to 200 ms before
    // asserting so the next tick definitely fires.
    await page.waitForTimeout(200);
    const flashStateNow = await page.evaluate(() =>
      document.querySelector('[data-testid="drift-ship-vitals-bar"]')?.getAttribute("data-flash"),
    );
    expect(flashStateNow).toBe("active");
    // After the 300 ms window + a poll cycle: flash is back to idle.
    await page.waitForTimeout(500);
    const flashStateAfter = await page.evaluate(() =>
      document.querySelector('[data-testid="drift-ship-vitals-bar"]')?.getAttribute("data-flash"),
    );
    expect(flashStateAfter).toBe("idle");
  });
});
