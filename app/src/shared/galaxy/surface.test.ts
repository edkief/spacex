import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateSystem } from './system';
import {
  CELL_SIZE_M,
  CHUNK_SIZE,
  HEIGHTMAP_SAMPLE_CELLS,
  NODE_PAD_CLEARANCE_M,
  amplitudeM,
  chunkSeed,
  generateSurfaceChunk,
} from './surface';
import { hash2, Rng, seedFromString } from '../random.js';
import { canonicalJson } from '../canonical.js';
import type { Planet, SurfaceChunk } from './types.js';
import fixture from './__fixtures__/surface-dev-seed-chunk00.json';

const DEV_SEED: string = fixture.seed;
const STAR0_ID: string = fixture.starId;
const BIOMES = ['plains', 'rock', 'canyon', 'frozen', 'wetland'];
const LIQUID_RESOURCES = new Set(['water', 'gas-compounds']);

const system = generateSystem(DEV_SEED, STAR0_ID);
const planets = system.planets;
const landable = planets.filter((p) => p.landable);

/** Heightmap sampled at the 16 committed fixture points. */
function sample16(chunk: SurfaceChunk): number[] {
  return HEIGHTMAP_SAMPLE_CELLS.map(([x, z]) => chunk.heightmap[z * CHUNK_SIZE + x]);
}

describe('generateSurfaceChunk', () => {
  it('golden snapshot: chunk (0,0) of the dev-seed landable planet matches the committed fixture', () => {
    expect(planets[fixture.planetIndex].id).toBe(fixture.planetId); // planet id stable
    const planet = planets[fixture.planetIndex];
    const chunk = generateSurfaceChunk(DEV_SEED, planet, 0, 0);

    expect(chunk.chunkX).toBe(0);
    expect(chunk.chunkZ).toBe(0);
    expect(chunk.biome).toBe(fixture.biome);
    expect(sample16(chunk)).toEqual(fixture.heightmapSamples);
    expect(chunk.resourceNodes).toEqual(fixture.resourceNodes);
    expect(chunk.landingPads).toEqual(fixture.landingPads);
    expect(chunk.landingPads).toHaveLength(1); // (0,0) of a landable planet
    const checksum = createHash('sha256').update(canonicalJson(chunk)).digest('hex');
    expect(checksum).toBe(fixture.fullChecksum);
  });

  it('is deterministic across two independent calls', () => {
    const planet = planets[fixture.planetIndex];
    const a = generateSurfaceChunk(DEV_SEED, planet, 3, -7);
    const b = generateSurfaceChunk(DEV_SEED, planet, 3, -7);
    expect(a).toEqual(b);
  });

  it('keeps 100 random chunks stable across 3 planets and fresh Rng instances', () => {
    const chosen = planets.slice(0, 3); // first three planets, any class
    const pickCoords = () => {
      const r = new Rng(seedFromString('surface-stability-v1'));
      return Array.from({ length: 100 }, () => ({
        planet: chosen[r.nextInt(3)],
        cx: r.nextInt(81) - 40,
        cz: r.nextInt(81) - 40,
      }));
    };
    const hashAll = (coords: { planet: Planet; cx: number; cz: number }[]) =>
      coords.map((c) =>
        createHash('sha256')
          .update(canonicalJson(generateSurfaceChunk(DEV_SEED, c.planet, c.cx, c.cz)))
          .digest('hex'),
      );
    // Fresh Rngs (two independent instances) select the identical chunk set.
    expect(hashAll(pickCoords())).toEqual(hashAll(pickCoords()));
  });

  it('derives a chunk sub-seed from (seed, planetId, chunkX, chunkZ)', () => {
    const planet = planets[fixture.planetIndex];
    const xy = ((BigInt(5) & 0xffffffffn) << 32n) | (BigInt(-2) & 0xffffffffn);
    expect(chunkSeed(DEV_SEED, planet.id, 5, -2)).toBe(
      hash2(hash2(seedFromString(DEV_SEED), seedFromString(planet.id)), xy),
    );
  });
});

