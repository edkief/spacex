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
 * - "bench-run-1" = the first 60 s scripted benchmark of TASK-58 (16 ships
 *   in combat over the streaming surface, High preset, headless
 *   SwiftShader — see scripts: `npm run bench:render`);
 * - "AC-<n>" = the TASK-58 acceptance criterion number.
 *
 * Success criterion (AC-2): the dev machine is not the reference hardware,
 * so absolute 60 fps is a stretch goal (TASK-61 verifies on reference
 * hardware); the measurable target is ≥ 30 % worst-case frame-time
 * reduction vs the pre-tuning baseline (bench-run-1) plus the draw /
 * triangle / material budgets below.
 */
import type { QualityPreset } from './settings';
import { lodRadiiFor, PRESETS } from './settings';

/** Per-frame budgets (AC-3 / AC-4): the renderer.info contract. */
export interface FrameBudgets {
  /** Draw calls per frame (renderer.info.render.calls). AC-3: < 120. */
  drawCalls: number;
  /** Distinct materials in the scene. AC-3: < 40. */
  materials: number;
  /** Total triangles per frame. AC-4: < 500 k (surface 400 k + entities + FX). */
  triangles: number;
}

/** Concurrent-FX caps (AC-4): the FX registry (TASK-43) enforces these. */
export interface FxCaps {
  /** Concurrent laser flash effects (line + spark pair counts as one). */
  laserFlashes: number;
  /** Concurrent missile tracers (in-flight projectiles rendered). */
  missiles: number;
  /** Concurrent explosion debris SETS (core + shockwave + 8 debris each). */
  debrisSets: number;
}

/** One preset's tuned pipeline numbers (the full contract). */
export interface PerfProfile {
  /** LOD ring radii (m, player → chunk center) — mirrors lodRadiiFor. */
  lodRadii: { nearMaxM: number; midMaxM: number; farMaxM: number };
  /** Starfield point count (ONE points cloud — AC-3: 1 draw call). */
  starCount: number;
  /** FX spawn-rate multiplier (0.3 / 0.6 / 1.0 — mirrors PRESETS). */
  fxQuality: number;
  /** Concurrent-FX caps (the CombatFx registry enforces, oldest expires). */
  fxCaps: FxCaps;
  /** Max simultaneous callsign labels (nearest-first, remote-entities). */
  maxLabels: number;
  /** Per-frame renderer budgets (gauge limits for the TASK-57 monitor). */
  budgets: FrameBudgets;
  /**
   * Instance-batch sizes: the max instances one InstancedMesh holds before
   * the layer rolls over to a second mesh of the same material (64 covers
   * the 500 m deposit ring with margin; 48 covers the 39-drone roster +
   * spawn transient). bench-run-1: the 500 m ring held ≤ 30 deposits per
   * resource, so 64 never rolls over on v1 surfaces.
   */
  instanceBatches: { depositsPerResource: number; drones: number };
}

/**
 * The tuned table. HIGH is the benchmark-tuned row (bench-run-1, then
 * passes 1-5 of the TASK-58 tuning); MEDIUM / LOW trim the same dials
 * proportionally (their chunk budgets / draw distance come from
 * PRESETS/lodRadiiFor, so this row only adds the shared contract).
 */
export const PERF_PROFILES: Record<QualityPreset, PerfProfile> = {
  high: {
    // lodRadii: TASK-55 high row (512 / 2048 / 8000 m) — bit-identical to
    // the pre-tuning pipeline, so the LOD pass is NOT the source of the
    // bench-run-1 delta; instancing + FX caps are.
    lodRadii: lodRadiiFor('high'),
    // starCount: mirrors PRESETS.high (2500 points, ONE draw call).
    starCount: PRESETS.high.starCount,
    fxQuality: PRESETS.high.fxQuality,
    // fxCaps: AC-4 verbatim — bench-run-1 peaked at 22 concurrent laser
    // flashes during the scripted duel; 16 keeps the flash pool ≤ 32
    // primitives (line + spark each) at the worst case.
    fxCaps: { laserFlashes: 16, missiles: 16, debrisSets: 8 },
    // maxLabels: 20 = the benchmark scene's "20 remote character labels"
    // (AC-1) — the cap admits the full scene; bench-run-1 measured the
    // label overlay at ≤ 0.4 ms/frame at 20 labels.
    maxLabels: 20,
    // budgets: AC-3 (draws < 120, materials < 40) + AC-4 (tris < 500 k).
    budgets: { drawCalls: 120, materials: 40, triangles: 500_000 },
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
    budgets: { drawCalls: 120, materials: 40, triangles: 500_000 },
    instanceBatches: { depositsPerResource: 48, drones: 48 },
  },
  low: {
    lodRadii: lodRadiiFor('low'),
    starCount: PRESETS.low.starCount,
    fxQuality: PRESETS.low.fxQuality,
    fxCaps: { laserFlashes: 8, missiles: 16, debrisSets: 4 },
    maxLabels: 12,
    budgets: { drawCalls: 120, materials: 40, triangles: 500_000 },
    instanceBatches: { depositsPerResource: 32, drones: 32 },
  },
};

/** The active profile for a quality preset (pure lookup). */
export function perfProfileFor(preset: QualityPreset): PerfProfile {
  return PERF_PROFILES[preset];
}
