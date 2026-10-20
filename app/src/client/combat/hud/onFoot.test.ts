/**
 * On-foot HUD math unit tests — TASK-52.
 *
 * Covers:
 *   - Exposure bar thresholds (`>25 green`, `10-25 amber`,
 *     `<10 red`).
 *   - Recovering state countdown (fake clock).
 *   - Hazard glyph fan-out (radiation / storm / drones / neutral).
 *   - Weight bar fill + colour + tooltip formatting.
 *   - Pick-nearest interaction line exclusivity.
 */
import { describe, expect, it } from "vitest";

import {
  CARRY_WEIGHT_CAP,
  EXPOSURE_MAX,
  EXPOSURE_THRESHOLDS,
  RECOVERING_DURATION_MS,
  exposureBarColor,
  exposureBarFraction,
  formatWeightTooltip,
  hazardGlyph,
  pickNearest,
  recoveringState,
  shouldFlashExposure,
  weightBarState,
} from "./onFoot.js";

describe("exposureBarFraction (TASK-52)", () => {
  it("returns a fraction in [0, 1] for the full exposure range", () => {
    expect(exposureBarFraction(0)).toBe(0);
    expect(exposureBarFraction(EXPOSURE_MAX / 2)).toBeCloseTo(0.5, 6);
    expect(exposureBarFraction(EXPOSURE_MAX)).toBe(1);
  });

  it("clamps negative values to 0", () => {
    expect(exposureBarFraction(-1)).toBe(0);
    expect(exposureBarFraction(-50)).toBe(0);
  });

  it("clamps over-cap values to 1", () => {
    expect(exposureBarFraction(51)).toBe(1);
    expect(exposureBarFraction(1_000)).toBe(1);
  });

  it("returns 0 for non-finite input", () => {
    expect(exposureBarFraction(Number.NaN)).toBe(0);
    expect(exposureBarFraction(Infinity)).toBe(0);
  });
});

describe("exposureBarColor (TASK-52)", () => {
  it("is green above the upper threshold (> 25)", () => {
    expect(exposureBarColor(EXPOSURE_THRESHOLDS.greenMin + 0.1)).toBe("#34d399");
    expect(exposureBarColor(40)).toBe("#34d399");
    expect(exposureBarColor(EXPOSURE_MAX)).toBe("#34d399");
  });

  it("is amber between 10 and 25 (inclusive of 10, exclusive of 25+)", () => {
    expect(exposureBarColor(EXPOSURE_THRESHOLDS.amberMin)).toBe("#f59e0b");
    expect(exposureBarColor(20)).toBe("#f59e0b");
    // Boundary: at the threshold (>25 isn't true) so amber.
    expect(exposureBarColor(EXPOSURE_THRESHOLDS.greenMin)).toBe("#f59e0b");
  });

  it("is red below 10 (inclusive)", () => {
    expect(exposureBarColor(EXPOSURE_THRESHOLDS.amberMin - 0.1)).toBe("#ff3344");
    expect(exposureBarColor(5)).toBe("#ff3344");
    expect(exposureBarColor(0)).toBe("#ff3344");
  });
});

describe("shouldFlashExposure (TASK-52)", () => {
  it("flashes while the player is recovering", () => {
    const now = 1_000_000;
    expect(shouldFlashExposure(0, now + 3_000, now)).toBe(true);
  });

  it("flashes below the amber threshold when not recovering", () => {
    expect(shouldFlashExposure(EXPOSURE_THRESHOLDS.amberMin - 0.1, 0, 0)).toBe(true);
  });

  it("does not flash once exposure is in the safe zone and not recovering", () => {
    expect(shouldFlashExposure(EXPOSURE_THRESHOLDS.amberMin + 5, 0, Date.now())).toBe(false);
    expect(shouldFlashExposure(EXPOSURE_MAX, 0, Date.now())).toBe(false);
  });
});

