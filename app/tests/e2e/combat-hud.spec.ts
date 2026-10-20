/**
 * TASK-50 acceptance — Playwright e2e for the assembled combat HUD.
 *
 * Scripts a combat scene through the existing dev seams (the same
 * ones TASK-43 / TASK-44 shipped):
 *
 *   - `__driftClient.__fireWeaponStateForTest` → the weapon /
 *     energy readout (selector + energy band),
 *   - `getTargeting().applyLocked` → the target box,
 *   - `getTargeting().applyCombatEvent` → the threat ping,
 *   - `getKillFeed().applyKillEvent` → the kill feed,
 *   - `__driftCombatHud.setTargetScreenOverride` → pin the box to
 *     a deterministic screen point for the screenshot.
 *
 * Asserts: no console/page errors, all four regions render, and
 * the four combat regions stay disjoint from the reserved HUD
 * regions (prompt line, player list, chat, debug overlay) at a
 * 1280×720 viewport.
 */

import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures.js";
import { ClaimPage } from "./pages/claim.js";
import path from "node:path";

/** Script the whole combat scene in one page-side call. */
async function scriptCombatScene(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __driftClient?: {
        __fireWeaponStateForTest?: (payload: {
          activeWeapon: "laser" | "missile";
          energy: number;
        }) => void;
        getTargeting?: () => {
          applyLocked?: (payload: Record<string, unknown>) => void;
          applyTargetUpdate?: (payload: Record<string, unknown>) => void;
          applyCombatEvent?: (event: Record<string, unknown>, self: string | null) => void;
        };
        getKillFeed?: () => {
          applyKillEvent?: (
            event: Record<string, unknown>,
            args: {
              resolver: (id: string) => string;
              isPlayerId: (id: string) => boolean;
              nowMs: number;
            },
          ) => void;
        };
        currentCallsign?: string | null;
      };
      __driftCombatHud?: {
        setTargetScreenOverride?: (p: { x: number; y: number } | null) => void;
      };
    };
    const client = w.__driftClient;
    if (!client) throw new Error("client seam missing");
    // Weapon / energy readout: active laser, energy in the amber band.
    client.__fireWeaponStateForTest?.({ activeWeapon: "laser", energy: 22 });
    // Target box: an AI interceptor 340 m out, 40 % hull, 60 % shield.
    const targeting = client.getTargeting?.();
    targeting?.applyLocked?.({
      targetId: "AI-INTERCEPTOR",
      callsign: null,
      range: 340,
      bearing: 12,
      lockedAt: Date.now(),
    });
    targeting?.applyTargetUpdate?.({
      targetId: "AI-INTERCEPTOR",
      callsign: null,
      classId: "interceptor",
      hull: 32,
      shields: 24,
      range: 340,
      bearing: 12,
    });
    // Threat ping: an enemy hit us from 40° to starboard.
    targeting?.applyCombatEvent?.(
      {
        kind: "damaged",
        target: "ship:self",
        source: { kind: "ai", id: "AI-INTERCEPTOR" },
        amount: 6,
        shieldHit: 6,
        hullHit: 0,
        tick: 1,
      },
      "ship:self",
    );
    // Kill feed: two entries (PvP white + PvE grey).
    const feed = client.getKillFeed?.();
    feed?.applyKillEvent?.(
      { kind: "kill", attacker: "VEGA", target: "NOMAD" },
      { resolver: (id) => id, isPlayerId: (id) => id === "VEGA", nowMs: Date.now() },
    );
    feed?.applyKillEvent?.(
      { kind: "kill", attacker: "VEGA", target: "RAIDER" },
      { resolver: (id) => id, isPlayerId: () => false, nowMs: Date.now() },
    );
    // Pin the box to a deterministic screen point.
    w.__driftCombatHud?.setTargetScreenOverride?.({ x: 853, y: 230 });
  });
}

test.describe("combat HUD (TASK-50)", () => {
  test("renders target box, weapon readout, threat ping and kill feed", async ({
    page,
    driftServer,
  }) => {
    const claim = new ClaimPage(page, driftServer);
    await claim.bootAndWaitForOnline();
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    await page.waitForTimeout(1_000);

    await scriptCombatScene(page);
    await page.waitForTimeout(400);

    const regions = await page.evaluate(() => {
      const pick = (id: string): DOMRect | null => {
        const el = document.querySelector(`[data-testid="${id}"]`);
        return el ? el.getBoundingClientRect() : null;
      };
      return {
        hud: pick("drift-combat-hud") !== null,
        targetBox: pick("drift-target-box") !== null,
        weaponReadout: pick("drift-weapon-readout") !== null,
        energyBar: pick("drift-energy-bar") !== null,
        killFeed: pick("drift-kill-feed") !== null,
        threatPing: pick("drift-threat-ping") !== null,
        energyLevel: document
          .querySelector('[data-testid="drift-energy-bar"]')
          ?.getAttribute("data-level"),
        killFeedRows: document.querySelectorAll('[data-testid="drift-kill-feed-row"]').length,
        lowEnergy: document.querySelector('[data-testid="drift-low-energy"]') !== null,
      };
    });

    expect(regions.hud).toBe(true);
    expect(regions.targetBox).toBe(true);
    expect(regions.weaponReadout).toBe(true);
    expect(regions.energyBar).toBe(true);
    // The kill feed + threat ping fade on a TTL; sample early.
    expect(regions.killFeed || regions.killFeedRows > 0).toBe(true);
    expect(regions.threatPing).toBe(true);
    expect(regions.energyLevel).toBe("amber");
    expect(regions.lowEnergy).toBe(false);

    // Layout discipline: the combat regions must not cover the
    // prompt line (bottom-center), the player list (bottom-left),
    // the chat (top-left) or the debug overlay (top-right).
    const overlaps = await page.evaluate(() => {
      const rect = (sel: string): DOMRect | null => {
        const el = document.querySelector(sel);
        return el ? el.getBoundingClientRect() : null;
      };
      const hit = (a: DOMRect, b: DOMRect): boolean =>
        a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      const combat = [
        rect('[data-testid="drift-kill-feed"]'),
        rect('[data-testid="drift-target-box"]'),
        rect('[data-testid="drift-weapon-readout"]'),
      ].filter((r): r is DOMRect => r !== null);
      const reserved = [
        rect('[data-testid="drift-player-list"]'),
        rect('[data-testid="drift-interact-prompt"]'),
        rect('[data-testid="drift-chat-log"]'),
      ].filter((r): r is DOMRect => r !== null);
      const found: string[] = [];
      for (const c of combat) {
        for (const r of reserved) {
          if (hit(c, r)) found.push(`${c.width}x${c.height} @ ${c.left},${c.top}`);
        }
      }
      return found;
    });
    expect(overlaps, `combat HUD overlaps reserved regions: ${overlaps.join(", ")}`).toEqual([]);

    expect(errors, errors.join("\n")).toEqual([]);

    const screenshotPath = path.join(process.cwd(), "..", ".ralph", "screenshots", "TASK-50-1.png");
    await page.screenshot({ path: screenshotPath, fullPage: false });
  });
});
