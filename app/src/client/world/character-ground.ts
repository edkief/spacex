/**
 * TASK-88: the on-foot character's ground height — the SAME expression the
 * server sim uses for character physics, so the local prediction (TASK-32
 * CharacterPredictor) tracks the same ground the server collides with.
 *
 * WHY THIS EXISTS: the predictor used to run on a FLAT pad plane (the pad
 * height constant). The server runs `padSurfaceHeight(x, z, ctx.heightAt,
 * pad)` — seeded terrain blended into the pad. Once the character walked
 * beyond the pad's flat disc (~30 m, ~5-10 s of walking), the predicted
 * feet stayed at pad height while the real terrain rose above them: the
 * predicted character — and the on-foot camera rigidly tracking it — sank
 * INSIDE the terrain mesh, and the opaque terrain painted the whole canvas
 * black (the owner-reported on-foot blackout). Feeding the prediction the
 * identical expression keeps the predicted feet on the true surface for
 * arbitrarily long walks.
 *
 * Reuses (does not re-derive): the server's `TerrainContext` (bilinear
 * sample over the seeded 5 m grid, O(1) cached neighborhood — the client
 * imports @server/shard/terrain, a pure module with no node dependencies)
 * and the shared `padSurfaceHeight` pad blend.
 */
import { TerrainContext } from '@server/shard/terrain';
import { padSurfaceHeight, padsForSystem, type PadInfo } from '@shared/world/pads';
import type { SystemGen } from '@shared/galaxy/types';
import type { Planet } from '@shared/galaxy/types';

export class CharacterGround {
  private planet: Planet | null = null;
  private pad: PadInfo | null = null;
  /** Lazy — the neighborhood generates on the first sample (not at setPlanet). */
  private ctx: TerrainContext | null = null;

  constructor(private readonly seed: string) {}

  /**
   * The planet the character is on (the disembark planet). Re-derives the
   * pad from the shared deterministic pad list and resets the terrain cache
   * (a planet change = a fresh heightfield). Null clears the source (the
   * height falls back to flat, defensive — on foot a planet always exists).
   */
  setPlanet(system: SystemGen | null, planetId: string | null): void {
    if (!system || !planetId) {
      this.planet = null;
      this.pad = null;
      this.ctx = null;
      return;
    }
    this.planet = system.planets.find((p) => p.id === planetId) ?? null;
    this.pad =
      this.planet !== null
        ? (padsForSystem(this.seed, system).find((p) => p.planetId === this.planet!.id) ?? null)
        : null;
    this.ctx = null;
  }

  /** The current planet's pad (diagnostics / tests). */
  get padOfPlanet(): PadInfo | null {
    return this.pad;
  }

  /**
   * Ground height at world (x, z): seeded terrain bilinearly sampled and
   * blended into the pad disc — `padSurfaceHeight(x, z, heightAt, pad)`,
   * byte-for-byte the server's expression (shard.ts character tick).
   */
  heightAt(x: number, z: number): number {
    if (!this.planet) return this.pad ? this.pad.pos.y : 0;
    if (!this.ctx) this.ctx = new TerrainContext(this.seed, this.planet);
    // O(1) no-op while the walker stays in the current chunk (server pattern:
    // refresh the cached 3x3 neighborhood, then sample).
    this.ctx.update(x, z);
    return padSurfaceHeight(x, z, this.ctx.heightAt(x, z), this.pad ?? undefined);
  }
}
