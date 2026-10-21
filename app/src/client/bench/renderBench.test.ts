/**
 * Render-benchmark tests — TASK-58 (the CI fast version).
 *
 * The full benchmark is `npm run bench:render` (5 runs × 60 s). The
 * suite runs the same driver over 10 s of *simulated* scene time
 * (600 frames) and asserts only what is machine-independent:
 *
 *   - the no-spike rule (zero frames over 50 ms),
 *   - the tuned draw-call / triangle / material budgets,
 *   - the ≥ 30 % worst-case frame-time reduction over the
 *     pre-tuning baseline.
 *
 * Absolute frame times are deliberately NOT asserted — they depend
 * on the machine. TASK-61 asserts them on reference hardware.
 */
import { describe, expect, it } from "vitest";

import type { Planet } from "@shared/galaxy/types.js";
import { PERF_PROFILES } from "@shared/perf.js";
import {
  benchPlanet,
  mobileMargin,
  runRenderBench,
  SPIKE_THRESHOLD_MS,
  worstCaseReduction,
  type RenderBenchReport,
} from "./renderBench.js";
import { sceneForFrame, WORST_CASE_CHUNKS, WORST_CASE_SHIPS, WORST_CASE_LABELS } from "./scene.js";

/** Simulated scene time per run, ms (the "fast 10 s version"). */
const FAST_MS = 10_000;
const profile = PERF_PROFILES.high;

/** One tuned run, memoised across the assertions in a describe. */
let tunedRun: RenderBenchReport | undefined;
function tuned(): RenderBenchReport {
  tunedRun ??= runRenderBench({ durationMs: FAST_MS, profile, tuned: true });
  return tunedRun;
}

describe("worst-case scene (TASK-58)", () => {
  it("builds the scene the acceptance criteria describe", () => {
    const scene = sceneForFrame(benchPlanetCached(), profile, 7);
    const chunks = scene.chunks.near + scene.chunks.mid + scene.chunks.far;
    expect(chunks).toBe(WORST_CASE_CHUNKS);
    expect(scene.ships).toBe(WORST_CASE_SHIPS);
    expect(scene.labels).toBe(WORST_CASE_LABELS);
    expect(scene.hazardCells).toBe(8);
    expect(Object.values(scene.deposits).reduce((a, b) => a + b, 0)).toBe(30);
    // Combat is deliberately hotter than the caps so the caps bite.
    expect(scene.fx["laser-flash"]).toBeGreaterThan(profile.fxCaps.laserFlash);
    expect(scene.fx["missile-tracer"]).toBeGreaterThan(profile.fxCaps.missile);
    expect(scene.fx.debris).toBeGreaterThan(profile.fxCaps.debrisSet);
  });

  it("measures the chunk triangle counts from the real geometry", () => {
    const scene = sceneForFrame(benchPlanetCached(), profile, 7);
    expect(scene.chunkTriangles.near).toBeGreaterThan(scene.chunkTriangles.mid);
    expect(scene.chunkTriangles.mid).toBeGreaterThan(scene.chunkTriangles.far);
  });

  it("is deterministic for a given frame seed", () => {
    const a = sceneForFrame(benchPlanetCached(), profile, 11);
    const b = sceneForFrame(benchPlanetCached(), profile, 11);
    expect(a.fx).toEqual(b.fx);
  });
});

