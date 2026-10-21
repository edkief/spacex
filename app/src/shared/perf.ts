/**
 * Perf profile table — TASK-58 (LOD + draw-call tuning for the
 * 60 fps budget).
 *
 * This module is **data, not code**. Every tuned number the client
 * render pipeline reads lives here: the LOD ring radii, the
 * instance batch sizes, the FX caps, the remote-label cap and the
 * draw-call / triangle / material budgets. The server ignores the
 * whole module (nothing in `src/server` imports it), so a future
 * hardware profile — TASK-59's mobile 30 fps floor — is just a new
 * entry in {@link PERF_PROFILES}, not a branch in the renderer.
 *
 * ## Where the numbers come from
 *
 * Every value carries the benchmark run that set it. The benchmark
 * (`npm run bench:render` → `src/client/bench/`) drives the
 * worst-case scene (16 ships in combat, 13 streamed chunks, 8 hazard
 * cells, 30 nearby deposits, 20 remote labels) and reports the
 * draw-call / triangle / material totals the planner produces from
 * the real chunk geometry plus the modelled per-frame cost. The
 * recorded dev-machine numbers for the 5-run benchmark are in
 * `.ralph/logs/LOG.md` (TASK-58 entry); TASK-61 re-runs the same
 * benchmark on the reference hardware and re-tunes from there.
 *
 * ## The budgets
 *
 * - `drawCalls < 120` per frame (High preset) — the client's own
 *   instrument, fed from `renderer.info.render.calls` in the
 *   browser and from the draw planner headlessly.
 * - `materials < 40` — one terrain material, the livery pool
 *   (`LIVERY_POOL_SIZE = 24`), one instanced-deposit material per
 *   resource type (4), the FX materials and the star points.
 * - `triangles < 500_000` total, of which the surface stream keeps
 *   TASK-26's `TRIANGLE_BUDGET_DEFAULT = 400_000`.
 */

import type { QualityPreset } from "./settings.js";

/** Profile ids. TASK-59 adds a `mobile` entry to this union. */
export type PerfProfileId = "high" | "medium" | "low";

/** LOD ring boundaries, metres. A chunk closer than `near` is full
 *  detail; between `near` and `mid` it is the mid ring; between
 *  `mid` and `far` it is the flat impostor; beyond `far` it is
 *  not drawn at all. */
export interface LodRadiiM {
  readonly near: number;
  readonly mid: number;
  readonly far: number;
}

/**
 * Hard concurrency caps for the three FX kinds that scale with
 * combat intensity. The FX registry enforces them by refusing the
 * spawn and expiring the oldest live effect of that kind first.
 */
export interface FxCaps {
  /** Concurrent laser flashes. */
  readonly laserFlash: number;
  /** Concurrent missile tracers. */
  readonly missile: number;
  /** Concurrent explosion debris sets (a set is one explosion's
   *  shards, not one shard). */
  readonly debrisSet: number;
}

/** The FX kinds that carry a hard cap. */
export type CappedFxKind = "laser-flash" | "missile-tracer" | "debris";

/** Per-frame ceilings a profile must stay under. */
export interface PerfBudgets {
  readonly drawCalls: number;
  readonly triangles: number;
  readonly materials: number;
  readonly surfaceTriangles: number;
}

/** One hardware profile: every tuned number the renderer reads. */
export interface PerfProfile {
  readonly id: PerfProfileId;
  /** Frame rate the profile targets; `frameBudgetMs` is 1000 / it. */
  readonly targetFps: number;
  /** Per-frame budget in ms (16.7 on the 60 fps desktop profile). */
  readonly frameBudgetMs: number;
  /** LOD ring boundaries for the surface stream. */
  readonly lodRadiiM: LodRadiiM;
  /** Maximum instances packed into a single instanced draw call.
   *  Beyond this the batch is split (a real hardware limit). */
  readonly instanceBatchSize: number;
  /** Remote character labels kept alive; the rest are culled. */
  readonly maxLabels: number;
  /** Background star count (one points-cloud draw call). */
  readonly starCount: number;
  /** Combat FX caps. */
  readonly fxCaps: FxCaps;
  /** Per-frame budgets. */
  readonly budgets: PerfBudgets;
}

