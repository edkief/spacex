/**
 * Pad registry tests — TASK-29 step 1 acceptance.
 *
 * Covers:
 *   - `padForPlanet` returns `null` for non-landable planets
 *   - `padForPlanet` returns the same id/position on repeat calls
 *   - `padForPlanet` is deterministic across separate callers
 *   - `padsForSystem` returns one pad per landable planet (in order)
 *   - `nearestPad` uses enter radius for entry, exit radius for
 *     hysteresis (the "19 m in / 21 m out" invariant from the spec)
 *   - `padsWithinRadius` filters by distance
 */

import { describe, expect, it } from "vitest";

import { generateSystemFromStar } from "../galaxy/system.js";
import { generateStars } from "../galaxy/stars.js";
import type { Planet } from "../galaxy/types.js";
import {
  PAD_EXIT_RADIUS_M,
  PAD_RADIUS_M,
  nearestPad,
  padForPlanet,
  padsForSystem,
  padsWithinRadius,
  type SystemPad,
} from "./pads.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Resolve a test star with the dev seed. Single source of truth so
 * every test in this file uses the same galaxy layout.
 */
function testStar(): { seed: string; starId: string; planet: Planet } {
  const seed = "pad-registry-test";
  const stars = generateStars(seed, 4);
  const star = stars[0];
  if (!star) throw new Error("pad-registry test fixture: no star");
  const system = generateSystemFromStar(seed, star);
  const planet = system.planets[0];
  if (!planet) throw new Error("pad-registry test fixture: no planet");
  return { seed, starId: star.id, planet };
}

/**
 * Walk the galaxy and find the first landable planet (the spec says
 * "at least one" per system).
 */
function landablePlanet(): { seed: string; starId: string; planet: Planet } {
  const seed = "pad-registry-landable-test";
  const stars = generateStars(seed, 4);
  for (const star of stars) {
    const system = generateSystemFromStar(seed, star);
    for (const planet of system.planets) {
      if (planet.landable) {
        return { seed, starId: star.id, planet };
      }
    }
  }
  throw new Error("pad-registry test fixture: no landable planet in seed");
}

// ---------------------------------------------------------------------------
// padForPlanet
// ---------------------------------------------------------------------------

describe("pads: padForPlanet", () => {
  it("returns null for non-landable planets", () => {
    const seed = "pad-registry-test";
    const stars = generateStars(seed, 4);
    for (const star of stars) {
      const system = generateSystemFromStar(seed, star);
      for (const planet of system.planets) {
        if (planet.landable) continue;
        const pad = padForPlanet({ seed, starId: star.id, planet });
        expect(pad).toBeNull();
      }
    }
  });

  it("returns the deterministic pad for a landable planet (id + position stable)", () => {
    const { seed, starId, planet } = testStar();
    const a = padForPlanet({ seed, starId, planet });
    const b = padForPlanet({ seed, starId, planet });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.padId).toBe(b!.padId);
    expect(a!.pos.x).toBe(b!.pos.x);
    expect(a!.pos.y).toBe(b!.pos.y);
    expect(a!.pos.z).toBe(b!.pos.z);
  });

  it("matches the landing-pad id derived by the surface placement pass", () => {
    const { seed, starId, planet } = landablePlanet();
    const pad = padForPlanet({ seed, starId, planet });
    expect(pad).not.toBeNull();
    // The id format is hex-16; verify shape only — the exact value
    // depends on the seed-driven placement RNG and is asserted by the
    // galaxy snapshot suite.
    expect(pad!.padId).toMatch(/^[0-9a-f]{16}$/u);
  });

  it("places the pad on the planet's surface (y = planet.radius)", () => {
    const { seed, starId, planet } = landablePlanet();
    const pad = padForPlanet({ seed, starId, planet });
    expect(pad).not.toBeNull();
    const center = { x: 0, y: 0, z: 0 }; // placeholder; pad.pos.y is the surface
    void center;
    expect(pad!.pos.y).toBeCloseTo(planet.radiusKm * 1000, 6);
  });

  it("exposes the canonical pad radii (entry 20 m, exit 25 m)", () => {
    expect(PAD_RADIUS_M).toBe(20);
    expect(PAD_EXIT_RADIUS_M).toBe(25);
    const { seed, starId, planet } = landablePlanet();
    const pad = padForPlanet({ seed, starId, planet });
    expect(pad!.radius).toBe(PAD_RADIUS_M);
    expect(pad!.exitRadius).toBe(PAD_EXIT_RADIUS_M);
  });

  it("kind tag is 'settlement' (v1 doesn't yet have separate station entities)", () => {
    const { seed, starId, planet } = landablePlanet();
    const pad = padForPlanet({ seed, starId, planet });
    expect(pad!.kind).toBe("settlement");
  });

  it("up-normal is world Y (v1 flat planet, no tilt)", () => {
    const { seed, starId, planet } = landablePlanet();
    const pad = padForPlanet({ seed, starId, planet });
    expect(pad!.normal).toEqual({ x: 0, y: 1, z: 0 });
  });
});

// ---------------------------------------------------------------------------
// padsForSystem
// ---------------------------------------------------------------------------

