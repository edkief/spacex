/**
 * TASK-26: frame-sliced streaming-chunk construction.
 *
 * A chunk's world data (heightmap, biome, pads, nodes) comes from the shared
 * deterministic generator (TASK-5); this module turns it into a three-level
 * geometry mip chain (near / mid / far impostor) in BOUNDED WORK UNITS so
 * the scheduler (chunks.ts) can honor its per-frame budget — no unit costs
 * more than a slice of one frame, so streaming never stalls the render loop.
 *
 * The near LOD is a (CHUNK_SIZE+1)^2 vertex grid sampled at 5 m world-cell
 * spacing: column 64 is the NEXT chunk's column 0 (the heightfield is a
 * world-space field), so neighboring meshes share boundary vertices exactly
 * — no cracks at chunk borders. The shared 64x64 subset is bit-identical to
 * TASK-5's `generateSurfaceChunk` heightmap; the placement pass reuses the
 * shared `generateChunkPlacement` verbatim, so staged and one-shot
 * generation produce the same SurfaceChunk.
 */

import * as THREE from 'three';
import {
  CELL_SIZE_M,
  CHUNK_SIZE,
  generateChunkPlacement,
  heightfieldChannels,
} from '@shared/galaxy/surface';
import type { Planet, SurfaceChunk } from '@shared/galaxy/types';
import { PAD_FLAT_BLEND_OUTER_M, padSurfaceHeight, type PadInfo } from '@shared/world/pads';

/** One streaming chunk edge in meters (64 cells x 5 m — the TASK-5 grid). */
export const CHUNK_METERS = CHUNK_SIZE * CELL_SIZE_M; // 320
/** Near-LOD vertex grid: 65x65 (the extra column/row is the shared border). */
export const NEAR_GRID = CHUNK_SIZE + 1;
/** Mid LOD: 2x vertex decimation of the near grid (33x33). */
export const MID_GRID = (NEAR_GRID + 1) / 2;
/** Heightmap rows sampled per work unit (~1 ms of fBm). */
const HEIGHT_ROWS_PER_UNIT = 8;
/** Near-grid rows filled per work unit (the fill is split in two halves). */
const NEAR_ROWS_PER_UNIT = 33;

export type LodRing = 'near' | 'mid' | 'far';

/** Triangles per LOD ring for one full chunk (what renderer.info reports). */
export const RING_TRIANGLES: Record<LodRing, number> = {
  near: (NEAR_GRID - 1) * (NEAR_GRID - 1) * 2, // 64x64 quads = 8192
  mid: (MID_GRID - 1) * (MID_GRID - 1) * 2, // 32x32 quads = 2048
  far: 2, // flat impostor quad
};

/**
 * Estimated bytes of one chunk's mip chain: positions + normals as
 * Float32 (6 floats/vertex), indices as Uint16 (a grid never exceeds
 * 65536 vertices). Feeds the LRU memory estimate (TASK-26 acceptance:
 * 400 chunks < 100 MB of geometry).
 */
export const RING_BYTES: Record<LodRing, number> = {
  near: NEAR_GRID * NEAR_GRID * 6 * 4 + RING_TRIANGLES.near * 3 * 2,
  mid: MID_GRID * MID_GRID * 6 * 4 + RING_TRIANGLES.mid * 3 * 2,
  far: 4 * 6 * 4 + RING_TRIANGLES.far * 3 * 2,
};

export interface ChunkGeometries {
  near: THREE.BufferGeometry | null;
  mid: THREE.BufferGeometry | null;
  far: THREE.BufferGeometry;
}

/** A fully built streaming chunk (world data + the mip chain). */
export interface BuiltChunk {
  /** TASK-5 world data; null for impostor-only (far-ring) entries. */
  chunk: SurfaceChunk | null;
  geometries: ChunkGeometries;
  /** Estimated geometry bytes of this entry's mip chain (may skip LODs). */
  geometryBytes: number;
  /** Which LODs were built (impostor-only entries build just 'far'). */
  rings: LodRing[];
}

export type BuildStage =
  'height' | 'placement' | 'near-positions' | 'near-index' | 'mid' | 'far' | 'done';

/**
 * Frame-sliced, resumable build of one streaming chunk. Each `advanceUnit`
 * does exactly one bounded work unit (row batch / placement / geometry
 * pass) and returns its wall ms; the caller (ChunkStreamer) keeps calling
 * until its per-frame budget is spent.
 */
