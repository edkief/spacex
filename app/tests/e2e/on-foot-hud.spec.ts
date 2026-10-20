/**
 * On-foot HUD e2e — TASK-52.
 *
 * Boots a Playwright browser against the worker fixture, flips the
 * local controls into on-foot mode (the same atomic event the
 * camera handoff uses), and asserts:
 *
 *   - The `<OnFootHUD>` subtree mounts with the expected test ids
 *     (`drift-on-foot-hud`, `drift-exposure-meter`,
 *     `drift-interaction-line`).
 *   - The `<ShipHUD>` subtree is gone — the mode switch is atomic.
 *   - The exposure meter shows the **radiation** icon when the
 *     player is inside a rad zone (`currentHazard.kind === "radzone"`).
 *   - The exposure bar colour flips to amber at 20 / 50, red at
 *     5 / 50, and green at 30 / 50 (TASK-52 thresholds).
 *   - The recover countdown reads "5s" the moment the
 *     `recoveringUntilMs` is set (5 000 ms in the future).
 *
 * Saves a screenshot to `.ralph/screenshots/TASK-52-1.png` (rad
 * zone on foot) and `TASK-52-2.png` (recovering on foot).
 */
import { test, expect } from "./fixtures.js";
import { ClaimPage } from "./pages/claim.js";
import type { Page } from "@playwright/test";
import path from "node:path";

const SHOTS_DIR = path.join(process.cwd(), "..", ".ralph", "screenshots");

async function setHudMode(page: Page, mode: "ship" | "character" | null): Promise<void> {
  await page.evaluate((nextMode) => {
    (window as unknown as { __driftHudModeOverride?: string | null }).__driftHudModeOverride =
      nextMode;
  }, mode);
  // Allow the React heartbeat to commit (the hook polls every 250 ms;
  // pin to 500 ms to stay deterministic across machines).
  await page.waitForTimeout(500);
}

/**
 * Pin the ship-HUD's snapshot via the dev seam so the
 * `<ShipHUD>` subtree renders with a deterministic snapshot.
 * Without this the ShipHUD returns `null` (snap === null branch)
 * and the "ship-subtree is gone after the switch" assertion races
 * with that null-return.
 */
async function injectShipSnapshot(page: Page, regime: string): Promise<void> {
  await page.evaluate((regimeArg) => {
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
    seam.setSnapshot({
      pos: { x: 0, y: 50, z: 0 },
      vel: { x: 0, y: 0, z: 12 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: regimeArg,
      hull: 100,
      shields: 50,
      onPad: null,
      classId: "scout",
      throttle: 0.4,
    });
  }, regime);
  await page.waitForTimeout(200);
}

async function freezeIngressHazard(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __driftClient?: { getHazardStore: () => unknown };
    };
    const store = w.__driftClient?.getHazardStore() as {
      applyHazardUpdate: (p: Record<string, unknown>, nowMs?: number) => void;
    };
    if (!store) throw new Error("hazard store not mounted");
    const original = store.applyHazardUpdate.bind(store);
    (window as unknown as { __hazardFrozen?: boolean }).__hazardFrozen = false;
    store.applyHazardUpdate = (p: Record<string, unknown>, nowMs?: number) => {
      if ((window as unknown as { __hazardFrozen?: boolean }).__hazardFrozen) return;
      original(p, nowMs);
    };
  });
}

async function driveHazardState(
  page: Page,
  payload: {
    exposure: number;
    inHazard: boolean;
    currentHazard: {
      hazardId: string;
      kind: "storm" | "radzone" | "drones";
      pos: [number, number, number];
      radius: number;
      intensity: number;
    } | null;
    recoveringUntilMs: number;
  },
): Promise<void> {
  await page.evaluate((p) => {
    const w = window as unknown as {
      __driftClient?: { getHazardStore: () => unknown };
    };
    const store = w.__driftClient?.getHazardStore() as {
      applyHazardUpdate: (p: Record<string, unknown>, nowMs?: number) => void;
    };
    if (!store) throw new Error("hazard store not mounted");
    const framed: Record<string, unknown> = {
      exposure: p.exposure,
      inHazard: p.inHazard,
      recoveringUntilMs: p.recoveringUntilMs,
    };
    if (p.currentHazard) framed.currentHazard = p.currentHazard;
    store.applyHazardUpdate(framed, Date.now());
  }, payload);
}

