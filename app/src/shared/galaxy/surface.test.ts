import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@shared/canonical.ts';
import { PROBE_GRID_SIZE, PROBE_GRID_SPACING_M } from '@shared/galaxy/placement.ts';
import { generateSurfaceChunk } from '@shared/galaxy/surface.ts';
import {
  CHUNK_SAMPLES,
  CHUNK_SIZE_M,
  MAX_CHUNK_COORD,
  MAX_HEIGHT_UNITS,
  SAMPLE_STEP_M,
  createSurfaceField,
  samplePosition,
  surfaceHeightAt,
} from '@shared/galaxy/terrain.ts';
import { Rng, seedFromString } from '@shared/random.ts';
import { firstPlanet, planetsOfClass } from '@tests/support/galaxy.ts';
import { sha256Hex } from '@tests/support/checksum.ts';

const SEED = 'drift-dev-seed-001';
const { planet } = firstPlanet(SEED, (p) => p.landable);
const gas = firstPlanet(SEED, (p) => p.class === 'gas').planet;
const hashOf = (value: unknown): string => sha256Hex(canonicalJson(value));
/** Squared distance between two points on the surface plane. */
const squaredDistance = (a: { x: number; z: number }, b: { x: number; z: number }): number =>
  (a.x - b.x) * (a.x - b.x) + (a.z - b.z) * (a.z - b.z);
const at = (heightmap: number[], i: number, j: number): number =>
  heightmap[j * CHUNK_SAMPLES + i] as number;

describe('generateSurfaceChunk shape', () => {
  const chunk = generateSurfaceChunk(SEED, planet, 0, 0);

  it('has a 64x64 integer heightmap inside the Uint16 range', () => {
    expect(chunk.heightmap).toHaveLength(CHUNK_SAMPLES * CHUNK_SAMPLES);
    for (const value of chunk.heightmap) {
      expect(Number.isInteger(value) && value >= 0 && value <= MAX_HEIGHT_UNITS).toBe(true);
    }
  });

  it('echoes its coordinates and a valid biome', () => {
    expect([chunk.chunkX, chunk.chunkZ]).toEqual([0, 0]);
    expect(['plains', 'rock', 'canyon', 'frozen', 'wetland']).toContain(chunk.biome);
  });

  it('always places exactly one pad in chunk (0,0) of a landable planet', () => {
    expect(chunk.landingPads).toHaveLength(1);
    for (const p of planetsOfClass(SEED, 'terran', 8).filter((candidate) => candidate.landable)) {
      expect(generateSurfaceChunk(SEED, p, 0, 0).landingPads).toHaveLength(1);
    }
  });

  it('places no pads on a non-landable surface', () => {
    const rocky = planetsOfClass(SEED, 'rocky', 30).find((p) => !p.landable);
    if (!rocky) return;
    for (let cx = 0; cx < 5; cx++) {
      expect(generateSurfaceChunk(SEED, rocky, cx, 0).landingPads).toEqual([]);
    }
  });
});

