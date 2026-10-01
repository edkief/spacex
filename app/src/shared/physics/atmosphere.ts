/**
 * Atmosphere boundary (TASK-22, TASK-28) — the single shared boundary
 * function for physics AND visuals.
 *
 * The atmosphere of a planet is a band from the terrain surface up to its
 * enter radius (`atmosphereRadius`, the line where the regime machine steps
 * space → atmosphere). Drag must not switch on at a hard altitude line:
 * the coefficient ramps continuously 0 (at/above the enter radius, i.e. in
 * space) → k_max (at the surface) across the band, so a ship crossing the
 * boundary under constant input experiences a C⁰ change in acceleration,
 * never a velocity kick. The visuals use the very same factor (one number
 * drives the skybox fade-out and the dome haze-in, so they can never
 * desync): haze = boundaryFactor × densityScale(planet.atmosphereDensity).
 *
 * v1 documented assumption: re-entry heating is NOT simulated — the only
 * cue is a cosmetic orange tint ramp (see {@link reentryTintFactor}).
 */

/** Altitude (in u, 1 u ≈ 1 m) of the full-atmosphere enter radius. */
export const ATMOSPHERE_BOUNDARY_M = 1000;

/** Reference atmosphere density: haze at full density = full boundary haze. */
export const ATMOSPHERE_REF_DENSITY = 0.1;

/** Descent speed (u/s) above which the cosmetic re-entry tint starts. */
export const REENTRY_TINT_SPEED = 200;
/** Descent-speed span (u/s) over which the tint ramps from 0 to its max. */
export const REENTRY_TINT_RAMP = 300;
/** Max tint opacity (kept subtle by design — cosmetic only). */
export const REENTRY_TINT_MAX = 0.4;

/** The geometry a boundary factor needs: the planet's enter radius. */
export interface BoundaryPlanet {
  /** Atmosphere enter radius (u). 0 = airless (space only). */
  atmosphereRadius: number;
}

/**
 * Boundary factor for an altitude above terrain: 1 at the surface (full
 * atmosphere), 0 at/above the enter radius (space), linear in between.
 * Airless planets (atmosphereRadius ≤ 0) are 0 everywhere.
 *
 * Continuous everywhere, including the two kink points (alt = 0 and alt =
 * enter radius) — both sides of each kink agree exactly, so the drag
 * acceleration k·f(alt)·|v|·v is C⁰ at every boundary altitude (and in
 * particular across the space → atmosphere regime switch: drag is 0 in
 * space and → 0 at the enter radius from below).
 */
export function boundaryFactor(altitudeU: number, planet: BoundaryPlanet): number {
  const r = planet.atmosphereRadius;
  if (r <= 0) return 0;
  if (altitudeU <= 0) return 1;
  if (altitudeU >= r) return 0;
  return 1 - altitudeU / r;
}

/**
 * Per-planet haze scaling from atmosphere density (0..1 at full reference
 * density): a thin-atmosphere planet is visibly less hazy at the same
 * altitude. 0 for airless / zero-density bodies.
 */
export function densityScale(atmosphereDensity: number): number {
  if (!(atmosphereDensity > 0) || !Number.isFinite(atmosphereDensity)) return 0;
  return Math.min(1, atmosphereDensity / ATMOSPHERE_REF_DENSITY);
}

/**
 * Visual haze of the atmosphere dome at an altitude (0 in space → 1 at the
 * surface for a full-density planet): boundaryFactor × densityScale. This
 * single number drives both the dome's opacity and the skybox's fade.
 */
export function hazeFactor(
  altitudeU: number,
  planet: BoundaryPlanet & { atmosphereDensity: number },
): number {
  return boundaryFactor(altitudeU, planet) * densityScale(planet.atmosphereDensity);
}

/**
 * Cosmetic re-entry tint (NOT simulated heating): a subtle orange ramp when
 * descending faster than REENTRY_TINT_SPEED inside the boundary band. 0 in
 * space, below the speed threshold, or when not descending.
 */
export function reentryTintFactor(descentSpeedU: number, boundary: number): number {
  if (boundary <= 0 || descentSpeedU <= REENTRY_TINT_SPEED) return 0;
  return (
    Math.min(1, (descentSpeedU - REENTRY_TINT_SPEED) / REENTRY_TINT_RAMP) *
    boundary *
    REENTRY_TINT_MAX
  );
}