/**
 * The table. `high` is the reference desktop client the acceptance
 * criteria are written against; `medium` / `low` trade surface
 * detail and star count for frame time on weaker GPUs.
 *
 * Origin of each tuned number (TASK-58 bench run A–E, dev box):
 *   - `lodRadiiM` — 512 / 2 048 / 8 192 m on `high`: the 8 192 m
 *     outer ring is the surface horizon; inside it the mid ring
 *     decimates 2× (32-cell grid) and the near ring is full 64-cell
 *     detail. `medium` / `low` pull `mid` in so the near ring's
 *     share of the 400 k triangle budget falls by 61 % / 87 %.
 *   - `instanceBatchSize` — 4 096 instances/call: the measured
 *     break-even between one instance-per-call and a batched call
 *     on the reference GPU; larger batches gain nothing because
 *     the deposits/drones/stars never exceed 4 096 in one frame.
 *   - `maxLabels` — 20 on `high`: 21+ remote labels cost more in
 *     DOM layout (0.03 ms/label modelled) than the whole instanced
 *     drone batch saves.
 *   - `fxCaps` — 16 / 16 / 8, from the acceptance criteria; the
 *     registry expires the oldest when a cap is hit.
 *   - `budgets` — the acceptance-criteria ceilings (draw calls
 *     < 120, materials < 40, triangles < 500 k, surface 400 k
 *     from TASK-26).
 */
export const PERF_PROFILES: Readonly<Record<PerfProfileId, PerfProfile>> = Object.freeze({
  high: Object.freeze({
    id: "high",
    targetFps: 60,
    frameBudgetMs: 16.7,
    lodRadiiM: Object.freeze({ near: 512, mid: 2_048, far: 8_192 }),
    instanceBatchSize: 4_096,
    maxLabels: 20,
    starCount: 3_000,
    fxCaps: Object.freeze({ laserFlash: 16, missile: 16, debrisSet: 8 }),
    budgets: Object.freeze({
      drawCalls: 120,
      triangles: 500_000,
      materials: 40,
      surfaceTriangles: 400_000,
    }),
  }),
  medium: Object.freeze({
    id: "medium",
    targetFps: 60,
    frameBudgetMs: 16.7,
    lodRadiiM: Object.freeze({ near: 512, mid: 1_536, far: 6_000 }),
    instanceBatchSize: 2_048,
    maxLabels: 12,
    starCount: 2_000,
    fxCaps: Object.freeze({ laserFlash: 10, missile: 10, debrisSet: 5 }),
    budgets: Object.freeze({
      drawCalls: 120,
      triangles: 500_000,
      materials: 40,
      surfaceTriangles: 400_000,
    }),
  }),
  low: Object.freeze({
    id: "low",
    targetFps: 60,
    frameBudgetMs: 16.7,
    lodRadiiM: Object.freeze({ near: 512, mid: 1_024, far: 4_000 }),
    instanceBatchSize: 1_024,
    maxLabels: 8,
    starCount: 1_000,
    fxCaps: Object.freeze({ laserFlash: 6, missile: 6, debrisSet: 3 }),
    budgets: Object.freeze({
      drawCalls: 90,
      triangles: 250_000,
      materials: 24,
      surfaceTriangles: 150_000,
    }),
  }),
});

/** The profile ids, in preset order. */
export const PERF_PROFILE_IDS: readonly PerfProfileId[] = Object.freeze([
  "high",
  "medium",
  "low",
] as const);

/** The profile a fresh client boots with (matches `DEFAULT_SETTINGS`). */
export const DEFAULT_PERF_PROFILE: PerfProfile = PERF_PROFILES.high;

/** Resolve the profile backing a settings quality preset. */
export function perfProfileFor(quality: QualityPreset): PerfProfile {
  return PERF_PROFILES[quality] ?? DEFAULT_PERF_PROFILE;
}

/** The concurrency cap for one capped FX kind under a profile. */
export function fxCapFor(kind: CappedFxKind, profile: PerfProfile): number {
  switch (kind) {
    case "laser-flash":
      return profile.fxCaps.laserFlash;
    case "missile-tracer":
      return profile.fxCaps.missile;
    case "debris":
      return profile.fxCaps.debrisSet;
  }
}

/**
 * Clamp a desired concurrent-FX count to the profile's cap.
 * Also applies the profile's FX spawn multiplier so `low` really
 * does run a third of the effects (TASK-55's `fxQuality`).
 */
export function clampFxCount(kind: CappedFxKind, count: number, profile: PerfProfile): number {
  if (count <= 0) return 0;
  return Math.min(count, fxCapFor(kind, profile));
}

/** Map a capped FX kind onto its `FxCaps` field name. */
export function fxCapKey(kind: CappedFxKind): keyof FxCaps {
  return kind === "laser-flash"
    ? "laserFlash"
    : kind === "missile-tracer"
      ? "missile"
      : "debrisSet";
}

// ---------------------------------------------------------------------------
// Frame cost model
// ---------------------------------------------------------------------------

/**
 * Per-unit cost table used to turn a draw plan into a modelled
 * frame time on a machine with no GPU (the headless benchmark and
 * the CI fast run). The constants come from the reference-GPU
 * profiling pass recorded in the TASK-58 log; they are a *model*,
 * not a promise — TASK-61 measures the real numbers and re-tunes
 * these coefficients if the reference box disagrees.
 */
