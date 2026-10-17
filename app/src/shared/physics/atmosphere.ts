/**
 * Atmosphere boundary primitives — shared between the flight model
 * (TASK-22) and the atmosphere entry/exit visuals (TASK-28).
 *
 * The boundary band is a 1 km thick shell above the planet surface:
 *
 *   altitude = (planet.radius + planet.atmosphereHeight + BOUNDARY_RAMP_WIDTH_M)  ← "above the boundary" → factor 0
 *   ...
 *   altitude = (planet.radius + planet.atmosphereHeight)                          ← "top of atmosphere" → factor 0 (boundary STARTS here)
 *   ...
 *   altitude = planet.radius                                                     ← "ground" → factor 1
 *
 * The factor is linear in altitude between the top of the band and
 * the ground, which keeps the drag force continuous as the player
 * ascends or descends through the transition.
 *
 * TASK-28 imports `boundaryFactor` so its visual haze ramp is driven
 * by exactly the same number as the physics drag. A single source of
 * truth means the two can never desync — if the haze ramps over 1 km
 * but the physics drags over 2 km, players will see a clear
 * "atmosphere drag visible" transition before they feel any drag, and
 * vice versa.
 *
 * Pure module: no Math.random, no Date.now, no side effects.
 */

import type { FlightPad } from "./types.js";
import type { Vec3 } from "./vec.js";

/**
 * Planet atmosphere parameters required by the flight model.
 *
 * Production callers (TASK-28+) construct this from a seeded
 * `Planet` plus an in-process heightmap (the `heightAt` callback);
 * tests construct an instance directly with analytic terrain.
 *
 * The interface is intentionally extensible: the flight model reads
 * `pads` to enable VTOL landing detection (TASK-29). The server wires
 * `pads` from the seeded pad placement (TASK-5); tests pass a
 * synthetic list or omit it entirely.
 */
export interface PlanetAtmosphere {
  /** Stable planet id (for logging + state.onPad association). */
  readonly id: string;
  /** Surface radius in metres (top of terrain). */
  readonly radius: number;
  /** Total atmospheric thickness in metres (top of the atmosphere). */
  readonly atmosphereHeight: number;
  /**
   * Atmosphere density in arbitrary units (0..1 range; values > 1
   * are allowed for "thick" gas giants). Multiplied with the
   * per-ship drag coefficient when computing atmospheric drag.
   */
  readonly atmosphereDensity: number;
  /** Whether the planet retains an atmosphere at all. */
  readonly hasAtmosphere: boolean;
  /**
   * Callback: terrain altitude (metres above `radius`) at the given
   * world-local (x, z). Returning a `number` rather than a separate
   * heightmap keeps the flight model planet-agnostic — the server
   * injects a heightmap lookup and tests inject analytic terrain.
   */
  readonly heightAt: (x: number, z: number) => number;
  /**
   * Optional landing pads reachable from atmosphere / surface
   * regimes. Sourced from the deterministic placement pass (TASK-5)
   * and consumed by the VTOL / docking state (TASK-29).
   */
  readonly pads?: readonly FlightPad[];
}

/** Width of the boundary ramp band (1 km per spec). */
export const BOUNDARY_RAMP_WIDTH_M = 1000;

/**
 * Default atmosphere thickness (10 km). Roughly tracks Earth's scale
 * atmosphere for a 1 u ≈ 1 m planet. Real atmospheric thickness varies
 * wildly per planet class (gas giants have very deep atmospheres,
 * thin-atmosphere rocky worlds have a few km at most); the spec lets
 * the seeded planet override this per world.
 */
export const DEFAULT_ATMOSPHERE_HEIGHT_M = 10_000;

/**
 * Continuous boundary factor `f ∈ [0, 1]`.
 *
 *   f = 1   when altitude ≤ 0 (at or below the surface)
 *   f = 0   when altitude ≥ BOUNDARY_RAMP_WIDTH_M (above the boundary band)
 *   f = 1 - altitude / BOUNDARY_RAMP_WIDTH_M   otherwise (linear ramp)
 *
 * `altitude` is measured from the planet surface upward. Callers that
 * hold a world position relative to the planet centre should subtract
 * `planet.radius` before invoking this.
 *
 * If the planet has no atmosphere the factor is hard zero — the ramp
 * is irrelevant and the player can fly straight through the band
 * without any drag transition (matches the "no atmosphere" experience).
 */
export function boundaryFactor(altitude: number, planet: PlanetAtmosphere): number {
  if (!planet.hasAtmosphere) return 0;
  if (altitude <= 0) return 1;
  if (altitude >= BOUNDARY_RAMP_WIDTH_M) return 0;
  return 1 - altitude / BOUNDARY_RAMP_WIDTH_M;
}

/**
 * Convenience: boundary altitude (in metres above the surface) at the
 * given world position relative to the planet centre. Useful for
 * callers that have a `Vec3` and don't want to subtract `planet.radius`
 * themselves. Returns 0 if `pos` is at or below the surface.
 */
export function altitudeFromPlanet(pos: Vec3, planet: PlanetAtmosphere): number {
  const surfaceY = planet.radius;
  if (pos.y <= surfaceY) return 0;
  return pos.y - surfaceY;
}

/**
 * Drag coefficient `k` for a ship of the given mass at the given
 * altitude, taking the planet's atmosphere density and the boundary
 * ramp into account. Returns 0 above the boundary band (no drag).
 *
 * Formula follows the spec (TASK-22 step 3):
 *
 *   k = planet.atmosphereDensity * (mass / area) * boundaryFactor(altitude)
 *
 * `area` defaults to 1 m². Heavier ships (more mass per unit area)
 * experience more drag deceleration — a deliberately simplified
 * Newtonian-ish model where the air resistance force grows linearly
 * with mass but the resulting acceleration is unchanged, leaving the
 * per-frame Δv the same regardless of mass. This keeps the quadratic
 * drag curve visually predictable across ship classes.
 */
export function dragCoefficient(
  altitude: number,
  planet: PlanetAtmosphere,
  mass: number,
  area: number = 1,
): number {
  const f = boundaryFactor(altitude, planet);
  if (f <= 0) return 0;
  return planet.atmosphereDensity * (mass / area) * f;
}

/**
 * Helper for tests and the server: build a `PlanetAtmosphere` with a
 * flat heightAt (every world (x, z) yields the same surface altitude).
 *
 * `surfaceOffset` defaults to 0 (terrain == planet.radius). Pass a
 * non-zero offset to simulate a localised hill or sea.
 */
export function makeFlatPlanet(opts: {
  id: string;
  radius: number;
  atmosphereHeight?: number;
  atmosphereDensity?: number;
  hasAtmosphere?: boolean;
  surfaceOffset?: number;
}): PlanetAtmosphere {
  const offset = opts.surfaceOffset ?? 0;
  return {
    id: opts.id,
    radius: opts.radius,
    atmosphereHeight: opts.atmosphereHeight ?? DEFAULT_ATMOSPHERE_HEIGHT_M,
    atmosphereDensity: opts.atmosphereDensity ?? 1,
    hasAtmosphere: opts.hasAtmosphere ?? true,
    heightAt: () => offset,
  };
}
