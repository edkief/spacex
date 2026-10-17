/**
 * Unit tests for `shared/galaxy/system` (functional invariants and
 * determinism). Sibling files exercise the rest of the suite:
 *   - `config-system.test.ts`  — integer bounds and weight sums.
 *   - `planet.test.ts`         — the per-planet generator.
 *   - `system.parity.test.ts`  — happy-dom parity + golden fixture +
 *                                source purity.
 *
 * Coverage here:
 *   - `generateSystem`: invariants on every generated system
 *     (planet count, ordering, id format, gas-never-landable,
 *     dockCount bounds, resource uniqueness, AI roster bounds).
 *   - determinism: identical output across repeated calls and across
 *     the seed-id and full-Star API entry points.
 *   - statistical: over 200 generated systems, the spec's 80%-of-
 *     systems-have-a-landable-planet-with-atmosphere invariant
 *     holds.
 *
 * @see ./system.ts for the generator this exercises.
 * @see ./stars.test.ts for the upstream pattern (this file mirrors it).
 */

import { describe, it, expect } from "vitest";

import { generateStars } from "./stars.js";
import { generateSystem, generateSystemFromStar } from "./system.js";
import {
  AI_ROSTER_MAX,
  AI_ROSTER_MIN,
  DOCK_COUNT_MAX,
  DOCK_COUNT_MIN,
  PLANET_COUNT_MAX,
  PLANET_COUNT_MIN,
  PLANET_RADIUS_MAX_KM,
  PLANET_RADIUS_MAX_KM_GAS,
  PLANET_RADIUS_MIN_KM,
  PLANET_RADIUS_MIN_KM_GAS,
  RESOURCE_PICKS_MAX,
  RESOURCE_PICKS_MIN,
  SYSTEM_NAME_SUFFIX,
} from "./config-system.js";
import type { Planet, ResourceType, Star } from "./types.js";
import { hash2, seedFromString } from "../random.js";
import {
  bigintToHex,
  DEV_SEED,
  sampleStar,
  STAR_INDEX,
  TEST_SEEDS,
  VALID_PLANET_CLASSES,
  VALID_RESOURCE_TYPES,
  VALID_SHIP_CLASSES,
} from "./system.helpers.js";

// ---------------------------------------------------------------------------
// generateSystem — invariants on every generated system
// ---------------------------------------------------------------------------

