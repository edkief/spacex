import { Planet } from './types';

/**
 * Computes the atmosphere boundary factor.
 * 1 at surface (alt=0), 0 above atmosphereHeight.
 * Ramps linearly from 1 to 0 over the last 1km of the atmosphere.
 * 
 * @param alt Altitude above planet surface in meters.
 * @param planet The planet's atmospheric properties.
 * @returns A value from 0 to 1.
 */
export function boundaryFactor(alt: number, planet: Planet): number {
  const height = planet.atmosphereHeight ?? 0;
  if (height === 0) {
    return 0;
  }

  const atmosphereM = height * 1000;
  const rampWidth = 1000; // 1km ramp

  if (alt <= atmosphereM - rampWidth) {
    return 1;
  }
  if (alt >= atmosphereM) {
    return 0;
  }

  // Ramp linearly from 1 to 0 over the last 1km
  const t = (alt - (atmosphereM - rampWidth)) / rampWidth;
  return 1 - t;
}