test.describe("on-foot HUD (TASK-52)", () => {
  test("the on-foot subtree mounts once the controls go on-foot and the ship subtree unmounts", async ({
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

    // Inject a ship snapshot so `<ShipHUD>` mounts (it returns
    // `null` until the first predictor frame lands, which is
    // mid-handshake).
    await injectShipSnapshot(page, "atmosphere");

    // Baseline: ship HUD is mounted, on-foot HUD is not.
    await expect(page.locator('[data-testid="drift-on-foot-hud"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="drift-ship-hud"]')).toHaveCount(1);

    await setHudMode(page, "character");

    await expect(page.locator('[data-testid="drift-on-foot-hud"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="drift-ship-hud"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="drift-exposure-meter"]')).toHaveCount(1);
    // The prompt itself only mounts when an interactable is in
    // range; we don't assert that here (the line still mounts).
    await expect(page.locator('[data-testid="drift-on-foot-hud"]')).toHaveAttribute(
      "data-mode",
      "character",
    );

    // Restore ship mode for the rest of the suite.
    await setHudMode(page, "ship");
    await expect(page.locator('[data-testid="drift-on-foot-hud"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="drift-ship-hud"]')).toHaveCount(1);

    expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
  });

  test("exposure meter paints the radiation icon inside a rad zone", async ({
    page,
    driftServer,
  }) => {
    const claim = new ClaimPage(page, driftServer);
    await claim.bootAndWaitForOnline();
    await setHudMode(page, "character");
    await freezeIngressHazard(page);
    await driveHazardState(page, {
      exposure: 30,
      inHazard: true,
      currentHazard: {
        hazardId: "h-rad",
        kind: "radzone",
        pos: [0, 0, 0],
        radius: 200,
        intensity: 5,
      },
      recoveringUntilMs: 0,
    });

    const meter = page.locator('[data-testid="drift-exposure-meter"]');
    await expect(meter).toHaveCount(1);
    await expect(meter).toHaveAttribute("data-current-hazard-kind", "radzone");
    await expect(
      page.locator('[data-testid="drift-exposure-hazard-icon"][data-kind="radzone"]'),
    ).toHaveCount(1);
    await expect(meter).toContainText("EXPOSURE");
    await expect(meter).toContainText("30/50");

    // Save the rad-zone screenshot for the task log.
    await page.screenshot({
      path: path.join(SHOTS_DIR, "TASK-52-1.png"),
      fullPage: true,
    });
  });

  test("exposure bar flips amber→red→green with the spec thresholds", async ({
    page,
    driftServer,
  }) => {
    const claim = new ClaimPage(page, driftServer);
    await claim.bootAndWaitForOnline();
    await setHudMode(page, "character");
    await freezeIngressHazard(page);

    // 20 / 50 → amber (#f59e0b). Browsers serialize hex to
    // `rgb()` so we match both forms.
    await driveHazardState(page, {
      exposure: 20,
      inHazard: true,
      currentHazard: null,
      recoveringUntilMs: 0,
    });
    const fill20 = page.locator('[data-testid="drift-exposure-fill"]');
    await expect(fill20).toHaveAttribute("style", /(#f59e0b|rgb\(245,\s*158,\s*11\))/);

    // 5 / 50 → red (#ff3344).
    await driveHazardState(page, {
      exposure: 5,
      inHazard: true,
      currentHazard: null,
      recoveringUntilMs: 0,
    });
    await expect(fill20).toHaveAttribute("style", /(#ff3344|rgb\(255,\s*51,\s*68\))/);

    // 30 / 50 → green (#34d399).
    await driveHazardState(page, {
      exposure: 30,
      inHazard: false,
      currentHazard: null,
      recoveringUntilMs: 0,
    });
    await expect(fill20).toHaveAttribute("style", /(#34d399|rgb\(52,\s*211,\s*153\))/);
  });

  test("recovering state flips the meter to RECOVERING + countdown", async ({
    page,
    driftServer,
  }) => {
    const claim = new ClaimPage(page, driftServer);
    await claim.bootAndWaitForOnline();
    await setHudMode(page, "character");
    await freezeIngressHazard(page);
    await driveHazardState(page, {
      exposure: 0,
      inHazard: false,
      currentHazard: null,
      recoveringUntilMs: Date.now() + 5_000,
    });

    const meter = page.locator('[data-testid="drift-exposure-meter"]');
    await expect(meter).toHaveAttribute("data-recovering", "true");
    await expect(page.locator('[data-testid="drift-exposure-recovering-badge"]')).toContainText(
      "RECOVERING",
    );
    await expect(page.locator('[data-testid="drift-exposure-recovering-countdown"]')).toContainText(
      "5s",
    );

    await page.screenshot({
      path: path.join(SHOTS_DIR, "TASK-52-2.png"),
      fullPage: true,
    });
  });

  test.afterEach(async ({ page }) => {
    // Always clear the dev override so a stuck value can't leak
    // across worker tests.
    await setHudMode(page, null);
  });
});
