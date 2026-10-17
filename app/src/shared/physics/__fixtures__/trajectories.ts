/**
 * AUTO-GENERATED — do not hand-edit.
 *
 * Regenerate with: npx tsx scripts/gen-flight-trajectories.ts
 *
 * Two golden trajectories that prove the flight model is bit-stable
 * across runs and clients. See flight.test.ts > "golden trajectory
 * fixtures" for the acceptance check.
 */
import type { ShipInput, ShipState } from "../flight.js";
import type { PlanetAtmosphere } from "../atmosphere.js";
import type { FlightPad } from "../flight.js";

export interface GoldenTrajectory {
  readonly name: string;
  readonly shipClass: string;
  readonly seconds: number;
  readonly start: ShipState;
  readonly input: ShipInput;
  readonly planet?: PlanetAtmosphere & { readonly pads?: readonly FlightPad[] };
  readonly final: ShipState;
}

// Marker export — keeps the module non-empty when consumed via
// `import {} from "./trajectories.js"` style imports.
export const _unused_marker = true;

export const GOLDEN_SPACE_60S: GoldenTrajectory = {
  name: "space-60s",
  shipClass: "scout",
  seconds: 60,
  start: {
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    regime: "space",
  },
  input: {
    thrust: 1,
    yaw: 0,
    pitch: 0,
    roll: 0,
    up: 0,
  },
  final: {
    pos: { x: 0, y: 0, z: 7561.110416666055 },
    vel: { x: 0, y: 0, z: 129.49999999999972 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    regime: "space",
    onPad: undefined,
  },
};
export const GOLDEN_ATMO_30S: GoldenTrajectory = {
  name: "atmo-30s",
  shipClass: "scout",
  seconds: 30,
  start: {
    pos: { x: 0, y: 1003000, z: 0 },
    vel: { x: 0, y: -20, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    regime: "atmosphere",
  },
  input: {
    thrust: 0.4,
    yaw: 0,
    pitch: 0,
    roll: 0,
    up: 0.2,
  },
  planet: {
    id: "test-planet",
    radius: 1000000,
    atmosphereHeight: 10000,
    atmosphereDensity: 0.01,
    hasAtmosphere: true,
    heightAt: (_x: number, _z: number): number => 0,
    pads: [{ id: "pad-home", x: 0, z: 0, height: 0, radius: 20 }],
  },
  final: {
    pos: { x: 0, y: 1002726.4330474025, z: 3231.0430942920607 },
    vel: { x: 0, y: -1.0234028990720172, z: 123.79563133630404 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    regime: "atmosphere",
    onPad: undefined,
  },
};
