import * as THREE from 'three';
import type { Quat, Vec3 } from '@shared/physics/vec.ts';
import type { ShipClassId } from '@shared/ships/ids.ts';
import type { Livery } from '@shared/ships/livery.ts';
import { relativeTo } from './relative.ts';

/** Hull length (m), width factor and wing span factor per class: placeholder silhouettes. */
const SHAPES: Readonly<Record<ShipClassId, { length: number; girth: number; wing: number }>> = {
  scout: { length: 14, girth: 2.6, wing: 9 },
  freighter: { length: 26, girth: 6, wing: 8 },
  interceptor: { length: 17, girth: 2.2, wing: 13 },
};

const DEFAULT_LIVERY: Livery = { hull: '#c8ccd8', accent: '#3d7bd9', trim: '#f2b134' };

/** Builds a placeholder ship: a hull cone with its nose along -z, a wing slab and an engine. */
function buildShip(classId: ShipClassId, livery: Livery): THREE.Group {
  const shape = SHAPES[classId];
  const group = new THREE.Group();
  const hull = new THREE.Mesh(
    new THREE.ConeGeometry(shape.girth, shape.length, 12),
    new THREE.MeshStandardMaterial({ color: livery.hull, roughness: 0.5, metalness: 0.4 }),
  );
  hull.rotation.x = -Math.PI / 2; // cone axis +y -> nose along -z
  const wing = new THREE.Mesh(
    new THREE.BoxGeometry(shape.wing * 2, 0.5, shape.length * 0.35),
    new THREE.MeshStandardMaterial({ color: livery.accent, roughness: 0.6 }),
  );
  wing.position.z = shape.length * 0.2;
  const engine = new THREE.Mesh(
    new THREE.SphereGeometry(shape.girth * 0.55, 12, 8),
    new THREE.MeshBasicMaterial({ color: livery.trim }),
  );
  engine.position.z = shape.length * 0.5;
  group.add(hull, wing, engine);
  return group;
}

export interface ShipDescriptor {
  id: string;
  classId: ShipClassId | null;
  livery?: Livery | undefined;
}

/**
 * Keeps one mesh per ship entity in step with the entity set: adds new ones, removes vanished
 * ones, and places each camera-relative every frame.
 */
export class ShipMeshes {
  readonly root = new THREE.Group();
  private readonly meshes = new Map<string, THREE.Group>();

  get count(): number {
    return this.meshes.size;
  }

  has(id: string): boolean {
    return this.meshes.has(id);
  }

  /** Makes the mesh set match `ships` (by id). */
  sync(ships: readonly ShipDescriptor[]): void {
    const wanted = new Set(ships.map((ship) => ship.id));
    for (const [id, mesh] of this.meshes) {
      if (wanted.has(id)) continue;
      this.root.remove(mesh);
      this.meshes.delete(id);
    }
    for (const ship of ships) {
      if (this.meshes.has(ship.id)) continue;
      const mesh = buildShip(ship.classId ?? 'scout', ship.livery ?? DEFAULT_LIVERY);
      mesh.name = `ship:${ship.id}`;
      this.meshes.set(ship.id, mesh);
      this.root.add(mesh);
    }
  }

  /** Places one ship at its world pose relative to the camera. */
  place(id: string, world: Vec3, quat: Quat, cameraWorld: Vec3): void {
    const mesh = this.meshes.get(id);
    if (!mesh) return;
    const p = relativeTo(world, cameraWorld);
    mesh.position.set(p.x, p.y, p.z);
    mesh.quaternion.set(quat.x, quat.y, quat.z, quat.w);
  }
}
