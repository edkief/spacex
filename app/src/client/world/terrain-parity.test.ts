import { describe, expect, it } from 'vitest';

import { generateStars } from '@shared/galaxy/stars';
import { generateSystem } from '@shared/galaxy/system';
import { planetAnchor, PLANET_SURFACE_RADIUS_M } from '@shared/galaxy/planets';
import { padSurfaceHeight, padsForSystem, type PadInfo } from '@shared/world/pads';
import { TerrainContext } from '@server/shard/terrain';
import { ChunkBuild, CHUNK_METERS } from './chunk-geometry';

/**
 * TASK-84 (step 1): the client's rendered terrain must equal the SERVER's
 * terrain — same frame (WORLD metres), same field, same pad flattening.
 *
 * The server collides ships and characters with `padSurfaceHeight(x, z,
 * TerrainContext.heightAt(x, z), pad)`; the client renders the ChunkBuild
 * near-LOD vertex grid. This test samples ~50 grid vertices (exact 5 m grid
 * points) inside PLANET_SURFACE_RADIUS_M of planet 0's anchor — including a
 * dense ring around the pad (disc, blend band, and just outside) — and
 * compares the server height against the vertex height the live
 * ChunkStreamer builds (same code path: `new ChunkBuild(seed, planet, cx,
 * cz, pad)` advanced to done).
 *
 * At grid vertices the server's bilinear sample returns the exact cell
 * height, so the two must agree to within Float32 storage precision (the
 * vertex y is stored in a Float32Array; 3 decimals = 5e-4 covers the ~2.4e-5
 * ulp at heights near 400 m). Pre-step-2 this test FAILS near the pad — the
 * client geometry did not flatten (no padSurfaceHeight); step 2 makes it
 * pass. A mismatch AWAY from the pad would mean client and server terrain
 * generation diverged — a sim question, not a rendering one.
 */

const SEED = 'TERRAIN-PARITY-SEED';
const star = generateStars(SEED)[0];
const system = generateSystem(SEED, star.id);
const planet = system.planets[0];
const anchor = planetAnchor(0);
const pad: PadInfo | undefined = padsForSystem(SEED, system).find((p) => p.planetId === planet.id);

/** All sampled points are exact grid vertices (multiples of CELL_SIZE_M). */
function gridVertex(m: number): boolean {
  return Math.abs(m / 5 - Math.round(m / 5)) < 1e-9;
}

/**
 * The ~50 sample points (world metres, grid vertices):
 * - a 600 m grid of points inside the island surface circle around the
 *   anchor (scattered terrain — away from the pad);
 * - a dense 5 m ring around the pad: the flat disc (≤ 20 m), the raised
 *   cosine blend (20–30 m), and just past the blend (30–35 m, back at the
 *   real terrain).
 */
function samplePoints(): Array<{ x: number; z: number }> {
  const pts: Array<{ x: number; z: number }> = [];
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      const x = anchor.x + dx * 600;
      const z = anchor.z + dz * 600;
      if (Math.hypot(x - anchor.x, z - anchor.z) > PLANET_SURFACE_RADIUS_M) continue;
      pts.push({ x, z });
    }
  }
  const cx = Math.round(pad!.pos.x / 5);
  const cz = Math.round(pad!.pos.z / 5);
  for (let kx = -7; kx <= 7; kx++) {
    for (let kz = -7; kz <= 7; kz++) {
      const x = cx * 5 + kx * 5;
      const z = cz * 5 + kz * 5;
      if (Math.hypot(x - pad!.pos.x, z - pad!.pos.z) > 35) continue;
      pts.push({ x, z });
    }
  }
  return pts;
}

/** Build one chunk through the SAME code path the ChunkStreamer uses. */
function buildChunk(chunkX: number, chunkZ: number): ChunkBuild {
  const build = new ChunkBuild(SEED, planet, chunkX, chunkZ, pad);
  while (!build.done) build.advanceUnit(() => performance.now());
  return build;
}

