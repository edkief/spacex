/**
 * Render benchmark driver — TASK-58.
 *
 * Runs the worst-case scene (see `./scene.ts`) for a wall-clock
 * budget and reports the numbers the acceptance criteria name:
 * median / p95 / worst frame time, the number of frames over the
 * no-spike threshold, draw calls, triangles, materials and the
 * budget verdict.
 *
 * ## How a frame is measured
 *
 * Each frame does the *real* client-side work — the LOD active set,
 * the draw-plan planning, the FX cap enforcement through the real
 * `FxRegistry` — and that CPU time is measured with
 * `performance.now()`. The GPU side has no headless representation,
 * so it is modelled by {@link estimateFrameMs} from the profile's
 * per-unit cost table (draw calls, triangles, instances, labels).
 * The modelled cost is then aligned to vsync
 * ({@link alignToVsync}) and pushed into the real
 * `FrameMonitor`, so the percentiles the report prints come out of
 * the same store the in-game overlay reads.
 *
 * ## Tuning modes
 *
 * - `tuned: true` (default) — every TASK-58 pass: LOD rings, ring
 *   merging, instancing, the livery pool, FX caps, the label cap,
 *   the points-cloud starfield.
 * - `tuned: false` — the pre-tuning baseline: one full-detail mesh
 *   per chunk, one mesh + material per entity, one draw per FX
 *   instance, no caps. The gap between the two is the ≥ 30 %
 *   worst-case reduction the spec measures.
 */

import { generateStars } from "@shared/galaxy/stars.js";
import { generateSystemFromStar } from "@shared/galaxy/system.js";
import type { Planet } from "@shared/galaxy/types.js";
import {
  alignToVsync,
  DEFAULT_PERF_PROFILE,
  estimateFrameMs,
  evaluateBudgets,
  type PerfMetrics,
  type PerfProfile,
} from "@shared/perf.js";
import { FxRegistry } from "@client/fx/registry.js";
import { FrameMonitor, pickPercentile } from "@client/perf/frameMonitor.js";
import { planDraws, type DrawPlan } from "@client/render/drawPlan.js";
import { computeActiveSet, CHUNK_SIZE_M } from "@client/world/chunks.js";

import { sceneForFrame, WORST_CASE_HAZARD_CELLS } from "./scene.js";

/** Frame time above which a frame counts as a spike, ms. */
export const SPIKE_THRESHOLD_MS = 50;

/** Simulated frame interval at 60 fps, ms. */
export const FRAME_INTERVAL_MS = 1000 / 60;

/**
 * Tolerance when comparing a frame time against the budget, ms.
 * A vsync-aligned frame lands on `frameBudgetMs` plus float dust
 * (`16.700000000000728`), which is not a budget miss; anything
 * meaningfully above the budget still fails.
 */
export const FRAME_TIME_EPSILON_MS = 0.05;

/** Options for {@link runRenderBench}. */
export interface RenderBenchOptions {
  /** Simulated scene time, ms. Default 10 000 (600 frames). */
  readonly durationMs?: number;
  /** Perf profile under test. Default `high` (the reference preset). */
  readonly profile?: PerfProfile;
  /** Apply the TASK-58 tuning passes. Default `true`. */
  readonly tuned?: boolean;
  /** Per-run label in the report (`"tuned"`, `"baseline"`, …). */
  readonly label?: string;
  /** Seed for the frame FX churn. Default 1. */
  readonly seed?: number;
  /** Planet to stand on; resolved from the dev seed when omitted. */
  readonly planet?: Planet;
}

/** The report the bench CLI and the unit test both consume. */
export interface RenderBenchReport {
  readonly label: string;
  readonly profile: PerfProfile;
  readonly tuned: boolean;
  readonly frames: number;
  /** Median frame time, ms. */
  readonly medianMs: number;
  /** 95th-percentile frame time, ms. */
  readonly p95Ms: number;
  /** Worst (max) frame time, ms. */
  readonly worstMs: number;
  /** Frames over {@link SPIKE_THRESHOLD_MS} — the no-spike rule. */
  readonly spikes: number;
  /** Highest frame time over the whole run, ms (== `worstMs`). */
  readonly peakDrawCalls: number;
  /** Peak triangles in a single frame. */
  readonly peakTriangles: number;
  /** Peak distinct materials in a single frame. */
  readonly peakMaterials: number;
  /** Measured client CPU cost per frame, ms (mean over the run). */
  readonly cpuMs: number;
  /** Budget verdict from the peak frame. */
  readonly budgetsOk: boolean;
  /** Budget violations from the peak frame (empty when green). */
  readonly violations: readonly { name: string; actual: number; budget: number }[];
  /** FX counts the caps left alive in the final frame. */
  readonly fxCounts: Readonly<Record<string, number>>;
}

/** Resolve a landable planet from the dev seed (cached). */
let cachedPlanet: Planet | null = null;
export function benchPlanet(seed = "drift-dev"): Planet {
  if (cachedPlanet !== null) return cachedPlanet;
  for (const star of generateStars(seed, 4)) {
    const system = generateSystemFromStar(seed, star);
    const planet = system.planets.find((p) => p.landable);
    if (planet) {
      cachedPlanet = planet;
      return planet;
    }
  }
  throw new Error("bench: no landable planet in the dev seed");
}

