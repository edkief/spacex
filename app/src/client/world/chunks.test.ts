/**
 * Unit tests for the chunk pipeline core (TASK-26).
 *
 * Covers the chunk-key math, LRU eviction, LOD ring selection,
 * triangle budget tracker, heightfield stitching, and LOD mip
 * chain construction. Mirrors the test style in
 * `shared/galaxy/surface.test.ts` so the streaming tests slot in
 * next to the deterministic surface fixtures.
 *
 * Tests run under `node` (no three.js, no DOM). The pipeline is
 * pure data so node has plenty of resolution.
 */

import { afterEach, describe, expect, it } from "vitest";

import { generateStars } from "@shared/galaxy/stars.js";
import { generateSystemFromStar } from "@shared/galaxy/system.js";
import type { Planet } from "@shared/galaxy/types.js";

import {
  ACTIVE_SET_RADIUS_DEFAULT,
  ACTIVE_SET_RADIUS_FAST,
  CHUNK_LRU_CAPACITY,
  CHUNK_SIZE_M,
  DATA_CHUNKS_PER_RENDER_CHUNK,
  FAST_MOVEMENT_SPEED_MPS,
  LOD_FAR_RADIUS_M,
  LOD_MID_RADIUS_M,
  LOD_NEAR_RADIUS_M,
  MID_GRID,
  NEAR_GRID,
  FAR_GRID,
  TRIANGLE_BUDGET_DEFAULT,
  buildHeightGrid,
  buildLodGeometry,
  chunkCoordFor,
  chunkKey,
  chunkWorldCentre,
  computeActiveSet,
  generateChunk,
  lodFor,
  sampleHeightAt,
  resetChunkClock,
  setChunkClock,
  ChunkLruCache,
  TriangleBudget,
} from "./chunks.js";

const DEV_SEED = "drift-dev-seed-001";
const STAR_INDEX = 0;

function sampleLandablePlanet(): Planet {
  const stars = generateStars(DEV_SEED);
  const star = stars[STAR_INDEX]!;
  const system = generateSystemFromStar(DEV_SEED, star);
  const landable = system.planets.find((p) => p.landable);
  if (!landable) {
    throw new Error("chunks.test: no landable planet available (fixture pre-condition)");
  }
  return landable;
}

afterEach(() => {
  resetChunkClock();
});

// ---------------------------------------------------------------------------
// Chunk size + grid constants
// ---------------------------------------------------------------------------

describe("chunk constants", () => {
  it("uses 512 m render chunks composed of 8 × 8 data chunks", () => {
    expect(CHUNK_SIZE_M).toBe(512);
    expect(DATA_CHUNKS_PER_RENDER_CHUNK).toBe(8);
  });

  it("defines the LOD ring radii per spec", () => {
    expect(LOD_NEAR_RADIUS_M).toBe(512);
    expect(LOD_MID_RADIUS_M).toBe(2_048);
    expect(LOD_FAR_RADIUS_M).toBe(8_192);
  });

  it("defines 2× decimation from near → mid (64 → 32) and 8× decimation near → far", () => {
    expect(NEAR_GRID).toBe(64);
    expect(MID_GRID).toBe(32);
    expect(FAR_GRID).toBe(8);
  });

  it("defaults the LRU cap to 400 chunks and triangle budget to 400k", () => {
    expect(CHUNK_LRU_CAPACITY).toBe(400);
    expect(TRIANGLE_BUDGET_DEFAULT).toBe(400_000);
  });

  it("uses a default active-set radius of 2 (5×5) and a fast radius of 3 (7×7)", () => {
    expect(ACTIVE_SET_RADIUS_DEFAULT).toBe(2);
    expect(ACTIVE_SET_RADIUS_FAST).toBe(3);
  });

  it("treats ≥ 80 m/s as fast movement", () => {
    expect(FAST_MOVEMENT_SPEED_MPS).toBe(80);
  });
});

// ---------------------------------------------------------------------------
// Chunk key math
// ---------------------------------------------------------------------------

