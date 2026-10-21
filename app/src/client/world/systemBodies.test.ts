/**
 * Deterministic system bodies — TASK-76.
 *
 * Pins the four promises the renderer depends on:
 *   (a) the same `(seed, systemId)` yields identical bodies twice,
 *   (b) two different seeds yield different star positions,
 *   (c) `orbitDistanceM` is strictly increasing in the orbit index,
 *   (d) an unknown `systemId` returns an empty body list instead of
 *       throwing.
 *
 * Plus the two documented scale rules (metres-per-km factor and the
 * orbit-radius clamp) so a future "tweak the visuals" commit cannot
 * silently change the numbers another module depends on.
 */
import { describe, expect, it } from "vitest";

import { generateStars } from "@shared/galaxy/stars.js";

import {
  MAX_BODY_ANGULAR_FRACTION,
  STAR_SYSTEM_OFFSET_M,
  ORBIT_GROWTH,
  ORBIT_ORIGIN_M,
  RENDER_METRES_PER_KM,
  computeSystemBodies,
  orbitDistanceM,
  planetOrbitOffset,
} from "./systemBodies.js";

const SEED = "DRIFT-TASK-76-TEST";
const OTHER_SEED = "DRIFT-TASK-76-OTHER";

/** First system id of a seed — the galaxy generator is the source
 *  of truth for which ids exist, so tests never hard-code one. */
function firstSystemId(seed: string): string {
  const star = generateStars(seed, 8)[0];
  expect(star).toBeDefined();
  return star?.id ?? "";
}

describe("computeSystemBodies", () => {
  it("(a) is deterministic: two calls with the same arguments match", () => {
    const systemId = firstSystemId(SEED);
    const first = computeSystemBodies(SEED, systemId);
    const second = computeSystemBodies(SEED, systemId);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.star).not.toBeNull();
    expect(first.star?.id).toBe(systemId);
    expect(first.bodyCount).toBe((first.planets.length ?? 0) + 1);
  });

  it("(b) different seeds yield different star positions", () => {
    const a = computeSystemBodies(SEED, firstSystemId(SEED));
    const b = computeSystemBodies(OTHER_SEED, firstSystemId(OTHER_SEED));
    expect(JSON.stringify(a.star?.posKm)).not.toBe(JSON.stringify(b.star?.posKm));
  });

  it("(c) orbitDistanceM is strictly increasing in orbitIndex", () => {
    expect(orbitDistanceM(0)).toBeCloseTo(ORBIT_ORIGIN_M, 6);
    let previous = orbitDistanceM(0);
    for (let i = 1; i <= 12; i++) {
      const next = orbitDistanceM(i);
      expect(next).toBeGreaterThan(previous);
      expect(next / previous).toBeCloseTo(ORBIT_GROWTH, 9);
      previous = next;
    }
    expect(() => orbitDistanceM(-1)).toThrow(RangeError);
  });

  it("(d) an unknown systemId returns an empty body list rather than throwing", () => {
    const result = computeSystemBodies(SEED, "ffffffffffffffff");
    expect(result.star).toBeNull();
    expect(result.planets).toEqual([]);
    expect(result.bodyCount).toBe(0);
    expect(() => computeSystemBodies("", "anything")).not.toThrow();
  });

  it("scales radii with the documented metres-per-km factor and clamps to the orbit", () => {
    const bodies = computeSystemBodies(SEED, firstSystemId(SEED));
    for (const planet of bodies.planets) {
      expect(planet.orbitDistanceM).toBeCloseTo(orbitDistanceM(planet.orbitIndex), 6);
      expect(planet.radiusM).toBeGreaterThan(0);
      const spawnDistance = Math.abs(planet.orbitDistanceM - STAR_SYSTEM_OFFSET_M);
      expect(planet.radiusM).toBeLessThanOrEqual(
        Math.max(12, spawnDistance) * MAX_BODY_ANGULAR_FRACTION + 1e-9,
      );
    }
    const star = bodies.star;
    expect(star).not.toBeNull();
    expect(star?.renderRadiusM).toBeCloseTo((star?.radiusKm ?? 0) * RENDER_METRES_PER_KM, 6);
  });

  it("places planets on distinct orbit rings around the star", () => {
    const bodies = computeSystemBodies(SEED, firstSystemId(SEED));
    const seen = new Set<string>();
    for (const planet of bodies.planets) {
      const offset = planetOrbitOffset(planet.orbitIndex, planet.orbitDistanceM);
      expect(Math.hypot(offset.x, offset.z)).toBeCloseTo(planet.orbitDistanceM, 6);
      seen.add(`${offset.x.toFixed(3)},${offset.z.toFixed(3)}`);
    }
    // Distinct (orbitIndex, angle) pairs → distinct positions.
    expect(seen.size).toBe(bodies.planets.length);
  });
});
