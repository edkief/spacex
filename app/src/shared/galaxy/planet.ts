/**
 * Per-planet generator — produces a single `Planet` from
 * `(parentStarId, systemSeed, orbitIndex)`.
 *
 * Lives in its own file (rather than appending to `system.ts`) so the
 * system-level generator stays focused on the *envelope* (systemId,
 * name, planet count, ordering) and the planet-level generator owns
 * the *body* of each orbit slot. TASK-45 (rogue AI ship placement) and
 * TASK-5 (surface chunks) will add fields built on top of this; the
 * split keeps their diffs small.
 *
 * The algorithm here is described in detail in the module header of
 * `system.ts` — every per-planet decision flows from the planet's own
 * sub-Rng so additions to other planets can't leak in (and vice-versa
 * from the system seed's perspective).
 *
 * @see ./system.ts for the system-level entry point.
 * @see ./types.ts for `Planet`, `AIRoster`, `PlanetClass`, etc.
 * @see ./config-system.ts for tunable bounds.
 */

import { hash2, Rng } from "../random.js";
import {
  AI_ROSTER_MAX,
  AI_ROSTER_MIN,
  ATMOSPHERE_PROBABILITY,
  DOCK_COUNT_MAX,
  DOCK_COUNT_MIN,
  ID_HEX_CHARS,
  PLANET_CLASS_WEIGHTS,
  PLANET_NAME_INDEX_MAX,
  PLANET_RADIUS_MAX_KM,
  PLANET_RADIUS_MAX_KM_GAS,
  PLANET_RADIUS_MIN_KM,
  PLANET_RADIUS_MIN_KM_GAS,
  RESOURCE_PICKS_MAX,
  RESOURCE_PICKS_MIN,
} from "./config-system.js";
import {
  PLANET_CLASSES,
  RESOURCE_TYPES,
  SHIP_CLASS_IDS,
  type AIRoster,
  type Planet,
  type PlanetClass,
  type ResourceType,
  type ShipClassId,
} from "./types.js";

/** Probability that a non-gas planet is landable (gas giants are *never* landable). */
const NON_GAS_LANDABLE_PROBABILITY = 0.95;

/** Roman-numeral letter tables for the planet display name ("Planet I", "Planet II", …). */
const ROMAN_ONES: readonly string[] = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX"];
const ROMAN_TENS: readonly string[] = ["", "X", "XX", "XXX", "XL", "L"];

// ---------------------------------------------------------------------------
// Public per-planet API
// ---------------------------------------------------------------------------

/**
 * Generates one planet for the given `(parentStarId, systemSeed, orbitIndex)`.
 * Public so the test suite can probe individual orbit slots; not part of
 * the user-facing API. `_parentStarId` is currently unused — the planet
 * id is keyed by `(systemSeed, orbitIndex)` only — but it's part of
 * the signature so the test can read a planet's id back without
 * reconstructing the system seed.
 */
export function generatePlanet(
  _parentStarId: string,
  systemSeed: bigint,
  orbitIndex: number,
): Planet {
  const planetSeed = hash2(systemSeed, BigInt(orbitIndex));
  const rng = new Rng(planetSeed);

  const cls = pickPlanetClass(rng);
  const radiusKm = pickPlanetRadiusKm(rng, cls);
  const hasAtmosphere = rollAtmosphere(rng, cls);
  const landable = cls !== "gas" && rng.nextF64() < NON_GAS_LANDABLE_PROBABILITY;
  const dockCount = landable
    ? DOCK_COUNT_MIN + rng.nextInt(DOCK_COUNT_MAX - DOCK_COUNT_MIN + 1)
    : 0;
  const resourceTypes = pickResourceFields(rng);
  const aiRoster = pickAiRoster(rng);

  const id = bigintToHex(planetSeed, ID_HEX_CHARS);
  const name = planetName(orbitIndex);

  return {
    id,
    name,
    orbitIndex,
    class: cls,
    radiusKm,
    hasAtmosphere,
    landable,
    dockCount,
    resourceTypes,
    aiRoster,
  };
}

// ---------------------------------------------------------------------------
// Helpers (per-planet scoped)
// ---------------------------------------------------------------------------

/**
 * Picks a planet class using `PLANET_CLASS_WEIGHTS`. Same algorithm as
 * `pickSpectralClass` in `stars.ts` — keep them structurally identical
 * so the test reader only has to learn the pattern once.
 */
