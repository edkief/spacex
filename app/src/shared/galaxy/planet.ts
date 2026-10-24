import { Rng, hash2 } from '../random';
import { Planet } from './types';
import { 
  PLANET_CLASSES, 
  RADIUS_RANGES, 
  ATMOSPHERE_PROBABILITIES, 
  RESOURCE_POOL, 
  RESOURCE_COUNT_RANGE, 
  AI_ROSTER_COUNT_RANGE, 
  SHIP_CLASSES,
  PLANET_NAME_PREFIXES,
  PLANET_NAME_SUFFIXES
} from './config-system';

/**
 * Generates a single planet based on a seed and its orbit index.
 */
export function generatePlanet(systemSeed: bigint, index: number): Planet {
  const planetSeed = hash2(systemSeed, BigInt(index));
  const rng = new Rng(planetSeed);

  // 1. Class weighted pick
  const totalWeight = PLANET_CLASSES.reduce((sum, p) => sum + p.weight, 0);
  let weightRoll = rng.nextInt(totalWeight);
  let planetClass: Planet['class'] = 'rocky';
  for (const p of PLANET_CLASSES) {
    if (weightRoll < p.weight) {
      planetClass = p.class;
      break;
    }
    weightRoll -= p.weight;
  }

  // 2. Radius
  const range = planetClass === 'gas' ? RADIUS_RANGES.gas : RADIUS_RANGES.standard;
  const radiusKm = Math.floor(rng.nextRange(range.min, range.max));

  // 3. Atmosphere
  const hasAtmosphere = rng.nextF64() < ATMOSPHERE_PROBABILITIES[planetClass];

  // 4. Landability
  // Only non-gas planets can be landable. 90% chance for others.
  const landable = planetClass !== 'gas' && rng.nextF64() < 0.9;

  // 5. Docks
  const dockCount = landable ? rng.nextInt(3) + 1 : 0;

  // 6. Resource Types
  const resCount = rng.nextInt(RESOURCE_COUNT_RANGE.max - RESOURCE_COUNT_RANGE.min + 1) + RESOURCE_COUNT_RANGE.min;
  const shuffledResources = [...RESOURCE_POOL].sort(() => rng.nextF64() - 0.5);
  const resourceTypes = shuffledResources.slice(0, resCount);

  // 7. AI Roster
  const aiCount = rng.nextInt(AI_ROSTER_COUNT_RANGE.max - AI_ROSTER_COUNT_RANGE.min + 1) + AI_ROSTER_COUNT_RANGE.min;
  const aiClasses: any[] = [];
  for (let i = 0; i < aiCount; i++) {
    aiClasses.push(rng.pick(SHIP_CLASSES));
  }

  // 8. Name
  const prefix = rng.pick(PLANET_NAME_PREFIXES);
  const suffix = rng.pick(PLANET_NAME_SUFFIXES);
  const name = `${prefix} ${suffix}`;

  return {
    id: `p-${index}`, // Simple ID based on index for now
    name,
    class: planetClass,
    radiusKm,
    hasAtmosphere,
    landable,
    dockCount,
    resourceTypes,
    aiRoster: {
      count: aiCount,
      classes: aiClasses,
    },
  };
}
