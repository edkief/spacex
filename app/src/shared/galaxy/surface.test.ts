/**
 * Unit tests for `shared/galaxy/surface` — the deterministic surface
 * chunk generator.
 *
 * Sibling files exercise the rest of the suite:
 *   - `surface.boundary.test.ts` — boundary continuity + biome
 *                                 distribution + heightmap stats.
 *   - `surface.parity.test.ts`   — golden snapshot regeneration under
 *                                 happy-dom + source purity.
 *
 * Coverage here:
 *   - `generateSurfaceChunk` shape (chunkX, chunkZ, 64×64 heightmap,
 *     valid biome, node + pad arrays).
 *   - Resource node shape (id format, type ∈ planet.resourceTypes,
 *     baseQuantity in [50, 200], positions in chunk bounds).
 *   - Landing-pad rules (chunk (0,0) of a landable planet always has
 *     exactly 1 pad; non-landable planets never have pads).
 *   - Determinism (two independent calls deeply equal; 30 random
 *     chunks across 3 planets produce stable JSON).
 *
 * @see ./surface.ts for the generator under test.
 */

import { describe, it, expect } from "vitest";

import { ALL_BIOMES, generateSurfaceChunk, type SurfaceChunk } from "./surface.js";
import type { Planet, Star } from "./types.js";
import { generateStars } from "./stars.js";
import { generateSystemFromStar } from "./system.js";
import {
  CELLS_PER_CHUNK,
  CHUNK_SIZE_CELLS,
  MAX_NODES_PER_CHUNK,
  MIN_NODES_PER_CHUNK,
  MIN_NODE_QUANTITY,
  PAD_PROBABILITY,
  PEAK_HEIGHT_M,
} from "./config-surface.js";
import { FIXTURE_CHUNK_X, FIXTURE_CHUNK_Z, sampleLandablePlanet } from "./surface.helpers.js";
import { DEV_SEED } from "./surface.helpers.js";

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

/** Returns the dev seed's first planet (orbit 0 — rocky, landable). */
function sampleFirstPlanet(): Planet {
  const stars = generateStars(DEV_SEED);
  const star = stars[0] as Star;
  const sys = generateSystemFromStar(DEV_SEED, star);
  return sys.planets[0] as Planet;
}

/** Returns the *first* landable planet — used for tests that need a guaranteed-pad chunk. */
function sampleLandableDevPlanet(): Planet {
  return sampleLandablePlanet();
}

// ---------------------------------------------------------------------------
// generateSurfaceChunk — shape
// ---------------------------------------------------------------------------

