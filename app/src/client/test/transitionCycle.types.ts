/**
 * Public type surface for the transition-cycle benchmark (TASK-30).
 *
 * Split out of `transitionCycle.ts` so the file stays under the
 * AGENTS.md 300-line cap. Imports are tight: only the shared
 * `Regime` type + this module's pure-type exports.
 */

import type { RegimePlanetContext } from "@shared/regime.js";
import type { Regime } from "@shared/regime.js";
import type { PlanetAtmosphere } from "@shared/physics/atmosphere.js";
import type { CharacterState as PhysicsCharacterState } from "@shared/physics/character.js";
import type { ShipState } from "@shared/physics/flight.js";
import type { Planet } from "@shared/galaxy/types.js";
import type { SystemPad } from "@shared/world/pads.js";
import type { FrameMonitor } from "../perf/frameMonitor.js";
import type { ChunkPipeline } from "../world/pipeline.js";
import type { CameraRig } from "../camera/CameraRig.js";
import type { CharacterState as CameraCharacterState } from "../camera/types.js";

// ---------------------------------------------------------------------------
// Phase taxonomy
// ---------------------------------------------------------------------------

/**
 * The ten transition phases the driver runs. Names are stable
 * strings so the report JSON is reproducible.
 *
 *   - `space-idle`              — ship far from any planet
 *   - `space-to-atmosphere`     — descent crosses the boundary band
 *   - `atmosphere-descent`      — inside the band, drag active
 *   - `atmosphere-to-surface`   — landing on a pad
 *   - `surface-idle`            — docked
 *   - `disembark`               — exit ship to character (camera handoff)
 *   - `onfoot-walk`             — character moves 10 m forward
 *   - `reenter`                 — character boards the docked ship (camera handoff)
 *   - `surface-to-atmosphere`   — takeoff
 *   - `atmosphere-to-space`     — climb back out
 */
export type PhaseName =
  | "space-idle"
  | "space-to-atmosphere"
  | "atmosphere-descent"
  | "atmosphere-to-surface"
  | "surface-idle"
  | "disembark"
  | "onfoot-walk"
  | "reenter"
  | "surface-to-atmosphere"
  | "atmosphere-to-space";

/** All phase names, in order. */
export const PHASE_ORDER: readonly PhaseName[] = [
  "space-idle",
  "space-to-atmosphere",
  "atmosphere-descent",
  "atmosphere-to-surface",
  "surface-idle",
  "disembark",
  "onfoot-walk",
  "reenter",
  "surface-to-atmosphere",
  "atmosphere-to-space",
];

/**
 * One frame's worth of measurements. The structure is the spec's
 * "actionable" report: a regression names the culprit with full
 * context (phase, frame number, baseline, measured, delta).
 */
export interface PhaseFrame {
  /** Which phase this frame belongs to. */
  readonly transition: PhaseName;
  /** Frame index inside the phase (0-based). */
  readonly frameIndex: number;
  /** Mean baseline frame time (ms). */
  readonly baselineMs: number;
  /** Measured frame time (ms). */
  readonly measuredMs: number;
  /** `measuredMs - baselineMs` (ms). */
  readonly deltaMs: number;
  /** `true` if `measuredMs > NO_PULL_THRESHOLD_MS`. */
  readonly noPullViolation: boolean;
}

/**
 * Per-phase aggregate: the worst + p99 delta we observed over
 * every frame in that phase. The bench script uses `worstDeltaMs`
 * for the spec's "max frame delta" rule, but the CI test uses
 * `p99DeltaMs` because absolute-max on a noisy dev machine is
 * dominated by GC spikes that aren't transition costs (TASK-30
 * step 3 — "Fix violations": on a healthy dev machine the worst
 * and p99 are similar; the CI fast-cycle test needs to tolerate
 * GC noise so it doesn't flake on CI infrastructure).
 */