function pickPlanetClass(rng: Rng): PlanetClass {
  const u = rng.nextF64();
  let acc = 0;
  for (const cls of PLANET_CLASSES) {
    acc += PLANET_CLASS_WEIGHTS[cls];
    if (u < acc) return cls;
  }
  // Floating-point tail: last class wins.
  return PLANET_CLASSES[PLANET_CLASSES.length - 1];
}

/**
 * Radius range per class:
 *   gas   → 20_000..60_000 km
 *   other →   2_000.. 8_000 km
 * Rounded to integer km so the wire type matches the spec's `radiusKm:
 * number` without dragging a unit suffix into JSON.
 */
function pickPlanetRadiusKm(rng: Rng, cls: PlanetClass): number {
  if (cls === "gas") {
    return (
      PLANET_RADIUS_MIN_KM_GAS +
      rng.nextInt(PLANET_RADIUS_MAX_KM_GAS - PLANET_RADIUS_MIN_KM_GAS + 1)
    );
  }
  return PLANET_RADIUS_MIN_KM + rng.nextInt(PLANET_RADIUS_MAX_KM - PLANET_RADIUS_MIN_KM + 1);
}

/**
 * Atmospheric probability by class. Gas/terran/ocean → always; rocky
 * and ice roll the dice per `ATMOSPHERE_PROBABILITY`. Tuned so that
 * over 200 generated systems ≥80% contain a landable planet with
 * atmosphere (the spec's acceptance criterion).
 */
function rollAtmosphere(rng: Rng, cls: PlanetClass): boolean {
  switch (cls) {
    case "gas":
    case "terran":
    case "ocean":
      return true;
    case "rocky":
      return rng.nextF64() < ATMOSPHERE_PROBABILITY["rocky"];
    case "ice":
      return rng.nextF64() < ATMOSPHERE_PROBABILITY["ice"];
  }
}

/**
 * Returns `RESOURCE_PICKS_MIN..RESOURCE_PICKS_MAX` unique resource
 * types via a partial Fisher–Yates shuffle of a copy of
 * `RESOURCE_TYPES`. Deterministic because the seeded `rng` is the
 * only source of randomness.
 */
function pickResourceFields(rng: Rng): readonly ResourceType[] {
  const pool = [...RESOURCE_TYPES];
  const n = RESOURCE_PICKS_MIN + rng.nextInt(RESOURCE_PICKS_MAX - RESOURCE_PICKS_MIN + 1);
  for (let i = 0; i < n; i++) {
    const j = i + rng.nextInt(pool.length - i);
    const tmp = pool[i] as ResourceType;
    pool[i] = pool[j] as ResourceType;
    pool[j] = tmp;
  }
  return pool.slice(0, n);
}

/**
 * Returns an AI roster of `count` ships with `count` classes drawn
 * with replacement from `SHIP_CLASS_IDS`. Stable per planet because
 * the planet's own sub-Rng is the only randomness source.
 */
function pickAiRoster(rng: Rng): AIRoster {
  const count = AI_ROSTER_MIN + rng.nextInt(AI_ROSTER_MAX - AI_ROSTER_MIN + 1);
  const classes: ShipClassId[] = [];
  for (let i = 0; i < count; i++) {
    classes.push(rng.pick(SHIP_CLASS_IDS));
  }
  return { count, classes };
}

/**
 * Planet display name: `Planet {Roman}` — deterministic, uniquely
 * ordered within the system (orbit 0 → I, orbit 1 → II, …).
 * Roman numerals are easier to read in the HUD than bare indices and
 * don't need an extra word list.
 */
function planetName(orbitIndex: number): string {
  if (orbitIndex < 0 || orbitIndex > PLANET_NAME_INDEX_MAX) {
    throw new RangeError(
      `planetName: orbitIndex out of range [0, ${PLANET_NAME_INDEX_MAX}], got ${orbitIndex}`,
    );
  }
  const tens = Math.floor(orbitIndex / 10);
  const ones = orbitIndex % 10;
  const roman = `${ROMAN_TENS[tens]}${ROMAN_ONES[ones]}`;
  // Index 0 → no roman numeral; without this branch we'd produce a
  // trailing space ("Planet ").
  return roman ? `Planet ${roman}` : "Planet";
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

/** Render a BigInt as a zero-padded lowercase hex string of `width` chars. */
function bigintToHex(value: bigint, width: number): string {
  const hex = value.toString(16);
  return hex.length >= width ? hex : "0".repeat(width - hex.length) + hex;
}