describe('client terrain == server terrain (TASK-84 parity)', () => {
  it('samples ~50 grid vertices inside the surface circle, including the pad zone', () => {
    const pts = samplePoints();
    expect(pts.length).toBeGreaterThanOrEqual(50);
    for (const p of pts) {
      expect(gridVertex(p.x)).toBe(true);
      expect(gridVertex(p.z)).toBe(true);
      expect(Math.hypot(p.x - anchor.x, p.z - anchor.z)).toBeLessThanOrEqual(
        PLANET_SURFACE_RADIUS_M + 1e-9,
      );
    }
  });

  it('samples real (varying) terrain, not a flat degenerate field', () => {
    const ctx = new TerrainContext(SEED, planet);
    const hs = new Set<number>();
    for (const p of samplePoints().filter(
      (p) => Math.hypot(p.x - pad!.pos.x, p.z - pad!.pos.z) > 100,
    )) {
      ctx.update(p.x, p.z);
      hs.add(ctx.heightAt(p.x, p.z));
    }
    expect(hs.size).toBeGreaterThan(5);
  });

  it('client vertex height == server heightAt (+ padSurfaceHeight) at every grid vertex', () => {
    const ctx = new TerrainContext(SEED, planet);
    const built = new Map<string, ChunkBuild>();
    let worst = 0;
    let worstPt: { x: number; z: number; server: number; client: number } | null = null;
    for (const p of samplePoints()) {
      ctx.update(p.x, p.z);
      const server = padSurfaceHeight(p.x, p.z, ctx.heightAt(p.x, p.z), pad);
      const cX = Math.floor(p.x / CHUNK_METERS);
      const cZ = Math.floor(p.z / CHUNK_METERS);
      const key = `${cX},${cZ}`;
      let chunk = built.get(key);
      if (!chunk) {
        chunk = buildChunk(cX, cZ);
        built.set(key, chunk);
      }
      const pos = chunk.built.geometries.near!.getAttribute('position').array as Float32Array;
      const ix = Math.round(p.x / 5) - cX * 64;
      const iz = Math.round(p.z / 5) - cZ * 64;
      expect(ix).toBeGreaterThanOrEqual(0);
      expect(ix).toBeLessThanOrEqual(64);
      expect(iz).toBeGreaterThanOrEqual(0);
      expect(iz).toBeLessThanOrEqual(64);
      const client = pos[(iz * 65 + ix) * 3 + 1];
      const d = Math.abs(client - server);
      if (d > worst) worstPt = { x: p.x, z: p.z, server, client };
      worst = Math.max(worst, d);
      expect(client).toBeCloseTo(server, 3);
    }
    // Diagnostic for a future divergence: report the worst sample.
    if (worstPt) console.warn(`worst parity delta: ${worst.toExponential(3)} at`, worstPt);
  });

  it('the pad disc renders FLAT at the sim pad height, blending out to 30 m', () => {
    const built = buildChunk(
      Math.floor(pad!.pos.x / CHUNK_METERS),
      Math.floor(pad!.pos.z / CHUNK_METERS),
    );
    const pos = built.built.geometries.near!.getAttribute('position').array as Float32Array;
    const hAt = (x: number, z: number): number => {
      const cX = Math.floor(pad!.pos.x / CHUNK_METERS);
      const cZ = Math.floor(pad!.pos.z / CHUNK_METERS);
      const ix = Math.round(x / 5) - cX * 64;
      const iz = Math.round(z / 5) - cZ * 64;
      return pos[(iz * 65 + ix) * 3 + 1];
    };
    // Inside the 20 m disc: exactly the pad plane.
    expect(hAt(pad!.pos.x, pad!.pos.z)).toBeCloseTo(pad!.pos.y, 3);
    expect(hAt(pad!.pos.x + 10, pad!.pos.z + 10)).toBeCloseTo(pad!.pos.y, 3);
    // Past the blend: back to the raw terrain (not the pad plane).
    const ctx = new TerrainContext(SEED, planet);
    const farX = pad!.pos.x + 40;
    const farZ = pad!.pos.z;
    ctx.update(farX, farZ);
    expect(hAt(farX, farZ)).toBeCloseTo(ctx.heightAt(farX, farZ), 3);
    expect(Math.abs(ctx.heightAt(farX, farZ) - pad!.pos.y)).toBeGreaterThan(0.1);
  });
});