describe('statistics over many chunks', () => {
  const planets = ['terran', 'rocky', 'ocean', 'ice'].flatMap((cls) =>
    planetsOfClass(SEED, cls as 'terran', 6)
      .filter((p) => p.landable)
      .slice(0, 2),
  );
  const chunks = planets.flatMap((p) =>
    Array.from({ length: 30 }, (_, n) => ({
      p,
      chunk: generateSurfaceChunk(SEED, p, (n % 6) - 3, Math.floor(n / 6) - 2),
    })),
  );

  it('keeps 1-4 nodes per chunk with allowed types, quantities and in-chunk positions', () => {
    for (const { p, chunk } of chunks) {
      const x0 = chunk.chunkX * CHUNK_SIZE_M;
      const z0 = chunk.chunkZ * CHUNK_SIZE_M;
      expect(chunk.resourceNodes.length).toBeGreaterThanOrEqual(1);
      expect(chunk.resourceNodes.length).toBeLessThanOrEqual(4);
      for (const node of chunk.resourceNodes) {
        expect(p.resourceTypes).toContain(node.type);
        expect(node.baseQuantity).toBeGreaterThanOrEqual(50);
        expect(node.baseQuantity).toBeLessThanOrEqual(200);
        expect(node.x).toBeGreaterThanOrEqual(x0 + 4);
        expect(node.x).toBeLessThanOrEqual(x0 + CHUNK_SIZE_M - 4);
        expect(node.z).toBeGreaterThanOrEqual(z0 + 4);
        expect(node.z).toBeLessThanOrEqual(z0 + CHUNK_SIZE_M - 4);
        expect(node.nodeId).toMatch(/^[0-9a-f]{16}$/);
      }
    }
  });

  it('has globally unique node and pad ids', () => {
    const unique = new Set<string>();
    let total = 0;
    for (const { p, chunk } of chunks) {
      for (const id of [
        ...chunk.resourceNodes.map((n) => n.nodeId),
        ...chunk.landingPads.map((x) => x.id),
      ]) {
        unique.add(`${p.id}:${chunk.chunkX},${chunk.chunkZ}:${id}`);
        unique.add(id);
        total++;
      }
    }
    expect(new Set([...unique].filter((id) => !id.includes(':'))).size).toBe(total);
  });

  it('keeps nodes 20 m clear of pads', () => {
    for (const { chunk } of chunks) {
      for (const node of chunk.resourceNodes) {
        for (const pad of chunk.landingPads) {
          expect(squaredDistance(node, pad)).toBeGreaterThanOrEqual(400);
        }
      }
    }
  });

  it('keeps solid nodes out of wetland unless no clear dry probe point exists in the chunk', () => {
    let wetSolid = 0;
    for (const { p, chunk } of chunks) {
      const field = createSurfaceField(SEED, p);
      const x0 = chunk.chunkX * CHUNK_SIZE_M;
      const z0 = chunk.chunkZ * CHUNK_SIZE_M;
      const dryClearProbe = Array.from(
        { length: PROBE_GRID_SIZE * PROBE_GRID_SIZE },
        (_, cell) => ({
          x: x0 + 4 + (cell % PROBE_GRID_SIZE) * PROBE_GRID_SPACING_M,
          z: z0 + 4 + Math.floor(cell / PROBE_GRID_SIZE) * PROBE_GRID_SPACING_M,
        }),
      ).some(
        ({ x, z }) =>
          field.biomeAt(x, z) !== 'wetland' &&
          chunk.landingPads.every((pad) => squaredDistance(pad, { x, z }) >= 400),
      );
      for (const node of chunk.resourceNodes) {
        if (node.type === 'water' || node.type === 'gas-compounds') continue;
        if (field.biomeAt(node.x, node.z) === 'wetland') {
          wetSolid++;
          expect(dryClearProbe).toBe(false);
        }
      }
    }
    expect(wetSolid).toBeLessThan(20);
  });

  it('places pads in roughly a quarter of ordinary chunks, inside the chunk', () => {
    const terran = planetsOfClass(SEED, 'terran', 10).find((p) => p.landable)!;
    let withPad = 0;
    const total = 400;
    for (let n = 0; n < total; n++) {
      const chunk = generateSurfaceChunk(SEED, terran, 10 + (n % 20), 10 + Math.floor(n / 20));
      withPad += chunk.landingPads.length;
      for (const pad of chunk.landingPads) {
        expect(pad.x).toBeGreaterThanOrEqual(chunk.chunkX * CHUNK_SIZE_M + 20);
        expect(pad.x).toBeLessThanOrEqual((chunk.chunkX + 1) * CHUNK_SIZE_M - 20);
      }
    }
    expect(withPad / total).toBeGreaterThan(0.15);
    expect(withPad / total).toBeLessThan(0.35);
  });

  it('covers every biome and respects class-specific biome rules', () => {
    const seen = new Set<string>();
    for (const { p, chunk } of chunks) {
      seen.add(chunk.biome);
      if (p.class === 'ice') expect(['frozen', 'rock']).toContain(chunk.biome);
      if (p.class === 'rocky') expect(['rock', 'canyon', 'plains']).toContain(chunk.biome);
    }
    const field = createSurfaceField(SEED, planetsOfClass(SEED, 'terran', 3)[0]!);
    for (let n = 0; n < 2000; n++) seen.add(field.biomeAt(n * 61.7 - 9000, n * 37.3 - 5000));
    for (const biome of ['plains', 'rock', 'canyon', 'frozen', 'wetland'])
      expect(seen).toContain(biome);
  });
});