export class ChunkBuild {
  stage: BuildStage = 'height';
  private readonly seed: string;
  private readonly planet: Planet;
  private readonly chunkX: number;
  private readonly chunkZ: number;
  private readonly field: ReturnType<typeof heightfieldChannels>;
  /** NEAR_GRID^2 world-meter heights (rounded, TASK-5 field), row-major. */
  private readonly grid = new Float32Array(NEAR_GRID * NEAR_GRID);
  private heightRow = 0;
  private readonly nearPos = new Float32Array(NEAR_GRID * NEAR_GRID * 3);
  private readonly nearNrm = new Float32Array(NEAR_GRID * NEAR_GRID * 3);
  private nearRow = 0;
  private surfaceChunk: SurfaceChunk | null = null;
  private result: BuiltChunk | null = null;
  /**
   * TASK-84: the planet's landing pad (at most one per planet — the same
   * PadInfo the server's padSurfaceHeight wrap uses). Its flat disc + blend
   * is applied to the rendered vertex heights only (in WORLD coordinates,
   * so the pad sits flush with the sim). `padActive` is true only for the
   * few chunks whose 320 m square can reach the PAD_FLAT_BLEND_OUTER_M
   * circle — every other chunk pays zero blend cost (the build cost stays
   * flat, verified by the render/transition benches).
   */
  private readonly pad: PadInfo | null;
  private readonly padActive: boolean;

  constructor(
    seed: string,
    planet: Planet,
    chunkX: number,
    chunkZ: number,
    pad?: PadInfo,
  ) {
    this.seed = seed;
    this.planet = planet;
    this.chunkX = chunkX;
    this.chunkZ = chunkZ;
    this.field = heightfieldChannels(seed, planet);
    this.pad = pad ?? null;
    // The blend only matters where the pad's outer blend circle can touch a
    // vertex of this chunk: the closest point of the chunk square to the pad
    // center must be within PAD_FLAT_BLEND_OUTER_M (typically one, at most
    // four, chunks per planet).
    this.padActive =
      this.pad !== null &&
      Math.hypot(
        clampToChunkEdge(chunkX, this.pad.pos.x) - this.pad.pos.x,
        clampToChunkEdge(chunkZ, this.pad.pos.z) - this.pad.pos.z,
      ) <= PAD_FLAT_BLEND_OUTER_M;
  }

  get done(): boolean {
    return this.stage === 'done';
  }

  get built(): BuiltChunk {
    if (!this.result) throw new Error(`chunk build not done (stage: ${this.stage})`);
    return this.result;
  }

  /** Do the next work unit; returns wall milliseconds spent. */
  advanceUnit(now: () => number): number {
    if (this.stage === 'done') return 0;
    const t0 = now();
    switch (this.stage) {
      case 'height':
        this.advanceHeight();
        break;
      case 'placement':
        this.advancePlacement();
        break;
      case 'near-positions':
        this.advanceNearPositions();
        break;
      case 'near-index':
        this.advanceNearIndex();
        break;
      case 'mid':
        this.advanceMid();
        break;
      case 'far':
        this.advanceFar();
        break;
    }
    return now() - t0;
  }

  /** Sample the next HEIGHT_ROWS_PER_UNIT rows of the 65x65 world grid. */
  private advanceHeight(): void {
    const end = Math.min(NEAR_GRID, this.heightRow + HEIGHT_ROWS_PER_UNIT);
    const ox = this.chunkX * CHUNK_SIZE;
    const oz = this.chunkZ * CHUNK_SIZE;
    for (let z = this.heightRow; z < end; z++) {
      for (let x = 0; x < NEAR_GRID; x++) {
        this.grid[z * NEAR_GRID + x] = Math.round(
          this.field.height.fbm01(ox + x, oz + z) * this.field.amp,
        );
      }
    }
    this.heightRow = end;
    if (this.heightRow >= NEAR_GRID) this.stage = 'placement';
  }

