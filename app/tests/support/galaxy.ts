import { generateStars } from '@shared/galaxy/stars.ts';
import { generateSystemForStar } from '@shared/galaxy/system.ts';
import type { Planet, Star } from '@shared/galaxy/types.ts';

/** A planet together with the star that owns it. */
export interface LocatedPlanet {
  star: Star;
  starIndex: number;
  planet: Planet;
}

/**
 * Scans the chart in star order and returns the first planet matching `predicate`.
 * "The dev-seed landable planet" in fixtures means `firstPlanet(seed, p => p.landable)`.
 */
export function firstPlanet(seed: string, predicate: (planet: Planet) => boolean): LocatedPlanet {
  const stars = generateStars(seed);
  for (let starIndex = 0; starIndex < stars.length; starIndex++) {
    const star = stars[starIndex]!;
    const planet = generateSystemForStar(seed, star).planets.find(predicate);
    if (planet) return { star, starIndex, planet };
  }
  throw new Error(`no matching planet in the galaxy of seed ${seed}`);
}

/** Collects up to `limit` non-gas planets of the given class, in chart order. */
export function planetsOfClass(
  seed: string,
  planetClass: Planet['class'],
  limit: number,
): Planet[] {
  const found: Planet[] = [];
  for (const star of generateStars(seed)) {
    for (const planet of generateSystemForStar(seed, star).planets) {
      if (planet.class === planetClass && found.length < limit) found.push(planet);
    }
  }
  return found;
}