describe("recoveringState (TASK-52)", () => {
  it("reports not-recovering when the timer has elapsed", () => {
    const now = 2_000_000;
    const state = recoveringState(now - 100, now);
    expect(state.recovering).toBe(false);
    expect(state.msRemaining).toBe(0);
    expect(state.secondsRemaining).toBe(0);
  });

  it("reports the remaining seconds floored by ceiling (1 s left when ms<1000)", () => {
    const now = 2_000_000;
    const state = recoveringState(now + 250, now);
    expect(state.recovering).toBe(true);
    // 250 ms rounds **up** to 1 s so the UI shows "1" the moment
    // it ticks below 1000 ms.
    expect(state.secondsRemaining).toBe(1);
  });

  it("reports a 5-second countdown when fresh", () => {
    const now = 2_000_000;
    const state = recoveringState(now + RECOVERING_DURATION_MS, now);
    expect(state.recovering).toBe(true);
    expect(state.secondsRemaining).toBe(RECOVERING_DURATION_MS / 1000);
  });

  it("clamps negative ms remaining to 0", () => {
    const state = recoveringState(0, 5_000);
    expect(state.msRemaining).toBe(0);
    expect(state.secondsRemaining).toBe(0);
  });
});

describe("hazardGlyph (TASK-52)", () => {
  it("returns a neutral glyph when the player is out of hazards", () => {
    const glyph = hazardGlyph(null);
    expect(glyph.family).toBe("neutral");
  });

  it("returns the radiation glyph for rad zones", () => {
    const glyph = hazardGlyph({ kind: "radzone" });
    expect(glyph.family).toBe("radiation");
    expect(glyph.color).toBe("#7CFF6B");
  });

  it("returns the storm glyph inside a storm cell", () => {
    const glyph = hazardGlyph({ kind: "storm" });
    expect(glyph.family).toBe("storm");
  });

  it("returns the drone glyph inside a drone cell", () => {
    const glyph = hazardGlyph({ kind: "drones" });
    expect(glyph.family).toBe("drones");
  });
});

describe("weightBarState (TASK-52)", () => {
  it("returns the right fill at the middle of the cap", () => {
    expect(weightBarState(CARRY_WEIGHT_CAP / 2).fill).toBeCloseTo(0.5, 6);
  });

  it("uses the grey colour below 70 %", () => {
    expect(weightBarState(20).color).toBe("#9aa6b2");
  });

  it("uses the amber colour at >= 70 %", () => {
    expect(weightBarState(Math.round(CARRY_WEIGHT_CAP * 0.7)).color).toBe("#f5b94d");
    expect(weightBarState(Math.round(CARRY_WEIGHT_CAP * 0.9)).color).toBe("#f5b94d");
  });

  it("uses the red colour at >= 95 %", () => {
    expect(weightBarState(CARRY_WEIGHT_CAP).color).toBe("#d04848");
    expect(weightBarState(CARRY_WEIGHT_CAP - 1).color).toBe("#d04848");
  });
});

describe("formatWeightTooltip (TASK-52)", () => {
  it("renders every non-zero stack with a stable ordering", () => {
    expect(formatWeightTooltip({ iron: 12, copper: 0, crystal: 2 })).toBe("crystal x2, iron x12");
  });

  it("renders an empty placeholder when nothing is held", () => {
    expect(formatWeightTooltip({})).toBe("(empty)");
    expect(formatWeightTooltip({ iron: 0, copper: 0 })).toBe("(empty)");
  });
});

describe("pickNearest (TASK-52)", () => {
  const items = [
    { id: "far", distance: 12 },
    { id: "near", distance: 2 },
    { id: "middle", distance: 5 },
  ];

  it("returns the entry with the smallest distance", () => {
    const picked = pickNearest(items);
    expect(picked?.id).toBe("near");
  });

  it("returns null when the list is empty", () => {
    expect(pickNearest([])).toBeNull();
  });

  it("breaks ties by first-occurring (stable order)", () => {
    const tied = [
      { id: "a", distance: 5 },
      { id: "b", distance: 5 },
    ];
    expect(pickNearest(tied)?.id).toBe("a");
  });
});