describe("shared/galaxy/surface — generateSurfaceChunk shape", () => {
  it("returns the chunk coordinates we passed in", () => {
    const chunk = generateSurfaceChunk(DEV_SEED, sampleFirstPlanet(), 7, -3);
    expect(chunk.chunkX).toBe(7);
    expect(chunk.chunkZ).toBe(-3);
  });

  it("returns a 64×64 row-major heightmap of integer metres", () => {
    const chunk = generateSurfaceChunk(DEV_SEED, sampleFirstPlanet(), 0, 0);
    expect(chunk.heightmap).toHaveLength(CELLS_PER_CHUNK);
    for (let i = 0; i < chunk.heightmap.length; i++) {
      const h = chunk.heightmap[i] as number;
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(PEAK_HEIGHT_M);
    }
  });

  it("returns a valid biome", () => {
    const chunk = generateSurfaceChunk(DEV_SEED, sampleFirstPlanet(), 0, 0);
    expect(ALL_BIOMES).toContain(chunk.biome);
  });

  it("returns a resourceNodes array (possibly empty for wetlands or planets without resources)", () => {
    const chunk = generateSurfaceChunk(DEV_SEED, sampleFirstPlanet(), 0, 0);
    expect(Array.isArray(chunk.resourceNodes)).toBe(true);
  });

  it("returns a landingPads array (0 or 1 entries)", () => {
    const chunk = generateSurfaceChunk(DEV_SEED, sampleFirstPlanet(), 0, 0);
    expect(chunk.landingPads.length).toBeGreaterThanOrEqual(0);
    expect(chunk.landingPads.length).toBeLessThanOrEqual(1);
  });

  it("rejects non-integer chunk coordinates", () => {
    expect(() => generateSurfaceChunk(DEV_SEED, sampleFirstPlanet(), 1.5, 0)).toThrow(RangeError);
    expect(() => generateSurfaceChunk(DEV_SEED, sampleFirstPlanet(), 0, -2.5)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Resource nodes
// ---------------------------------------------------------------------------

describe("shared/galaxy/surface — resource nodes", () => {
  it("places 1..4 nodes per chunk (spec bound)", () => {
    // Sample many chunks on a landable planet; skip wetlands.
    const planet = sampleFirstPlanet();
    let sampledNonWetland = 0;
    for (let cz = 0; cz < 10 && sampledNonWetland < 5; cz++) {
      for (let cx = 0; cx < 10 && sampledNonWetland < 5; cx++) {
        const chunk = generateSurfaceChunk(DEV_SEED, planet, cx, cz);
        if (chunk.biome === "wetland") continue;
        sampledNonWetland++;
        expect(chunk.resourceNodes.length).toBeGreaterThanOrEqual(MIN_NODES_PER_CHUNK);
        expect(chunk.resourceNodes.length).toBeLessThanOrEqual(MAX_NODES_PER_CHUNK);
      }
    }
    expect(sampledNonWetland).toBeGreaterThan(0);
  });

  it("node types are restricted to the planet's resourceTypes", () => {
    const planet = sampleFirstPlanet();
    const allowed = new Set<string>(planet.resourceTypes);
    expect(allowed.size).toBeGreaterThan(0);
    for (let cx = 0; cx < 5; cx++) {
      for (let cz = 0; cz < 5; cz++) {
        const chunk = generateSurfaceChunk(DEV_SEED, planet, cx, cz);
        for (const node of chunk.resourceNodes) {
          expect(allowed.has(node.type)).toBe(true);
        }
      }
    }
  });

  it("node ids are 16-hex-char lowercase, unique within the chunk", () => {
    const planet = sampleFirstPlanet();
    const chunk = generateSurfaceChunk(DEV_SEED, planet, 0, 0);
    const ids = new Set<string>();
    for (const node of chunk.resourceNodes) {
      expect(node.nodeId).toMatch(/^[0-9a-f]{16}$/);
      expect(ids.has(node.nodeId)).toBe(false);
      ids.add(node.nodeId);
    }
  });

  it("node baseQuantity is in [50, 200]", () => {
    const planet = sampleFirstPlanet();
    let checked = 0;
    for (let cx = 0; cx < 5 && checked < 5; cx++) {
      for (let cz = 0; cz < 5 && checked < 5; cz++) {
        const chunk = generateSurfaceChunk(DEV_SEED, planet, cx, cz);
        for (const node of chunk.resourceNodes) {
          expect(node.baseQuantity).toBeGreaterThanOrEqual(MIN_NODE_QUANTITY);
          expect(node.baseQuantity).toBeLessThanOrEqual(200);
          checked++;
        }
      }
    }
  });

  it("node positions are in chunk bounds (0..63)", () => {
    const planet = sampleFirstPlanet();
    for (let cx = 0; cx < 5; cx++) {
      for (let cz = 0; cz < 5; cz++) {
        const chunk = generateSurfaceChunk(DEV_SEED, planet, cx, cz);
        for (const node of chunk.resourceNodes) {
          expect(node.x).toBeGreaterThanOrEqual(0);
          expect(node.x).toBeLessThan(CHUNK_SIZE_CELLS);
          expect(node.z).toBeGreaterThanOrEqual(0);
          expect(node.z).toBeLessThan(CHUNK_SIZE_CELLS);
        }
      }
    }
  });

  it("wetland chunks have no resource nodes (solid resources don't spawn in marshes)", () => {
    const planet = sampleFirstPlanet();
    for (let cx = 0; cx < 20; cx++) {
      for (let cz = 0; cz < 20; cz++) {
        const chunk = generateSurfaceChunk(DEV_SEED, planet, cx, cz);
        if (chunk.biome === "wetland") {
          expect(chunk.resourceNodes).toHaveLength(0);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Landing pads
// ---------------------------------------------------------------------------

describe("shared/galaxy/surface — landing pads", () => {
  it("chunk (0,0) of a landable planet has exactly 1 pad", () => {
    const planet = sampleLandableDevPlanet();
    expect(planet.landable).toBe(true);
    const chunk = generateSurfaceChunk(DEV_SEED, planet, FIXTURE_CHUNK_X, FIXTURE_CHUNK_Z);
    expect(chunk.landingPads).toHaveLength(1);
  });

  it("pad id is 16-hex-char lowercase", () => {
    const planet = sampleLandableDevPlanet();
    const chunk = generateSurfaceChunk(DEV_SEED, planet, 0, 0);
    for (const pad of chunk.landingPads) {
      expect(pad.id).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it("pad position is inside the chunk (0..64 in metres)", () => {
    const planet = sampleLandableDevPlanet();
    const chunk = generateSurfaceChunk(DEV_SEED, planet, 0, 0);
    for (const pad of chunk.landingPads) {
      expect(pad.x).toBeGreaterThanOrEqual(0);
      expect(pad.x).toBeLessThanOrEqual(CHUNK_SIZE_CELLS);
      expect(pad.z).toBeGreaterThanOrEqual(0);
      expect(pad.z).toBeLessThanOrEqual(CHUNK_SIZE_CELLS);
    }
  });

  it("non-landable planets never have pads (even in chunk (0,0))", () => {
    // Find a non-landable planet.
    const stars = generateStars(DEV_SEED);
    let nonLandable: Planet | null = null;
    for (const star of stars.slice(0, 50)) {
      const sys = generateSystemFromStar(DEV_SEED, star);
      for (const p of sys.planets) {
        if (!p.landable) {
          nonLandable = p;
          break;
        }
      }
      if (nonLandable) break;
    }
    expect(nonLandable).not.toBeNull();
    const planet = nonLandable as Planet;
    for (let cx = 0; cx < 5; cx++) {
      for (let cz = 0; cz < 5; cz++) {
        const chunk = generateSurfaceChunk(DEV_SEED, planet, cx, cz);
        expect(chunk.landingPads).toHaveLength(0);
      }
    }
  });

  it("other chunks of a landable planet have 0 or 1 pads (≤ PAD_PROBABILITY + slack)", () => {
    const planet = sampleLandableDevPlanet();
    let withPad = 0;
    let total = 0;
    for (let i = 1; i <= 100; i++) {
      const cx = i % 10;
      const cz = Math.floor(i / 10);
      const chunk = generateSurfaceChunk(DEV_SEED, planet, cx, cz);
      total++;
      if (chunk.landingPads.length === 1) withPad++;
      expect(chunk.landingPads.length).toBeLessThanOrEqual(1);
    }
    // Loose bound — actual ratio is near PAD_PROBABILITY; we just check
    // it's not absurd (e.g. 100% would indicate the test is broken).
    expect(withPad).toBeLessThan(total);
    expect(withPad).toBeLessThanOrEqual(Math.ceil(total * (PAD_PROBABILITY + 0.3)));
  });
});

// ---------------------------------------------------------------------------
// Determinism (large-scale stability loops live here so the boundary
// test file stays focused on noise behaviour)
// ---------------------------------------------------------------------------

describe("shared/galaxy/surface — determinism", () => {
  it("two independent calls produce deeply equal chunks", () => {
    const planet = sampleFirstPlanet();
    const a = generateSurfaceChunk(DEV_SEED, planet, 3, 4);
    const b = generateSurfaceChunk(DEV_SEED, planet, 3, 4);
    expect(a).toEqual(b);
  });

  it("different chunk coords produce different chunks (almost surely)", () => {
    const planet = sampleFirstPlanet();
    const a = generateSurfaceChunk(DEV_SEED, planet, 0, 0);
    const b = generateSurfaceChunk(DEV_SEED, planet, 5, 5);
    expect(a.heightmap).not.toEqual(b.heightmap);
  });

  it("30 random chunks across 3 planets produce stable JSON across two runs", () => {
    // Pick three landable planets (one per top-3 stars that have any landable).
    const stars = generateStars(DEV_SEED);
    const landables: Planet[] = [];
    for (const star of stars.slice(0, 30)) {
      const sys = generateSystemFromStar(DEV_SEED, star);
      for (const p of sys.planets) {
        if (p.landable) {
          landables.push(p);
          if (landables.length >= 3) break;
        }
      }
      if (landables.length >= 3) break;
    }
    expect(landables.length).toBeGreaterThanOrEqual(3);

    const fingerprints: string[] = [];
    for (let run = 0; run < 2; run++) {
      const digests: string[] = [];
      for (let i = 0; i < 30; i++) {
        const planet = landables[i % 3] as Planet;
        const cx = Math.floor(i / 7) - 5;
        const cz = ((i * 3) % 11) - 5;
        const chunk = generateSurfaceChunk(DEV_SEED, planet, cx, cz);
        digests.push(stableFingerprint(chunk));
      }
      fingerprints.push(digests.join("|"));
    }
    expect(fingerprints[0]).toBe(fingerprints[1]);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A compact, deterministic fingerprint of a SurfaceChunk for stability loops. */
function stableFingerprint(chunk: SurfaceChunk): string {
  const step = CHUNK_SIZE_CELLS / 4;
  const samples: number[] = [];
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) {
      samples.push(chunk.heightmap[j * step * CHUNK_SIZE_CELLS + i * step] as number);
    }
  }
  return JSON.stringify({
    chunkX: chunk.chunkX,
    chunkZ: chunk.chunkZ,
    biome: chunk.biome,
    samples,
    nodes: chunk.resourceNodes.map((n) => ({
      n: n.nodeId,
      t: n.type,
      x: n.x,
      z: n.z,
      q: n.baseQuantity,
    })),
    pads: chunk.landingPads.map((p) => ({ i: p.id, x: p.x, z: p.z })),
  });
}