export interface PhaseReport {
  readonly transition: PhaseName;
  readonly frames: readonly PhaseFrame[];
  /** Absolute worst delta across every frame in the phase. */
  readonly worstDeltaMs: number;
  /** The frame that produced `worstDeltaMs`. */
  readonly worstFrame: PhaseFrame;
  /** 99th-percentile delta across the phase. */
  readonly p99DeltaMs: number;
}

/**
 * Per-cycle aggregate. The CI test and the bench script both
 * surface this shape; downstream consumers can `JSON.stringify`
 * it for archival.
 */
export interface CycleReport {
  /** Mean of the baseline samples (ms). */
  readonly baselineMeanMs: number;
  /** p95 of the baseline samples (ms). */
  readonly baselineP95Ms: number;
  /** Per-phase reports, in `PHASE_ORDER`. */
  readonly phases: readonly PhaseReport[];
  /** Worst delta across every phase (ms). */
  readonly worstDeltaMs: number;
  /** Phase that owns `worstDeltaMs`. */
  readonly worstPhase: PhaseName;
  /** Worst single-frame wall-clock cost across every phase (ms). */
  readonly worstFrameMs: number;
  /** `true` when `worstFrameMs > NO_PULL_THRESHOLD_MS`. */
  readonly noPullViolation: boolean;
  /** Per-phase worst-deltas, in `PHASE_ORDER` (ms). Used by the
   *  bench's repeatability assertion. */
  readonly perPhaseWorstDeltaMs: readonly number[];
  /** Cycle duration in simulated frames. */
  readonly totalFrames: number;
  /** Repeat index (0 for the CI test, 0..4 for the bench). */
  readonly repeatIndex: number;
}

/**
 * Optional knobs the caller can pass to `runCycle`. Every field
 * is optional; defaults match the spec's contract.
 */
export interface RunCycleOptions {
  /** Wall-clock clock. Defaults to `performance.now()` in the
   *  browser, `Date.now()` in Node. Tests inject a fake. */
  readonly clock?: () => number;
  /** Logger used by `FrameMonitor.budgetCheck` on misses. */
  readonly logger?: { warn(message: string, ...rest: unknown[]): void };
  /** Frames per phase. Defaults to `PHASE_FRAMES_DEFAULT`. */
  readonly framesPerPhase?: number;
  /** Repeat index (for logging only). */
  readonly repeatIndex?: number;
  /** Skip the warmup pass (tests use `true` to keep the suite fast). */
  readonly skipWarmup?: boolean;
  /** Skip the baseline measurement (tests use `true` to assert on
   *  the absolute deltas only). Default `false`. */
  readonly skipBaseline?: boolean;
  /** Override the dev seed (the test uses `undefined` to share the
   *  default with the rest of the test suite). */
  readonly seed?: string;
}

/** Internal: the per-phase work callback signature. */
export interface PhaseWork {
  readonly frames: number;
  setup(state: CycleState): void;
  work(state: CycleState): void;
  teardown?(state: CycleState): void;
}

/**
 * Internal: the simulation state shared across the phase work
 * callbacks. Lives here (not in `transitionCycle.ts`) so the
 * phase descriptor module can also reference it without a
 * circular import.
 */
export interface CycleState {
  readonly seed: string;
  readonly starId: string;
  readonly planet: Planet;
  readonly planetContext: RegimePlanetContext;
  readonly planetAtmosphere: PlanetAtmosphere;
  readonly pad: SystemPad;
  readonly planetCenter: { x: number; y: number; z: number };
  readonly planets: readonly RegimePlanetContext[];
  readonly monitor: FrameMonitor;
  readonly pipeline: ChunkPipeline;
  readonly rig: CameraRig;
  ship: ShipState;
  character: PhysicsCharacterState | null;
  cameraCharacter: CameraCharacterState | null;
  regime: Regime;
  prevRegime: Regime;
  cameraMode: "cockpit" | "onfoot";
  walkDistanceM: number;
  readonly clock: () => number;
}
