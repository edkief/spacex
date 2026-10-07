import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CHUNK_METERS,
  RING_BYTES,
  RING_TRIANGLES,
  type BuiltChunk,
  ChunkBuild,
  ImpostorBuild,
} from './chunk-geometry';
import {
  activeSet,
  chunkCenterOffset,
  chunkKey,
  chunkOfMeters,
  ChunkStreamer,
  DEFAULT_LRU_CAP,
  FAST_TRAVEL_SPEED,
  LOD_FAR_MAX_M,
  LOD_MID_MAX_M,
  LOD_NEAR_MAX_M,
  lodRingForChunk,
  lodRingForDistance,
  parseChunkKey,
  SURFACE_TRIANGLE_BUDGET,
} from './chunks';
import { generateSurfaceChunk } from '@shared/galaxy/surface';
import { generateSystem } from '@shared/galaxy/system';
import fixture from '@shared/galaxy/__fixtures__/surface-dev-seed-chunk00.json';
import { setPerfLogSink } from '@client/perf/logger';

const SEED = fixture.seed;
const PLANET = generateSystem(SEED, fixture.starId).planets[fixture.planetIndex];

/** A full build is ~15 work units — 100 is a generous hang cap. */
const MAX_BUILD_UNITS = 100;

/**
 * Build one chunk to completion (drives the staged pipeline through every
 * unit). Capped: a stage that never reaches 'done' fails the test with the
 * chunk named instead of hanging.
 */
function buildToDone(seed: string, planet: typeof PLANET, cx: number, cz: number): BuiltChunk {
  const build = new ChunkBuild(seed, planet, cx, cz);
  let units = 0;
  while (!build.done) {
    if (++units > MAX_BUILD_UNITS) {
      throw new Error(
        `ChunkBuild stuck on chunk (${cx},${cz}) after ${units} units (stage: ${build.stage})`,
      );
    }
    build.advanceUnit(() => performance.now());
  }
  return build.built;
}

describe('chunk key math', () => {
  it('chunkKey/parseChunkKey roundtrip (incl. negative coords)', () => {
    for (const [x, z] of [
      [0, 0],
      [1, -3],
      [-7, 12],
      [-2147483648 + 1, 2147483647 - 1],
    ]) {
      expect(parseChunkKey(chunkKey(x, z))).toEqual({ chunkX: x, chunkZ: z });
    }
  });

  it('parseChunkKey throws on malformed keys', () => {
    for (const bad of ['nocomma', ',5', '1,2,3', 'x,y', '', '1,']) {
      expect(() => parseChunkKey(bad)).toThrow(/invalid chunk key/);
    }
  });

  it('chunkOfMeters maps world meters onto the 320 m grid, negative-safe', () => {
    expect(CHUNK_METERS).toBe(320);
    expect(chunkOfMeters(0)).toBe(0);
    expect(chunkOfMeters(319.9)).toBe(0);
    expect(chunkOfMeters(320)).toBe(1);
    expect(chunkOfMeters(-0.1)).toBe(-1);
    expect(chunkOfMeters(-320)).toBe(-1);
    expect(chunkOfMeters(-320.1)).toBe(-2);
  });

  it('chunkCenterOffset is player-relative to the chunk center (160 m in-bounds)', () => {
    expect(chunkCenterOffset(0, 0, 160, 160)).toEqual({ dx: 0, dz: 0 });
    expect(chunkCenterOffset(1, 0, 0, 160)).toEqual({ dx: 480, dz: 0 });
    // Chunk (-1,2) center is (-160, 800); player (500,500) → (-660, 300).
    expect(chunkCenterOffset(-1, 2, 500, 500)).toEqual({ dx: -660, dz: 300 });
  });
});

