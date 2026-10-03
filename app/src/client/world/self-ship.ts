import type { Livery } from '@shared/protocol/schemas';
import type { Quat, Vec3 } from '@shared/physics/vec';
import { applyLivery, buildShipMesh, disposeShipMesh, type ShipMesh } from '@client/render/ship-mesh';

/**
 * TASK-72: the player's OWN ship, as a scene-level mesh. The remote-entity
 * layer drops every entity carrying the self callsign, so this group is the
 * ONLY place the player's ship renders. It lives at SCENE level (like the
 * character capsule), not in the per-system world group, so a warp
 * (swapWorld) never destroys it; the 10 Hz self entity_update keeps driving
 * it even while the player is on foot (the ship sits docked — the object the
 * character walks back to).
 *
 * Renderer-free (pure three.js objects) so the whole lifecycle is unit
 * testable in node. Lifecycle (asserted in self-ship.test.ts):
 *  - `set` CREATES the group on first call and places it;
 *  - a classId change (ship purchase) REBUILDS it — the old group is
 *    disposed first;
 *  - a livery change RE-TINTS the three zone materials in place — no
 *    geometry or material churn, the group identity never changes;
 *  - `set(null)` DISPOSES everything (the ship left the player's hands).
 */

/** One self-ship update from the entity stream (main.tsx bridge). */
export interface SelfShipInput {
  classId: string;
  pos: Vec3;
  rot: Quat;
  livery?: Livery | null;
}

/** What changed during one `set` (diagnostics/tests). */
export interface SelfShipSetResult {
  created: boolean;
  rebuilt: boolean;
  retinted: boolean;
  disposed: boolean;
}

/** A stable key for the (possibly partial/absent) livery — dedup guard. */
function liveryKey(livery: Livery | null | undefined): string {
  if (!livery) return '';
  return [livery.hull ?? '', livery.accent ?? '', livery.trim ?? ''].join('|');
}

export class SelfShip {
  /** The rendered ship (null = not spawned). */
  mesh: ShipMesh | null = null;
  /** `buildShipMesh` calls so far (1 after first spawn, +1 per classId change). */
  builds = 0;

  /**
   * Spawn / update / dispose the self ship. `null` disposes. Returns what
   * happened so the caller (and tests) can tell a re-tint from a rebuild.
   */
  set(state: SelfShipInput | null): SelfShipSetResult {
    const result: SelfShipSetResult = {
      created: false,
      rebuilt: false,
      retinted: false,
      disposed: false,
    };
    if (!state) {
      if (this.mesh) {
        this.dispose();
        result.disposed = true;
      }
      return result;
    }

    if (!this.mesh || this.mesh.classId !== state.classId) {
      // First spawn, or a ship purchase: the silhouette changed, so the
      // whole group is rebuilt (the old one is disposed first).
      this.dispose();
      this.mesh = buildShipMesh(state.classId);
      this.builds += 1;
      // buildShipMesh starts at the class default livery; a different
      // livery arriving with the first update must still be applied.
      const key = liveryKey(state.livery);
      this.lastLiveryKey = key;
      if (key !== '') applyLivery(this.mesh, state.livery);
      result.created = this.builds === 1;
      result.rebuilt = this.builds > 1;
    } else if (liveryKey(state.livery) !== this.lastLiveryKey) {
      // Same hull, new paint: recolor the three zone materials in place.
      this.lastLiveryKey = liveryKey(state.livery);
      applyLivery(this.mesh, state.livery ?? null);
      result.retinted = true;
    }

    this.transform(state.pos, state.rot);
    return result;
  }

  /** Per-frame placement (the 10 Hz snapshot now; client prediction in TASK-73). */
  transform(pos: Vec3, quat: Quat): void {
    if (!this.mesh) return;
    this.mesh.group.position.set(pos.x, pos.y, pos.z);
    this.mesh.group.quaternion.set(quat.x, quat.y, quat.z, quat.w);
  }

  /** Remove + free all geometries and materials (idempotent). */
  dispose(): void {
    if (!this.mesh) return;
    disposeShipMesh(this.mesh);
    this.mesh = null;
    this.lastLiveryKey = null;
  }

  /** The world position of the rendered group (null = not spawned). */
  position(): Vec3 | null {
    if (!this.mesh) return null;
    const p = this.mesh.group.position;
    return { x: p.x, y: p.y, z: p.z };
  }

  /** True while a mesh exists (a scene-level parent keeps it visible). */
  get active(): boolean {
    return this.mesh !== null;
  }

  private lastLiveryKey: string | null = null;
}
