import { Vec3, Quat } from './vec';

export type FlightRegime = 'space' | 'atmosphere' | 'surface';

export interface ShipState {
  pos: Vec3;
  vel: Vec3;
  quat: Quat;
  regime: FlightRegime;
  onPad?: string;
}

export interface FlightInput {
  thrust: number; // -1 to 1
  pitch: number;  // -1 to 1
  yaw: number;    // -1 to 1
  roll: number;   // -1 to 1
  up: boolean;    // VTOL lift
}

export interface Planet {
  id: string;
  atmosphereDensity: number;
  radiusKm: number;
  atmosphereHeight: number; // Height in km above radiusKm
  // Other properties as needed by TASK-28
}

export interface FlightOptions {
  /** Callback to get terrain height at (x, z) */
  heightAt?: (x: number, z: number) => number;
}
