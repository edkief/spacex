/**
 * Phase registry for the transition-cycle benchmark (TASK-30).
 *
 * Each phase is a `(setup, work, teardown)` triple the driver
 * runs for `frames` simulated render frames. The phases
 * themselves live in two side modules:
 *
 *   - `./transitionCycle.phases.flight.ts` — phases 1-5 + 9-10
 *     (ship-side, cockpit mode).
 *   - `./transitionCycle.phases.onfoot.ts` — phases 6-8
 *     (on-foot, character mode + camera hand-offs).
 *
 * This module is the single `ReadonlyMap` the driver iterates
 * over. Splitting keeps each module under the AGENTS.md 300-line
 * cap while keeping the registry in one place so the driver
 * doesn't have to know the split.
 */

import {
  PHASE_ATMOSPHERE_DESCENT,
  PHASE_ATMOSPHERE_TO_SPACE,
  PHASE_ATMOSPHERE_TO_SURFACE,
  PHASE_SPACE_IDLE,
  PHASE_SPACE_TO_ATMOSPHERE,
  PHASE_SURFACE_IDLE,
  PHASE_SURFACE_TO_ATMOSPHERE,
} from "./transitionCycle.phases.flight.js";
import {
  PHASE_DISEMBARK,
  PHASE_ONFOOT_WALK,
  PHASE_REENTER,
} from "./transitionCycle.phases.onfoot.js";
import type { PhaseName, PhaseWork } from "./transitionCycle.types.js";

export { tickShipFrame } from "./transitionCycle.phases.flight.js";

/** Phase name → work descriptor. */
export const PHASES: ReadonlyMap<PhaseName, PhaseWork> = new Map<PhaseName, PhaseWork>([
  ["space-idle", PHASE_SPACE_IDLE],
  ["space-to-atmosphere", PHASE_SPACE_TO_ATMOSPHERE],
  ["atmosphere-descent", PHASE_ATMOSPHERE_DESCENT],
  ["atmosphere-to-surface", PHASE_ATMOSPHERE_TO_SURFACE],
  ["surface-idle", PHASE_SURFACE_IDLE],
  ["disembark", PHASE_DISEMBARK],
  ["onfoot-walk", PHASE_ONFOOT_WALK],
  ["reenter", PHASE_REENTER],
  ["surface-to-atmosphere", PHASE_SURFACE_TO_ATMOSPHERE],
  ["atmosphere-to-space", PHASE_ATMOSPHERE_TO_SPACE],
]);
