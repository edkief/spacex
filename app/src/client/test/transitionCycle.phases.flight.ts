/**
 * Ship-side phase descriptors for the transition-cycle benchmark
 * (TASK-30). Split out of `transitionCycle.phases.ts` so the
 * phases module stays under the AGENTS.md 300-line cap.
 *
 * Phases 1-5 + 9-10 are ship-side (cockpit mode): the rig tracks
 * the ship's pose, the integrator drives the ship's physics, the
 * chunk pipeline caches the surface chunks around the ship. The
 * on-foot phases (disembark / onfoot-walk / reenter) live in
 * `transitionCycle.phases.onfoot.ts`.
 */

import { IDENTITY } from "@shared/physics/vec.js";
import type { PlanetAtmosphere } from "@shared/physics/atmosphere.js";
import { integrateShip, type ShipInput } from "@shared/physics/flight.js";
import { regimeFor } from "@shared/regime.js";

import { SIM_DT_S } from "./transitionCycle.constants.js";
import { BENCH_SHIP_CLASS } from "./transitionCycle.helpers.js";
import type { CycleState, PhaseWork } from "./transitionCycle.types.js";

/** The per-frame cockpit work: integrate + regime update + pipeline
 *  tick + rig update. Used by every ship-side phase. */
export function tickShipFrame(
  state: CycleState,
  input: ShipInput,
  regime: "space" | "atmosphere" | "surface",
  planet: PlanetAtmosphere | undefined,
): void {
  state.ship = integrateShip(state.ship, input, SIM_DT_S, regime, BENCH_SHIP_CLASS, planet);
  state.prevRegime = state.regime;
  state.regime = regimeFor(state.ship.pos, state.planets).regime;
  state.pipeline.setPlayerPosition(state.ship.pos.x, state.ship.pos.z);
  state.pipeline.tick();
  state.rig.setShip(state.ship);
  state.rig.setCharacter(null);
  if (state.rig.mode !== "cockpit") state.rig.setMode("cockpit");
  state.rig.update(SIM_DT_S);
}

// ---------------------------------------------------------------------------
// Phase 1: idle in space
// ---------------------------------------------------------------------------

export const PHASE_SPACE_IDLE: PhaseWork = {
  frames: 30,
  setup(state) {
    state.ship = {
      pos: {
        x: state.planetCenter.x + 1_000_000,
        y: state.planetCenter.y,
        z: state.planetCenter.z,
      },
      vel: { x: 0, y: 0, z: 0 },
      quat: IDENTITY,
      regime: "space",
    };
    state.character = null;
    state.cameraCharacter = null;
    state.cameraMode = "cockpit";
    state.regime = "space";
    state.prevRegime = "space";
    state.walkDistanceM = 0;
  },
  work(state) {
    tickShipFrame(state, { thrust: 0, yaw: 0, pitch: 0, roll: 0, up: 0 }, "space", undefined);
  },
};

// ---------------------------------------------------------------------------
// Phase 2: space → atmosphere
// ---------------------------------------------------------------------------

export const PHASE_SPACE_TO_ATMOSPHERE: PhaseWork = {
  frames: 60,
  setup(state) {
    // Start the ship 50 km above the planet surface so the descent
    // has to traverse the 10 km atmosphere band before reaching
    // the surface band. The pre-warm (in `runCycle`) ensures the
    // chunk cache is populated before this phase runs.
    state.ship = {
      pos: {
        x: state.planetCenter.x,
        y: state.planetCenter.y + state.planetContext.radius + 50_000,
        z: state.planetCenter.z,
      },
      vel: { x: 0, y: -100, z: 0 },
      quat: IDENTITY,
      regime: "space",
    };
    state.character = null;
    state.cameraCharacter = null;
    state.cameraMode = "cockpit";
    state.regime = "space";
    state.prevRegime = "space";
    state.walkDistanceM = 0;
  },
  work(state) {
    const atmosphereRadius = state.planetContext.radius + state.planetContext.atmosphereHeight;
    const distanceFromCenter = Math.sqrt(
      (state.ship.pos.x - state.planetCenter.x) ** 2 +
        (state.ship.pos.y - state.planetCenter.y) ** 2 +
        (state.ship.pos.z - state.planetCenter.z) ** 2,
    );
    const inAtmosphere = distanceFromCenter < atmosphereRadius;
    tickShipFrame(
      state,
      { thrust: 0, yaw: 0, pitch: 0, roll: 0, up: 0 },
      inAtmosphere ? "atmosphere" : "space",
      inAtmosphere ? state.planetAtmosphere : undefined,
    );
  },
};

// ---------------------------------------------------------------------------
// Phase 3: atmosphere descent
// ---------------------------------------------------------------------------

