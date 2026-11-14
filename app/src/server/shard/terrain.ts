import { chunkInChart } from '@shared/galaxy/chart.ts';
import { generateSurfaceChunk } from '@shared/galaxy/surface.ts';
import { CHUNK_SIZE_M, createSurfaceField, type SurfaceField } from '@shared/galaxy/terrain.ts';
import type { Planet, SystemGen } from '@shared/galaxy/types.ts';
import type { FlatPad, SurfaceProvider } from '@shared/physics/flightTypes.ts';
import { parseFrame, type FrameId } from '@shared/physics/frames.ts';
import type { Vec3 } from '@shared/physics/vec.ts';

/** Flat metres around a ship within which chunks are searched for pads (pad radius, stretched). */
const PAD_SEARCH_M = 32;
const MAX_CACHED_CHUNKS = 512;

/**
 * Terrain access for one system's sim: a cached height field per surface frame, and landing
 * pads from lazily generated (and cached) chunks. Pads are only looked up when the flight model
 * actually asks for them, which is when a ship is on the ground and slow.
 */
export class SurfaceAccess {
  private readonly planets: Map<string, Planet>;
  private readonly fields = new Map<FrameId, SurfaceField>();
  private readonly pads = new Map<string, readonly FlatPad[]>();
  private readonly seed: string;

  constructor(seed: string, system: SystemGen) {
    this.seed = seed;
    this.planets = new Map(system.planets.filter((p) => p.landable).map((p) => [p.id, p]));
  }

  private field(frame: FrameId): { field: SurfaceField; planet: Planet } | undefined {
    const ref = parseFrame(frame);
    const planet = ref && this.planets.get(ref.planetId);
    if (!ref || !planet) return undefined;
    let field = this.fields.get(frame);
    if (!field) {
      field = createSurfaceField(this.seed, planet, ref.hemisphere);
      this.fields.set(frame, field);
    }
    return { field, planet };
  }

  private chunkPads(frame: FrameId, planet: Planet, cx: number, cz: number): readonly FlatPad[] {
    const key = `${frame}:${cx}:${cz}`;
    const cached = this.pads.get(key);
    if (cached) return cached;
    const ref = parseFrame(frame);
    const pads =
      ref && chunkInChart(planet.simRadius, cx, cz, CHUNK_SIZE_M)
        ? generateSurfaceChunk(this.seed, planet, cx, cz, ref.hemisphere).landingPads
        : [];
    if (this.pads.size >= MAX_CACHED_CHUNKS) this.pads.clear();
    this.pads.set(key, pads);
    return pads;
  }

  /** Pads of the chunks within reach of a flat position. */
  padsNear(frame: FrameId, pos: Vec3): readonly FlatPad[] {
    const found = this.field(frame);
    if (!found) return [];
    const lo = (v: number): number => Math.floor((v - PAD_SEARCH_M) / CHUNK_SIZE_M);
    const hi = (v: number): number => Math.floor((v + PAD_SEARCH_M) / CHUNK_SIZE_M);
    const pads: FlatPad[] = [];
    for (let cz = lo(pos.z); cz <= hi(pos.z); cz++) {
      for (let cx = lo(pos.x); cx <= hi(pos.x); cx++) {
        pads.push(...this.chunkPads(frame, found.planet, cx, cz));
      }
    }
    return pads;
  }

  /** The terrain provider for a ship at `pos` in `frame`; undefined for unknown frames. */
  provider(frame: FrameId, pos: Vec3): SurfaceProvider | undefined {
    const found = this.field(frame);
    if (!found) return undefined;
    const padsNear = (): readonly FlatPad[] => this.padsNear(frame, pos);
    return {
      heightAt: (x, z) => found.field.heightAt(x, z),
      get pads() {
        return padsNear();
      },
    };
  }
}
