import { hash2, seedFromString } from '../random.js';
import { GALAXY_STAR_COUNT } from './config.js';

/**
 * A player's home system (TASK-10): the star index is derived from the
 * player id (deterministic, stable for the player's whole life) and the
 * system id comes from the exact same (seed, starId) sub-seed that
 * generateSystem uses — so the home system always exists in the seeded
 * galaxy, and no geometry ever needs to be stored for it.
 */
export function homeSystemIdForPlayer(galaxySeed: string, playerId: string): string {
  const hex = playerId.replace(/-/g, '');
  // First 15 hex digits fit in a BigInt cheaply and mix well enough modulo
  // the star count; the full id would work identically.
  const starIndex = Number(BigInt(`0x${hex.slice(0, 15)}`) % BigInt(GALAXY_STAR_COUNT));
  const master = seedFromString(galaxySeed);
  const starId = hash2(master, BigInt(starIndex)).toString(16).padStart(16, '0');
  return hash2(master, seedFromString(starId)).toString(16).padStart(16, '0');
}