describe('chunk border continuity', () => {
  it('shares boundary samples: neighboring chunks differ only by one cell step', () => {
    const planet = planets[fixture.planetIndex];
    // Theoretical worst case of one world-cell step is ~0.08x the amplitude
    // (sum of per-octave lattice steps); allow 0.15x as a comfortable margin.
    const epsilon = 0.15 * amplitudeM(planet);
    // X-adjacent: rightmost column of (0,0) vs leftmost column of (1,0).
    const a = generateSurfaceChunk(DEV_SEED, planet, 0, 0);
    const b = generateSurfaceChunk(DEV_SEED, planet, 1, 0);
    let edgeMax = 0;
    for (let z = 0; z < CHUNK_SIZE; z++) {
      const d = Math.abs(
        a.heightmap[z * CHUNK_SIZE + CHUNK_SIZE - 1] - b.heightmap[z * CHUNK_SIZE + 0],
      );
      if (d > edgeMax) edgeMax = d;
    }
    expect(edgeMax).toBeLessThan(epsilon);

    // Z-adjacent: bottom row of (0,0) vs top row of (0,1).
    const c = generateSurfaceChunk(DEV_SEED, planet, 0, 1);
    let rowMax = 0;
    for (let x = 0; x < CHUNK_SIZE; x++) {
      const d = Math.abs(a.heightmap[(CHUNK_SIZE - 1) * CHUNK_SIZE + x] - c.heightmap[x]);
      if (d > rowMax) rowMax = d;
    }
    expect(rowMax).toBeLessThan(epsilon);
  });
});

describe('structural invariants', () => {
  const cases: { planet: Planet; cx: number; cz: number }[] = [];
  for (const p of planets) {
    for (const [cx, cz] of [
      [0, 0],
      [0, 1],
      [1, 0],
      [-1, 0],
      [7, -3],
      [-4, 12],
    ]) {
      cases.push({ planet: p, cx, cz });
    }
  }

  it('every chunk has a valid 64x64 Uint16-safe integer heightmap and biome', () => {
    for (const { planet, cx, cz } of cases) {
      const chunk = generateSurfaceChunk(DEV_SEED, planet, cx, cz);
      expect(chunk.chunkX).toBe(cx);
      expect(chunk.chunkZ).toBe(cz);
      expect(chunk.heightmap).toHaveLength(CHUNK_SIZE * CHUNK_SIZE);
      for (const h of chunk.heightmap) {
        expect(Number.isInteger(h)).toBe(true);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThanOrEqual(65535);
      }
      expect(BIOMES).toContain(chunk.biome);
    }
  });

  it('non-landable planets have terrain but no nodes or pads', () => {
    for (const p of planets.filter((p) => !p.landable)) {
      const chunk = generateSurfaceChunk(DEV_SEED, p, 0, 0);
      expect(chunk.resourceNodes).toEqual([]);
      expect(chunk.landingPads).toEqual([]);
    }
  });

  it('landable chunk (0,0) always has exactly one pad; other chunks have 0-1', () => {
    for (const p of landable) {
      expect(generateSurfaceChunk(DEV_SEED, p, 0, 0).landingPads).toHaveLength(1);
    }
    const r = new Rng(seedFromString('surface-pads'));
    for (let i = 0; i < 120; i++) {
      const chunk = generateSurfaceChunk(
        DEV_SEED,
        landable[r.nextInt(landable.length)],
        1 + r.nextInt(20),
        1 + r.nextInt(20),
      );
      expect(chunk.landingPads.length).toBeLessThanOrEqual(1);
      for (const pad of chunk.landingPads) {
        expect(pad.id).toMatch(/^[0-9a-f]{16}$/);
        expect(pad.x).toBeGreaterThanOrEqual(0);
        expect(pad.x).toBeLessThan(CHUNK_SIZE * CELL_SIZE_M);
        expect(pad.z).toBeGreaterThanOrEqual(0);
        expect(pad.z).toBeLessThan(CHUNK_SIZE * CELL_SIZE_M);
      }
    }
  });

  it('places 1-4 nodes per landable chunk with valid types, quantities and ids', () => {
    for (const { planet, cx, cz } of cases.filter((c) => c.planet.landable)) {
      const chunk = generateSurfaceChunk(DEV_SEED, planet, cx, cz);
      expect(chunk.resourceNodes.length).toBeGreaterThanOrEqual(1);
      expect(chunk.resourceNodes.length).toBeLessThanOrEqual(4);
      const ids = new Set<string>();
      chunk.resourceNodes.forEach((n, i) => {
        expect(planet.resourceTypes).toContain(n.type);
        expect(n.baseQuantity).toBeGreaterThanOrEqual(50);
        expect(n.baseQuantity).toBeLessThanOrEqual(200);
        expect(n.nodeId).toMatch(/^[0-9a-f]{16}$/);
        expect(ids.has(n.nodeId)).toBe(false);
        ids.add(n.nodeId);
        // Stable identity: hex hash of (seed, planetId, chunkX, chunkZ, nodeIndex).
        expect(n.nodeId).toBe(
          hash2(chunkSeed(DEV_SEED, planet.id, cx, cz), BigInt(i))
            .toString(16)
            .padStart(16, '0'),
        );
      });
    }
  });

  it('keeps nodes clear of pads and solid types out of wetlands (where liquids exist)', () => {
    const clearance = Math.ceil(NODE_PAD_CLEARANCE_M / CELL_SIZE_M);
    for (const { planet, cx, cz } of cases.filter((c) => c.planet.landable)) {
      const chunk = generateSurfaceChunk(DEV_SEED, planet, cx, cz);
      const hasLiquid = planet.resourceTypes.some((t) => LIQUID_RESOURCES.has(t));
      for (const n of chunk.resourceNodes) {
        for (const p of chunk.landingPads) {
          const dx = Math.abs(p.x - n.x) / CELL_SIZE_M;
          const dz = Math.abs(p.z - n.z) / CELL_SIZE_M;
          expect(Math.max(dx, dz)).toBeGreaterThanOrEqual(clearance);
        }
        if (chunk.biome === 'wetland' && hasLiquid) {
          expect(LIQUID_RESOURCES.has(n.type)).toBe(true);
        }
      }
    }
  });
});

