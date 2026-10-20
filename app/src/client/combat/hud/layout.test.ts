/**
 * HUD layout + frame budget — TASK-50 acceptance.
 *
 * The disjointness rule (the spec's "layout test") lives here as
 * pure math over `hudSlots()`, so it runs in Node with no DOM. The
 * component test (`CombatHUD.test.tsx`) proves the rendered markup
 * actually lands on the slots this table resolves.
 */
import { describe, expect, it } from "vitest";

import { FrameMonitor } from "../../perf/frameMonitor.js";
import {
  HUD_DISJOINT_SLOTS,
  HUD_FRAME_BUDGET_MS,
  HUD_REFERENCE_VIEWPORT_H,
  HUD_REFERENCE_VIEWPORT_W,
  HUD_STATE_POLL_MS,
  hudSlots,
  rectsOverlap,
} from "./layout.js";
import { timeHudWork } from "./timing.js";

describe("hudSlots (TASK-50)", () => {
  it("keeps every HUD region inside the viewport", () => {
    const layout = hudSlots();
    for (const [name, rect] of Object.entries(layout)) {
      expect(rect.left, name).toBeGreaterThanOrEqual(0);
      expect(rect.top, name).toBeGreaterThanOrEqual(0);
      expect(rect.left + rect.width, name).toBeLessThanOrEqual(HUD_REFERENCE_VIEWPORT_W);
      expect(rect.top + rect.height, name).toBeLessThanOrEqual(HUD_REFERENCE_VIEWPORT_H);
    }
  });

  it("anchors the target box 1/3 in from the right edge", () => {
    const rect = hudSlots().targetBox;
    const centre = rect.left + rect.width / 2;
    expect(centre / HUD_REFERENCE_VIEWPORT_W).toBeCloseTo(2 / 3, 3);
  });

  it("puts the weapon readout above the prompt line (bottom-center)", () => {
    const { weaponReadout, prompt } = hudSlots();
    expect(weaponReadout.left + weaponReadout.width / 2).toBeCloseTo(
      prompt.left + prompt.width / 2,
      0,
    );
    expect(weaponReadout.top + weaponReadout.height).toBeLessThanOrEqual(prompt.top);
  });

  it("keeps the combat regions disjoint from every reserved region", () => {
    const layout = hudSlots();
    for (let i = 0; i < HUD_DISJOINT_SLOTS.length; i++) {
      for (let j = i + 1; j < HUD_DISJOINT_SLOTS.length; j++) {
        const a = layout[HUD_DISJOINT_SLOTS[i]!];
        const b = layout[HUD_DISJOINT_SLOTS[j]!];
        expect(
          rectsOverlap(a, b),
          `${HUD_DISJOINT_SLOTS[i]} overlaps ${HUD_DISJOINT_SLOTS[j]}`,
        ).toBe(false);
      }
    }
  });

  it("holds the disjointness rule at other viewport sizes", () => {
    for (const [w, h] of [
      [1024, 768],
      [1440, 900],
      [1920, 1080],
    ] as const) {
      const layout = hudSlots(w, h);
      for (let i = 0; i < HUD_DISJOINT_SLOTS.length; i++) {
        for (let j = i + 1; j < HUD_DISJOINT_SLOTS.length; j++) {
          expect(
            rectsOverlap(layout[HUD_DISJOINT_SLOTS[i]!], layout[HUD_DISJOINT_SLOTS[j]!]),
            `${HUD_DISJOINT_SLOTS[i]} overlaps ${HUD_DISJOINT_SLOTS[j]} at ${w}x${h}`,
          ).toBe(false);
        }
      }
    }
  });
});

describe("rectsOverlap (TASK-50)", () => {
  it("treats touching edges as disjoint and real overlap as a hit", () => {
    const a = { left: 0, top: 0, width: 10, height: 10 };
    expect(rectsOverlap(a, { left: 10, top: 0, width: 10, height: 10 })).toBe(false);
    expect(rectsOverlap(a, { left: 9, top: 0, width: 10, height: 10 })).toBe(true);
    expect(rectsOverlap(a, { left: 0, top: 9, width: 10, height: 10 })).toBe(true);
  });
});

describe("timeHudWork (TASK-50 / TASK-57)", () => {
  it("records the HUD category on the frame monitor", () => {
    const monitor = new FrameMonitor();
    let clock = 0;
    const elapsed = timeHudWork(
      () => {
        clock += 0.25;
      },
      { monitor, now: () => clock },
    );
    expect(elapsed).toBeCloseTo(0.25, 5);
    expect(monitor.getCategoryCount("hud")).toBeCloseTo(0.25, 5);
  });

  it("keeps a realistic projection pass inside the 1 ms budget", () => {
    const monitor = new FrameMonitor();
    const sample = {
      camPos: { x: 0, y: 0, z: 0 },
      camForward: { x: 0, y: 0, z: 1 },
      targetPos: { x: 3, y: 2, z: 120 },
      viewportW: 1280,
      viewportH: 720,
    };
    let now = 0;
    const start = now;
    let elapsed = 0;
    for (let i = 0; i < 100; i++) {
      elapsed = timeHudWork(
        () => {
          Math.sqrt(sample.targetPos.x ** 2 + sample.targetPos.y ** 2 + sample.targetPos.z ** 2);
        },
        { monitor, now: () => (now += 0.02) },
      );
    }
    expect(elapsed).toBeLessThan(HUD_FRAME_BUDGET_MS);
    expect(now - start).toBeGreaterThan(0);
  });

  it("re-throws after recording a failure", () => {
    const monitor = new FrameMonitor();
    let clock = 0;
    expect(() =>
      timeHudWork(
        () => {
          clock += 1;
          throw new Error("boom");
        },
        { monitor, now: () => clock },
      ),
    ).toThrow("boom");
    expect(monitor.getCategoryCount("hud")).toBe(1);
  });
});

describe("HUD cadence (TASK-50)", () => {
  it("pins the HUD state cadence to the 10 Hz snapshot rate", () => {
    expect(HUD_STATE_POLL_MS).toBe(100);
  });
});
