import { generateStars } from '@shared/galaxy/stars.ts';
import { generateSystemForStar } from '@shared/galaxy/system.ts';
import type { SystemGen } from '@shared/galaxy/types.ts';
import { bodiesOf, type Body } from '@shared/physics/bodies.ts';

/** A system as the client derives it from the seed: generated data plus its sim bodies. */
export interface ClientSystem {
  system: SystemGen;
  bodies: readonly Body[];
}

/**
 * Regenerates the system with id `systemId` from the galaxy seed, exactly as the server does.
 * System ids are hashes, so the chart is scanned once.
 * @throws when the id does not belong to the seed's galaxy.
 */
export function deriveSystem(seed: string, systemId: string): ClientSystem {
  for (const star of generateStars(seed)) {
    const system = generateSystemForStar(seed, star);
    if (system.systemId === systemId) return { system, bodies: bodiesOf(system) };
  }
  throw new RangeError(`system ${systemId} is not part of this galaxy`);
}