describe('LOD ring selection', () => {
  it('boundaries: 512 near / 2048 mid / 8000 far / beyond none', () => {
    expect(LOD_NEAR_MAX_M).toBe(512);
    expect(LOD_MID_MAX_M).toBe(2_048);
    expect(LOD_FAR_MAX_M).toBe(8_000);
    expect(lodRingForDistance(0)).toBe('near');
    expect(lodRingForDistance(512)).toBe('near'); // exactly 512 → near
    expect(lodRingForDistance(512.001)).toBe('mid');
    expect(lodRingForDistance(2_048)).toBe('mid'); // exactly 2048 → mid
    expect(lodRingForDistance(2_048.001)).toBe('far');
    expect(lodRingForDistance(8_000)).toBe('far'); // exactly 8000 → far
    expect(lodRingForDistance(8_000.001)).toBe('none');
  });

  it('lodRingForChunk uses the player→chunk-CENTER distance', () => {
    // Chunk (0,0) center is (160,160): from (160,160) it is 0 m → near.
    expect(lodRingForChunk(0, 0, 160, 160)).toBe('near');
    // From (672,160) the same chunk's center is 512 m away → still near;
    // one more meter pushes it into mid.
    expect(lodRingForChunk(0, 0, 672, 160)).toBe('near');
    expect(lodRingForChunk(0, 0, 673, 160)).toBe('mid');
  });
});

describe('active set', () => {
  it('at rest: 13 chunks (3x3 near block + 4 cardinals two away) in a 5x5 span', () => {
    const set = activeSet(160, 160, 0);
    expect(set).toHaveLength(13);
    const keys = new Set(set.map((a) => chunkKey(a.chunkX, a.chunkZ)));
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) keys.delete(chunkKey(dx, dz)); // 3x3 block
    }
    expect([...keys].sort()).toEqual(['-2,0', '0,-2', '0,2', '2,0']);
    // 3x3 block rings are near; cardinals at 640 m are mid.
    const rings = new Map(set.map((a) => [chunkKey(a.chunkX, a.chunkZ), a.ring]));
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++) {
        expect(rings.get(chunkKey(dx, dz))).toBe('near');
      }
    for (const k of ['2,0', '-2,0', '0,2', '0,-2']) expect(rings.get(k)).toBe('mid');
  });

  it('at >= FAST_TRAVEL_SPEED: full 7x7 (49)', () => {
    expect(FAST_TRAVEL_SPEED).toBe(100);
    expect(activeSet(160, 160, 99.9)).toHaveLength(13); // just below: still 13
    for (const speed of [100, 180, 1_000]) {
      const set = activeSet(160, 160, speed);
      expect(set).toHaveLength(49);
      const span = set.map((a) => a.chunkX).concat(set.map((a) => a.chunkZ));
      expect(Math.min(...span)).toBe(-3);
      expect(Math.max(...span)).toBe(3);
    }
  });

  it('always contains the player chunk first (nearest-first by center distance)', () => {
    for (const [px, pz, speed] of [
      [160, 160, 0],
      [319, 5, 0], // inside chunk (0,0), near the +x edge
      [1000, -4000, 180], // off-center in chunk (3,-13)
    ]) {
      const set = activeSet(px, pz, speed);
      const pcx = chunkOfMeters(px);
      const pcz = chunkOfMeters(pz);
      expect(set[0]).toMatchObject({ chunkX: pcx, chunkZ: pcz, distance: expect.any(Number) });
      expect(set[0].distance).toBeLessThanOrEqual(226.4); // corner case: half-diagonal
      for (let i = 1; i < set.length; i++) {
        expect(set[i].distance).toBeGreaterThanOrEqual(set[i - 1].distance);
      }
    }
  });
});

