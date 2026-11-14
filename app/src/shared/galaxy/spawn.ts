import { seedFromString } from '../random.ts';
import { generateStars } from './stars.ts';
import { generateSystemForStar } from './system.ts';

/** A system a new player may start in. */
export interface SpawnSystem {
  systemId: string;
  starId: string;
  starName: string;
}

/**
 * Systems of the galaxy that have at least one landable planet with a dock, in chart order.
 * (Star #0 of the dev seed has only gas giants, so it is not eligible.)
 */
export function listSpawnSystems(seed: string): SpawnSystem[] {
  const spawns: SpawnSystem[] = [];
  for (const star of generateStars(seed)) {
    const system = generateSystemForStar(seed, star);
    if (system.planets.some((planet) => planet.landable && planet.dockCount >= 1)) {
      spawns.push({ systemId: system.systemId, starId: star.id, starName: star.name });
    }
  }
  return spawns;
}

/**
 * Deterministically picks the spawn system for a player: FNV-1a of the player id, modulo the
 * number of eligible systems. The same id always lands in the same system for a given seed.
 */
export function pickSpawnSystem(spawns: readonly SpawnSystem[], playerId: string): SpawnSystem {
  const first = spawns[0];
  if (!first) throw new RangeError('galaxy has no eligible spawn systems');
  const index = Number(seedFromString(playerId) % BigInt(spawns.length));
  return spawns[index] ?? first;
}
