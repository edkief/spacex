/**
 * On-foot phase descriptors for the transition-cycle benchmark
 * (TASK-30). Split out of `transitionCycle.phases.ts` so the
 * phases module stays under the AGENTS.md 300-line cap.
 *
 * Phases 6-8 are on-foot: the rig tracks the character's pose,
 * `integrateCharacter` drives the on-foot physics, and the
 * pipeline still caches the surface chunks around the player.
 *
 * Note that the rig-mode hand-offs (cockpit ↔ onfoot) happen
 * here — `disembark` and `reenter` are the two phases the spec
 * calls out as the camera-handoff hotspots.
 */

import { IDENTITY } from "@shared/physics/vec.js";
import {
  type CharacterInput,
  type CharacterState as PhysicsCharacterState,
  integrateCharacter,
} from "@shared/physics/character.js";

import { SIM_DT_S } from "./transitionCycle.constants.js";
import type { CharacterState as CameraCharacterState } from "../camera/types.js";
import type { CycleState, PhaseWork } from "./transitionCycle.types.js";

/** Convert the physics character state to the camera-rig shape. */
function toCameraCharacter(c: PhysicsCharacterState | null): CameraCharacterState | null {
  if (c === null) return null;
  return { pos: { x: c.pos.x, y: c.pos.y, z: c.pos.z }, yaw: 0, pitch: 0 };
}

/** Reset the camera character + walk counter. */
function resetCharacter(state: CycleState, c: PhysicsCharacterState): void {
  state.character = c;
  state.cameraCharacter = toCameraCharacter(c);
  state.walkDistanceM = 0;
}

// ---------------------------------------------------------------------------
// Phase 6: disembark (exit ship to character)
// ---------------------------------------------------------------------------

export const PHASE_DISEMBARK: PhaseWork = {
  frames: 60,
  setup(state) {
    // Spawn the character 2.5 m off the ship's local +X axis (the
    // spec's side-offset — see `@server/shard/entity.ts`).
    const c: PhysicsCharacterState = {
      pos: { x: state.ship.pos.x + 2.5, y: state.ship.pos.y, z: state.ship.pos.z },
      vel: { x: 0, y: 0, z: 0 },
      quat: IDENTITY,
      onGround: true,
    };
    state.character = c;
    state.cameraCharacter = toCameraCharacter(c);
    state.cameraMode = "onfoot";
    state.walkDistanceM = 0;
  },
  work(state) {
    if (state.rig.mode !== "onfoot") {
      state.rig.setMode("onfoot");
    }
    state.rig.setCharacter(state.cameraCharacter);
    state.rig.setShip(null);
    state.rig.update(SIM_DT_S);
  },
};

// ---------------------------------------------------------------------------
// Phase 7: on-foot walk (10 m forward)
// ---------------------------------------------------------------------------

export const PHASE_ONFOOT_WALK: PhaseWork = {
  frames: 120,
  setup(state) {
    const base: PhysicsCharacterState = state.character ?? {
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: IDENTITY,
      onGround: true,
    };
    const c: PhysicsCharacterState = {
      pos: { x: base.pos.x, y: base.pos.y, z: base.pos.z },
      vel: { x: 0, y: 0, z: 0 },
      quat: IDENTITY,
      onGround: true,
    };
    resetCharacter(state, c);
  },
  work(state) {
    if (state.character === null) return;
    const input: CharacterInput = { moveX: 0, moveZ: 1, yaw: 0, run: false, jump: false };
    state.character = integrateCharacter(
      state.character,
      input,
      SIM_DT_S,
      state.planetContext.heightAt,
      { planetRadius: state.planetContext.radius },
    );
    state.walkDistanceM = Math.abs(state.character.pos.z);
    state.cameraCharacter = toCameraCharacter(state.character);
    state.rig.setCharacter(state.cameraCharacter);
    state.rig.update(SIM_DT_S);
  },
};

// ---------------------------------------------------------------------------
// Phase 8: re-enter (board the docked ship)
// ---------------------------------------------------------------------------

export const PHASE_REENTER: PhaseWork = {
  frames: 60,
  setup(state) {
    // Re-bind the ship so the rig has a cockpit target.
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
  },
  work(state) {
    if (state.rig.mode !== "cockpit") {
      state.rig.setMode("cockpit");
    }
    state.rig.setShip(state.ship);
    state.rig.setCharacter(null);
    state.rig.update(SIM_DT_S);
  },
};
