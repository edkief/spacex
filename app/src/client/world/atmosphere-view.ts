import { regimeFor } from '@shared/regime';
import type { Regime } from '@shared/regime';
import {
  systemRegimePlanets,
  planetAtmosphereRadius,
  planetAtmosphereDensity,
} from '@shared/galaxy/planets';
import { boundaryFactor, hazeFactor } from '@shared/physics/atmosphere';
import type { Planet, SystemGen } from '@shared/galaxy/types';
import type { Vec3 } from '@shared/physics/vec';

/**
 * Atmosphere view (TASK-28.1) — the pure per-planet resolution of "which
 * planet's atmosphere am I in, and how hazy is it".
 *
 * For a position it resolves the OWNING planet through the shared regime
 * machine (regimeFor — the same source of truth the server tick and the
 * client tracker use), then derives the two shared visuals from the SAME
 * altitude: `boundary` (the boundaryFactor — 1 at surface → 0 at the enter
 * radius) and `haze` (boundaryFactor × densityScale — the ONE number that
 * drives both the dome and the skybox fade, so they can never desync).
 *
 * Pure and deterministic: same (pos, system, current) → identical result.
 * No three.js, no DOM — unit-testable without a renderer.
 */

/** The resolved atmosphere view for a position (null planet = space). */
export interface AtmosphereView {
  /** The planet whose atmosphere owns this position (null in space). */
  planet: Planet | null;
  /** Altitude above the flat client terrain (anchors sit at y = 0). */
  altitude: number;
  /** boundaryFactor at the altitude (1 surface → 0 at/above the enter radius). */
  boundary: number;
  /** hazeFactor at the altitude — the single number driving dome + skybox. */
  haze: number;
}

/** The no-atmosphere result: no planet, no boundary, no haze. */
function spaceView(pos: Vec3): AtmosphereView {
  return { planet: null, altitude: pos.y, boundary: 0, haze: 0 };
}

/**
 * Resolve the atmosphere view for a position (TASK-28.1).
 *
 * @param pos     world position (u); the client terrain is flat, so the
 *                altitude is pos.y (surface anchors sit at y = 0).
 * @param system  the system currently rendered (null = no world yet).
 * @param current the LIVE regime to resolve from (default 'space'). The
 *                caller must pass the tracker's live regime: the exit
 *                hysteresis band [enter, exit) stays 'space' or
 *                'atmosphere' depending on history, and the visual must
 *                follow the same decision the sim did.
 */
export function atmosphereViewFor(
  pos: Vec3,
  system: SystemGen | null,
  current: Regime = 'space',
): AtmosphereView {
  if (system === null) return spaceView(pos);
  const result = regimeFor(pos, systemRegimePlanets(system), current, 0);
  if (result.regime === 'space') return spaceView(pos);
  // Non-space regimes always carry the owning planet (by construction of
  // regimeFor) — guard anyway for a type-safe find.
  const planet = system.planets.find((p) => p.id === result.planetId);
  if (!planet) return spaceView(pos);
  const altitude = pos.y;
  return {
    planet,
    altitude,
    boundary: boundaryFactor(altitude, {
      atmosphereRadius: planetAtmosphereRadius(planet),
    }),
    haze: hazeFactor(altitude, {
      atmosphereRadius: planetAtmosphereRadius(planet),
      atmosphereDensity: planetAtmosphereDensity(planet),
    }),
  };
}
