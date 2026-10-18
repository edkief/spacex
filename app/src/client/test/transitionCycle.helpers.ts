/**
 * Helpers + fixture resolvers for the transition-cycle benchmark
 * (TASK-30). Split out of `transitionCycle.ts` so the driver
 * file stays under the AGENTS.md 300-line cap.
 *
 * Contents:
 *   - `BENCH_SHIP_CLASS` — the shared ship class the integrator
 *     consumes (the starter scout).
 *   - `resolveFixtures` — picks a landable+atmosphere planet from
 *     the dev seed and returns the RegimePlanetContext +
 *     PlanetAtmosphere + SystemPad the cycle drives through.
 *   - `pickPercentile` — linear-interpolated percentile (the
 *     same shape `FrameMonitor.pickPercentile` uses).
 *   - `defaultClock` — the wall-clock fallback (performance.now
 *     in the browser, Date.now in Node).
 */

import { generateStars } from "@shared/galaxy/stars.js";
import { generateSystemFromStar } from "@shared/galaxy/system.js";
import { planetWorldPosition } from "@shared/regime-planets.js";
import type { Planet } from "@shared/galaxy/types.js";
import { type PlanetAtmosphere } from "@shared/physics/atmosphere.js";
import { type RegimePlanetContext } from "@shared/regime.js";
import { SHIP_CLASSES, type ShipClass } from "@shared/ships.js";
import { padForPlanet, type SystemPad } from "@shared/world/pads.js";

/** Shared ship-class reference — uses the starter scout. */
export const BENCH_SHIP_CLASS: ShipClass = SHIP_CLASSES.scout;

/** Resolve the dev-seed planet the cycle drives through. */
export function resolveFixtures(seed: string): {
  starId: string;
  planet: Planet;
  planetContext: RegimePlanetContext;
  planetAtmosphere: PlanetAtmosphere;
  pad: SystemPad;
  planetCenter: { x: number; y: number; z: number };
} {
  const stars = generateStars(seed, 4);
  for (const star of stars) {
    const system = generateSystemFromStar(seed, star);
    for (const planet of system.planets) {
      if (!planet.landable || !planet.hasAtmosphere) continue;
      const pad = padForPlanet({ seed, starId: star.id, planet });
      if (pad === null) continue;
      const planetCenter = planetWorldPosition(seed, star.id, planet.orbitIndex);
      const radiusM = planet.radiusKm * 1000;
      // Build a RegimePlanetContext the regime manager can consume.
      // The center uses the actual planet world position (TASK-25
      // `planetWorldPosition`) so the regime manager sees the
      // right distance when the ship is at the pad. heightAt is
      // flat (no terrain) so the surface check happens at the
      // planet radius exactly.
      const planetContext: RegimePlanetContext = {
        id: planet.id,
        center: planetCenter,
        radius: radiusM,
        hasAtmosphere: planet.hasAtmosphere,
        atmosphereHeight: 10_000,
        heightAt: () => 0,
      };
      // The integrator consumes `PlanetAtmosphere`; we mirror
      // the regime context with the additional `atmosphereDensity`
      // field (default 1 — neutral).
      const planetAtmosphere: PlanetAtmosphere = {
        id: planet.id,
        radius: radiusM,
        atmosphereHeight: 10_000,
        atmosphereDensity: 1,
        hasAtmosphere: planet.hasAtmosphere,
        heightAt: () => 0,
      };
      return { starId: star.id, planet, planetContext, planetAtmosphere, pad, planetCenter };
    }
  }
  throw new Error("transitionCycle: no landable+atmosphere planet available in the dev seed");
}

/**
 * Linear-interpolated percentile (same shape as
 * `FrameMonitor.pickPercentile`). Re-exported here so the driver
 * doesn't have to reach into `@client/perf/frameMonitor` for the
 * one helper it needs.
 */
export function pickPercentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const clamped = Math.min(1, Math.max(0, p));
  const rank = clamped * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo]!;
  const weight = rank - lo;
  return sortedAsc[lo]! * (1 - weight) + sortedAsc[hi]! * weight;
}

/**
 * Default clock — prefer `performance.now()` in the browser; fall
 * back to `Date.now()` in Node so the bench runs under `tsx`.
 */
export function defaultClock(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}
