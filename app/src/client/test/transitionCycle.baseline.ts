/**
 * Baseline measurement for the transition-cycle benchmark (TASK-30).
 *
 * The baseline establishes the "scene-idle" frame time so the
 * per-phase delta is anchored to the same scene without the
 * transition cost. Split out of `transitionCycle.ts` so the
 * driver file stays under the AGENTS.md 300-line cap.
 *
 * The baseline is the same scene the cycle runs in — the same
 * rig, the same chunk pipeline, the same integrator — but the
 * ship sits idle in space (no transitions active). The per-phase
 * delta = measured_ms - baseline_mean_ms, so a transition that
 * genuinely takes 1 ms of work shows up as a 1 ms delta rather
 * than a 5 ms absolute cost.
 */

import { regimeFor } from "@shared/regime.js";
import { type ShipInput, integrateShip } from "@shared/physics/flight.js";

import { BASELINE_FRAMES, SIM_DT_S } from "./transitionCycle.constants.js";
import { BENCH_SHIP_CLASS, pickPercentile } from "./transitionCycle.helpers.js";
import { sampleFrameCost } from "./transitionCycle.sampling.js";
import type { CycleState } from "./transitionCycle.types.js";

/**
 * Measure the baseline (scene-idle) frame time. The driver runs
 * the rig + chunk pipeline + regime lookup + ship integrator in
 * their idle states (no transitions active) for `BASELINE_FRAMES`
 * frames and reports mean / p95 so the per-frame delta is
 * anchored to the same scene without the transition cost.
 *
 * Each sample is the **minimum** of `samplesPerFrame` repetitions
 * (the same de-noising the measured phases use), so the baseline
 * is the idle scene's real price rather than the host's noise —
 * without that, run-to-run baseline drift lands directly in every
 * transition delta.
 */
export function measureBaseline(opts: {
  state: CycleState;
  frames?: number;
  samplesPerFrame?: number;
}): {
  meanMs: number;
  p95Ms: number;
} {
  const frames = opts.frames ?? BASELINE_FRAMES;
  const samplesPerFrame = opts.samplesPerFrame ?? 1;
  const samples: number[] = [];
  const idleInput: ShipInput = { thrust: 0, yaw: 0, pitch: 0, roll: 0, up: 0 };
  for (let i = 0; i < frames; i++) {
    const sample = sampleFrameCost({
      work: () => {
        // Idle: ship is far from any planet; regime is space; no
        // chunks load; camera is in cockpit mode with no handoff.
        opts.state.ship = integrateShip(
          opts.state.ship,
          idleInput,
          SIM_DT_S,
          "space",
          BENCH_SHIP_CLASS,
          undefined,
        );
        opts.state.regime = regimeFor(opts.state.ship.pos, opts.state.planets).regime;
        opts.state.pipeline.setPlayerPosition(opts.state.ship.pos.x, opts.state.ship.pos.z);
        opts.state.pipeline.tick();
        opts.state.rig.setShip(opts.state.ship);
        opts.state.rig.update(SIM_DT_S);
      },
      samples: samplesPerFrame,
      clock: opts.state.clock,
    });
    samples.push(sample.costMs);
  }
  samples.sort((a, b) => a - b);
  const sum = samples.reduce((acc, v) => acc + v, 0);
  const meanMs = sum / samples.length;
  const p95Ms = pickPercentile(samples, 0.95);
  return { meanMs, p95Ms };
}
