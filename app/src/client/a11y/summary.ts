/**
 * HUD status summary — TASK-54.
 *
 * The screen-reader channel for the live HUD numbers. The spec
 * asks for a single spoken sentence per second, e.g.
 *
 *   "Speed 120 meters per second. Hull 80 percent."
 *
 * so the pure formatter lives here (unit-testable, no React) and
 * the `<LiveRegion>` component owns the 1 Hz poll that feeds it.
 *
 * The summary deliberately omits values that are unknown or
 * meaningless in the current mode (no credits before the first
 * REST read, no exposure while flying) — an unreadable
 * "Exposure undefined" is worse than silence.
 */

/** The numbers the summary can speak. */
export interface HudSummaryInput {
  /** Speed in metres per second (`null` when unknown). */
  speedMps?: number | null;
  /** Hull points remaining. */
  hull?: number | null;
  /** Hull maximum (defaults to 100). */
  hullMax?: number | null;
  /** Credit balance. */
  credits?: number | null;
  /** Exposure pool remaining. */
  exposure?: number | null;
  /** Exposure pool maximum (defaults to 50). */
  exposureMax?: number | null;
}

/** Percentages are rounded to whole numbers — "80 percent", not "80.43 percent". */
function percent(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.round((value / max) * 100);
}

/**
 * Format the HUD numbers into one spoken sentence.
 *
 * Returns an empty string when there is nothing to say (so the
 * live region stays silent instead of announcing a blank).
 */
export function formatHudSummary(input: HudSummaryInput): string {
  const parts: string[] = [];
  if (input.speedMps !== undefined && input.speedMps !== null) {
    const speed = Math.round(input.speedMps);
    parts.push(`Speed ${speed} meters per second.`);
  }
  if (input.hull !== undefined && input.hull !== null) {
    const hullMax = input.hullMax ?? 100;
    parts.push(`Hull ${percent(input.hull, hullMax)} percent.`);
  }
  if (input.exposure !== undefined && input.exposure !== null) {
    const exposureMax = input.exposureMax ?? 50;
    parts.push(`Exposure ${percent(input.exposure, exposureMax)} percent.`);
  }
  if (input.credits !== undefined && input.credits !== null) {
    parts.push(`Credits ${Math.round(input.credits)}.`);
  }
  return parts.join(" ");
}