describe('staged build == one-shot generation', () => {
  it('ChunkBuild to done is deep-equal to generateSurfaceChunk (guards the TASK-5 refactor)', () => {
    for (const [cx, cz] of [
      [0, 0], // forced pad chunk
      [3, -7],
      [-4, 5],
    ]) {
      const staged = buildToDone(SEED, PLANET, cx, cz);
      const oneShot = generateSurfaceChunk(SEED, PLANET, cx, cz);
      expect(staged.chunk?.heightmap).toEqual(oneShot.heightmap); // 65x65 grid's 64x64 subset
      expect(staged.chunk?.biome).toBe(oneShot.biome);
      expect(staged.chunk?.landingPads).toEqual(oneShot.landingPads);
      expect(staged.chunk?.resourceNodes).toEqual(oneShot.resourceNodes);
    }
  });

  it('the mip chain is complete and sized per ring', () => {
    const built = buildToDone(SEED, PLANET, 0, 0);
    expect(built.rings).toEqual(['near', 'mid', 'far']);
    for (const [ring, g] of Object.entries(built.geometries)) {
      expect(g).not.toBeNull();
      const idx = g!.getIndex();
      expect(idx).not.toBeNull();
      expect(idx!.count / 3).toBe(RING_TRIANGLES[ring as 'near' | 'mid' | 'far']);
    }
    expect(built.geometryBytes).toBe(RING_BYTES.near + RING_BYTES.mid + RING_BYTES.far);
  });

  it('ImpostorBuild produces a 2-triangle flat quad with no world data', () => {
    const build = new ImpostorBuild(SEED, PLANET, 7, 2);
    expect(build.done).toBe(false);
    build.advanceUnit(() => performance.now());
    expect(build.done).toBe(true);
    expect(build.built.chunk).toBeNull();
    expect(build.built.rings).toEqual(['far']);
    expect(build.built.geometryBytes).toBe(RING_BYTES.far);
    const pos = build.built.geometries.far.getAttribute('position').array as Float32Array;
    for (let i = 1; i < pos.length; i += 3) {
      expect(pos[i]).toBe(pos[1]); // flat: one height for all four corners
    }
  });
});

describe('triangle budget (acceptance: < 400k at default quality)', () => {
  it('resting set (9 near + 4 mid) = 81,920 tris; 7x7 set well under the gauge', () => {
    const restTris = 9 * RING_TRIANGLES.near + 4 * RING_TRIANGLES.mid;
    console.log(
      `[budget] rest 13-chunk set: 9x${RING_TRIANGLES.near} near + 4x${RING_TRIANGLES.mid} mid = ${restTris} tris (gauge ${SURFACE_TRIANGLE_BUDGET})`,
    );
    expect(restTris).toBe(81_920);
    expect(restTris).toBeLessThan(SURFACE_TRIANGLE_BUDGET);

    const fastTris = 9 * RING_TRIANGLES.near + 40 * RING_TRIANGLES.mid;
    console.log(`[budget] 7x7 speed set: 9 near + 40 mid = ${fastTris} tris`);
    expect(fastTris).toBeLessThan(SURFACE_TRIANGLE_BUDGET);
  });

  it('400-chunk LRU stays under 100 MB of geometry (estimated from ring bytes)', () => {
    const perChunk = RING_BYTES.near + RING_BYTES.mid + RING_BYTES.far;
    const totalMb = (DEFAULT_LRU_CAP * perChunk) / 1024 / 1024;
    console.log(
      `[memory] ${DEFAULT_LRU_CAP} chunks x ${perChunk} B (~${(perChunk / 1024).toFixed(0)} KB) ≈ ${totalMb.toFixed(1)} MB (cap 100 MB)`,
    );
    expect(DEFAULT_LRU_CAP).toBe(400);
    expect(totalMb).toBeLessThan(100);
  });
});

/**
 * Drive the streamer at (px,pz) until the window is exhausted (`pending === 0`
 * — nothing in-flight and nothing left to schedule). The default 4 ms budget
 * still applies: convergence is real frame-sliced work (~1 s), which is what
 * the scheduler exists to do.
 */