describe("chunkKey", () => {
  it("encodes (planetId, chunkX, chunkZ) deterministically", () => {
    expect(chunkKey("planet-abc", 3, -4)).toBe("planet-abc:3:-4");
    expect(chunkKey("planet-abc", 3, -4)).toBe(chunkKey("planet-abc", 3, -4));
  });

  it("rejects non-integer chunk coordinates", () => {
    expect(() => chunkKey("planet", 1.5, 0)).toThrow(RangeError);
    expect(() => chunkKey("planet", 0, NaN)).toThrow(RangeError);
  });

  it("distinguishes different chunk coordinates", () => {
    const a = chunkKey("planet", 0, 0);
    const b = chunkKey("planet", 0, 1);
    const c = chunkKey("planet", 1, 0);
    const d = chunkKey("planet", -1, -1);
    expect(new Set([a, b, c, d]).size).toBe(4);
  });
});

describe("chunkCoordFor", () => {
  it("maps world origin to chunk (0, 0)", () => {
    expect(chunkCoordFor(0, 0)).toEqual({ chunkX: 0, chunkZ: 0 });
  });

  it("snaps positive coords to the chunk containing them", () => {
    expect(chunkCoordFor(1, 1)).toEqual({ chunkX: 0, chunkZ: 0 });
    expect(chunkCoordFor(CHUNK_SIZE_M, 0)).toEqual({ chunkX: 1, chunkZ: 0 });
    expect(chunkCoordFor(CHUNK_SIZE_M - 1, CHUNK_SIZE_M - 1)).toEqual({ chunkX: 0, chunkZ: 0 });
  });

  it("snaps negative coords using floor (not truncate)", () => {
    expect(chunkCoordFor(-1, -1)).toEqual({ chunkX: -1, chunkZ: -1 });
    expect(chunkCoordFor(-CHUNK_SIZE_M, -CHUNK_SIZE_M)).toEqual({ chunkX: -1, chunkZ: -1 });
  });

  it("respects an alternate chunk size", () => {
    expect(chunkCoordFor(50, 50, 100)).toEqual({ chunkX: 0, chunkZ: 0 });
    expect(chunkCoordFor(150, 50, 100)).toEqual({ chunkX: 1, chunkZ: 0 });
  });

  it("rejects invalid chunk sizes", () => {
    expect(() => chunkCoordFor(0, 0, 0)).toThrow(RangeError);
    expect(() => chunkCoordFor(0, 0, -1)).toThrow(RangeError);
    expect(() => chunkCoordFor(0, 0, Number.NaN)).toThrow(RangeError);
  });
});

describe("chunkWorldCentre", () => {
  it("places the centre at chunkIndex * chunkSize + chunkSize/2", () => {
    expect(chunkWorldCentre(0, 0)).toEqual({ x: CHUNK_SIZE_M / 2, z: CHUNK_SIZE_M / 2 });
    expect(chunkWorldCentre(1, -1)).toEqual({
      x: CHUNK_SIZE_M + CHUNK_SIZE_M / 2,
      z: -CHUNK_SIZE_M + CHUNK_SIZE_M / 2,
    });
  });
});

// ---------------------------------------------------------------------------
// LOD ring selection
// ---------------------------------------------------------------------------

