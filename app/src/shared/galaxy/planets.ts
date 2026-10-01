/**
 * Sim-world planet placement (TASK-25, shared by client + server).
 *
 * The sim's world plane is shared: every planet of a system owns a region of
 * it, anchored at a deterministic position derived from its orbital-slot
 * index (the same stable order generateSystem uses). Anchors are far apart
 * (PLANET_ANCHOR_SPACING_M ≫ any atmosphere radius), so a ship is near at
 * most ONE planet's atmosphere at a time — "nearest planet" is unambiguous
 * in practice, and regime.ts still tie-breaks deterministically.
 *
 * The atmosphere radius is derived from TASK-4 planet data: airless bodies
 * get 0 (space only), bodies with an atmosphere get the 1 km boundary that
 * TASK-22's drag ramp already uses (ATMOSPHERE_BOUNDARY_M) — the regime
 * boundary and the drag boundary are the same line, so entering the
 * atmosphere is also where drag starts ramping.
 */

import { ATMOSPHERE_BOUNDARY_M } from '../physics/atmosphere';
import type { RegimePlanet } from '../regime';
import type { Planet, SystemGen } from './types';

/** Spacing (u) between planet surface anchors on the shared world plane. */
export const PLANET_ANCHOR_SPACING_M = 10_000;

/** Surface anchor of the planet at orbital-slot `index` (world u). */
export function planetAnchor(index: number): { x: number; z: number } {
  return { x: (index + 1) * PLANET_ANCHOR_SPACING_M, z: 0 };
}

/**
 * Atmosphere radius (u) of a planet from its TASK-4 data: 0 when airless,
 * otherwise the shared 1 km TASK-22 drag boundary.
 */
export function planetAtmosphereRadius(planet: Pick<Planet, 'hasAtmosphere'>): number {
  return planet.hasAtmosphere ? ATMOSPHERE_BOUNDARY_M : 0;
}

/**
 * The regime manager's view of a system's planets (orbital-slot order).
 * `heightAt` is left for the caller to inject (the server wires the
 * chunk-cached TerrainContext; the client uses its own terrain source) —
 * this keeps the mapping a pure function of the system data.
 */
export function systemRegimePlanets(system: Pick<SystemGen, 'planets'>): RegimePlanet[] {
  return system.planets.map((planet, index) => {
    const anchor = planetAnchor(index);
    return {
      id: planet.id,
      x: anchor.x,
      z: anchor.z,
      atmosphereRadius: planetAtmosphereRadius(planet),
      landable: planet.landable,
    };
  });
}
