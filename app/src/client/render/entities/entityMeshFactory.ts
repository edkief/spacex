/**
 * Entity mesh factory — TASK-75.
 *
 * A pure `ProtocolEntityKind` → three.js `Object3D` map. The
 * remote-entity layer (`RemoteEntityLayer.ts`) acquires one of
 * these per buffered remote and writes the interpolated pose onto
 * it every frame; nothing here reads the clock or the network.
 *
 * The map is typed as an exhaustive `Record<ProtocolEntityKind,
 * EntityMeshBuilder>`, so adding a tenth kind to
 * `EntityKindSchema` fails `tsc` instead of silently rendering
 * nothing.
 *
 * Ship kinds (`ship`, `ai-ship`) reuse the paint-zone machinery in
 * `../../ships/ShipMeshBuilder.ts` via `buildShipObject`. The
 * hostile palette is a constant in this file: an AI ship NEVER
 * wears a player's livery.
 *
 * **DO NOT** add `Math.random` / `Date.now` to a build path — the
 * determinism spec forbids it and the pool rebuilds meshes on
 * demand.
 */
import {
  BoxGeometry,
  CapsuleGeometry,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  Group,
  IcosahedronGeometry,
  Mesh,
  OctahedronGeometry,
  type Object3D,
  SphereGeometry,
} from "three";

import { buildShipObject } from "../ship/buildShipObject.js";
import { sharedMaterial, type PaletteSlot } from "./entityPalette.js";

import type { ShipPaintRegistry } from "@client/ships/ShipMeshBuilder.js";
import type { ShipClassId } from "@shared/ships.js";
import type { ShipLivery } from "@server/db/types.js";
import type { ProtocolEntityKind } from "@shared/protocol/index.js";

/** Dependencies a builder needs. Paint registry is shared with
 *  the own-ship mesh so both draw from one material cache. */
export interface EntityMeshContext {
  readonly paintRegistry: ShipPaintRegistry;
}

/** Builds one mesh for a kind. Pure — same args, same geometry. */
export type EntityMeshBuilder = (ctx: EntityMeshContext) => Object3D;

/** Neutral livery for another player's ship (the wire carries no
 *  paint frame — the owner's palette is not in the snapshot). */
export const REMOTE_SHIP_LIVERY: ShipLivery = Object.freeze({
  primary: "#8fa3b8",
  secondary: "#2b3a4a",
  accent: "#dfe9f2",
});

/** Hostile palette — AI ships only, never a player livery. */
export const HOSTILE_SHIP_LIVERY: ShipLivery = Object.freeze({
  primary: "#c0392b",
  secondary: "#4a1d18",
  accent: "#ffb703",
});

/** Ship class used for remote hulls (the wire kind does not carry
 *  a per-entity class for remotes yet). */
const REMOTE_SHIP_CLASS: ShipClassId = "scout";

/**
 * `userData` key stamped on spinning meshes (drones) so the layer
 * can advance them without a kind switch.
 */
export const SPIN_RATE_KEY = "spinRateRadPerSec";

/** Build the ship hull through the shared paint-zone builder. */
function buildShip(livery: ShipLivery): EntityMeshBuilder {
  return (ctx) =>
    buildShipObject({
      classId: REMOTE_SHIP_CLASS,
      livery,
      paintRegistry: ctx.paintRegistry,
    }).object;
}

/** On-foot character placeholder: an upright capsule. */
function buildCharacter(): EntityMeshBuilder {
  return () => {
    const mesh = new Mesh(new CapsuleGeometry(0.35, 1.1, 4, 8), sharedMaterial("terminalShell"));
    mesh.userData["placeholder"] = true;
    return mesh;
  };
}

/** Flat-shaded rock lump. Deterministic non-uniform scale — no RNG. */
function buildWreck(): EntityMeshBuilder {
  return () => {
    const mesh = new Mesh(new IcosahedronGeometry(1.2, 0), sharedMaterial("hullDark"));
    mesh.scale.set(1.6, 0.7, 1.1);
    mesh.userData["placeholder"] = true;
    return mesh;
  };
}

