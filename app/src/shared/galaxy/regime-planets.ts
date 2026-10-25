import { Vec3 } from '../physics/vec';
import { Planet } from './types';
import { Rng, seedFromString, hash2 } from '../random';

export const ORBIT_ORIGIN_M = 4000;
export const ORBIT_GROWTH = 1.9;
export const ORBIT_PHI = Math.PI * (3 - Math.sqrt(5)); // Golden angle
export const STAR_SYSTEM_OFFSET_M = 8000;

/**
 * Deterministically computes the world position of a planet in a system.
 * Based on orbit separation and golden angle distribution.
 */
export function planetWorldPosition(seed: string, starId: string, orbitIndex: number): Vec3 {
  const masterSeed = seedFromString(seed);
  const starSeedBigInt = BigInt('0x' + starId);
  const systemSeed = hash2(masterSeed, starSeedBigInt);
  
  const distance = ORBIT_ORIGIN_M * Math.pow(ORBIT_GROWTH, orbitIndex);
  const angle = orbitIndex * ORBIT_PHI;
  
  // Use a planet-specific seed for inclination
  const planetSeed = hash2(systemSeed, BigInt(orbitIndex));
  const pRng = new Rng(planetSeed);
  const inclination = (pRng.nextF64() - 0.5) * 0.2; // +/- 0.1 radians
  
  return {
    x: Math.cos(angle) * distance,
    y: Math.sin(inclination) * distance,
    z: Math.sin(angle) * distance + STAR_SYSTEM_OFFSET_M,
  };
}

export interface RegimePlanetContext {
  planet: {
    id: string;
    radiusKm: number;
    atmosphereHeight: number;
  };
  pos: Vec3;
}

/**
 * Creates a list of planet contexts (planet + position) for a given system.
 * Maps Galaxy Planet to a simplified Physics Planet structure.
 */
export function getRegimePlanetContexts(seed: string, starId: string, planets: any[]): RegimePlanetContext[] {
  return planets.map((planet, i) => ({
    planet: {
      id: planet.id,
      radiusKm: planet.radiusKm,
      atmosphereHeight: planet.hasAtmosphere ? planet.radiusKm * 0.1 : 0,
    },
    pos: planetWorldPosition(seed, starId, i),
  }));
}
