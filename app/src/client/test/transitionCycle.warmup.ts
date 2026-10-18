/**
 * Warmup + chunk pre-generation for the transition-cycle
 * benchmark (TASK-30). Split out of `transitionCycle.ts` so the
 * driver file stays under the AGENTS.md 300-line cap.
 *
 * Two responsibilities:
 *
 *   - **JIT warmup.** 200 idle ticks at space regime prime V8's
 *     inliner + optimiser so the measured `runCycle` ticks run
 *     at full speed. Without this, the first few measured frames
 *     spike by ~2-10 ms due to cold-start compilation.
 *
 *   - **Chunk pre-generation.** The descent phases run at 50-100
 *     m/s which exceeds `FAST_MOVEMENT_SPEED_MPS=80` and therefore
 *     expands the chunk pipeline's active set to 7×7 (49 chunks
 *     vs the default 5×5 = 25). Without pre-warming the outer
 *     ring, the descent phases would have to generate the
 *     boundary ring on the fly — the spec's "first chunk
 *     generation at the boundary" hotspot. We pre-generate at
 *     both `speed=0` (5×5) and `speed=100` (7×7) so the LRU is
 *     fully populated before measurement starts.
 */

import { IDENTITY } from "@shared/physics/vec.js";
import { integrateShip, type ShipInput } from "@shared/physics/flight.js";
import { regimeFor } from "@shared/regime.js";

import { SIM_DT_S } from "./transitionCycle.constants.js";
import { BENCH_SHIP_CLASS } from "./transitionCycle.helpers.js";
import type { CycleState } from "./transitionCycle.types.js";

const JIT_WARMUP_TICKS = 200;
const CHUNK_WARMUP_TICKS_PER_PASS = 100;

/**
 * Run the JIT warmup + chunk pre-generation. Mutates `state` to
 * point the ship at the planet's pad area so the chunk pipeline
 * caches the 7×7 ring around the landing site.
 *
 * After this call returns:
 *   - `state.ship` sits at the pad with regime="surface", `onPad`
 *     populated.
 *   - `state.monitor` is reset so its rolling window doesn't
 *     include warmup samples.
 *   - `state.pipeline.scheduler.budgetMs` is restored to the
 *     production 4 ms.
 */
export function runCycleWarmup(state: CycleState): void {
  // Phase A: JIT warmup at idle space.
  for (let i = 0; i < JIT_WARMUP_TICKS; i++) {
    const input: ShipInput = { thrust: 0, yaw: 0, pitch: 0, roll: 0, up: 0 };
    state.ship = integrateShip(state.ship, input, SIM_DT_S, "space", BENCH_SHIP_CLASS, undefined);
    state.regime = regimeFor(state.ship.pos, state.planets).regime;
    state.pipeline.setPlayerPosition(state.ship.pos.x, state.ship.pos.z);
    state.pipeline.tick();
    state.rig.setShip(state.ship);
    state.rig.update(SIM_DT_S);
  }
  // Phase B: chunk pre-generation at the pad. Park the ship so
  // the pipeline caches the chunks around the landing site.
  state.ship = {
    pos: { x: state.pad.pos.x, y: state.pad.pos.y, z: state.pad.pos.z },
    vel: { x: 0, y: 0, z: 0 },
    quat: IDENTITY,
    regime: "surface",
    onPad: state.pad.padId,
  };
  // Pass 1: 5×5 at speed=0 (slow approach).
  state.pipeline.setPlayerPosition(state.ship.pos.x, state.ship.pos.z, 0);
  state.pipeline.scheduler.setBudgetMs(4_000);
  for (let i = 0; i < CHUNK_WARMUP_TICKS_PER_PASS; i++) {
    state.pipeline.tick();
    if (state.pipeline.scheduler.pending() === 0) break;
  }
  // Pass 2: 7×7 at speed=100 (fast approach). The 7×7 ring is
  // what the descent phases need.
  state.pipeline.setPlayerPosition(state.ship.pos.x, state.ship.pos.z, 100);
  for (let i = 0; i < CHUNK_WARMUP_TICKS_PER_PASS; i++) {
    state.pipeline.tick();
    if (state.pipeline.scheduler.pending() === 0) break;
  }
  // Restore the production budget so the measurement reflects
  // what the real-time render loop will see.
  state.pipeline.scheduler.setBudgetMs(4);
  // Reset the monitor's rolling window so warmup samples don't
  // pollute the baseline measurement.
  state.monitor.reset();
}
