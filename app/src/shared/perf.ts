/**
 * TASK-58: the rendering-pipeline tuning table — all tuned numbers as DATA.
 *
 * The client reads this live through the quality preset (the SettingsBridge
 * pattern, TASK-55: `settingsState().quality` → `PERF_PROFILES[preset]`);
 * the server ignores it (it carries no sim state). A future hardware
 * profile (mobile, TASK-59) is a NEW ENTRY in the same table — no code
 * change in the render pipeline.
 *
 * Every number below cites the benchmark run / AC that set it:
 * - "bench-final" = the final 60 s scripted benchmark of TASK-58, recorded
 *   in .ralph/bench/TASK-58.json on 2026-10-05 (`npm run bench:render`;
 *   16 ships in combat over the streaming surface, High preset, headless).
 *   It is the first run with ALL five tuning passes active — instancing,
 *   the per-LOD-ring chunk-mesh merge (TASK-58.2, `merged: true` default in
 *   chunk-scene.ts), the shared biome material pool, the FX caps, and the
 *   single points-cloud starfield.
 * - "AC-<n>" = the TASK-58 acceptance criterion number.
 *
 * Success criterion (AC-2): the dev machine is not the reference hardware,
 * so absolute 60 fps is a stretch goal (TASK-61 verifies on reference
 * hardware); the measurable target is ≥ 30 % worst-case frame-time
 * reduction vs the pre-tuning baseline. The dev machine cannot hold that
 * delta: bench-final's frame times sit on the headless noise floor
 * (baseline p95 1.681 ms / max 5.149 ms vs best tuned p95 1.801 ms / worst
 * tuned max 5.463 ms — deltas of -7.1 % p95 / -6.1 % max, both within run
 * noise), so the achieved numbers are recorded as the final record in
 * .ralph/bench/TASK-58.json and TASK-61 is the verification point on
 * reference hardware. The structural reductions ARE machine-independent
 * and are what the tuned pipeline buys: draw calls 120 p95 / 122 max
 * (baseline) → 86 p95 / 88 max (tuned, -28 %, chunk merge + instancing),
 * triangles 90,720 → 87,912.
 */
import type { QualityPreset } from './settings';
import { lodRadiiFor, PRESETS } from './settings';

/** Per-frame budgets (AC-3 / AC-4): the renderer.info contract. */
export interface FrameBudgets {
  /**
   * Draw calls per frame (renderer.info.render.calls). AC-3: < 120 —
   * bench-final held the tuned scene at 86 p95 / 88 max against that
   * ceiling (baseline: 120 p95 / 122 max).
   */
  drawCalls: number;
  /**
   * Distinct materials in the scene. AC-3, revised to < 80 in TASK-58.1
   * (approved decision, 40 → 80): bench-final measures 71 on BOTH the
   * baseline and the tuned scene — the committed design holds one material
   * instance per live FX/hazard piece; a material-sharing pass is deferred
   * past TASK-58.2.
   */
  materials: number;
  /**
   * Total triangles per frame. AC-4: < 500 k (surface 400 k + entities +
   * FX). bench-final: 87,912 max on the tuned scene (baseline 90,720).
   */
  triangles: number;
}

/** Concurrent-FX caps (AC-4): the FX registry (TASK-43) enforces these. */
export interface FxCaps {
  /**
   * Concurrent laser flash effects (line + spark pair counts as one).
   * AC-4: 16 keeps the flash pool ≤ 32 primitives at the worst case;
   * bench-final's registry peaked at 1 concurrent flash during the
   * scripted duel (the cap is headroom for real player fire-rate bursts).
   */
  laserFlashes: number;
  /**
   * Concurrent missile tracers (in-flight projectiles rendered). Mirrors
   * the server's 16-projectile shard budget; bench-final's activeCount
   * peaked at 37 (tracers + retired effects aging out, the registry's own
   * count).
   */
  missiles: number;
  /**
   * Concurrent explosion debris SETS (core + shockwave + 8 debris each).
   * AC-4; bench-final peaked at 2 concurrent sets with one destruction
   * every 3 s (the cap allows a 4× burst of the scripted cadence).
   */
  debrisSets: number;
}