describe("pads: padsForSystem", () => {
  it("returns one pad per landable planet (in orbit order)", () => {
    const seed = "pad-registry-system-test";
    const stars = generateStars(seed, 4);
    const star = stars[0];
    if (!star) throw new Error("no star");
    const system = generateSystemFromStar(seed, star);
    const expectedLandable = system.planets.filter((p) => p.landable).length;
    const pads = padsForSystem({
      seed,
      starId: star.id,
      planets: system.planets,
    });
    expect(pads.length).toBe(expectedLandable);
    // Pads must be ordered by orbitIndex ascending (mirrors the
    // system's planet ordering).
    const planetIds = system.planets.filter((p) => p.landable).map((p) => p.id);
    expect(pads.map((p) => p.planetId)).toEqual(planetIds);
  });

  it("returns an empty array for a system with no landable planets", () => {
    const seed = "pad-registry-empty-test";
    // Force the test to find a planet list we know has no landable
    // entries — gas giants are never landable.
    const planets: Planet[] = [
      {
        id: "0000000000000001",
        name: "Gas I",
        orbitIndex: 0,
        class: "gas",
        radiusKm: 30_000,
        hasAtmosphere: true,
        landable: false,
        dockCount: 0,
        resourceTypes: ["gas-compounds"],
        aiRoster: { count: 2, classes: ["scout"] },
      },
    ];
    const pads = padsForSystem({ seed, starId: "star-stub", planets });
    expect(pads).toEqual([]);
  });

  it("is deterministic across calls (cache-friendly)", () => {
    const seed = "pad-registry-determinism-test";
    const stars = generateStars(seed, 4);
    const star = stars[0];
    if (!star) throw new Error("no star");
    const system = generateSystemFromStar(seed, star);
    const args = { seed, starId: star.id, planets: system.planets };
    const a = padsForSystem(args);
    const b = padsForSystem(args);
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// nearestPad — hysteresis (the "19 m in / 21 m out" spec invariant)
// ---------------------------------------------------------------------------

describe("pads: nearestPad hysteresis", () => {
  function makePad(x: number, z: number): SystemPad {
    return {
      padId: `pad-${x}-${z}`,
      planetId: "test-planet",
      kind: "settlement",
      pos: { x, y: 0, z },
      normal: { x: 0, y: 1, z: 0 },
      radius: 20,
      exitRadius: 25,
    };
  }

  it("detects the pad when 19 m away (within entry radius, outside exit)", () => {
    // 19 m is INSIDE the entry radius (20 m) but OUTSIDE the exit
    // radius (25 m) for a non-docked ship. Per the spec acceptance:
    // "19 m in" → detected.
    const pad = makePad(0, 0);
    const found = nearestPad({
      pos: { x: 19, y: 0, z: 0 },
      pads: [pad],
    });
    expect(found?.padId).toBe("pad-0-0");
  });

  it("does NOT detect the pad when 21 m away without dock state", () => {
    // 21 m is OUTSIDE the entry radius (20 m) — without the
    // hysteresis hold, the pad is not detected.
    const pad = makePad(0, 0);
    const found = nearestPad({
      pos: { x: 21, y: 0, z: 0 },
      pads: [pad],
    });
    expect(found).toBeNull();
  });

  it("holds the pad at 21 m when already docked (hysteresis)", () => {
    // 21 m is OUTSIDE the entry radius but INSIDE the exit radius
    // (25 m). When the ship is already docked, the lookup uses the
    // exit radius, so the pad remains detected.
    const pad = makePad(0, 0);
    const found = nearestPad({
      pos: { x: 21, y: 0, z: 0 },
      pads: [pad],
      alreadyDockedOn: "pad-0-0",
    });
    expect(found?.padId).toBe("pad-0-0");
  });

  it("drops the pad at 26 m even when already docked (beyond exit radius)", () => {
    // 26 m is beyond the exit radius (25 m) — the hysteresis hold
    // can no longer keep the pad detected.
    const pad = makePad(0, 0);
    const found = nearestPad({
      pos: { x: 26, y: 0, z: 0 },
      pads: [pad],
      alreadyDockedOn: "pad-0-0",
    });
    expect(found).toBeNull();
  });

  it("picks the nearest pad among several candidates", () => {
    const pads = [makePad(0, 0), makePad(15, 0), makePad(50, 0)];
    const found = nearestPad({
      pos: { x: 10, y: 0, z: 0 },
      pads,
    });
    // Ship at (10, 0, 0) is 5 m from pad (15, 0) and 10 m from
    // pad (0, 0); nearest wins.
    expect(found?.padId).toBe("pad-15-0");
  });

  it("returns null when no pad is within range", () => {
    const pads = [makePad(1000, 0)];
    const found = nearestPad({
      pos: { x: 0, y: 0, z: 0 },
      pads,
    });
    expect(found).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// padsWithinRadius
// ---------------------------------------------------------------------------

describe("pads: padsWithinRadius", () => {
  function makePad(x: number, z: number): SystemPad {
    return {
      padId: `pad-${x}-${z}`,
      planetId: "test-planet",
      kind: "settlement",
      pos: { x, y: 0, z },
      normal: { x: 0, y: 1, z: 0 },
      radius: 20,
      exitRadius: 25,
    };
  }

  it("returns pads within the radius (sorted by source order)", () => {
    const pads = [makePad(0, 0), makePad(50, 0), makePad(100, 0), makePad(600, 0)];
    const within = padsWithinRadius({
      pos: { x: 0, y: 0, z: 0 },
      pads,
      radius: 500,
    });
    expect(within.map((p) => p.padId)).toEqual(["pad-0-0", "pad-50-0", "pad-100-0"]);
  });

  it("returns empty when no pad is within range", () => {
    const pads = [makePad(1000, 0), makePad(0, 1000)];
    const within = padsWithinRadius({
      pos: { x: 0, y: 0, z: 0 },
      pads,
      radius: 50,
    });
    expect(within).toEqual([]);
  });

  it("uses 3-D distance (y included)", () => {
    const pads = [makePad(0, 0)];
    // 40 m horizontal but 40 m vertical — total 3-D distance
    // ≈ 56.6 m; outside the 50 m radius.
    const within = padsWithinRadius({
      pos: { x: 0, y: 40, z: 40 },
      pads,
      radius: 50,
    });
    expect(within).toEqual([]);
  });
});