describe("shared/galaxy/system — generateSystem(seed, star)", () => {
  it("returns a planet count within [PLANET_COUNT_MIN, PLANET_COUNT_MAX]", () => {
    for (const seed of TEST_SEEDS) {
      const stars = generateStars(seed);
      for (const star of stars) {
        const sys = generateSystemFromStar(seed, star);
        expect(sys.planets.length).toBeGreaterThanOrEqual(PLANET_COUNT_MIN);
        expect(sys.planets.length).toBeLessThanOrEqual(PLANET_COUNT_MAX);
      }
    }
  });

  it("returns a 16-char lowercase-hex systemId", () => {
    const sys = generateSystem(DEV_SEED, sampleStar());
    expect(sys.systemId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns a name built from the parent star's name + suffix", () => {
    const sys = generateSystem(DEV_SEED, sampleStar());
    expect(sys.name).toBe(`${sampleStar().name}${SYSTEM_NAME_SUFFIX}`);
  });

  it("planet ids are unique within a system and are 16-hex-char lowercase", () => {
    const sys = generateSystem(DEV_SEED, sampleStar());
    const ids = new Set(sys.planets.map((p) => p.id));
    expect(ids.size).toBe(sys.planets.length);
    for (const p of sys.planets) {
      expect(p.id).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it("planets are ordered by orbitIndex ascending (innermost first)", () => {
    for (const seed of TEST_SEEDS) {
      const stars = generateStars(seed);
      for (const star of stars.slice(0, 20)) {
        const sys = generateSystemFromStar(seed, star);
        for (let i = 1; i < sys.planets.length; i++) {
          const prev = sys.planets[i - 1] as Planet;
          const curr = sys.planets[i] as Planet;
          expect(curr.orbitIndex).toBeGreaterThan(prev.orbitIndex);
        }
      }
    }
  });

  it("planet classes are always one of the 5 canonical classes", () => {
    const sys = generateSystem(DEV_SEED, sampleStar());
    for (const p of sys.planets) {
      expect(VALID_PLANET_CLASSES.has(p.class)).toBe(true);
    }
  });

  it("planets have orbitIndex, name, and all spec'd fields populated", () => {
    const sys = generateSystem(DEV_SEED, sampleStar());
    for (const p of sys.planets) {
      expect(p.name).toMatch(/^Planet( I{0,3}|IV|V|VI|VII|VIII|IX|X|XX|XXX|XL|L)?$/);
      expect(Number.isInteger(p.orbitIndex)).toBe(true);
      expect(p.orbitIndex).toBeGreaterThanOrEqual(0);
      expect(p.orbitIndex).toBeLessThanOrEqual(PLANET_COUNT_MAX - 1);
      expect(Number.isInteger(p.radiusKm)).toBe(true);
      expect(typeof p.hasAtmosphere).toBe("boolean");
      expect(typeof p.landable).toBe("boolean");
      expect(Number.isInteger(p.dockCount)).toBe(true);
      expect(Array.isArray(p.resourceTypes)).toBe(true);
      expect(p.resourceTypes.length).toBeGreaterThanOrEqual(RESOURCE_PICKS_MIN);
      expect(p.resourceTypes.length).toBeLessThanOrEqual(RESOURCE_PICKS_MAX);
      expect(p.aiRoster.count).toBeGreaterThanOrEqual(AI_ROSTER_MIN);
      expect(p.aiRoster.count).toBeLessThanOrEqual(AI_ROSTER_MAX);
      expect(p.aiRoster.classes.length).toBe(p.aiRoster.count);
      for (const cls of p.aiRoster.classes) {
        expect(VALID_SHIP_CLASSES.has(cls)).toBe(true);
      }
    }
  });

  it("gas giants are never landable (hard invariant)", () => {
    const sys = generateSystem(DEV_SEED, sampleStar());
    for (const p of sys.planets) {
      if (p.class === "gas") {
        expect(p.landable).toBe(false);
        expect(p.dockCount).toBe(0);
      }
    }
  });

  it("non-gas landable planets have dockCount in [DOCK_COUNT_MIN, DOCK_COUNT_MAX]", () => {
    const sys = generateSystem(DEV_SEED, sampleStar());
    for (const p of sys.planets) {
      if (p.class !== "gas" && p.landable) {
        expect(p.dockCount).toBeGreaterThanOrEqual(DOCK_COUNT_MIN);
        expect(p.dockCount).toBeLessThanOrEqual(DOCK_COUNT_MAX);
      }
    }
  });

  it("non-landable non-gas planets have dockCount === 0", () => {
    const sys = generateSystem(DEV_SEED, sampleStar());
    for (const p of sys.planets) {
      if (p.class !== "gas" && !p.landable) {
        expect(p.dockCount).toBe(0);
      }
    }
  });

  it("gas giants have radius in the gas range; others in the non-gas range", () => {
    const sys = generateSystem(DEV_SEED, sampleStar());
    for (const p of sys.planets) {
      if (p.class === "gas") {
        expect(p.radiusKm).toBeGreaterThanOrEqual(PLANET_RADIUS_MIN_KM_GAS);
        expect(p.radiusKm).toBeLessThanOrEqual(PLANET_RADIUS_MAX_KM_GAS);
      } else {
        expect(p.radiusKm).toBeGreaterThanOrEqual(PLANET_RADIUS_MIN_KM);
        expect(p.radiusKm).toBeLessThanOrEqual(PLANET_RADIUS_MAX_KM);
      }
    }
  });

  it("atmosphere probability matches class (gas/terran/ocean always yes; rocky/ice roll the dice)", () => {
    const sys = generateSystem(DEV_SEED, sampleStar());
    for (const p of sys.planets) {
      if (p.class === "gas" || p.class === "terran" || p.class === "ocean") {
        expect(p.hasAtmosphere).toBe(true);
      } else {
        expect(typeof p.hasAtmosphere).toBe("boolean");
      }
    }
  });

  it("resourceTypes contains valid canonical types only, no duplicates, within pick bounds", () => {
    const sys = generateSystem(DEV_SEED, sampleStar());
    for (const p of sys.planets) {
      const seen = new Set<ResourceType>();
      for (const r of p.resourceTypes) {
        expect(VALID_RESOURCE_TYPES.has(r)).toBe(true);
        expect(seen.has(r)).toBe(false);
        seen.add(r);
      }
      expect(p.resourceTypes.length).toBeGreaterThanOrEqual(RESOURCE_PICKS_MIN);
      expect(p.resourceTypes.length).toBeLessThanOrEqual(RESOURCE_PICKS_MAX);
    }
  });

  it("AI roster contains valid ship classes, length === count", () => {
    const sys = generateSystem(DEV_SEED, sampleStar());
    for (const p of sys.planets) {
      expect(p.aiRoster.count).toBeGreaterThanOrEqual(AI_ROSTER_MIN);
      expect(p.aiRoster.count).toBeLessThanOrEqual(AI_ROSTER_MAX);
      expect(p.aiRoster.classes).toHaveLength(p.aiRoster.count);
      for (const cls of p.aiRoster.classes) {
        expect(VALID_SHIP_CLASSES.has(cls)).toBe(true);
      }
    }
  });

  it("two Rng instances built from the same seed produce identical systems", () => {
    const stars = generateStars(DEV_SEED);
    const star = stars[STAR_INDEX] as Star;
    const a = generateSystemFromStar(DEV_SEED, star);
    const b = generateSystemFromStar(DEV_SEED, star);
    expect(a).toEqual(b);
  });

  it("generateSystem returns the same planets whether called with Star object or starId", () => {
    const stars = generateStars(DEV_SEED);
    const star = stars[STAR_INDEX] as Star;
    // The seed-only API synthesises a placeholder Star, so the full
    // SystemGen differs in `star` (placeholder). Spec only requires
    // deterministic planets and systemId, so we compare those.
    const full = generateSystemFromStar(DEV_SEED, star);
    const byId = generateSystem(DEV_SEED, star.id);
    expect(byId.systemId).toBe(full.systemId);
    expect(byId.planets).toEqual(full.planets);
  });

  it("statistical: over 200 systems, >=80% have a landable planet with atmosphere", () => {
    const stars = generateStars(DEV_SEED);
    let withLandingTarget = 0;
    let total = 0;
    for (const star of stars) {
      const sys = generateSystemFromStar(DEV_SEED, star);
      total++;
      if (sys.planets.some((p) => p.landable && p.hasAtmosphere)) {
        withLandingTarget++;
      }
    }
    const ratio = withLandingTarget / total;
    expect(ratio).toBeGreaterThanOrEqual(0.8);
  });

  it("two calls diverge on different seeds", () => {
    const stars1 = generateStars("alpha");
    const star1 = stars1[STAR_INDEX] as Star;
    const stars2 = generateStars("beta");
    const star2 = stars2[STAR_INDEX] as Star;
    const a = generateSystemFromStar("alpha", star1);
    const b = generateSystemFromStar("beta", star2);
    expect(a.systemId).not.toBe(b.systemId);
    let samePlanets = true;
    for (let i = 0; i < Math.min(a.planets.length, b.planets.length); i++) {
      if (a.planets[i]!.id !== b.planets[i]!.id) {
        samePlanets = false;
        break;
      }
    }
    expect(samePlanets).toBe(false);
  });

  it("systemId equals bigintToHex(hash2(seedFromString(seed), seedFromString(star.id)))", () => {
    const stars = generateStars(DEV_SEED);
    const star = stars[STAR_INDEX] as Star;
    const masterSeed = seedFromString(DEV_SEED);
    const expected = bigintToHex(hash2(masterSeed, seedFromString(star.id)), 16);
    const sys = generateSystemFromStar(DEV_SEED, star);
    expect(sys.systemId).toBe(expected);
  });
});
