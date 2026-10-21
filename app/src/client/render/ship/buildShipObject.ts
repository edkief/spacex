/**
 * Ship mesh builder (renderer glue) — TASK-74.
 *
 * Wraps the paint-zone material model (`ShipMeshBuilder.ts`) into
 * a three.js `THREE.Group` so the `RenderHost` can add it to the
 * scene with one call. Each zone's material is a
 * `MeshStandardMaterial` initialised via `createThreeMaterialAdapter`;
 * the geometry is a deliberately simple wedge that reads as a
 * spaceship at the chase-camera distance.
 *
 * Numbers (length / width / height) are in world metres (the
 * ship physics model is built around the same units). The
 * impostor is half a metre narrower than the collision radius
 * so it never clips a station pad. Three classes today, three
 * meshes. Extending the catalog is one new entry in
 * `SHIP_CLASS_GEOMETRY` and a couple of helper lines. **DO NOT**
 * add `Math.random` or `Date.now` to the construction path —
 * the determinism spec forbids it.
 *
 * @see ../ships/ShipMeshBuilder.ts — paint-zone model.
 * @see ../ships/threeAdapter.ts    — three.js adapter.
 */
import { ConeGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial } from "three";

import type { ShipClassId } from "@shared/ships.js";
import type { ShipLivery } from "@server/db/types.js";

import { ShipPaintRegistry, liveryToPaintZones } from "../../ships/ShipMeshBuilder.js";
import { createThreeMaterialAdapter } from "../../ships/threeAdapter.js";

/**
 * Per-class geometric envelope — the length, width and height
 * the renderer uses. Numbers in world metres.
 */
export interface ShipClassGeometry {
  readonly length: number;
  readonly width: number;
  readonly height: number;
  /** Number of accent fins (typographical — 0 for bricks). */
  readonly fins: number;
  /** Number of engine glow cylinders. */
  readonly engines: number;
}

/** Catalog — keyed by `ShipClassId`. */
export const SHIP_CLASS_GEOMETRY: Readonly<Record<ShipClassId, ShipClassGeometry>> = Object.freeze({
  scout: { length: 4, width: 1, height: 1, fins: 2, engines: 1 },
  freighter: { length: 6, width: 2, height: 1, fins: 0, engines: 2 },
  interceptor: { length: 5, width: 1, height: 1, fins: 4, engines: 1 },
});

/**
 * Resolve the ship's material for a given (classId, livery)
 * combination via the registry. The registry caches meshes so
 * the impostor GPU material is shared across all ships in the
 * same livery.
 */
function paintFor(
  registry: ShipPaintRegistry,
  meshId: string,
  zone: "hull" | "accent" | "trim",
): MeshStandardMaterial {
  const mesh = registry.getShipMesh(meshId);
  // The paint registry was constructed with
  // `createThreeMaterialAdapter(MeshStandardMaterial)` so the
  // material shape is always the three.js concrete type.
  const mat = mesh?.materials[zone];
  if (mat === undefined) {
    throw new Error(`buildShipObject: paint registry missing material for ${meshId}/${zone}`);
  }
  return mat as unknown as MeshStandardMaterial;
}

/**
 * Build a deterministic three.js group for the given ship class
 * + livery. The returned group is parented once to the
 * scene's ship layer; per-frame state writes
 * (`writeShipStateToObject`) drive the transform.
 */
export function buildShipObject(args: {
  classId: ShipClassId;
  livery: ShipLivery;
  paintRegistry: ShipPaintRegistry;
}): { object: Group; meshId: string } {
  const geom = SHIP_CLASS_GEOMETRY[args.classId];
  const meshId = `${args.classId}:${liveryHash(args.livery)}`;
  // Build the paint registry's material slots for every zone.
  // `buildShipMeshWithLivery` is a no-op if a mesh for `meshId`
  // already exists.
  args.paintRegistry.buildShipMeshWithLivery(meshId, args.classId, args.livery);
  const zones = liveryToPaintZones(args.livery);
  void zones;
  const group = new Group();
  group.userData["meshId"] = meshId;
  group.userData["classId"] = args.classId;
  // Hull — a forward-pointed cone rotated so the apex sits at
  // +Z (the ship's forward axis).
  const hullGeom = new ConeGeometry(geom.width / 2, geom.length, 12);
  hullGeom.rotateX(-Math.PI / 2);
  group.add(new Mesh(hullGeom, paintFor(args.paintRegistry, meshId, "hull")));
  // Accent fins — distributed around the hull's centre. A
  // freighter has none (we add a zero-vertex invisible mesh
  // just so the dispose path stays uniform).
  if (geom.fins === 0) {
    group.add(
      new Mesh(new ConeGeometry(0.01, 0.01, 4), paintFor(args.paintRegistry, meshId, "accent")),
    );
  } else {
    for (let i = 0; i < geom.fins; i++) {
      const fin = new ConeGeometry(geom.width * 0.15, geom.length * 0.3, 8);
      fin.rotateX(-Math.PI / 2);
      const angle = (i / geom.fins) * Math.PI * 2;
      fin.translate(Math.cos(angle) * geom.width * 0.6, 0, Math.sin(angle) * geom.width * 0.6);
      group.add(new Mesh(fin, paintFor(args.paintRegistry, meshId, "accent")));
    }
  }
  // Trim pinstripe running along the top edge of the hull.
  const trimGeom = new CylinderGeometry(0.08, 0.08, geom.length, 6, 1, false);
  trimGeom.rotateX(Math.PI / 2);
  trimGeom.translate(0, geom.height * 0.4, 0);
  group.add(new Mesh(trimGeom, paintFor(args.paintRegistry, meshId, "trim")));
  // Engine glows — count from the geometry; for 1 engine we
  // centre it; for 2+ we split along X.
  for (let i = 0; i < geom.engines; i++) {
    const spread = geom.engines > 1 ? geom.width * 0.3 : 0;
    const offset = i * spread - ((geom.engines - 1) / 2) * spread;
    const cyl = new CylinderGeometry(0.2, 0.2, 0.3, 8, 1, false);
    cyl.rotateZ(Math.PI / 2);
    cyl.translate(offset, 0, -geom.length * 0.5);
    group.add(new Mesh(cyl, paintFor(args.paintRegistry, meshId, "trim")));
  }
  return { object: group, meshId };
}

/**
 * Apply a per-frame state (pos + quat) to the ship group's
 * transform. Cheap: just two setter calls.
 */
export function writeShipStateToObject(
  object: Group,
  pos: { x: number; y: number; z: number },
  quat: { x: number; y: number; z: number; w: number },
): void {
  object.position.set(pos.x, pos.y, pos.z);
  object.quaternion.set(quat.x, quat.y, quat.z, quat.w);
}

/**
 * Cheap deterministic hash of a livery — used to key the ship
 * material cache. Identical liveries share the same impostor
 * GPU material.
 *
 * No `Math.random` / `Date.now` — the hash is purely the hex
 * triple concatenated in lowercase order.
 */
export function liveryHash(livery: ShipLivery): string {
  return [livery.primary, livery.secondary, livery.accent].map((s) => s.toLowerCase()).join("-");
}

/**
 * Convenience factory for the paint registry — used by the
 * `RenderHost`'s GameCanvas effect so the registry lifetime
 * matches the React mount.
 */
export function createPaintRegistry(): ShipPaintRegistry {
  return new ShipPaintRegistry(createThreeMaterialAdapter(MeshStandardMaterial));
}