/** Mineral deposit: a chunky dodecahedron. */
function buildDeposit(): EntityMeshBuilder {
  return () => {
    const mesh = new Mesh(new DodecahedronGeometry(1.5, 0), sharedMaterial("ore"));
    mesh.scale.set(1, 1.2, 1);
    return mesh;
  };
}

/** Station terminal: a shell box plus an emissive screen face. */
function buildTerminal(): EntityMeshBuilder {
  return () => {
    const group = new Group();
    group.add(new Mesh(new BoxGeometry(1.2, 1.6, 0.8), sharedMaterial("terminalShell")));
    const screen = new Mesh(new BoxGeometry(0.8, 0.5, 0.05), sharedMaterial("terminalScreen"));
    screen.position.set(0, 0.25, 0.43);
    group.add(screen);
    return group;
  };
}

/** Ground loot: a small emissive sphere. */
function buildGroundItem(): EntityMeshBuilder {
  return () => {
    const mesh = new Mesh(new SphereGeometry(0.25, 8, 6), sharedMaterial("item"));
    mesh.userData["placeholder"] = true;
    return mesh;
  };
}

/** Missile: a stretched billboard — an elongated cone with a
 *  glowing tip, always readable edge-on at speed. */
function buildMissile(): EntityMeshBuilder {
  return () => {
    const group = new Group();
    const body = new Mesh(new ConeGeometry(0.15, 1.8, 6), sharedMaterial("missileBody"));
    body.rotation.x = -Math.PI / 2;
    body.position.z = -0.4;
    group.add(body);
    const tip = new Mesh(new ConeGeometry(0.16, 0.5, 6), sharedMaterial("missileTip"));
    tip.rotation.x = -Math.PI / 2;
    tip.position.z = 0.75;
    group.add(tip);
    group.userData["stretchedBillboard"] = true;
    return group;
  };
}

/** Mining drone: a small octahedron that spins every frame. */
function buildDrone(): EntityMeshBuilder {
  return () => {
    const group = new Group();
    const body = new Mesh(new OctahedronGeometry(0.5, 0), sharedMaterial("drone"));
    group.add(body);
    const ring = new Mesh(new CylinderGeometry(0.62, 0.62, 0.06, 6), sharedMaterial("hullDark"));
    group.add(ring);
    group.userData[SPIN_RATE_KEY] = 1.8;
    return group;
  };
}

/**
 * The exhaustive kind → builder map. `Record<ProtocolEntityKind, …>`
 * is the build-time contract the acceptance criteria ask for.
 */
export const ENTITY_MESH_BUILDERS: Readonly<Record<ProtocolEntityKind, EntityMeshBuilder>> =
  Object.freeze({
    ship: buildShip(REMOTE_SHIP_LIVERY),
    character: buildCharacter(),
    "ai-ship": buildShip(HOSTILE_SHIP_LIVERY),
    wreck: buildWreck(),
    deposit: buildDeposit(),
    terminal: buildTerminal(),
    groundItem: buildGroundItem(),
    missile: buildMissile(),
    drone: buildDrone(),
  });

/** Every kind the protocol can push, in enum order. */
export const PROTOCOL_ENTITY_KINDS: readonly ProtocolEntityKind[] = Object.freeze(
  Object.keys(ENTITY_MESH_BUILDERS) as ProtocolEntityKind[],
);

/**
 * Build the mesh for one kind. Unknown kinds (forward-compat with a
 * newer server) fall back to the `ship` builder rather than
 * rendering nothing.
 */
export function buildEntityMesh(
  kind: ProtocolEntityKind | string | undefined,
  ctx: EntityMeshContext,
): Object3D {
  const builder = kind !== undefined ? ENTITY_MESH_BUILDERS[kind as ProtocolEntityKind] : undefined;
  return (builder ?? ENTITY_MESH_BUILDERS.ship)(ctx);
}

/**
 * Release the GPU resources of a pooled mesh. Shared palette
 * materials are left alone (`SHARED_MATERIAL_KEY`); only
 * per-object geometry is disposed. Safe to call twice.
 */
export function disposeEntityMesh(object: Object3D): void {
  object.traverse((node) => {
    const mesh = node as Mesh;
    if (mesh.geometry !== undefined) mesh.geometry.dispose();
  });
}

/** Palette slot re-export so tests can assert on the shared cache. */
export type { PaletteSlot };
