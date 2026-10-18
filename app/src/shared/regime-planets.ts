/**
 * Deterministic planet world-position resolver — TASK-25.
 *
 * The `Planet` record (TASK-4) does not carry a world position —
 * the seed-driven system generator only emits (id, name, class,
 * radius, atmosphere flag, ...). For the regime manager we need
 * each planet's centre in world space so `regimeFor` can compute
 * the distance from a ship to the nearest atmosphere.
 *
 * This module builds a deterministic world position per planet by
 * spreading the planets around the star on a circle, with one
 * revolution per orbit slot. The orbit radius grows linearly with
 * `orbitIndex` so consecutive planets stay clear of each other
 * (50 Mm between adjacent orbits — well outside any atmosphere
 * shell, even for the largest gas giant).
 *
 * Why deterministic and not a per-tick RNG? Because the server's
 * authoritative regime resolution AND the client's predicted regime
 * resolution must agree on which planet is nearest at any
 * `(ship.pos, time)`. If the positions rolled at spawn time the two
 * peers could end up with different layouts after a warp/reload.
 * Locking the layout to `(seed, starId, orbitIndex)` means every
 * consumer can re-derive the same coordinates from the same seed.
 *
 * The module ships a single export — `planetWorldPosition` — plus a
 * thin wrapper `regimePlanetContexts` that returns the full list of
 * `RegimePlanetContext` records the sim tick needs. Callers that
 * already have the planet list (the server's `ShardSystemContext`,
 * the client's cached `SystemGen`) plug them straight in.
 *
 * @see ./regime.ts for the `regimeFor` function that consumes the
 *      contexts produced here.
 * @see ../../server/galaxy/system-data.ts for the position resolver
 *      the server's shard already wires.
 */

import { hash2, Rng, seedFromString } from "./random.js";
import type { Planet } from "./galaxy/types.js";
import { makeRegimePlanetContext, type RegimePlanetContext } from "./regime.js";
import type { Vec3 } from "./physics/vec.js";

// ---------------------------------------------------------------------------
// Tunable constants
// ---------------------------------------------------------------------------

/**
 * Base orbit radius (m). The innermost planet sits at this distance
 * from the star. 100 Mm = 100_000 km — comfortably outside any
 * atmosphere shell for the largest gas giants (~60_000 km radius)
 * the seed-driven generator can produce.
 */
export const PLANET_ORBIT_BASE_M = 100_000_000;

/**
 * Per-orbit spacing (m). Each subsequent planet sits this much
 * further from the star. 50 Mm = 50_000 km — about 8× the largest
 * gas giant, leaving plenty of clear space for ships to fly between
 * planets without accidentally crossing into a neighbour's
 * atmosphere.
 */
export const PLANET_ORBIT_STEP_M = 50_000_000;

/**
 * Default atmosphere thickness (m). Matches the `DEFAULT_ATMOSPHERE_HEIGHT_M`
 * in `@shared/physics/atmosphere` — both share the same constant so
 * the physics and the regime manager can't drift apart.
 */
export const DEFAULT_PLANET_ATMOSPHERE_HEIGHT_M = 10_000;

// ---------------------------------------------------------------------------
// Position resolver
// ---------------------------------------------------------------------------

/**
 * Compute the world position of the planet at `orbitIndex` in the
 * system identified by `(seed, starId)`. Pure function: same inputs
 * always yield the same `{ x, y, z }`.
 *
 * Layout:
 *   - `angle` = `orbitIndex × (2π / max(planets, 8))` radians,
 *      spread around the star so consecutive orbit slots land at
 *      distinct angles. Using a divisor (not a unit angle per
 *      orbit) keeps the layout symmetric and prevents planets
 *      from piling up on one side when a system only has 2
 *      planets.
 *   - `radius` = `PLANET_ORBIT_BASE_M + orbitIndex × PLANET_ORBIT_STEP_M`
 *      (linear progression, no collisions).
 *   - `y` is 0 — the v1 layout is planar. Future tasks (TASK-26)
 *      may lift the layout into a 3-D distribution; for now,
 *      `y === 0` keeps the heightmap lookup trivial.
 *
 * The function does NOT consult the `Planet` records themselves;
 * it derives everything from `(seed, starId, orbitIndex)` so the
 * same layout is reproducible without a full system generation
 * pass. The shard already has the planets; this function is the
 * cheap layout resolver that pairs each one with a position.
 */
