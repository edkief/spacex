import { Vec3, vec3 } from './physics/vec';
import { FlightRegime } from './physics/types';

export const LANDING_VELOCITY_THRESHOLD = 10;
export const SURFACE_OFFSET = 2;

export interface RegimePlanetContext {
  planet: {
    id: string;
    radiusKm: number;
    atmosphereHeight: number;
  };
  pos: Vec3;
}

/**
 * Resolves the current flight regime for a ship based on its position, velocity, 
 * nearby planets, and previous regime (for hysteresis).
 * 
 * @param pos Current position of the ship.
 * @param vel Current velocity of the ship.
 * @param contexts List of planets with their world positions.
 * @param current The current regime of the ship.
 * @returns The resolved regime and the ID of the planet influencing it, if any.
 */
export function regimeFor(
  pos: Vec3,
  vel: Vec3,
  contexts: RegimePlanetContext[],
  current: FlightRegime,
): { regime: FlightRegime; planetId?: string } {
  if (contexts.length === 0) {
    return { regime: 'space' };
  }

  // 1. Find the nearest planet
  let nearestContext: RegimePlanetContext | null = null;
  let minDistSq = Infinity;

  for (const ctx of contexts) {
    const dSq = vec3.lenSq(vec3.sub(pos, ctx.pos));
    if (dSq < minDistSq) {
      minDistSq = dSq;
      nearestContext = ctx;
    }
  }

  if (!nearestContext) {
    return { regime: 'space' };
  }

  const { planet, pos: planetPos } = nearestContext;
  const dist = Math.sqrt(minDistSq);
  
  // enterRadius = radiusKm + atmosphereHeight
  // We assume radiusKm is in meters for this calculation if pos is in meters.
  // Wait, if radiusKm is 2000, and pos is in meters, we need to convert.
  // Let's assume positions are in meters.
  const radiusM = planet.radiusKm * 1000;
  const atmosphereM = planet.atmosphereHeight * 1000;
  const enterRadius = radiusM + atmosphereM;
  const exitRadius = enterRadius * 1.05;

  const speed = vec3.len(vel);
  const isSlow = speed < LANDING_VELOCITY_THRESHOLD;

  // Transition logic
  if (current === 'space') {
    if (dist < enterRadius) {
      return { regime: 'atmosphere', planetId: planet.id };
    }
    return { regime: 'space' };
  }

  if (current === 'atmosphere') {
    if (dist > exitRadius) {
      return { regime: 'space' };
    }
    if (dist < radiusM + SURFACE_OFFSET && isSlow) {
      return { regime: 'surface', planetId: planet.id };
    }
    return { regime: 'atmosphere', planetId: planet.id };
  }

  if (current === 'surface') {
    if (dist > radiusM + SURFACE_OFFSET) {
      return { regime: 'atmosphere', planetId: planet.id };
    }
    return { regime: 'surface', planetId: planet.id };
  }

  return { regime: 'space' };
}
