/**
 * Surface charts. Each landable planet has two flat charts, north (pole +y) and south (pole -y),
 * each the stereographic projection of the sphere about its pole. For a unit direction n from
 * the planet centre:
 *
 *   north: a = n.x / (1 + n.y), b =  n.z / (1 + n.y)
 *   south: a = n.x / (1 - n.y), b = -n.z / (1 - n.y)
 *
 * (the south chart negates z so both charts are right-handed with altitude as +y). Flat frame
 * metres are x = 2R*a, z = 2R*b. With r^2 = a^2 + b^2: r = 0 at the pole, r = 1 at the equator.
 * The projection is conformal: the local scale is the same in every direction,
 * `chartScale = 1 / (1 + r^2)` true metres per flat metre (1 at the pole, 0.5 at the equator).
 *
 * The inverse (chart -> sphere) needs only + - * /, so terrain generation can use it and stay
 * bit-identical across JS engines. The forward direction needs a normalisation and lives with
 * the sim code in physics/frames.ts.
 */

export type Hemisphere = 'n' | 's';
export const HEMISPHERES: readonly Hemisphere[] = ['n', 's'];

/** A chart is authoritative up to the equator (r = 1). */
export const CHART_LIMIT_R = 1;

/** The other hemisphere. */
export function oppositeHemisphere(hemisphere: Hemisphere): Hemisphere {
  return hemisphere === 'n' ? 's' : 'n';
}

/** r^2 of a flat chart position on a planet of sim radius `radius` (1 at the equator). */
export function chartRadiusSq(radius: number, x: number, z: number): number {
  const a = x / (2 * radius);
  const b = z / (2 * radius);
  return a * a + b * b;
}

/** Local scale at chart radius-squared `r2`: true metres per flat metre, in every direction. */
export function chartScale(r2: number): number {
  return 1 / (1 + r2);
}

/** Unit direction from the planet centre for flat chart position (x, z). Exact operations only. */
export function chartToUnit(
  hemisphere: Hemisphere,
  radius: number,
  x: number,
  z: number,
): { x: number; y: number; z: number } {
  const a = x / (2 * radius);
  const b = z / (2 * radius);
  const q = 1 + a * a + b * b;
  const sign = hemisphere === 'n' ? 1 : -1;
  return { x: (2 * a) / q, y: (sign * (2 - q)) / q, z: (sign * 2 * b) / q };
}

/** True when chunk (chunkX, chunkZ) of size `chunkSize` has its centre inside the chart limit. */
export function chunkInChart(
  radius: number,
  chunkX: number,
  chunkZ: number,
  chunkSize: number,
): boolean {
  const cx = (chunkX + 0.5) * chunkSize;
  const cz = (chunkZ + 0.5) * chunkSize;
  return chartRadiusSq(radius, cx, cz) <= CHART_LIMIT_R * CHART_LIMIT_R;
}
