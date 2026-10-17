/**
 * System generator — produces the full `SystemGen` for a single star,
 * including its planet list, deterministic ordering, system id, and
 * display name.
 *
 * This module is the per-star companion to `stars.ts` (TASK-3). Together
 * they implement the galaxy's static geometry: every client and every
 * server can reconstruct every star system from `(GALAXY_SEED, starId)`
 * without any further input. Determinism flows from the same primitives
 * the star generator uses (`Rng`, `hash2`, `seedFromString`), so the
 * `system.ts` ↔ `stars.ts` ↔ `random.ts` import graph is a strict
 * dependency DAG and no `Math.random` / `Date.now` can sneak in.
 *
 * ## Determinism contract (mirrors stars.ts)
 *
 * - `systemId` is the hex of `hash2(seedFromString(seed), seedFromString(starId))`.
 *   Hashing the star id once more keeps the system id decorrelated from
 *   the star id's literal hex while remaining stable.
 * - `name` is `"{star.name} system"` — derived from the star's name
 *   (which is itself seed-derived), so it changes iff the star changes.
 * - `planets` are returned in **orbit order** (`orbitIndex` ascending,
 *   innermost first). This is the stable order; downstream consumers
 *   must never sort by a runtime-derived value (e.g. radius).
 *
 * ## Planet generation
 *
 * The per-planet body (class, radius, atmosphere, landability, dock
 * count, resource fields, AI roster, id, name) lives in `planet.ts` so
 * this file can stay focused on the *system envelope*. Each planet
 * gets its own sub-Rng keyed by `(systemSeed, orbitIndex)`, so adding
 * a planet field can never leak into a sibling planet's body.
 *
 * @see ./stars.ts for the upstream generator this extends.
 * @see ./planet.ts for the per-planet body.
 * @see ./types.ts for `Planet`, `AIRoster`, `SystemGen`, etc.
 * @see ./config-system.ts for tunable constants.
 */

import { hash2, seedFromString, Rng } from "../random.js";
import { generatePlanet } from "./planet.js";
import {
  ID_HEX_CHARS,
  PLANET_COUNT_MAX,
  PLANET_COUNT_MIN,
  SYSTEM_NAME_SUFFIX,
} from "./config-system.js";
import type { Planet, Star, SystemGen } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates the full system body for the given `(seed, starId)` pair,
 * producing a `SystemGen` whose `star` field carries at least the
 * `class` and `name` of the parent star.
 *
 * Two convenience overloads exist:
 *   - `generateSystem(seed, star)`     — primary; passes the parent
 *                                       star through directly.
 *   - `generateSystem(seed, starId)`   — when the caller has only the
 *                                       star id; reconstructs a
 *                                       minimal `Star` snapshot.
 *
 * The statistical test suite uses the id form; the chart UI (TASK-7)
 * uses the full-star form.
 */
export function generateSystem(seed: string, star: Star): SystemGen;
export function generateSystem(seed: string, starId: string): SystemGen;
export function generateSystem(seed: string, starOrId: Star | string): SystemGen {
  const star: Star = typeof starOrId === "string" ? synthesiseStarFromId(seed, starOrId) : starOrId;
  return generateSystemFromStar(seed, star);
}

/**
 * Same as `generateSystem` but takes the parent `Star` directly. This
 * is the "real" entry point — `generateSystem(seed, starId)` routes
 * here after synthesising a minimal `Star` for the caller's `starId`.
 */
export function generateSystemFromStar(seed: string, star: Star): SystemGen {
  if (!Number.isInteger(star.systemCount)) {
    throw new RangeError(
      `generateSystemFromStar: star.systemCount must be an integer, got ${star.systemCount}`,
    );
  }
  const masterSeed = seedFromString(seed);
  const systemSeed = hash2(masterSeed, seedFromString(star.id));
  const rng = new Rng(systemSeed);

  const planetCount = PLANET_COUNT_MIN + rng.nextInt(PLANET_COUNT_MAX - PLANET_COUNT_MIN + 1);

  const planets: Planet[] = [];
  for (let j = 0; j < planetCount; j++) {
    planets.push(generatePlanet(star.id, systemSeed, j));
  }

  // Deterministic ordering: by orbit index ascending. Already true from
  // the loop above, but assert it so a future refactor cannot silently
  // break the order guarantee (rendering and persistence both rely on
  // this contract).
  assertOrbitOrder(planets);

  const systemId = bigintToHex(systemSeed, ID_HEX_CHARS);
  const name = `${star.name}${SYSTEM_NAME_SUFFIX}`;

  return {
    systemId,
    name,
    star,
    planets,
  };
}

// ---------------------------------------------------------------------------
// Synth star (for the starId-only API)
// ---------------------------------------------------------------------------

/**
 * Synthesises a minimal `Star` snapshot for the `(seed, starId)` API
 * form. We can't recover the star's true class, name, or coordinates
 * from a star id alone (those are pulled from the master RNG, not
 * the per-star sub-seed), so this fallback exists *only* to satisfy
 * the contract `star: {class, name}` when the caller hasn't provided
 * the parent `Star`. Real callers — the chart UI, the galaxy router,
 * tests — have the full star list and use `generateSystemFromStar`.
 *
 * The id is real; the rest is documented placeholders. The `class`
 * fallback is `M` (the most common class) so the wire type stays
 * safe; the `name` includes the star id so the placeholder is
 * obviously a placeholder in debug output.
 */
function synthesiseStarFromId(_seed: string, starId: string): Star {
  if (!starId || !/^[0-9a-f]{16}$/.test(starId)) {
    throw new RangeError(
      `generateSystem: starId must be a 16-hex-char string, got ${JSON.stringify(starId)}`,
    );
  }
  return {
    id: starId,
    name: `star:${starId}`,
    class: "M",
    x: 0,
    y: 0,
    z: 0,
    systemCount: 0,
  };
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

/** Render a BigInt as a zero-padded lowercase hex string of `width` chars. */
function bigintToHex(value: bigint, width: number): string {
  const hex = value.toString(16);
  return hex.length >= width ? hex : "0".repeat(width - hex.length) + hex;
}

function assertOrbitOrder(planets: readonly Planet[]): void {
  for (let i = 1; i < planets.length; i++) {
    const prev = planets[i - 1] as Planet;
    const curr = planets[i] as Planet;
    if (curr.orbitIndex <= prev.orbitIndex) {
      throw new Error(
        `internal: planets must be ordered by orbitIndex ascending (got ${prev.orbitIndex} → ${curr.orbitIndex})`,
      );
    }
  }
}

// Re-export the per-planet generator so existing callers (and the test
// suite) can keep importing everything from `./system.js`. The actual
// implementation lives in `planet.ts`.
export { generatePlanet } from "./planet.js";
