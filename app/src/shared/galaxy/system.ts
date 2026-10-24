import { Rng, seedFromString, hash2 } from '../random';
import { SystemGen, Planet } from './types';
import { generateStars } from './stars';
import { generatePlanet } from './planet';
import { PLANET_COUNT_RANGE } from './config-system';

/**
 * Deterministically generates a star system based on a seed and starId.
 */
export function generateSystem(seed: string, starId: string): SystemGen {
  const masterSeed = seedFromString(seed);
  
  // 1. Find the star to get its class and name
  const stars = generateStars(seed);
  const star = stars.find(s => s.id === starId);
  
  if (!star) {
    throw new Error(`Star with ID ${starId} not found in galaxy generated with seed ${seed}`);
  }

  // 2. System seed
  // We use the starId as a basis for the system seed.
  // Since starId is already a hex string of a hash, we convert it back to bigint.
  const starSeedBigInt = BigInt('0x' + starId);
  const systemSeed = hash2(masterSeed, starSeedBigInt);
  const rng = new Rng(systemSeed);

  // 3. Planet count: 2-6
  const planetCount = rng.nextInt(PLANET_COUNT_RANGE.max - PLANET_COUNT_RANGE.min + 1) + PLANET_COUNT_RANGE.min;

  // 4. Generate planets
  const planets: Planet[] = [];
  for (let i = 0; i < planetCount; i++) {
    planets.push(generatePlanet(systemSeed, i));
  }

  // 5. System name
  // Either 'StarName system' or a designation like 'DR-042'
  const name = rng.nextF64() < 0.8 
    ? `${star.name} system` 
    : `SYS-${starId.substring(0, 4).toUpperCase()}-${rng.nextInt(1000).toString().padStart(3, '0')}`;

  return {
    systemId: systemSeed.toString(16),
    name,
    star: {
      class: star.class,
      name: star.name,
    },
    planets,
  };
}