export function planetWorldPosition(seed: string, starId: string, orbitIndex: number): Vec3 {
  if (!Number.isInteger(orbitIndex) || orbitIndex < 0) {
    throw new RangeError(
      `planetWorldPosition: orbitIndex must be a non-negative integer, got ${orbitIndex}`,
    );
  }
  // Sub-seed for this planet. Same scheme as `generatePlanet` so the
  // angle lines up with the planet's other per-instance fields
  // (class, radius, AI roster). Two clients that hash `(seed, starId,
  // orbitIndex)` the same way get the same angle.
  const systemSeed = hash2(seedFromString(seed), seedFromString(starId));
  const planetSeed = hash2(systemSeed, BigInt(orbitIndex));
  const rng = new Rng(planetSeed);

  // 8 evenly-spaced slots by default (a system has 2..6 planets in
  // practice, but 8 slots means even the densest system spreads its
  // orbits around the star). The RNG pick is a small deterministic
  // jitter inside the slot so two adjacent orbits don't land at
  // exactly the same angle (which would make `nearestAtmospherePlanet`
  // ambiguous for a ship on the line connecting them).
  const slotCount = 8;
  const baseAngle = (orbitIndex * 2 * Math.PI) / slotCount;
  const jitter = (rng.nextF64() - 0.5) * (Math.PI / slotCount);
  const angle = baseAngle + jitter;

  const radius = PLANET_ORBIT_BASE_M + orbitIndex * PLANET_ORBIT_STEP_M;
  return {
    x: radius * Math.cos(angle),
    y: 0,
    z: radius * Math.sin(angle),
  };
}

// ---------------------------------------------------------------------------
// RegimePlanetContext builder
// ---------------------------------------------------------------------------

/**
 * Convert the shard's planet list + heightAt closure into a list of
 * `RegimePlanetContext` records. The shard passes a `heightAt` it
 * derived from the deterministic heightmap; the resulting context
 * list is exactly what `regimeFor` consumes.
 *
 * `heightAtFor` is optional — when omitted the resolver falls back
 * to a flat heightmap (every (x, z) yields 0). Production wires the
 * real heightmap; tests pass `undefined` to keep the layout
 * trivially flat.
 *
 * `atmosphereHeightFor` is optional — when omitted the resolver uses
 * `DEFAULT_PLANET_ATMOSPHERE_HEIGHT_M` (10 km, matching the server
 * sim's constant). Tests pass a per-planet override so the regime
 * math can be exercised with smaller planets (a 10 km atmosphere
 * around a 1-metre planet would otherwise dwarf the ship's
 * trajectory).
 *
 * Returns an empty list if `planets` is empty (no regime info to
 * resolve against — every ship stays in `'space'` mode).
 */
export function regimePlanetContexts(args: {
  seed: string;
  starId: string;
  planets: readonly Planet[];
  heightAtFor?: (planetId: string) => (x: number, z: number) => number;
  atmosphereHeightFor?: (planetId: string) => number;
}): RegimePlanetContext[] {
  const { seed, starId, planets, heightAtFor, atmosphereHeightFor } = args;
  const out: RegimePlanetContext[] = [];
  for (const planet of planets) {
    const center = planetWorldPosition(seed, starId, planet.orbitIndex);
    const heightAt = heightAtFor?.(planet.id) ?? (() => 0);
    const atmosphereHeight = atmosphereHeightFor?.(planet.id) ?? DEFAULT_PLANET_ATMOSPHERE_HEIGHT_M;
    out.push(
      makeRegimePlanetContext({
        id: planet.id,
        center,
        radius: planet.radiusKm * 1000,
        hasAtmosphere: planet.hasAtmosphere,
        heightAt,
        atmosphereHeight,
      }),
    );
  }
  return out;
}