/** One preset's tuned pipeline numbers (the full contract). */
export interface PerfProfile {
  /**
   * LOD ring radii (m, player → chunk center) — mirrors lodRadiiFor.
   * bench-final confirmed the LOD pass is NOT a source of the tuned
   * numbers: high keeps the pre-tuning radii (512 / 2048 / 8000), so the
   * delta is structural (instancing, chunk merge, caps), not distance.
   */
  lodRadii: { nearMaxM: number; midMaxM: number; farMaxM: number };
  /** Starfield point count (ONE points cloud — AC-3: 1 draw call). */
  starCount: number;
  /** FX spawn-rate multiplier (0.3 / 0.6 / 1.0 — mirrors PRESETS). */
  fxQuality: number;
  /** Concurrent-FX caps (the CombatFx registry enforces, oldest expires). */
  fxCaps: FxCaps;
  /**
   * Max simultaneous callsign labels (nearest-first, remote-entities).
   * 20 = the benchmark scene's "20 remote character labels" (AC-1);
   * bench-final measured the whole remote-render stage (interpolation +
   * label overlay for 20 labels) at ~0.19 ms/frame.
   */
  maxLabels: number;
  /** Per-frame renderer budgets (gauge limits for the TASK-57 monitor). */
  budgets: FrameBudgets;
  /**
   * Instance-batch sizes: the max instances one InstancedMesh holds before
   * the layer rolls over to a second mesh of the same material. 64 covers
   * the 500 m deposit ring with margin (bench-final: ≤ 30 deposits in the
   * ring, so a batch never rolls over on v1 surfaces); 48 covers the
   * 39-drone roster + spawn transients (bench-final ran 4 hostile drones).
   */
  instanceBatches: { depositsPerResource: number; drones: number };
}

/**
 * The tuned table. HIGH is the benchmark-tuned row (bench-final — all five
 * passes of the TASK-58 tuning: instancing, per-LOD-ring chunk-mesh merge,
 * material pool, FX caps, points-cloud starfield); MEDIUM / LOW trim the
 * same dials proportionally (their chunk budgets / draw distance come from
 * PRESETS/lodRadiiFor, so this row only adds the shared contract).
 */
export const PERF_PROFILES: Record<QualityPreset, PerfProfile> = {
  high: {
    // lodRadii: TASK-55 high row (512 / 2048 / 8000 m) — bit-identical to
    // the pre-tuning pipeline (bench-final confirms the LOD pass is not a
    // source of the tuned numbers; the delta is structural).
    lodRadii: lodRadiiFor('high'),
    // starCount: mirrors PRESETS.high (2500 points, ONE draw call — the
    // starfield is a single THREE.Points cloud, AC-3).
    starCount: PRESETS.high.starCount,
    fxQuality: PRESETS.high.fxQuality,
    // fxCaps: AC-4 verbatim (origins per the FxCaps field docs — bench-
    // final peaks: 1 concurrent laser flash, 2 debris sets, 37 active
    // effects; the caps are headroom over the scripted combat cadence).
    fxCaps: { laserFlashes: 16, missiles: 16, debrisSets: 8 },
    // maxLabels: 20 = the benchmark scene's "20 remote character labels"
    // (AC-1) — the cap admits the full scene (bench-final: remote-render
    // stage ~0.19 ms/frame at 20 labels).
    maxLabels: 20,
    // budgets: AC-3 (draws < 120 — bench-final 86 p95 / 88 max; materials
    // < 80 — revised in TASK-58.1, bench-final measures 71) + AC-4 (tris
    // < 500 k — bench-final 87,912 max).
    budgets: { drawCalls: 120, materials: 80, triangles: 500_000 },
    // instanceBatches: bench-final — ≤ 30 deposits per resource inside the
    // 500 m ring (64 never rolls over) and 4 drones (48 holds the roster).
    instanceBatches: { depositsPerResource: 64, drones: 48 },
  },
  medium: {
    lodRadii: lodRadiiFor('medium'),
    starCount: PRESETS.medium.starCount,
    fxQuality: PRESETS.medium.fxQuality,
    // Scaled from high (×0.75, floored): medium trims the FX tail, not the
    // structural caps (the tracer cap mirrors the server's 16-projectile
    // shard budget — going below it would recycle live projectiles).
    fxCaps: { laserFlashes: 12, missiles: 16, debrisSets: 6 },
    maxLabels: 16,
    // Same structural budgets (the scene must hold the contract on every
    // preset; medium reduces what is DRAWN, not what is allowed).
    budgets: { drawCalls: 120, materials: 80, triangles: 500_000 },
    instanceBatches: { depositsPerResource: 48, drones: 48 },
  },
  low: {
    lodRadii: lodRadiiFor('low'),
    starCount: PRESETS.low.starCount,
    fxQuality: PRESETS.low.fxQuality,
    fxCaps: { laserFlashes: 8, missiles: 16, debrisSets: 4 },
    maxLabels: 12,
    budgets: { drawCalls: 120, materials: 80, triangles: 500_000 },
    instanceBatches: { depositsPerResource: 32, drones: 32 },
  },
};

/** The active profile for a quality preset (pure lookup). */
export function perfProfileFor(preset: QualityPreset): PerfProfile {
  return PERF_PROFILES[preset];
}