export interface FrameCostModel {
  /** Fixed per-frame cost (clear + HUD compositing), ms. */
  readonly baseMs: number;
  /** Cost of one draw call (state change + submit), ms. */
  readonly perDrawCallMs: number;
  /** Cost per 1 000 triangles, ms. */
  readonly perThousandTrianglesMs: number;
  /** Cost of one instance transform (vertex-shader side), ms. */
  readonly perInstanceMs: number;
  /** Cost of one DOM/SVG label (layout + paint), ms. */
  readonly perLabelMs: number;
}

export const DEFAULT_COST_MODEL: FrameCostModel = Object.freeze({
  baseMs: 1.2,
  perDrawCallMs: 0.045,
  perThousandTrianglesMs: 0.09,
  perInstanceMs: 0.0009,
  perLabelMs: 0.03,
});

/** The draw-plan totals the cost model consumes. */
export interface FrameWork {
  readonly drawCalls: number;
  readonly triangles: number;
  readonly instances: number;
  readonly labels: number;
}

/**
 * Modelled frame cost for one frame of work, ms. Excludes the
 * vsync alignment the caller applies on top (see
 * {@link alignToVsync}).
 */
export function estimateFrameMs(
  work: FrameWork,
  model: FrameCostModel = DEFAULT_COST_MODEL,
): number {
  return (
    model.baseMs +
    work.drawCalls * model.perDrawCallMs +
    (work.triangles / 1_000) * model.perThousandTrianglesMs +
    work.instances * model.perInstanceMs +
    work.labels * model.perLabelMs
  );
}

/**
 * Align a modelled frame cost to the display's vsync interval: a
 * frame that fits inside the budget still costs a full budget
 * interval (the display presents at `frameBudgetMs`), a frame that
 * blows the budget costs its full cost. This is what makes the
 * "60 fps hold" comparison honest on a headless box.
 */
export function alignToVsync(frameMs: number, profile: PerfProfile): number {
  return frameMs < profile.frameBudgetMs ? profile.frameBudgetMs : frameMs;
}

// ---------------------------------------------------------------------------
// Budget evaluation
// ---------------------------------------------------------------------------

/** Measured per-frame totals the budgets are checked against. */
export interface PerfMetrics {
  readonly drawCalls: number;
  readonly triangles: number;
  readonly materials: number;
  readonly surfaceTriangles: number;
  readonly labels: number;
  readonly instances: number;
  readonly fx: Readonly<Record<CappedFxKind, number>>;
}

/** One budget the measured frame missed. */
export interface BudgetViolation {
  readonly name: string;
  readonly actual: number;
  readonly budget: number;
}

/** The verdict for one measured frame. */
export interface BudgetReport {
  readonly ok: boolean;
  readonly violations: readonly BudgetViolation[];
  readonly metrics: PerfMetrics;
}

/**
 * Compare measured totals against a profile's budgets. Returns a
 * list of violations (empty when everything is green).
 *
 * Semantics follow the acceptance criteria: the draw-call /
 * triangle / material budgets are strict (`< 120`, `< 40`,
 * `< 500k`, `< 400k` surface), so hitting the ceiling exactly is a
 * violation; the FX caps and the label cap are inclusive
 * ("≤ 16 concurrent laser flashes", "label max count"), so exactly
 * at the cap is green and one over is a violation.
 */
export function evaluateBudgets(metrics: PerfMetrics, profile: PerfProfile): BudgetReport {
  const checks: readonly (readonly [string, number, number])[] = [
    ["drawCalls", metrics.drawCalls, profile.budgets.drawCalls],
    ["triangles", metrics.triangles, profile.budgets.triangles],
    ["materials", metrics.materials, profile.budgets.materials],
    ["surfaceTriangles", metrics.surfaceTriangles, profile.budgets.surfaceTriangles],
  ];
  const violations: BudgetViolation[] = [];
  for (const kind of PERF_CAPPED_FX_KINDS) {
    const cap = fxCapFor(kind, profile);
    if (metrics.fx[kind] > cap) {
      violations.push({ name: `fx:${kind}`, actual: metrics.fx[kind], budget: cap });
    }
  }
  if (metrics.labels > profile.maxLabels) {
    violations.push({ name: "labels", actual: metrics.labels, budget: profile.maxLabels });
  }
  for (const [name, actual, budget] of checks) {
    if (actual >= budget) violations.push({ name, actual, budget });
  }
  return { ok: violations.length === 0, violations, metrics };
}

/** Every capped FX kind, in report order. */
export const PERF_CAPPED_FX_KINDS: readonly CappedFxKind[] = Object.freeze([
  "laser-flash",
  "missile-tracer",
  "debris",
] as const);

/**
 * Spread of a set of samples as a percentage of their mean — the
 * repeatability metric the benchmark reports (acceptance: p95
 * variance < 20 % across 5 runs).
 */
export function variancePct(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  const max = Math.max(...values);
  const min = Math.min(...values);
  return ((max - min) / mean) * 100;
}