function warm(streamer: ChunkStreamer, px: number, pz: number, speed: number, maxFrames = 800) {
  let stats = streamer.update(px, pz, speed);
  for (let f = 0; f < maxFrames && stats.pending > 0; f++) {
    stats = streamer.update(px, pz, speed);
  }
  expect(stats.pending).toBe(0); // guard: the window must drain
  return stats;
}

/** Far-ring impostors in the streamer's 13x13 horizon window (mirrors the schedule). */
function farWindowCount(px: number, pz: number, speed: number, streamer: ChunkStreamer): number {
  const pcx = chunkOfMeters(px);
  const pcz = chunkOfMeters(pz);
  const activeKeys = new Set(activeSet(px, pz, speed).map((a) => chunkKey(a.chunkX, a.chunkZ)));
  let n = 0;
  for (let dx = -6; dx <= 6; dx++) {
    for (let dz = -6; dz <= 6; dz++) {
      const key = chunkKey(pcx + dx, pcz + dz);
      if (activeKeys.has(key)) continue;
      if (lodRingForChunk(pcx + dx, pcz + dz, px, pz) !== 'far') continue;
      if (streamer.isReady(key)) n += 1;
    }
  }
  return n;
}

describe('ChunkStreamer scheduling + LRU', () => {
  let sink: Array<{ message: string }>;

  beforeEach(() => {
    sink = [];
    setPerfLogSink((message) => sink.push({ message }));
  });

  afterEach(() => setPerfLogSink(null)); // restore the default console sink

  it('schedules the active set, completes the whole window, and reports per-ring tris', () => {
    const ready: string[] = [];
    const evicted: string[] = [];
    const streamer = new ChunkStreamer(SEED, PLANET, {
      onChunkReady: (k) => ready.push(k),
      onChunkEvict: (k) => evicted.push(k),
    });
    const stats = warm(streamer, 160, 160, 0);

    // 13 active full chunks + far-window impostors all completed.
    expect(stats.completed).toBeGreaterThan(0);
    for (const a of activeSet(160, 160, 0)) {
      expect(streamer.isReady(chunkKey(a.chunkX, a.chunkZ))).toBe(true);
    }
    expect(streamer.pendingCount).toBe(0);
    expect(ready).toContain(chunkKey(0, 0));
    expect(evicted).toEqual([]); // default cap 400 >> window: nothing to evict

    // Triangle tally over the mountable set at rest: 9 near + 4 mid +
    // 2 tris per ready far impostor in the horizon window.
    const far = farWindowCount(160, 160, 0, streamer);
    expect(stats.triangles).toEqual({
      near: 9 * RING_TRIANGLES.near,
      mid: 4 * RING_TRIANGLES.mid,
      far: far * RING_TRIANGLES.far,
    });
    expect(far).toBeGreaterThan(0);
    expect(stats.maxChunkWorkMs).toBeGreaterThan(0);
    // Backlog pressure (13 active > far-drop threshold) was logged, rate-limited.
    expect(sink.filter((w) => w.message.includes('dropping far-ring generation')).length).toBe(1);
  });

  it('LRU evicts oldest NON-active chunks beyond the cap and never an active one', () => {
    const evicted: string[] = [];
    const streamer = new ChunkStreamer(SEED, PLANET, {
      lruCap: 10,
      onChunkEvict: (k) => evicted.push(k),
    });

    // Station A: drain the window around (160,160). The cap (10) is below the
    // 13 active chunks, so impostors are evicted as they arrive and A ends
    // at exactly its 13 active chunks (eviction cannot touch active).
    warm(streamer, 160, 160, 0);
    const atA = new Set(activeSet(160, 160, 0).map((a) => chunkKey(a.chunkX, a.chunkZ)));
    const readyAtA = new Set([...streamer.entries()].map((e) => e.key));
    expect(readyAtA.size).toBe(13); // floor: 13 active, all else evicted
    for (const k of atA) expect(readyAtA.has(k)).toBe(true);
    expect(evicted.length).toBeGreaterThan(0); // impostors were churned
    for (const k of evicted) expect(atA).not.toContain(k); // never an active chunk
    const frameAtA = Math.max(...[...streamer.entries()].map((e) => e.lastAccessFrame));

    // Jump 30 chunks east: A's whole cache is now > 9.6 km away ('none' ring,
    // not active, not mountable) — the LRU must chew through it as B builds.
    const B = { x: 160 + 30 * CHUNK_METERS, z: 160 };
    warm(streamer, B.x, B.z, 0);
    const activeB = activeSet(B.x, B.z, 0).map((a) => chunkKey(a.chunkX, a.chunkZ));

    // None of B's active chunks was ever evicted; all are ready now.
    for (const k of evicted) expect(activeB).not.toContain(k);
    for (const k of activeB) expect(streamer.isReady(k)).toBe(true);
    // A's 13 oldest full chunks are all gone (oldest LRU stamps).
    for (const k of atA) expect(streamer.isReady(k)).toBe(false);
    // Everything left was accessed after A's window, and the floor holds.
    for (const e of streamer.entries()) expect(e.lastAccessFrame).toBeGreaterThan(frameAtA);
    expect(streamer.readyCount).toBe(13);
  });

  it('reset() drops all state and geometry', () => {
    const streamer = new ChunkStreamer(SEED, PLANET, { lruCap: 4 });
    warm(streamer, 160, 160, 0);
    expect(streamer.readyCount).toBeGreaterThan(0);
    streamer.reset();
    expect(streamer.readyCount).toBe(0);
    expect(streamer.pendingCount).toBe(0);
  });
});

