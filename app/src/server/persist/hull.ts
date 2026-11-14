/** Hull fractions that trigger an immediate save when damage crosses them. */
export const HULL_THRESHOLDS = [0.75, 0.5, 0.25] as const;

/**
 * Damage level 0..3: how many of the 75/50/25% hull thresholds the hull is at or below.
 * Level only rises as damage accumulates and falls again after repairs.
 */
export function damageLevel(hull: number, maxHull: number): number {
  if (!(maxHull > 0)) return 0;
  const fraction = hull / maxHull;
  return HULL_THRESHOLDS.filter((threshold) => fraction <= threshold).length;
}