describe('statistical checks (dev seed, landable planets)', () => {
  it('pads appear at roughly the seeded 25% rate outside chunk (0,0)', () => {
    const r = new Rng(seedFromString('surface-pad-rate'));
    let pads = 0;
    const n = 200;
    for (let i = 0; i < n; i++) {
      const cx = 1 + r.nextInt(40);
      const cz = 1 + r.nextInt(40);
      if (
        generateSurfaceChunk(DEV_SEED, landable[r.nextInt(landable.length)], cx, cz).landingPads
          .length === 1
      ) {
        pads++;
      }
    }
    expect(pads / n).toBeGreaterThan(0.1);
    expect(pads / n).toBeLessThan(0.4);
  });

  it('node counts span 1..4 across chunks', () => {
    const r = new Rng(seedFromString('surface-node-counts'));
    const counts = new Set<number>();
    for (let i = 0; i < 100; i++) {
      const chunk = generateSurfaceChunk(
        DEV_SEED,
        landable[r.nextInt(landable.length)],
        r.nextInt(30),
        r.nextInt(30),
      );
      counts.add(chunk.resourceNodes.length);
    }
    expect(counts.size).toBeGreaterThanOrEqual(3);
  });

  it('biomes include plains/rock on rocky-class worlds and frozen is reachable on ice worlds', () => {
    const seen = new Set<string>();
    const r = new Rng(seedFromString('surface-biomes'));
    for (let i = 0; i < 120; i++) {
      const p = planets[r.nextInt(planets.length)];
      if (!p.landable) continue;
      seen.add(generateSurfaceChunk(DEV_SEED, p, r.nextInt(25), r.nextInt(25)).biome);
    }
    expect(seen.size).toBeGreaterThanOrEqual(2);
    const ice = planets.find((p) => p.class === 'ice' && p.landable);
    if (ice) {
      const frozenSeen = Array.from(
        { length: 40 },
        (_, i) => generateSurfaceChunk(DEV_SEED, ice, i - 20, i - 20).biome,
      ).includes('frozen');
      expect(frozenSeen).toBe(true);
    }
  });
});