describe('world-space heightmap sampling', () => {
  const field = createSurfaceField(SEED, planet);

  it('places sample (i, j) at chunk origin + 4 m * index', () => {
    expect(samplePosition(2, -3, 0, 0)).toEqual({ x: 512, z: -768 });
    expect(samplePosition(0, 0, 63, 63)).toEqual({ x: 252, z: 252 });
    expect(SAMPLE_STEP_M * CHUNK_SAMPLES).toBe(CHUNK_SIZE_M);
  });

  it('is exactly the quantised surfaceHeightAt at every sample position', () => {
    for (const [cx, cz] of [
      [0, 0],
      [-1, 2],
      [5, -4],
    ] as const) {
      const chunk = generateSurfaceChunk(SEED, planet, cx, cz);
      for (let j = 0; j < CHUNK_SAMPLES; j += 7) {
        for (let i = 0; i < CHUNK_SAMPLES; i += 5) {
          const { x, z } = samplePosition(cx, cz, i, j);
          const meters = surfaceHeightAt(SEED, planet, x, z);
          expect(at(chunk.heightmap, i, j)).toBe(Math.round(meters * 10));
          expect(Math.abs(at(chunk.heightmap, i, j) / 10 - meters)).toBeLessThanOrEqual(0.05);
        }
      }
    }
  });

  it('keeps adjacent chunk edges one 4 m step apart with no seam', () => {
    const a = generateSurfaceChunk(SEED, planet, 0, 0);
    const b = generateSurfaceChunk(SEED, planet, 1, 0);
    const c = generateSurfaceChunk(SEED, planet, 0, 1);
    expect(at(b.heightmap, 0, 5)).toBe(field.heightUnitsAt(CHUNK_SIZE_M, 5 * SAMPLE_STEP_M));
    expect(at(c.heightmap, 5, 0)).toBe(field.heightUnitsAt(5 * SAMPLE_STEP_M, CHUNK_SIZE_M));

    /** Largest height change between horizontally adjacent samples inside one chunk. */
    const interiorStep = (h: number[]): number => {
      let max = 0;
      for (let j = 0; j < CHUNK_SAMPLES; j++) {
        for (let i = 0; i < CHUNK_SAMPLES - 1; i++)
          max = Math.max(max, Math.abs(at(h, i + 1, j) - at(h, i, j)));
      }
      return max;
    };
    const bound = Math.max(interiorStep(a.heightmap), interiorStep(b.heightmap));
    let seam = 0;
    for (let j = 0; j < CHUNK_SAMPLES; j++) {
      seam = Math.max(
        seam,
        Math.abs(at(b.heightmap, 0, j) - at(a.heightmap, CHUNK_SAMPLES - 1, j)),
      );
    }
    expect(seam).toBeLessThanOrEqual(bound);
    expect(seam / 10).toBeLessThan(8);
  });

  it('is continuous at arbitrary resolution (1 mm steps move height by < 1 cm)', () => {
    for (let n = 0; n < 200; n++) {
      const x = n * 3.173 - 300;
      const z = n * 1.911 + 40;
      expect(Math.abs(field.heightAt(x + 0.001, z) - field.heightAt(x, z))).toBeLessThan(0.01);
    }
  });
});

describe('determinism', () => {
  it('returns identical chunks from independent calls', () => {
    expect(generateSurfaceChunk(SEED, planet, 3, -2)).toEqual(
      generateSurfaceChunk(SEED, planet, 3, -2),
    );
  });

  it('is stable across 100 random chunks on 3 planets, including a fresh Rng', () => {
    const picks = ['terran', 'rocky', 'ice'].map((cls) =>
      planetsOfClass(SEED, cls as 'terran', 6).find((p) => p.landable)!,
    );
    const pick = new Rng(seedFromString('chunk-picker'));
    for (let n = 0; n < 100; n++) {
      const p = picks[pick.nextInt(3)]!;
      const cx = pick.nextInt(201) - 100;
      const cz = pick.nextInt(201) - 100;
      const hemisphere = n % 2 === 0 ? 'n' : 's';
      const first = hashOf(generateSurfaceChunk(SEED, p, cx, cz, hemisphere));
      expect(hashOf(generateSurfaceChunk(SEED, p, cx, cz, hemisphere))).toBe(first);
    }
  });

  it('depends on seed, planet and chunk coordinates (negatives included)', () => {
    const base = generateSurfaceChunk(SEED, planet, 0, 0);
    expect(generateSurfaceChunk('other', planet, 0, 0).heightmap).not.toEqual(base.heightmap);
    expect(generateSurfaceChunk(SEED, planet, -1, 0).heightmap).not.toEqual(base.heightmap);
    expect(generateSurfaceChunk(SEED, planet, 0, -1).resourceNodes[0]?.nodeId).not.toBe(
      generateSurfaceChunk(SEED, planet, -1, 0).resourceNodes[0]?.nodeId,
    );
  });
});

describe('input validation', () => {
  it('rejects gas giants, non-integer and out-of-range chunk coordinates', () => {
    expect(() => generateSurfaceChunk(SEED, gas, 0, 0)).toThrow(/gas giants/);
    expect(() => generateSurfaceChunk(SEED, planet, 0.5, 0)).toThrow(RangeError);
    expect(() => generateSurfaceChunk(SEED, planet, 0, Number.NaN)).toThrow(RangeError);
    expect(() => generateSurfaceChunk(SEED, planet, MAX_CHUNK_COORD + 1, 0)).toThrow(RangeError);
    expect(() => surfaceHeightAt(SEED, planet, 1e12, 0)).toThrow(RangeError);
  });
});
