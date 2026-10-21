/**
 * Perf profile table tests — TASK-58.
 *
 * The acceptance criteria pin the tuned numbers; these tests are the
 * regression guard so a later tuning pass (or TASK-59's mobile
 * profile) can't silently move a budget.
 */
import { describe, expect, it } from "vitest";

import { QUALITY_PRESETS, QUALITY_PRESET_IDS, pipelineParamsFor } from "./settings.js";
import {
  alignToVsync,
  clampFxCount,
  DEFAULT_COST_MODEL,
  DEFAULT_PERF_PROFILE,
  estimateFrameMs,
  evaluateBudgets,
  fxCapFor,
  fxCapKey,
  PERF_CAPPED_FX_KINDS,
  PERF_PROFILE_IDS,
  PERF_PROFILES,
  perfProfileFor,
  variancePct,
  type PerfMetrics,
} from "./perf.js";

/** Green metrics — one unit under every budget. */
function greenMetrics(over: Partial<PerfMetrics> = {}): PerfMetrics {
  return {
    drawCalls: 119,
    triangles: 499_999,
    materials: 39,
    surfaceTriangles: 399_999,
    labels: 20,
    instances: 100,
    fx: { "laser-flash": 16, "missile-tracer": 16, debris: 8 },
    ...over,
  };
}

describe("PERF_PROFILES", () => {
  it("has one entry per settings preset", () => {
    expect([...PERF_PROFILE_IDS]).toEqual([...QUALITY_PRESET_IDS]);
    for (const id of QUALITY_PRESET_IDS) {
      expect(PERF_PROFILES[id].id).toBe(id);
      expect(perfProfileFor(id)).toBe(PERF_PROFILES[id]);
    }
  });

  it("pins the High-preset acceptance numbers", () => {
    const high = PERF_PROFILES.high;
    expect(high.targetFps).toBe(60);
    expect(high.frameBudgetMs).toBeCloseTo(16.7, 1);
    expect(high.budgets.drawCalls).toBe(120);
    expect(high.budgets.triangles).toBe(500_000);
    expect(high.budgets.materials).toBe(40);
    expect(high.budgets.surfaceTriangles).toBe(400_000);
    expect(high.maxLabels).toBe(20);
  });

  it("pins the FX caps (≤ 16 lasers, ≤ 16 missiles, ≤ 8 debris sets)", () => {
    const high = PERF_PROFILES.high;
    expect(high.fxCaps.laserFlash).toBe(16);
    expect(high.fxCaps.missile).toBe(16);
    expect(high.fxCaps.debrisSet).toBe(8);
    expect(fxCapFor("laser-flash", high)).toBe(16);
    expect(fxCapFor("missile-tracer", high)).toBe(16);
    expect(fxCapFor("debris", high)).toBe(8);
  });

  it("keeps the LOD rings ordered and within the 8 km horizon", () => {
    for (const id of PERF_PROFILE_IDS) {
      const { near, mid, far } = PERF_PROFILES[id].lodRadiiM;
      expect(near).toBeGreaterThan(0);
      expect(mid).toBeGreaterThan(near);
      expect(far).toBeGreaterThan(mid);
      expect(far).toBeLessThanOrEqual(8_192);
    }
  });

  it("stays in step with the settings presets (star count + draw distance)", () => {
    for (const id of QUALITY_PRESET_IDS) {
      const profile = PERF_PROFILES[id];
      const params = pipelineParamsFor(id);
      expect(profile.starCount).toBe(params.starCount);
      // The far ring may reach one chunk (512 m) past the preset's
      // draw distance so a partially-visible edge chunk still draws.
      expect(profile.lodRadiiM.far).toBeLessThanOrEqual(params.drawDistanceM + 512);
      expect(profile.lodRadiiM.mid).toBeLessThanOrEqual(params.drawDistanceM);
      expect(QUALITY_PRESETS[id]).toBeDefined();
    }
  });

  it("falls back to the default profile for an unknown preset", () => {
    expect(perfProfileFor("ultra" as never)).toBe(DEFAULT_PERF_PROFILE);
  });

  it("gets cheaper as the preset drops (a mobile profile adds below low)", () => {
    const high = PERF_PROFILES.high;
    const medium = PERF_PROFILES.medium;
    const low = PERF_PROFILES.low;
    expect(medium.maxLabels).toBeLessThan(high.maxLabels);
    expect(low.maxLabels).toBeLessThan(medium.maxLabels);
    expect(low.instanceBatchSize).toBeLessThan(high.instanceBatchSize);
    expect(low.starCount).toBeLessThan(high.starCount);
    expect(low.budgets.drawCalls).toBeLessThan(high.budgets.drawCalls);
    for (const kind of PERF_CAPPED_FX_KINDS) {
      expect(fxCapFor(kind, low)).toBeLessThan(fxCapFor(kind, high));
    }
  });

  it("is frozen so a renderer can't mutate the table in place", () => {
    expect(Object.isFrozen(PERF_PROFILES)).toBe(true);
    expect(Object.isFrozen(PERF_PROFILES.high)).toBe(true);
    expect(Object.isFrozen(PERF_PROFILES.high.fxCaps)).toBe(true);
  });
});

