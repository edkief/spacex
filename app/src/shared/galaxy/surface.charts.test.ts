import { describe, expect, it } from 'vitest';
import { chunkInChart } from '@shared/galaxy/chart.ts';
import { fbm3D, hash32x3, valueNoise3D } from '@shared/galaxy/noise.ts';
import { generateSurfaceChunk } from '@shared/galaxy/surface.ts';
import { CHUNK_SIZE_M, createSurfaceField } from '@shared/galaxy/terrain.ts';
import { Rng, seedFromString } from '@shared/random.ts';
import { firstPlanet } from '@tests/support/galaxy.ts';

const SEED = 'drift-dev-seed-001';
const { planet } = firstPlanet(SEED, (candidate) => candidate.landable);

describe('two charts over one sphere', () => {
  const R = planet.simRadius;

  it('gives both charts the same terrain where they overlap, to floating-point noise', () => {
    const north = createSurfaceField(SEED, planet, 'n');
    const south = createSurfaceField(SEED, planet, 's');
    let worst = 0;
    const pick = new Rng(seedFromString('equator-picker'));
    for (let n = 0; n < 400; n++) {
      // A north-chart point between r = 0.8 and r = 1.2, and the same ground in the south chart.
      const r = 0.8 + 0.4 * pick.nextF64();
      let ux: number;
      let uz: number;
      for (;;) {
        ux = 2 * pick.nextF64() - 1;
        uz = 2 * pick.nextF64() - 1;
        const d = ux * ux + uz * uz;
        if (d > 0.01 && d <= 1) {
          ux /= Math.sqrt(d);
          uz /= Math.sqrt(d);
          break;
        }
      }
      const a = r * ux;
      const b = r * uz;
      const x = 2 * R * a;
      const z = 2 * R * b;
      const xs = (2 * R * a) / (r * r);
      const zs = (-2 * R * b) / (r * r);
      worst = Math.max(worst, Math.abs(north.heightAt(x, z) - south.heightAt(xs, zs)));
      expect(Math.abs(north.moistureAt(x, z) - south.moistureAt(xs, zs))).toBeLessThan(1e-6);
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it('has no seam: terrain is as smooth across the equator as anywhere else', () => {
    const field = createSurfaceField(SEED, planet, 'n');
    let worst = 0;
    for (let i = 0; i < 2000; i++) {
      // Walk outward through the equator (r = 1) along +x in 4 flat-metre (2 true metre) steps.
      const x = 2 * R - 4000 + i * 4;
      worst = Math.max(worst, Math.abs(field.heightAt(x + 4, 300) - field.heightAt(x, 300)));
    }
    expect(worst).toBeLessThan(8);
  });

  it('reports the chart scale: 1 at the pole, 0.5 at the equator', () => {
    const field = createSurfaceField(SEED, planet, 's');
    expect(field.hemisphere).toBe('s');
    expect(field.scaleAt(0, 0)).toBe(1);
    expect(field.scaleAt(0, 2 * R)).toBeCloseTo(0.5, 12);
  });

  it('generates distinct south chunks and refuses chunks beyond the equator', () => {
    const north = generateSurfaceChunk(SEED, planet, 3, -2, 'n');
    const south = generateSurfaceChunk(SEED, planet, 3, -2, 's');
    expect(north.hemisphere).toBe('n');
    expect(south.hemisphere).toBe('s');
    expect(south.heightmap).not.toEqual(north.heightmap);
    expect(south.resourceNodes[0]?.nodeId).not.toBe(north.resourceNodes[0]?.nodeId);
    expect(generateSurfaceChunk(SEED, planet, 0, 0, 's').landingPads.length).toBeLessThanOrEqual(1);
    const edge = Math.floor((2 * R) / CHUNK_SIZE_M);
    expect(chunkInChart(R, edge - 1, 0, CHUNK_SIZE_M)).toBe(true);
    expect(chunkInChart(R, edge + 1, 0, CHUNK_SIZE_M)).toBe(false);
    expect(() => generateSurfaceChunk(SEED, planet, edge + 1, 0)).toThrow(RangeError);
    expect(() => generateSurfaceChunk(SEED, planet, edge - 1, 0, 's')).not.toThrow();
  });

  it('keeps pad clearances in true metres near the equator', () => {
    const edge = Math.floor((2 * R) / CHUNK_SIZE_M);
    let pads = 0;
    for (let cz = -40; cz < 40 && pads < 5; cz++) {
      const chunk = generateSurfaceChunk(SEED, planet, edge - 2, cz);
      const scale = createSurfaceField(SEED, planet).scaleAt(
        (edge - 1.5) * CHUNK_SIZE_M,
        (cz + 0.5) * CHUNK_SIZE_M,
      );
      for (const pad of chunk.landingPads) {
        pads++;
        for (const node of chunk.resourceNodes) {
          const dx = node.x - pad.x;
          const dz = node.z - pad.z;
          const flat = Math.sqrt(dx * dx + dz * dz);
          expect(flat * scale).toBeGreaterThanOrEqual(20 * 0.98);
        }
      }
    }
    expect(pads).toBeGreaterThan(0);
  });
});

describe('3D value noise', () => {
  it('shares corner hashes with hash32x3 and stays within [0, 1)', () => {
    // On lattice points the noise equals the corner hash exactly.
    for (const [x, y, z] of [
      [0, 0, 0],
      [512, -1024, 2048],
      [-51_200, 7680, 256],
    ] as const) {
      expect(valueNoise3D(99, x, y, z, 256)).toBe(
        hash32x3(99, x / 256, y / 256, z / 256) / 4294967296,
      );
    }
    const pick = new Rng(5n);
    for (let n = 0; n < 2000; n++) {
      const v = fbm3D(
        7,
        pick.nextRange(-8e4, 8e4),
        pick.nextRange(-8e4, 8e4),
        pick.nextRange(-8e4, 8e4),
        512,
        5,
      );
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