describe('ChunkStreamer chunkFilter + pad (TASK-84)', () => {
  it('filtered chunks are never generated, never cached, never mounted', () => {
    // Island clip: only the z = 0 chunk row is allowed (a degenerate
    // chunkInSurface stand-in — the contract is the same).
    const filter = (cx: number, cz: number) => cz === 0;
    const streamer = new ChunkStreamer(SEED, PLANET, { chunkFilter: filter });
    warm(streamer, 160, 160, 0);
    expect(streamer.pendingCount).toBe(0);
    expect(streamer.readyCount).toBeGreaterThan(0);
    for (const e of streamer.entries()) {
      expect(filter(e.chunkX, e.chunkZ)).toBe(true);
    }
    const mounted = streamer.mountable(160, 160, 0);
    expect(mounted.length).toBeGreaterThan(0);
    for (const m of mounted) {
      expect(filter(m.entry.chunkX, m.entry.chunkZ)).toBe(true);
    }
    // Nothing outside the filter was ever cached, even in the far window.
    for (const a of activeSet(160, 160, 0)) {
      if (!filter(a.chunkX, a.chunkZ))
        expect(streamer.isReady(chunkKey(a.chunkX, a.chunkZ))).toBe(false);
    }
  });

  it('the pad option flattens the built chunk at the pad plane (shared padSurfaceHeight)', () => {
    // A synthetic pad at the center of chunk (0,0) with a distinct height.
    const pad = {
      padId: 'unit-pad',
      planetId: PLANET.id,
      pos: { x: 160, y: 12.5, z: 160 },
      normal: { x: 0, y: 1, z: 0 },
      radius: 20,
    };
    const streamer = new ChunkStreamer(SEED, PLANET, { pad });
    warm(streamer, 160, 160, 0);
    const entry = streamer.getCached(chunkKey(0, 0))!;
    const pos = entry.built.geometries.near!.getAttribute('position').array as Float32Array;
    // Local vertex (32, 32) is (160, 160) = the pad center: on the flat disc.
    const y = pos[(32 * 65 + 32) * 3 + 1];
    expect(y).toBeCloseTo(12.5, 3);
    // 5 m out is still inside the 20 m disc.
    const y2 = pos[(33 * 65 + 32) * 3 + 1];
    expect(y2).toBeCloseTo(12.5, 3);
  });
});