describe("FX caps", () => {
  it("maps each capped kind onto its FxCaps field", () => {
    expect(fxCapKey("laser-flash")).toBe("laserFlash");
    expect(fxCapKey("missile-tracer")).toBe("missile");
    expect(fxCapKey("debris")).toBe("debrisSet");
  });

  it("clamps a requested count to the cap and floors at zero", () => {
    const high = PERF_PROFILES.high;
    expect(clampFxCount("laser-flash", 40, high)).toBe(16);
    expect(clampFxCount("missile-tracer", 3, high)).toBe(3);
    expect(clampFxCount("debris", -1, high)).toBe(0);
    expect(clampFxCount("debris", 0, high)).toBe(0);
  });
});

describe("cost model", () => {
  it("scales with draw calls, triangles, instances and labels", () => {
    const light = estimateFrameMs({ drawCalls: 10, triangles: 1_000, instances: 10, labels: 0 });
    const heavy = estimateFrameMs({
      drawCalls: 200,
      triangles: 200_000,
      instances: 1_000,
      labels: 20,
    });
    expect(heavy).toBeGreaterThan(light * 5);
    expect(light).toBeGreaterThan(DEFAULT_COST_MODEL.baseMs);
  });

  it("aligns a frame inside the budget to one vsync interval", () => {
    const high = PERF_PROFILES.high;
    expect(alignToVsync(4, high)).toBe(high.frameBudgetMs);
    expect(alignToVsync(40, high)).toBe(40);
  });
});

describe("evaluateBudgets", () => {
  it("passes a frame one unit under every budget", () => {
    const report = evaluateBudgets(greenMetrics(), PERF_PROFILES.high);
    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it("treats the draw-call / material / triangle ceilings as strict", () => {
    const report = evaluateBudgets(
      greenMetrics({ drawCalls: 120, materials: 40, triangles: 500_000 }),
      PERF_PROFILES.high,
    );
    expect(report.ok).toBe(false);
    expect(report.violations.map((v) => v.name).sort()).toEqual([
      "drawCalls",
      "materials",
      "triangles",
    ]);
  });

  it("treats the FX and label caps as inclusive", () => {
    const ok = evaluateBudgets(greenMetrics(), PERF_PROFILES.high);
    expect(ok.ok).toBe(true);
    const over = evaluateBudgets(
      greenMetrics({ labels: 21, fx: { "laser-flash": 17, "missile-tracer": 16, debris: 8 } }),
      PERF_PROFILES.high,
    );
    expect(over.violations.map((v) => v.name).sort()).toEqual(["fx:laser-flash", "labels"]);
  });

  it("flags a surface triangle overrun separately from the total", () => {
    const report = evaluateBudgets(greenMetrics({ surfaceTriangles: 400_000 }), PERF_PROFILES.high);
    expect(report.violations.map((v) => v.name)).toEqual(["surfaceTriangles"]);
  });
});

describe("variancePct", () => {
  it("is 0 for a single sample and for an empty set", () => {
    expect(variancePct([])).toBe(0);
    expect(variancePct([5])).toBe(0);
  });

  it("reports the spread as a percentage of the mean", () => {
    expect(variancePct([10, 10, 10])).toBeCloseTo(0, 6);
    expect(variancePct([10, 20])).toBeCloseTo(((20 - 10) / 15) * 100, 6);
    expect(variancePct([19, 20, 21, 22, 23])).toBeLessThan(20);
  });
});