export const PHASE_ATMOSPHERE_DESCENT: PhaseWork = {
  frames: 30,
  setup(state) {
    state.ship = {
      pos: {
        x: state.planetCenter.x,
        y: state.planetCenter.y + state.planetContext.radius + 5_000,
        z: state.planetCenter.z,
      },
      vel: { x: 0, y: -50, z: 0 },
      quat: IDENTITY,
      regime: "atmosphere",
    };
    state.character = null;
    state.cameraCharacter = null;
    state.cameraMode = "cockpit";
    state.regime = "atmosphere";
    state.prevRegime = "atmosphere";
    state.walkDistanceM = 0;
  },
  work(state) {
    tickShipFrame(
      state,
      { thrust: 0, yaw: 0, pitch: 0, roll: 0, up: 0 },
      "atmosphere",
      state.planetAtmosphere,
    );
  },
};

// ---------------------------------------------------------------------------
// Phase 4: atmosphere → surface (land on pad)
// ---------------------------------------------------------------------------

export const PHASE_ATMOSPHERE_TO_SURFACE: PhaseWork = {
  frames: 60,
  setup(state) {
    // Hover above the pad to trigger the VTOL drift damp.
    state.ship = {
      pos: {
        x: state.pad.pos.x,
        y: state.pad.pos.y + 50,
        z: state.pad.pos.z,
      },
      vel: { x: 0, y: 0, z: 0 },
      quat: IDENTITY,
      regime: "atmosphere",
    };
    state.character = null;
    state.cameraCharacter = null;
    state.cameraMode = "cockpit";
    state.regime = "atmosphere";
    state.prevRegime = "atmosphere";
    state.walkDistanceM = 0;
  },
  work(state) {
    // VTOL up-thrust + zero horizontal input.
    tickShipFrame(
      state,
      { thrust: 0, yaw: 0, pitch: 0, roll: 0, up: 1 },
      "atmosphere",
      state.planetAtmosphere,
    );
  },
};

// ---------------------------------------------------------------------------
// Phase 5: surface idle (docked on pad)
// ---------------------------------------------------------------------------

export const PHASE_SURFACE_IDLE: PhaseWork = {
  frames: 15,
  setup(state) {
    state.ship = {
      pos: {
        x: state.pad.pos.x,
        y: state.pad.pos.y,
        z: state.pad.pos.z,
      },
      vel: { x: 0, y: 0, z: 0 },
      quat: IDENTITY,
      regime: "surface",
      onPad: state.pad.padId,
    };
    state.character = null;
    state.cameraCharacter = null;
    state.cameraMode = "cockpit";
    state.regime = "surface";
    state.prevRegime = "surface";
    state.walkDistanceM = 0;
  },
  work(state) {
    tickShipFrame(
      state,
      { thrust: 0, yaw: 0, pitch: 0, roll: 0, up: 0 },
      "surface",
      state.planetAtmosphere,
    );
  },
};

// ---------------------------------------------------------------------------
// Phase 9: surface → atmosphere (takeoff)
// ---------------------------------------------------------------------------

export const PHASE_SURFACE_TO_ATMOSPHERE: PhaseWork = {
  frames: 30,
  setup(state) {
    state.ship = {
      pos: {
        x: state.pad.pos.x,
        y: state.pad.pos.y,
        z: state.pad.pos.z,
      },
      vel: { x: 0, y: 10, z: 0 },
      quat: IDENTITY,
      regime: "surface",
    };
    state.regime = "surface";
    state.prevRegime = "surface";
    state.cameraMode = "cockpit";
  },
  work(state) {
    tickShipFrame(
      state,
      { thrust: 0, yaw: 0, pitch: 0, roll: 0, up: 1 },
      "atmosphere",
      state.planetAtmosphere,
    );
  },
};

// ---------------------------------------------------------------------------
// Phase 10: atmosphere → space (climb out)
// ---------------------------------------------------------------------------

export const PHASE_ATMOSPHERE_TO_SPACE: PhaseWork = {
  frames: 60,
  setup(state) {
    state.ship = {
      pos: {
        x: state.planetCenter.x,
        y: state.planetCenter.y + state.planetContext.radius + 5_000,
        z: state.planetCenter.z,
      },
      vel: { x: 0, y: 100, z: 0 },
      quat: IDENTITY,
      regime: "atmosphere",
    };
    state.regime = "atmosphere";
    state.prevRegime = "atmosphere";
    state.cameraMode = "cockpit";
  },
  work(state) {
    const atmosphereRadius = state.planetContext.radius + state.planetContext.atmosphereHeight;
    const distanceFromCenter = Math.sqrt(
      (state.ship.pos.x - state.planetCenter.x) ** 2 +
        (state.ship.pos.y - state.planetCenter.y) ** 2 +
        (state.ship.pos.z - state.planetCenter.z) ** 2,
    );
    const inAtmosphere = distanceFromCenter < atmosphereRadius;
    tickShipFrame(
      state,
      { thrust: 0, yaw: 0, pitch: 0, roll: 0, up: 0 },
      inAtmosphere ? "atmosphere" : "space",
      inAtmosphere ? state.planetAtmosphere : undefined,
    );
  },
};