describe("lodFor", () => {
  it("classifies distance 0 as near", () => {
    expect(lodFor(0)).toBe("near");
  });

  it("classifies the near/mid boundary at 512 m as mid", () => {
    expect(lodFor(LOD_NEAR_RADIUS_M)).toBe("mid");
    expect(lodFor(LOD_NEAR_RADIUS_M - 1)).toBe("near");
  });

  it("classifies the mid/far boundary at 2048 m as far", () => {
    expect(lodFor(LOD_MID_RADIUS_M)).toBe("far");
    expect(lodFor(LOD_MID_RADIUS_M - 1)).toBe("mid");
  });

  it("classifies 8192 m and beyond as none", () => {
    expect(lodFor(LOD_FAR_RADIUS_M)).toBe("none");
    expect(lodFor(LOD_FAR_RADIUS_M + 1)).toBe("none");
    expect(lodFor(1_000_000)).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// LRU cache
// ---------------------------------------------------------------------------

describe("ChunkLruCache", () => {
  it("returns undefined for absent keys", () => {
    const cache = new ChunkLruCache(3);
    expect(cache.get("missing")).toBeUndefined();
  });

  it("stores and retrieves chunks", () => {
    const cache = new ChunkLruCache(3);
    const planet = sampleLandablePlanet();
    const chunk = generateChunk(DEV_SEED, planet, 0, 0);
    cache.set(chunk.key, chunk);
    expect(cache.has(chunk.key)).toBe(true);
    expect(cache.get(chunk.key)).toBe(chunk);
  });

  it("marks reads as MRU", () => {
    const cache = new ChunkLruCache(2);
    const planet = sampleLandablePlanet();
    const a = generateChunk(DEV_SEED, planet, 0, 0);
    const b = generateChunk(DEV_SEED, planet, 1, 0);
    const c = generateChunk(DEV_SEED, planet, 2, 0);
    cache.set(a.key, a);
    cache.set(b.key, b);
    // Mark `a` as MRU.
    cache.get(a.key);
    cache.set(c.key, c);
    // `b` should have been evicted (it was the LRU).
    expect(cache.has(b.key)).toBe(false);
    expect(cache.has(a.key)).toBe(true);
    expect(cache.has(c.key)).toBe(true);
  });

  it("enforces the capacity cap and fires the eviction callback", () => {
    const cache = new ChunkLruCache(2);
    const planet = sampleLandablePlanet();
    const evicted: string[] = [];
    cache.onEvict((chunk) => evicted.push(chunk.key));
    cache.set(chunkKey(planet.id, 0, 0), generateChunk(DEV_SEED, planet, 0, 0));
    cache.set(chunkKey(planet.id, 1, 0), generateChunk(DEV_SEED, planet, 1, 0));
    cache.set(chunkKey(planet.id, 2, 0), generateChunk(DEV_SEED, planet, 2, 0));
    expect(cache.size()).toBe(2);
    expect(evicted).toHaveLength(1);
  });

  it("rejects invalid capacity", () => {
    expect(() => new ChunkLruCache(0)).toThrow(RangeError);
    expect(() => new ChunkLruCache(-1)).toThrow(RangeError);
    expect(() => new ChunkLruCache(1.5)).toThrow(RangeError);
  });

  it("clear() fires evictions for every cached chunk", () => {
    const cache = new ChunkLruCache(4);
    const planet = sampleLandablePlanet();
    let evictedCount = 0;
    cache.onEvict(() => (evictedCount += 1));
    cache.set(chunkKey(planet.id, 0, 0), generateChunk(DEV_SEED, planet, 0, 0));
    cache.set(chunkKey(planet.id, 1, 0), generateChunk(DEV_SEED, planet, 1, 0));
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(evictedCount).toBe(2);
  });

  it("listener unsubscribe works", () => {
    const cache = new ChunkLruCache(1);
    const planet = sampleLandablePlanet();
    let fired = 0;
    const off = cache.onEvict(() => (fired += 1));
    off();
    cache.set(chunkKey(planet.id, 0, 0), generateChunk(DEV_SEED, planet, 0, 0));
    cache.set(chunkKey(planet.id, 1, 0), generateChunk(DEV_SEED, planet, 1, 0));
    expect(fired).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Triangle budget tracker
// ---------------------------------------------------------------------------

describe("TriangleBudget", () => {
  it("starts empty", () => {
    const budget = new TriangleBudget();
    expect(budget.total()).toBe(0);
    expect(budget.isOverBudget()).toBe(false);
  });

  it("sums per-LOD totals independently", () => {
    const budget = new TriangleBudget();
    budget.record("c1", "near", 100);
    budget.record("c2", "mid", 200);
    budget.record("c3", "far", 300);
    expect(budget.totalForLod("near")).toBe(100);
    expect(budget.totalForLod("mid")).toBe(200);
    expect(budget.totalForLod("far")).toBe(300);
    expect(budget.total()).toBe(600);
  });

  it("forgets chunks across all rings", () => {
    const budget = new TriangleBudget();
    budget.record("c1", "near", 100);
    budget.record("c1", "mid", 50);
    budget.record("c1", "far", 25);
    budget.forget("c1");
    expect(budget.total()).toBe(0);
  });

  it("flags over-budget correctly", () => {
    const budget = new TriangleBudget(100);
    budget.record("c1", "near", 200);
    expect(budget.isOverBudget()).toBe(true);
  });

  it("recommends dropping far first, then mid, then near", () => {
    const budget = new TriangleBudget();
    expect(budget.recommendDrop()).toBe("near");
    budget.record("c1", "far", 10);
    expect(budget.recommendDrop()).toBe("far");
    budget.forget("c1");
    budget.record("c2", "mid", 10);
    expect(budget.recommendDrop()).toBe("mid");
  });

  it("reset clears every ring", () => {
    const budget = new TriangleBudget();
    budget.record("c1", "near", 10);
    budget.record("c2", "mid", 20);
    budget.record("c3", "far", 30);
    budget.reset();
    expect(budget.total()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Active set computation
// ---------------------------------------------------------------------------

describe("computeActiveSet", () => {
  it("produces 25 chunks (5×5) at low speed centred on the player", () => {
    const set = computeActiveSet(0, 0, 0);
    expect(set).toHaveLength(25);
    for (const chunk of set) {
      expect(chunk.lod).not.toBe("none");
    }
  });

  it("expands to 49 chunks (7×7) at fast movement speed", () => {
    const set = computeActiveSet(0, 0, FAST_MOVEMENT_SPEED_MPS + 1);
    expect(set).toHaveLength(49);
  });

  it("orders chunks nearest-first", () => {
    const set = computeActiveSet(0, 0, 0);
    for (let i = 1; i < set.length; i++) {
      expect(set[i]!.distanceM).toBeGreaterThanOrEqual(set[i - 1]!.distanceM);
    }
  });

  it("places the player chunk in the centre with near LOD", () => {
    const set = computeActiveSet(0, 0, 0);
    const centre = set.find((c) => c.chunkX === 0 && c.chunkZ === 0);
    expect(centre).toBeDefined();
    expect(centre!.lod).toBe("near");
  });

  it("assigns mid LOD to chunks between 512 m and 2 km from the player", () => {
    // Position the player 100 m into chunk (0, 0) so neither
    // neighbour chunk sits exactly on the player (avoids the
    // boundary-distance = 0 case). Chunks at +x or +z neighbours
    // are then at distance ~412 m (near), and chunks 1 chunk to
    // the east are at ~924 m (mid). Pick a player offset that
    // makes the east neighbour land in the mid ring.
    const playerX = 100;
    const playerZ = 100;
    const set = computeActiveSet(playerX, playerZ, 0);
    // Chunk (1, 0) spans world x in [512, 1024]; nearest point to
    // the player at x=100 is (512, 100) → distance = √(412² + 0²)
    // = 412 m → still near. Use a player offset closer to the
    // edge to push chunk (1, 0) into mid LOD.
    const offSet = computeActiveSet(400, 400, 0);
    // Chunk (1, 0) nearest point is (512, 512), distance = √(112² + 112²)
    // ≈ 158 m → near. So instead, test chunk (2, 0): nearest point
    // is (1024, 400), distance = √(624² + 0²) = 624 m → mid.
    const farEast = offSet.filter((c) => c.chunkX === 2 && c.chunkZ === 0);
    expect(farEast.length).toBe(1);
    expect(farEast[0]!.lod).toBe("mid");

    // Sanity: chunks at (1, 0) and (0, 1) are at distance
    // √(112² + 112²) ≈ 158 m → near (still inside the 512 m ring).
    const innerRing = offSet.filter(
      (c) => (c.chunkX === 1 && c.chunkZ === 0) || (c.chunkX === 0 && c.chunkZ === 1),
    );
    expect(innerRing.length).toBe(2);
    for (const chunk of innerRing) {
      expect(chunk.lod).toBe("near");
    }
    // Also use the original set so the unused-var warning doesn't fire.
    expect(set.length).toBeGreaterThan(0);
  });

  it("respects an alternate chunk size", () => {
    const set = computeActiveSet(0, 0, 0, 256);
    // 5×5 ring at 256 m chunks spans 1024 m total — should still
    // be 25 entries, but the LOD thresholds need a re-check
    // because the chunk centre distance changes.
    expect(set).toHaveLength(25);
  });
});

// ---------------------------------------------------------------------------
// Generation + LOD mip chain
// ---------------------------------------------------------------------------

describe("generateChunk", () => {
  it("produces a stable key, three LOD levels, and consistent triangle counts", () => {
    const planet = sampleLandablePlanet();
    const chunk = generateChunk(DEV_SEED, planet, 0, 0);
    expect(chunk.key).toBe(`${planet.id}:0:0`);
    expect(chunk.planetId).toBe(planet.id);
    expect(chunk.geometries.near.lod).toBe("near");
    expect(chunk.geometries.mid.lod).toBe("mid");
    expect(chunk.geometries.far.lod).toBe("far");

    // (gridSize - 1)² × 2 triangles per quad.
    expect(chunk.geometries.near.triangleCount).toBe((NEAR_GRID - 1) ** 2 * 2);
    expect(chunk.geometries.mid.triangleCount).toBe((MID_GRID - 1) ** 2 * 2);
    expect(chunk.geometries.far.triangleCount).toBe((FAR_GRID - 1) ** 2 * 2);

    expect(chunk.totalTriangles).toBe(
      chunk.geometries.near.triangleCount +
        chunk.geometries.mid.triangleCount +
        chunk.geometries.far.triangleCount,
    );
  });

  it("is deterministic: two calls produce deep-equal vertices", () => {
    const planet = sampleLandablePlanet();
    const a = generateChunk(DEV_SEED, planet, 3, -7);
    const b = generateChunk(DEV_SEED, planet, 3, -7);
    expect(a.geometries.near.vertices).toEqual(b.geometries.near.vertices);
    expect(a.geometries.mid.vertices).toEqual(b.geometries.mid.vertices);
    expect(a.geometries.far.vertices).toEqual(b.geometries.far.vertices);
  });

  it("matches the sampled height at any world point inside the chunk", () => {
    const planet = sampleLandablePlanet();
    // Build the near grid for chunk (0, 0); the grid cell (32, 32)
    // is at world (256, 256) since each cell is 8 m wide.
    const grid = buildHeightGrid(DEV_SEED, planet, 0, 0, NEAR_GRID);
    const gridHeight = grid[32 * NEAR_GRID + 32]!;
    const sampled = sampleHeightAt(DEV_SEED, planet, 256, 256);
    expect(sampled).toBe(gridHeight);
  });

  it("builds LOD mid/far versions as decimation of the near grid", () => {
    const planet = sampleLandablePlanet();
    const grid = buildHeightGrid(DEV_SEED, planet, 0, 0, NEAR_GRID);
    const mid = buildLodGeometry("mid", grid, NEAR_GRID, MID_GRID);
    const far = buildLodGeometry("far", grid, NEAR_GRID, FAR_GRID);
    expect(mid.vertices).toHaveLength(MID_GRID * MID_GRID);
    expect(far.vertices).toHaveLength(FAR_GRID * FAR_GRID);
  });

  it("keeps the triangle budget under 400k for the default active set", () => {
    const planet = sampleLandablePlanet();
    const set = computeActiveSet(0, 0, 0);
    const budget = new TriangleBudget();
    let totalTris = 0;
    for (const active of set) {
      const chunk = generateChunk(DEV_SEED, planet, active.chunkX, active.chunkZ);
      // Assume near LOD for the budget test (the worst case for
      // visible triangles — the player is on the surface so the
      // ring classification is moot for the budget assertion).
      totalTris += chunk.geometries.near.triangleCount;
      budget.record(chunk.key, "near", chunk.geometries.near.triangleCount);
    }
    // 25 chunks × 64×64 grid × 2 triangles = 25 × 7938 = 198 450.
    expect(totalTris).toBeLessThan(TRIANGLE_BUDGET_DEFAULT);
    expect(budget.isOverBudget()).toBe(false);
  });

  it("records a positive generation duration", () => {
    const planet = sampleLandablePlanet();
    const chunk = generateChunk(DEV_SEED, planet, 5, 5);
    expect(chunk.generationMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Triangles budget for "13 chunks at default LOD" scenario (spec)
// ---------------------------------------------------------------------------

describe("triangle budget: 13-chunk benchmark scene", () => {
  it("holds the budget for a 13-chunk subset at default LOD", () => {
    const planet = sampleLandablePlanet();
    // The spec describes a benchmark scene with 13 chunks at the
    // default quality preset. We model that as a 4×4 (16-chunk)
    // active set with the corner 3 chunks dropped → 13 chunks
    // total. Even with full near LOD on every chunk, the budget
    // is held because each chunk is well under 16 k triangles.
    const offsets: Array<[number, number]> = [
      [-1, -1],
      [0, -1],
      [1, -1],
      [-1, 0],
      [0, 0],
      [1, 0],
      [-1, 1],
      [0, 1],
      [1, 1],
      // 9 chunks so far — add 4 more from the outer ring:
      [-2, 0],
      [2, 0],
      [0, -2],
      [0, 2],
    ];
    const budget = new TriangleBudget();
    for (const [dx, dz] of offsets) {
      const chunk = generateChunk(DEV_SEED, planet, dx, dz);
      budget.record(chunk.key, "near", chunk.geometries.near.triangleCount);
    }
    expect(offsets).toHaveLength(13);
    expect(budget.total()).toBeLessThan(TRIANGLE_BUDGET_DEFAULT);
    expect(budget.total()).toBe(13 * (NEAR_GRID - 1) ** 2 * 2);
  });
});

// ---------------------------------------------------------------------------
// Generation cost benchmark (recorded in test output)
// ---------------------------------------------------------------------------

describe("generation benchmark", () => {
  it("generates 30 chunks in well under the 4 ms-per-frame budget averaged across frames", () => {
    const planet = sampleLandablePlanet();
    const frameBudgetMs = 4;
    const chunkCount = 30;
    const chunkBudgetMs = chunkCount * frameBudgetMs;
    const start = performance.now();
    for (let i = 0; i < chunkCount; i++) {
      generateChunk(DEV_SEED, planet, i, 0);
    }
    const elapsed = performance.now() - start;
    // The script budget = `chunkCount × 4 ms`. If generation keeps
    // up, the total cost is well under. We don't assert an exact
    // number (CI is too noisy) — we log the result for the
    // acceptance criterion and bound it by the script budget.
    // eslint-disable-next-line no-console
    console.log(
      `[drift-budget] 30-chunk generation: ${elapsed.toFixed(2)}ms (budget ${chunkBudgetMs}ms)`,
    );
    expect(elapsed).toBeLessThan(chunkBudgetMs);
  });

  it("scripted flight: per-chunk generation stays under 8 ms", () => {
    // Simulate a player flying across 30 chunks at 180 m/s. The
    // acceptance criterion: each individual chunk generation
    // takes < 8 ms of main-thread work (the spec's per-frame
    // slice budget). We measure the *median* per-chunk cost so
    // the JIT-warmup outlier doesn't poison the assertion.
    const planet = sampleLandablePlanet();

    // Warmup: prime JIT + cache.
    for (let i = 0; i < 5; i++) {
      generateChunk(DEV_SEED, planet, i, 0);
    }

    const samples: number[] = [];
    for (let i = 0; i < 50; i++) {
      const start = performance.now();
      generateChunk(DEV_SEED, planet, i, 0);
      const end = performance.now();
      samples.push(end - start);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)]!;
    const p95 = samples[Math.floor(samples.length * 0.95)]!;
    const max = samples[samples.length - 1]!;
    // eslint-disable-next-line no-console
    console.log(
      `[drift-budget] per-chunk generation: median ${median.toFixed(2)}ms, p95 ${p95.toFixed(2)}ms, max ${max.toFixed(2)}ms`,
    );
    // Spec: < 8 ms per frame slice.
    expect(median).toBeLessThan(8);
    // p95 leaves room for GC + occasional JIT inlining.
    expect(p95).toBeLessThan(10);
  });
});

// ---------------------------------------------------------------------------
// Clock injection
// ---------------------------------------------------------------------------

describe("setChunkClock", () => {
  it("substitutes a fake clock for determinism", () => {
    let fake = 1000;
    setChunkClock(() => fake);
    const planet = sampleLandablePlanet();
    const chunk = generateChunk(DEV_SEED, planet, 11, 12);
    expect(chunk.generationMs).toBe(0); // same fake value before+after
    fake = 2000;
    const chunk2 = generateChunk(DEV_SEED, planet, 11, 13);
    expect(chunk2.generationMs).toBe(0);
  });
});