  /** TASK-5 placement pass (shared, bit-identical) over the finished grid. */
  private advancePlacement(): void {
    const heightmap = new Array<number>(CHUNK_SIZE * CHUNK_SIZE);
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        heightmap[z * CHUNK_SIZE + x] = this.grid[z * NEAR_GRID + x];
      }
    }
    const { biome, landingPads, resourceNodes } = generateChunkPlacement(
      this.seed,
      this.planet,
      this.chunkX,
      this.chunkZ,
      heightmap,
    );
    this.surfaceChunk = {
      chunkX: this.chunkX,
      chunkZ: this.chunkZ,
      heightmap,
      biome,
      resourceNodes,
      landingPads,
    };
    this.stage = 'near-positions';
  }

  /**
   * Fill the next half of the near-LOD positions + analytic normals
   * (central differences over the height grid — cheaper and deterministic
   * than computeVertexNormals).
   */
  private advanceNearPositions(): void {
    const end = Math.min(NEAR_GRID, this.nearRow + NEAR_ROWS_PER_UNIT);
    for (let z = this.nearRow; z < end; z++) {
      const zUp = (z - 1 + NEAR_GRID) % NEAR_GRID;
      const zDn = (z + 1) % NEAR_GRID;
      for (let x = 0; x < NEAR_GRID; x++) {
        const xL = x > 0 ? x - 1 : x;
        const xR = x < NEAR_GRID - 1 ? x + 1 : x;
        const dx =
          (this.blendedAt(xR, z) - this.blendedAt(xL, z)) /
          ((xR - xL) * CELL_SIZE_M || 1);
        const dz =
          (this.blendedAt(x, zDn) - this.blendedAt(x, zUp)) /
          ((zDn - zUp) * CELL_SIZE_M || 1);
        const len = Math.hypot(dx, 1, dz);
        const i = (z * NEAR_GRID + x) * 3;
        this.nearPos[i] = x * CELL_SIZE_M;
        this.nearPos[i + 1] = this.blendedAt(x, z);
        this.nearPos[i + 2] = z * CELL_SIZE_M;
        this.nearNrm[i] = -dx / len;
        this.nearNrm[i + 1] = 1 / len;
        this.nearNrm[i + 2] = -dz / len;
      }
    }
    this.nearRow = end;
    if (this.nearRow >= NEAR_GRID) this.stage = 'near-index';
  }

  /**
   * TASK-84: the rendered height of grid vertex (x, z) — the TASK-5 field
   * rounded to metres, with the SHARED pad flattening applied in WORLD
   * coordinates (the same padSurfaceHeight the server sim wraps — the pad
   * disc renders flush with the sim's pad plane). The raw `grid` (and thus
   * the placement pass + biome/pad derivation) stays un-blended: it must
   * remain bit-identical to the server's generateSurfaceChunk heightmap.
   * Pads sit on grid vertices (5 m cells), so this never changes which cell
   * a vertex falls in.
   */
  private blendedAt(gx: number, gz: number): number {
    const h = this.grid[gz * NEAR_GRID + gx];
    if (!this.padActive || !this.pad) return h;
    const wx = (this.chunkX * CHUNK_SIZE + gx) * CELL_SIZE_M;
    const wz = (this.chunkZ * CHUNK_SIZE + gz) * CELL_SIZE_M;
    return padSurfaceHeight(wx, wz, h, this.pad);
  }

  /** Near-LOD index (Uint16 — 4225 vertices fits with room to spare). */
  private advanceNearIndex(): void {
    this.nearIndexData = buildQuads(NEAR_GRID, RING_TRIANGLES.near * 3);
    this.stage = 'mid';
  }

  private nearIndexData: Uint16Array | null = null;

  /** Mid LOD: 2x vertex decimation (every other vertex of the near grid). */
  private advanceMid(): void {
    const pos = new Float32Array(MID_GRID * MID_GRID * 3);
    const nrm = new Float32Array(MID_GRID * MID_GRID * 3);
    const idx = buildQuads(MID_GRID, RING_TRIANGLES.mid * 3);
    for (let z = 0; z < MID_GRID; z++) {
      for (let x = 0; x < MID_GRID; x++) {
        const src = (z * 2 * NEAR_GRID + x * 2) * 3;
        const dst = (z * MID_GRID + x) * 3;
        pos[dst] = this.nearPos[src];
        pos[dst + 1] = this.nearPos[src + 1];
        pos[dst + 2] = this.nearPos[src + 2];
        nrm[dst] = this.nearNrm[src];
        nrm[dst + 1] = this.nearNrm[src + 1];
        nrm[dst + 2] = this.nearNrm[src + 2];
      }
    }
    this.midGeometry = makeGeometry(pos, nrm, idx);
    this.stage = 'far';
  }

  private midGeometry: THREE.BufferGeometry | null = null;

  /**
   * Far LOD: flat impostor quad at the chunk's center height (the
   * 2048 m-8 km ring reads as a flat horizon band).
   */
  private advanceFar(): void {
    const h = this.blendedAt(32, 32);
    const pos = new Float32Array([
      0,
      h,
      0,
      CHUNK_METERS,
      h,
      0,
      CHUNK_METERS,
      h,
      CHUNK_METERS,
      0,
      h,
      CHUNK_METERS,
    ]);
    const nrm = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]);
    const idx = new Uint16Array([0, 2, 1, 0, 3, 2]);
    this.farGeometry = makeGeometry(pos, nrm, idx);
    this.finish();
  }

  private farGeometry: THREE.BufferGeometry | null = null;

  private finish(): void {
    if (!this.surfaceChunk) throw new Error('finish() before placement');
    const geometries: ChunkGeometries = {
      near: makeGeometry(this.nearPos, this.nearNrm, this.nearIndexData!),
      mid: this.midGeometry,
      far: this.farGeometry!,
    };
    this.result = {
      chunk: this.surfaceChunk,
      geometries,
      geometryBytes: RING_BYTES.near + RING_BYTES.mid + RING_BYTES.far,
      rings: ['near', 'mid', 'far'],
    };
    this.stage = 'done';
  }
}

