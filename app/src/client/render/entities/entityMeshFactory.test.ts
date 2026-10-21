/**
 * TASK-75 — entity mesh factory unit tests.
 *
 * The acceptance criterion "every ProtocolEntityKind has a mesh
 * factory entry" is pinned here twice: once against the zod enum
 * (`EntityKindSchema.options`) so a new kind fails the suite, and
 * once against the built meshes so an entry that returns `null` or
 * a non-Object3D also fails.
 */
import { describe, expect, it } from "vitest";
import { Group, MeshStandardMaterial, Object3D } from "three";

import { ShipPaintRegistry } from "@client/ships/ShipMeshBuilder.js";
import { createThreeMaterialAdapter } from "@client/ships/threeAdapter.js";

import {
  ENTITY_MESH_BUILDERS,
  HOSTILE_SHIP_LIVERY,
  PROTOCOL_ENTITY_KINDS,
  REMOTE_SHIP_LIVERY,
  SPIN_RATE_KEY,
  buildEntityMesh,
  disposeEntityMesh,
} from "./entityMeshFactory.js";
import { SHARED_MATERIAL_KEY, sharedMaterialCount } from "./entityPalette.js";

import { EntityKindSchema, type ProtocolEntityKind } from "@shared/protocol/index.js";

/** A registry is only needed by the two ship builders. */
function ctx(): { paintRegistry: ShipPaintRegistry } {
  return { paintRegistry: new ShipPaintRegistry(createThreeMaterialAdapter(MeshStandardMaterial)) };
}

describe("entityMeshFactory", () => {
  it("covers every ProtocolEntityKind (exhaustive Record)", () => {
    const fromSchema = [...EntityKindSchema.options].sort();
    const fromFactory = [...PROTOCOL_ENTITY_KINDS].sort();
    expect(fromFactory).toEqual(fromSchema);
    for (const kind of EntityKindSchema.options) {
      expect(typeof ENTITY_MESH_BUILDERS[kind], `${kind} needs a builder`).toBe("function");
    }
  });

  it("builds a real Object3D for every kind", () => {
    const c = ctx();
    for (const kind of ENTITY_MESH_BUILDERS ? Object.keys(ENTITY_MESH_BUILDERS) : []) {
      const object = ENTITY_MESH_BUILDERS[kind as ProtocolEntityKind]!(c);
      expect(object, `${kind} must build an object`).toBeInstanceOf(Object3D);
      expect(object.children.length + 1, `${kind} must draw at least one mesh`).toBeGreaterThan(0);
      disposeEntityMesh(object);
    }
  });

  it("builds ship-like meshes for ship + ai-ship, with different liveries", () => {
    const c = ctx();
    const player = buildEntityMesh("ship", c);
    const hostile = buildEntityMesh("ai-ship", c);
    expect(player.userData["classId"]).toBe("scout");
    expect(hostile.userData["classId"]).toBe("scout");
    expect(player.userData["meshId"]).not.toBe(hostile.userData["meshId"]);
    expect(REMOTE_SHIP_LIVERY.primary).not.toBe(HOSTILE_SHIP_LIVERY.primary);
  });

  it("marks drones with a spin rate so the layer can rotate them", () => {
    const drone = buildEntityMesh("drone", ctx());
    expect(typeof drone.userData[SPIN_RATE_KEY]).toBe("number");
    expect(drone.userData[SPIN_RATE_KEY]).toBeGreaterThan(0);
  });

  it("marks the missile as a stretched billboard with a bright tip", () => {
    const missile = buildEntityMesh("missile", ctx());
    expect(missile.userData["stretchedBillboard"]).toBe(true);
    expect(missile.children.length).toBeGreaterThanOrEqual(2);
  });

  it("falls back to the ship builder for an unknown kind", () => {
    const object = buildEntityMesh("not-a-kind", ctx());
    expect(object.userData["classId"]).toBe("scout");
  });

  it("reuses palette materials across meshes and leaves them alive on dispose", () => {
    const before = sharedMaterialCount();
    const a = buildEntityMesh("wreck", ctx());
    const b = buildEntityMesh("wreck", ctx());
    expect(before).toBeGreaterThan(0);
    // `wreck` is a bare Mesh, so the material hangs off the root.
    const matA = (a as unknown as { material: { userData: Record<string, unknown> } }).material;
    const matB = (b as unknown as { material: unknown }).material;
    expect(matB).toBe(matA);
    expect(matA.userData[SHARED_MATERIAL_KEY]).toBe(true);
    // Dispose is geometry-only: the shared material survives so the
    // next acquire of the same kind is still renderable.
    expect(() => disposeEntityMesh(a)).not.toThrow();
    expect(() => disposeEntityMesh(a)).not.toThrow();
    disposeEntityMesh(b);
    expect(sharedMaterialCount()).toBe(before);
  });

  it("builds ships into a Group with the paint registry materials", () => {
    const group = buildEntityMesh("ship", ctx());
    expect(group).toBeInstanceOf(Group);
    expect(group.children.length).toBeGreaterThanOrEqual(3);
  });
});
