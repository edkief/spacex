import { hash2, Rng, seedFromString } from '../random.js';

/**
 * Home-system dock position (TASK-20): deterministically derived from
 * (galaxySeed, systemId), same sub-seed scheme as the rest of the galaxy —
 * the starter ship always docks at the same coordinates, and no dock
 * geometry ever needs to be stored.
 *
 * Draw order is fixed: x, z. y is always 0 (docks sit on the system's
 * docking plane). Integer metres, kept to a 200 m square around the origin
 * so every dock is reachable in one sublight hop.
 */
export interface DockPosition {
  x: number;
  y: number;
  z: number;
}

export function homeDockPosition(galaxySeed: string, systemId: string): DockPosition {
  const subSeed = hash2(seedFromString(galaxySeed), seedFromString(systemId));
  const rng = new Rng(subSeed);
  return { x: rng.nextInt(201) - 100, y: 0, z: rng.nextInt(201) - 100 };
}
