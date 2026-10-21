/**
 * Deterministic system bodies — TASK-76.
 *
 * Turns `(galaxySeed, systemId)` into the *renderable* description
 * of the system's bodies: one star plus its planet list, with the
 * orbit distances and body radii the renderer needs. The galaxy
 * generators already own every physical decision (class, radius,
 * atmosphere, planet count, ordering) — this module owns only the
 * two things they deliberately leave out:
 *
 *   1. **Orbit separation.** The `Planet` record carries no orbit
 *      distance, so we define one deterministic geometric rule
 *      (below) and pin it with unit tests.
 *   2. **Unit conversion.** Galaxy coordinates are in galactic
 *      units, radii in kilometres, and the sim/renderer work in
 *      metres. One documented factor converts km → rendered
 *      metres so no call site invents its own scale.
 *
 * The function is **pure**: no three.js, no clock, no randomness
 * beyond the seeded generators. Two calls with the same arguments
 * return structurally identical bodies on every client.
 *
 * @see @shared/galaxy/stars.ts   — `generateStars`
 * @see @shared/galaxy/system.ts  — `generateSystemFromStar`
 * @see ./seedContext.ts          — where the seed comes from
 * @see ../render/bodies/SystemBodyLayer.ts — the consumer
 */

import { GALAXY_STAR_COUNT } from "@shared/galaxy/config.js";
import { generateStars } from "@shared/galaxy/stars.js";
import { generateSystemFromStar } from "@shared/galaxy/system.js";
import type { PlanetClass, SpectralClass } from "@shared/galaxy/types.js";

// ---------------------------------------------------------------------------
// Scale rules (documented, single-sourced, unit-tested)
// ---------------------------------------------------------------------------

/** Physical kilometres per rendered metre. */
export const METRES_PER_KM = 1000;

/**
 * Rendered metres per *generated* kilometre. Real radii would
 * dwarf the play space (a 6 000 km planet is a 6 000 km ball of
 * rock next to a 20 m ship), so body radii are compressed by this
 * single documented factor. It is applied to star radii and planet
 * radii alike — there is exactly one scale rule in the codebase.
 */
export const RENDER_METRES_PER_KM = 0.25;

/**
 * Innermost orbit distance, in rendered metres. `orbitDistanceM(0)`
 * equals this value; each further orbit multiplies it by
 * {@link ORBIT_GROWTH}. 4 km puts the first planet comfortably
 * inside the star's visible disc from the spawn point.
 */
export const ORBIT_ORIGIN_M = 4_000;

/** Geometric ratio between consecutive orbits (1.9 ⇒ no two
 *  planets ever overlap, and the outermost orbit of a 10-planet
 *  system lands at ≈ 135 km). */
export const ORBIT_GROWTH = 1.9;

/**
 * Upper bound on a planet's radius as a fraction of its distance
 * from the *spawn point* (the system origin, where the player is
 * dropped). Without it a gas giant — up to 60 000 generated km —
 * would swallow the camera when it swings between the player and
 * the star. 0.18 keeps every planet under ~10° of angular radius,
 * so the star always wins the frame.
 */
export const MAX_BODY_ANGULAR_FRACTION = 0.18;

/** Floor for the clamp above so a body never degenerates to a
 *  sub-pixel speck when the camera is right on top of it. */
export const MIN_BODY_RADIUS_M = 12;

/**
 * Distance from the system origin (the spawn point every shard uses
 * for its entity coordinates) to the star's centre, along +Z — the
 * ship's forward axis — so "fly toward the star" is a direction the
 * player can actually see from the cockpit.
 */
export const STAR_SYSTEM_OFFSET_M = 8_000;

/** Angle between consecutive planet orbits (the golden angle, in
 *  radians) so no two planets line up on the same ray. */
export const ORBIT_PHI = 2.399963229728653;

/** Galactic units (kpc by convention) → kilometres. Used only for
 *  the informational `star.posKm` field; the renderer works in
 *  system-local space. (≈ 3.086 × 10¹⁶ km per kpc.) */
export const GALACTIC_UNIT_TO_KM = 3.085677581491367e16;

/**
 * Stellar radii in kilometres by spectral class (a compressed but
 * monotonically ordered stand-in for the real main-sequence table).
 * Scaled into rendered metres by {@link RENDER_METRES_PER_KM}.
 */
export const STAR_RADIUS_KM: Readonly<Record<SpectralClass, number>> = {
  O: 70_000,
  B: 35_000,
  A: 18_000,
  F: 11_000,
  G: 8_000,
  K: 4_800,
  M: 3_200,
};

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/** A plain 3-vector (no three.js in this module). */
export interface Vec3M {
  x: number;
  y: number;
  z: number;
}

/** The star of a system, in rendered units. */
export interface StarBody {
  /** `Star.id` — equal to the system id (see `overview.ts`). */
  id: string;
  name: string;
  class: SpectralClass;
  /** Galactic position converted to kilometres (informational). */
  posKm: Vec3M;
  /** Stellar radius in generated kilometres. */
  radiusKm: number;
  /** Rendered radius in metres (star sits `STAR_SYSTEM_OFFSET_M`
   *  in front of the system origin — the layer owns that offset). */
  renderRadiusM: number;
}

