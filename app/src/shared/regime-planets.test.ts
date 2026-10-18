/**
 * Tests for the deterministic planet world-position resolver — TASK-25.
 *
 * Covers the spec checklist for the regime manager's planet layout:
 *
 *   - Same `(seed, starId, orbitIndex)` always yields the same
 *     `{ x, y, z }` (deterministic).
 *   - Layout is collision-free: adjacent orbits sit far enough apart
 *     that one planet's atmosphere doesn't bleed into its neighbour.
 *   - `regimePlanetContexts` builds the same shape the sim tick
 *     needs (id, center, radius, hasAtmosphere, heightAt,
 *     atmosphereHeight).
 */

import { describe, expect, it } from "vitest";

import {
  PLANET_ORBIT_BASE_M,
  PLANET_ORBIT_STEP_M,
  planetWorldPosition,
  regimePlanetContexts,
} from "./regime-planets.js";
import type { Planet } from "./galaxy/types.js";

describe("regime-planets: constants", () => {
  it("orbit base is 100 Mm", () => {
    expect(PLANET_ORBIT_BASE_M).toBe(100_000_000);
  });

  it("orbit step is 50 Mm", () => {
    expect(PLANET_ORBIT_STEP_M).toBe(50_000_000);
  });
});

describe("regime-planets: world position resolver", () => {
  it("returns the same position for identical inputs", () => {
    const a = planetWorldPosition("seed-A", "star-1", 0);
    const b = planetWorldPosition("seed-A", "star-1", 0);
    expect(a).toEqual(b);
  });

  it("returns different positions for different seeds", () => {
    const a = planetWorldPosition("seed-A", "star-1", 0);
    const b = planetWorldPosition("seed-B", "star-1", 0);
    expect(a.x === b.x && a.y === b.y && a.z === b.z).toBe(false);
  });

  it("returns different positions for different star ids", () => {
    const a = planetWorldPosition("seed-A", "star-1", 0);
    const b = planetWorldPosition("seed-A", "star-2", 0);
    expect(a.x === b.x && a.y === b.y && a.z === b.z).toBe(false);
  });

  it("places each orbit at increasing radius", () => {
    const r = (i: number) => {
      const p = planetWorldPosition("seed-A", "star-1", i);
      return Math.sqrt(p.x * p.x + p.z * p.z);
    };
    expect(r(0)).toBeGreaterThan(0);
    expect(r(1)).toBeGreaterThan(r(0));
    expect(r(2)).toBeGreaterThan(r(1));
    // Distance between consecutive orbits matches the step (modulo
    // tiny jitter from the RNG angle adjustment).
    const step = r(1) - r(0);
    expect(step).toBeCloseTo(PLANET_ORBIT_STEP_M, -2);
  });

  it("y is always 0 (planar layout for v1)", () => {
    for (let i = 0; i < 6; i++) {
      const p = planetWorldPosition("seed-A", "star-1", i);
      expect(p.y).toBe(0);
    }
  });

  it("rejects negative orbit indices", () => {
    expect(() => planetWorldPosition("seed-A", "star-1", -1)).toThrow();
  });

  it("rejects non-integer orbit indices", () => {
    expect(() => planetWorldPosition("seed-A", "star-1", 1.5)).toThrow();
  });
});

describe("regime-planets: contexts", () => {
  function planet(orbitIndex: number, overrides: Partial<Planet> = {}): Planet {
    return {
      id: `p${orbitIndex}`,
      name: `Planet ${orbitIndex}`,
      orbitIndex,
      class: "rocky",
      radiusKm: 6_000,
      hasAtmosphere: true,
      landable: true,
      dockCount: 1,
      resourceTypes: ["iron"],
      aiRoster: { count: 1, classes: ["scout"] },
      ...overrides,
    };
  }

  it("builds one context per planet", () => {
    const planets = [planet(0), planet(1), planet(2)];
    const ctx = regimePlanetContexts({
      seed: "seed-A",
      starId: "star-1",
      planets,
    });
    expect(ctx.length).toBe(3);
    expect(ctx[0].id).toBe("p0");
    expect(ctx[1].id).toBe("p1");
    expect(ctx[2].id).toBe("p2");
  });

  it("carries the radius in metres (km * 1000)", () => {
    const planets = [planet(0, { radiusKm: 6_500 })];
    const ctx = regimePlanetContexts({
      seed: "seed-A",
      starId: "star-1",
      planets,
    });
    expect(ctx[0].radius).toBe(6_500_000);
  });

  it("propagates hasAtmosphere", () => {
    const planets = [planet(0, { hasAtmosphere: true }), planet(1, { hasAtmosphere: false })];
    const ctx = regimePlanetContexts({
      seed: "seed-A",
      starId: "star-1",
      planets,
    });
    expect(ctx[0].hasAtmosphere).toBe(true);
    expect(ctx[1].hasAtmosphere).toBe(false);
  });

  it("uses a flat heightAt by default (returns 0 everywhere)", () => {
    const planets = [planet(0)];
    const ctx = regimePlanetContexts({
      seed: "seed-A",
      starId: "star-1",
      planets,
    });
    expect(ctx[0].heightAt(0, 0)).toBe(0);
    expect(ctx[0].heightAt(50, 50)).toBe(0);
  });

  it("uses the caller-supplied heightAt when provided", () => {
    const planets = [planet(0)];
    const ctx = regimePlanetContexts({
      seed: "seed-A",
      starId: "star-1",
      planets,
      heightAtFor: (id) => (id === "p0" ? () => 5 : () => 0),
    });
    expect(ctx[0].heightAt(0, 0)).toBe(5);
  });

  it("returns an empty list for an empty planet array", () => {
    expect(
      regimePlanetContexts({
        seed: "seed-A",
        starId: "star-1",
        planets: [],
      }),
    ).toEqual([]);
  });

  it("uses the default 10 km atmosphere height", () => {
    const planets = [planet(0)];
    const ctx = regimePlanetContexts({
      seed: "seed-A",
      starId: "star-1",
      planets,
    });
    expect(ctx[0].atmosphereHeight).toBe(10_000);
  });
});