/** Clamp a world coordinate to the 320 m edge range of one chunk (negative-safe). */
function clampToChunkEdge(chunk: number, v: number): number {
  const lo = chunk * CHUNK_METERS;
  return Math.min(Math.max(v, lo), lo + CHUNK_METERS);
}

/** (rows-1)^2 quads of a rows×rows grid, consistent winding, row-major. */
function buildQuads(rows: number, triCount3: number): Uint16Array {
  const idx = new Uint16Array(triCount3);
  let q = 0;
  for (let z = 0; z < rows - 1; z++) {
    for (let x = 0; x < rows - 1; x++) {
      const a = z * rows + x;
      const b = a + 1;
      const c = a + rows;
      const d = c + 1;
      idx[q++] = a;
      idx[q++] = c;
      idx[q++] = b;
      idx[q++] = b;
      idx[q++] = c;
      idx[q++] = d;
    }
  }
  return idx;
}

/** A position+normal+index BufferGeometry (Uint16 indices — grids stay < 65536 verts). */
function makeGeometry(
  pos: Float32Array,
  nrm: Float32Array,
  idx: Uint16Array,
): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

/**
 * Cheap impostor-only build for far-ring chunks: one center-height fBm
 * sample + a flat quad (no full heightmap, no mid LOD). A handful of
 * microseconds — the horizon band costs almost nothing, and the streamer
 * drops this tier first when generation falls behind (TASK-26 note).
 */
export class ImpostorBuild {
  stage: BuildStage = 'height';
  private readonly seed: string;
  private readonly planet: Planet;
  private readonly chunkX: number;
  private readonly chunkZ: number;
  private impostor: BuiltChunk | null = null;

  constructor(seed: string, planet: Planet, chunkX: number, chunkZ: number) {
    this.seed = seed;
    this.planet = planet;
    this.chunkX = chunkX;
    this.chunkZ = chunkZ;
  }

  /** One work unit: sample the center height + build the quad. */
  advanceUnit(now: () => number): number {
    if (this.stage === 'done') return 0;
    const t0 = now();
    const { height, amp } = heightfieldChannels(this.seed, this.planet);
    const h = Math.round(
      height.fbm01(
        this.chunkX * CHUNK_SIZE + (CHUNK_SIZE >> 1),
        this.chunkZ * CHUNK_SIZE + (CHUNK_SIZE >> 1),
      ) * amp,
    );
    const pos = new Float32Array([
      0,
      h,
      0,
      CHUNK_METERS,
      h,
      0,
      CHUNK_METERS,
      h,
      CHUNK_METERS,
      0,
      h,
      CHUNK_METERS,
    ]);
    const nrm = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]);
    const idx = new Uint16Array([0, 2, 1, 0, 3, 2]);
    this.impostor = {
      chunk: null,
      geometries: { near: null, mid: null, far: makeGeometry(pos, nrm, idx) },
      geometryBytes: RING_BYTES.far,
      rings: ['far'],
    };
    this.stage = 'done';
    return now() - t0;
  }

  get done(): boolean {
    return this.stage === 'done';
  }

  get built(): BuiltChunk {
    if (!this.impostor) throw new Error('impostor build not done');
    return this.impostor;
  }
}