describe("runRenderBench — tuned worst case", () => {
  it("holds 60 fps: median ≤ 16.7 ms and p95 ≤ 20 ms", () => {
    const report = tuned();
    expect(report.frames).toBe(Math.round(FAST_MS / (1000 / 60)));
    expect(report.medianMs).toBeLessThanOrEqual(profile.frameBudgetMs);
    expect(report.p95Ms).toBeLessThanOrEqual(profile.frameBudgetMs * 1.2);
  });

  it("records zero spikes over 10 s of scene time (the no-spike rule)", () => {
    const report = tuned();
    expect(report.worstMs).toBeLessThan(SPIKE_THRESHOLD_MS);
    expect(report.spikes).toBe(0);
  });

  it("stays under the draw-call, triangle and material budgets", () => {
    const report = tuned();
    expect(report.peakDrawCalls).toBeLessThan(profile.budgets.drawCalls);
    expect(report.peakTriangles).toBeLessThan(profile.budgets.triangles);
    expect(report.peakMaterials).toBeLessThan(profile.budgets.materials);
    expect(report.budgetsOk).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it("caps the live FX at the profile budgets", () => {
    expect(tuned().fxCounts).toEqual({
      "laser-flash": profile.fxCaps.laserFlash,
      "missile-tracer": profile.fxCaps.missile,
      debris: profile.fxCaps.debrisSet,
    });
  });

  it("is repeatable: two runs agree within 20 %", () => {
    const a = runRenderBench({ durationMs: FAST_MS, profile, tuned: true, seed: 1 });
    const b = runRenderBench({ durationMs: FAST_MS, profile, tuned: true, seed: 2 });
    const spread = (Math.max(a.p95Ms, b.p95Ms) - Math.min(a.p95Ms, b.p95Ms)) / a.p95Ms;
    expect(spread).toBeLessThan(0.2);
    expect(a.peakDrawCalls).toBe(b.peakDrawCalls);
  });

  it("keeps the client CPU cost per frame well inside the budget", () => {
    expect(tuned().cpuMs).toBeLessThan(profile.frameBudgetMs / 4);
  });
});

describe("runRenderBench — baseline vs tuned delta", () => {
  it("reduces the worst-case frame time by at least 30 %", () => {
    const baseline = runRenderBench({ durationMs: FAST_MS, profile, tuned: false });
    const delta = worstCaseReduction(baseline, tuned());
    expect(baseline.p95Ms).toBeGreaterThan(profile.frameBudgetMs);
    expect(delta).toBeGreaterThanOrEqual(0.3);
  });

  it("cuts draw calls and materials by at least 2×", () => {
    const baseline = runRenderBench({ durationMs: FAST_MS, profile, tuned: false });
    expect(baseline.peakDrawCalls / tuned().peakDrawCalls).toBeGreaterThan(2);
    expect(baseline.peakMaterials / tuned().peakMaterials).toBeGreaterThan(2);
  });

  it("reports 0 reduction against itself", () => {
    expect(worstCaseReduction(tuned(), tuned())).toBe(0);
  });
});

/** The benchmark planet is resolved once and cached by the driver. */
function benchPlanetCached(): Planet {
  return benchPlanet();
}

// ---------------------------------------------------------------------------
// TASK-59 — the mobile floor's frame-time margin over desktop
// ---------------------------------------------------------------------------

describe("mobile profile margin (TASK-59)", () => {
  it("holds a ≥ 1.5× frame-time margin over the high profile", () => {
    const high = runRenderBench({
      durationMs: FAST_MS,
      profile: PERF_PROFILES.high,
      label: "high",
    });
    const mobile = runRenderBench({
      durationMs: FAST_MS,
      profile: PERF_PROFILES.mobile,
      label: "mobile",
    });
    const margin = mobileMargin(high, mobile);
    expect(margin).toBeGreaterThanOrEqual(1.5);
    // Sanity: the mobile profile really is doing less work, not
    // just aligning to a bigger vsync budget.
    expect(mobile.workMs).toBeLessThan(high.workMs);
    expect(mobile.peakTriangles).toBeLessThan(high.peakTriangles);
    expect(mobile.peakDrawCalls).toBeLessThanOrEqual(high.peakDrawCalls);
  });

  it("stays inside its own budgets on the worst-case scene", () => {
    const mobile = runRenderBench({
      durationMs: FAST_MS,
      profile: PERF_PROFILES.mobile,
      label: "mobile-budgets",
    });
    expect(mobile.budgetsOk).toBe(true);
    expect(mobile.violations).toEqual([]);
    // 30 fps floor: the median frame fits the 33.4 ms budget.
    expect(mobile.medianMs).toBeLessThanOrEqual(PERF_PROFILES.mobile.frameBudgetMs);
    expect(mobile.spikes).toBe(0);
    // FX caps really are lower than the desktop profile's.
    expect(mobile.fxCounts["missile-tracer"]).toBeLessThanOrEqual(
      PERF_PROFILES.mobile.fxCaps.missile,
    );
  });
});