/**
 * Run the benchmark. Synchronous and deterministic (no timers, no
 * network), so the CLI's 5 runs and the CI fast run measure the
 * same thing.
 */
export function runRenderBench(options: RenderBenchOptions = {}): RenderBenchReport {
  const profile = options.profile ?? DEFAULT_PERF_PROFILE;
  const tuned = options.tuned !== false;
  const durationMs = options.durationMs ?? 10_000;
  const planet = options.planet ?? benchPlanet();
  const seed = options.seed ?? 1;
  const frames = Math.max(1, Math.round(durationMs / FRAME_INTERVAL_MS));

  const monitor = new FrameMonitor({ capacity: Math.max(60, frames) });
  const registry = new FxRegistry();
  registry.setProfile(profile);

  // Real per-frame CPU work starts at an artificial epoch so the
  // first frame doesn't register a multi-second delta.
  let epoch = performance.now();
  let cpuTotal = 0;
  let peakDrawCalls = 0;
  let peakTriangles = 0;
  let peakMaterials = 0;
  let peakMetrics: PerfMetrics | null = null;
  let fxCounts: Readonly<Record<string, number>> = {};

  for (let frame = 0; frame < frames; frame++) {
    const cpuStart = performance.now();
    // 1. LOD active set — the real chunk-pipeline per-frame work.
    const active = computeActiveSet(0, 0, 0, CHUNK_SIZE_M, profile.lodRadiiM.far);
    void active;
    // 2. Scene composition + draw plan.
    const scene = sceneForFrame(planet, profile, seed * 7919 + frame);
    const plan: DrawPlan = planDraws(scene, { tuned }, profile);
    // 3. FX caps — the registry refuses the overflow and expires the
    //    oldest effect of each kind.
    for (const kind of ["laser-flash", "missile-tracer", "debris"] as const) {
      const requested = scene.fx[kind];
      for (let i = 0; i < requested; i++) registry.spawn(kind);
      fxCounts = {
        "laser-flash": registry.activeCount("laser-flash"),
        "missile-tracer": registry.activeCount("missile-tracer"),
        debris: registry.activeCount("debris"),
      };
    }
    const cpuMs = performance.now() - cpuStart;
    cpuTotal += cpuMs;

    // 4. Modelled GPU cost, aligned to vsync.
    const modelled = estimateFrameMs(plan.metrics);
    const frameMs = alignToVsync(modelled + cpuMs, profile);

    // The synthetic clock advances by the *modelled* frame time so
    // the monitor's rolling window holds the real per-frame deltas.
    epoch += frameMs;
    monitor.recordFrameTime(epoch);
    monitor.recordRendererInfo({
      render: { calls: plan.metrics.drawCalls, triangles: plan.metrics.triangles },
    });
    monitor.recordEntityCount(scene.ships + scene.drones + WORST_CASE_HAZARD_CELLS);
    peakDrawCalls = Math.max(peakDrawCalls, plan.metrics.drawCalls);
    peakTriangles = Math.max(peakTriangles, plan.metrics.triangles);
    peakMaterials = Math.max(peakMaterials, plan.metrics.materials);
    if (peakDrawCalls === plan.metrics.drawCalls) peakMetrics = plan.metrics;
  }

  const sorted = sortedFrameTimes(monitor);
  const budget = evaluateBudgets(peakMetrics ?? ZERO_METRICS, profile);
  const worst = sorted[sorted.length - 1] ?? 0;
  return {
    label: options.label ?? (tuned ? "tuned" : "baseline"),
    profile,
    tuned,
    frames,
    medianMs: pickPercentile(sorted, 0.5),
    p95Ms: pickPercentile(sorted, 0.95),
    worstMs: worst,
    spikes: sorted.filter((ms) => ms > SPIKE_THRESHOLD_MS).length,
    peakDrawCalls,
    peakTriangles,
    peakMaterials,
    cpuMs: cpuTotal / frames,
    budgetsOk: budget.ok,
    violations: budget.violations,
    fxCounts,
  };
}

/** Zeroed metrics — the fallback when a run produced no frames. */
const ZERO_METRICS: PerfMetrics = {
  drawCalls: 0,
  triangles: 0,
  materials: 0,
  surfaceTriangles: 0,
  labels: 0,
  instances: 0,
  fx: { "laser-flash": 0, "missile-tracer": 0, debris: 0 },
};

/** Read the monitor's rolling window back out as a sorted array. */
function sortedFrameTimes(monitor: FrameMonitor): number[] {
  const out = monitor.sampleFrameTimes();
  // The first sample is the epoch frame (0 ms); keep the rest.
  out.shift();
  out.sort((a, b) => a - b);
  return out;
}

/**
 * Reduction in worst-case frame time between a baseline run and a
 * tuned run, as a fraction (0.3 = 30 % faster). Measured on the
 * p95 frame time — the same metric the acceptance criteria pin
 * ("p95 ≤ 20 ms") and robust to a single GC spike. The
 * acceptance criterion is `>= 0.3`.
 */
export function worstCaseReduction(baseline: RenderBenchReport, tuned: RenderBenchReport): number {
  if (baseline.p95Ms <= 0) return 0;
  return (baseline.p95Ms - tuned.p95Ms) / baseline.p95Ms;
}