/** One planet of a system, in rendered units. */
export interface PlanetBody {
  id: string;
  name: string;
  class: PlanetClass;
  orbitIndex: number;
  /** Distance from the star's centre, in metres. */
  orbitDistanceM: number;
  /** Rendered radius in metres (clamped by the orbit rule). */
  radiusM: number;
  hasAtmosphere: boolean;
}

/** Everything the renderer needs for one system. */
export interface SystemBodies {
  /** `null` when the system id is unknown to the galaxy. */
  star: StarBody | null;
  /** Empty when the system id is unknown. */
  planets: readonly PlanetBody[];
  /** Star + planets. `0` for an unknown system. */
  bodyCount: number;
  /** The system id these bodies were computed for. */
  systemId: string;
}

// ---------------------------------------------------------------------------
// Placement rules
// ---------------------------------------------------------------------------

/**
 * Distance of a planet from its star, in rendered metres.
 *
 * The rule is a pure geometric progression:
 * `orbitDistanceM(i) = ORBIT_ORIGIN_M * ORBIT_GROWTH^i`, i.e.
 * 4 000 / 7 600 / 14 440 / 27 436 / 52 128 / 99 043 m for orbits
 * 0..5. It is strictly increasing by construction (growth > 1),
 * which is what the unit test asserts — a planet can never be
 * placed behind another one.
 */
export function orbitDistanceM(orbitIndex: number): number {
  if (!Number.isFinite(orbitIndex) || orbitIndex < 0) {
    throw new RangeError(`orbitDistanceM: orbitIndex must be >= 0, got ${orbitIndex}`);
  }
  return ORBIT_ORIGIN_M * ORBIT_GROWTH ** orbitIndex;
}

/**
 * A planet's offset from the star's centre in the orbit plane.
 * Orbits are spread by the golden angle (no collinear planets) and
 * given a small deterministic inclination so the system reads as a
 * disc rather than a flat line when viewed edge-on.
 */
export function planetOrbitOffset(orbitIndex: number, distanceM: number): Vec3M {
  const angle = orbitIndex * ORBIT_PHI;
  const incline = Math.sin(angle * 1.7) * 0.12;
  return {
    x: Math.cos(angle) * distanceM,
    y: incline * distanceM,
    z: Math.sin(angle) * distanceM,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Derive a system's bodies from the galaxy seed.
 *
 * Pure and deterministic: `generateStars` + `generateSystemFromStar`
 * are the shared seed-derived generators, and every placement rule
 * above is arithmetic. Two calls with the same arguments produce
 * identical output on any client.
 *
 * An unknown `systemId` returns an **empty** body list (`star:
 * null`, `planets: []`) rather than throwing — the renderer simply
 * renders nothing until the shard reports a system the client can
 * regenerate.
 */
export function computeSystemBodies(seed: string, systemId: string): SystemBodies {
  if (typeof seed !== "string" || seed.length === 0) {
    return { star: null, planets: [], bodyCount: 0, systemId: String(systemId ?? "") };
  }
  const stars = generateStars(seed, GALAXY_STAR_COUNT);
  const star = stars.find((candidate) => candidate.id === systemId);
  if (star === undefined) {
    return { star: null, planets: [], bodyCount: 0, systemId };
  }

  // `generateSystemFromStar` (not the id-only overload) so the star
  // keeps its real class / position — the id-only form synthesises
  // placeholders that would render as a class-M star everywhere.
  const system = generateSystemFromStar(seed, star);

  const planets: PlanetBody[] = system.planets.map((planet) => {
    const distance = orbitDistanceM(planet.orbitIndex);
    const rawRadius = planet.radiusKm * RENDER_METRES_PER_KM;
    // Worst case is the orbit's near point (the planet passing
    // between the player and the star), so the clamp holds for the
    // whole orbit rather than one instant of it.
    const spawnDistance = Math.max(MIN_BODY_RADIUS_M, Math.abs(distance - STAR_SYSTEM_OFFSET_M));
    return {
      id: planet.id,
      name: planet.name,
      class: planet.class,
      orbitIndex: planet.orbitIndex,
      orbitDistanceM: distance,
      radiusM: Math.min(rawRadius, spawnDistance * MAX_BODY_ANGULAR_FRACTION),
      hasAtmosphere: planet.hasAtmosphere,
    };
  });

  const radiusKm = STAR_RADIUS_KM[star.class];
  return {
    star: {
      id: star.id,
      name: star.name,
      class: star.class,
      posKm: {
        x: star.x * GALACTIC_UNIT_TO_KM,
        y: star.y * GALACTIC_UNIT_TO_KM,
        z: star.z * GALACTIC_UNIT_TO_KM,
      },
      radiusKm,
      renderRadiusM: radiusKm * RENDER_METRES_PER_KM,
    },
    planets,
    bodyCount: planets.length + 1,
    systemId,
  };
}
