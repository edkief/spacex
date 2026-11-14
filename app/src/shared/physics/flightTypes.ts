import type { ClientPayload } from '../protocol/registry.ts';
import type { Regime } from '../regime.ts';
import type { ShipClass } from '../ships/catalog.ts';
import type { Body } from './bodies.ts';
import type { FrameId } from './frames.ts';
import type { Quat, Vec3 } from './vec.ts';

/**
 * A ship's simulated state. Position, velocity and orientation are expressed in `frame`:
 * the system frame, or one of a landable planet's surface charts (`<planetId>:n|s`). `quat` rotates
 * ship-local vectors (nose -z, up +y, right +x) into that frame.
 */
export interface ShipState {
  frame: FrameId;
  pos: Vec3;
  vel: Vec3;
  quat: Quat;
  regime: Regime;
  /** Id of the surface pad the ship is resting on, if any. */
  onPad?: string;
  /** Id of the orbital dock the ship is docked at, if any (the ship is then held in place). */
  dockedAt?: string;
}

/** The part of the protocol `input` message the flight model consumes. */
export type FlightInput = Pick<
  ClientPayload<'input'>,
  'thrust' | 'yaw' | 'pitch' | 'roll' | 'up' | 'brake' | 'action'
>;

/** A landing pad in a surface chart's flat coordinates. */
export interface FlatPad {
  id: string;
  x: number;
  z: number;
}

/** What a surface frame needs from the terrain: height lookup and nearby pads (injected). */
export interface SurfaceProvider {
  /** Terrain height above the datum at flat (x, z), metres. */
  heightAt(x: number, z: number): number;
  pads: readonly FlatPad[];
}

/** Everything `integrateShip` needs besides the ship, input and step size. */
export interface FlightContext {
  shipClass: Readonly<ShipClass>;
  bodies: readonly Body[];
  /** Required when `state.frame` is a surface chart. */
  surface?: SurfaceProvider | undefined;
  /** Surface gravity in m/s^2 (default SURFACE_GRAVITY); tests set 0. */
  gravity?: number;
  /** Hover assist (VTOL velocity hold); default true. Tests turn it off for pure physics. */
  assist?: boolean;
}

/** The sim world seen by `stepShip`. */
export interface FlightWorld {
  bodies: readonly Body[];
  /** Terrain access per surface frame id; undefined means flat datum terrain with no pads. */
  surface(frame: FrameId): SurfaceProvider | undefined;
}
