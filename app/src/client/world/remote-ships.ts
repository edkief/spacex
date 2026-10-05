import * as THREE from 'three';

import {
  applyLivery,
  buildShipMesh,
  buildMergedShip,
  disposeShipMesh,
  recolorMerged,
  shipStateMaterial,
  stateKeyForOpacity,
  type MergedShipMesh,
  type ShipMesh,
} from '@client/render/ship-mesh';
import type { Livery } from '@shared/protocol/schemas';

/**
 * TASK-74 / TASK-58: the SHIP render path for the remote-entity layer (the
 * per-kind module pattern — remote-entities.ts stays the dispatcher).
 *
 * Tuned path (the default since TASK-58): ONE merged geometry per ship —
 * the class silhouette baked into a single draw call, livery in a per-ship
 * vertex-color buffer, lit by ONE of three shared state materials (the
 * stale/dimmed rule is material SELECTION, not per-material opacity). 16
 * ships = 16 draw calls + 3 materials, instead of 16 × 7 meshes + 48
 * materials (the AC-3 contract).
 *
 * Legacy path (`merged: false`, pre-TASK-58 tuning — the benchmark's
 * baseline mode): one buildShipMesh (TASK-21) per id, 3 MeshStandard
 * materials per ship.
 *
 * - `ship`    — a remote player's ship, livery-tinted when the wire livery
 *   changes (dedup: the wire livery is stable, most frames are a no-op).
 * - `ai-ship` — a rogue AI: the class silhouette + livery fallback, but the
 *   TRIM zone is always forced to AI_SHIP_TRIM_COLOR so players can tell a
 *   hostile apart at a glance.
 *
 * No per-frame material churn: creation applies the livery once, per-frame
 * work is transform + state, and dispose frees the per-ship geometry exactly
 * once when the entity leaves (the shared state materials are never freed).
 */

/** The single hostile accent — every ai-ship's trim zone, no exceptions. */
export const AI_SHIP_TRIM_COLOR = '#e5484d';
/** Label anchor above the ship origin (m — clears the 0.7 m dorsal fin). */
export const SHIP_LABEL_HEIGHT_M = 2.0;

export interface ShipRender {
  /** The hull class (ship swap detection in the layer). */
  classId: string;
  group: THREE.Group;
  /** kind 'ai-ship' — the trim zone is forced to AI_SHIP_TRIM_COLOR. */
  ai: boolean;
  /**
   * The wire livery last applied, canonicalized (null = none seen yet).
   * The dedup guard — applyShipLivery is a no-op when it is unchanged.
   */
  liveryKey: string | null;
  /** The merged (tuned) mesh — set when created with the default mode. */
  mergedMesh: MergedShipMesh | null;
  /** The legacy (pre-tuning) mesh — set in `merged: false` mode. */
  legacyMesh: ShipMesh | null;
}

/** Canonical form of a (possibly partial) wire livery — stable key + apply. */
export function liveryKey(livery: Livery | null | undefined): string {
  if (!livery) return '';
  return Object.keys(livery)
    .sort()
    .map((k) => `${k}=${livery[k]}`)
    .join(';');
}

/**
 * Create the render for one remote ship (tuned merged mode by default;
 * `merged: false` for the benchmark's pre-tuning baseline). Applies the
 * initial livery (the class default when absent) and forces the hostile
 * trim on AI ships.
 */
export function createShipRender(
  classId: string,
  ai: boolean,
  livery?: Livery,
  opts: { merged?: boolean } = {},
): ShipRender {
  const merged = opts.merged ?? true;
  const render: ShipRender = {
    classId,
    group: new THREE.Group(),
    ai,
    liveryKey: null,
    mergedMesh: merged ? buildMergedShip(classId) : null,
    legacyMesh: merged ? null : buildShipMesh(classId),
  };
  if (render.legacyMesh) {
    render.group = render.legacyMesh.group;
    for (const mat of Object.values(render.legacyMesh.zones)) mat.transparent = true;
  } else {
    render.group.add(render.mergedMesh!.mesh);
  }
  applyShipLivery(render, livery);
  return render;
}

/**
 * Re-tint in place: recolors only when the wire livery CHANGED (the dedup
 * guard — the livery is stable across most 10 Hz batches). AI ships always
 * end with the hostile trim, livery or not (the recolor would overwrite it).
 */
export function applyShipLivery(render: ShipRender, livery: Livery | null | undefined): void {
  const key = liveryKey(livery);
  if (key === render.liveryKey) return;
  render.liveryKey = key;
  if (render.mergedMesh) recolorMerged(render.mergedMesh, livery, render.ai);
  else if (render.legacyMesh) {
    applyLivery(render.legacyMesh, livery);
    if (render.ai) render.legacyMesh.zones.trim.color.set(AI_SHIP_TRIM_COLOR);
  }
}

/**
 * The stale/dimmed opacity rule: the tuned path SWAPS the shared state
 * material (no per-ship material exists to touch); the legacy path sets the
 * three zone opacities (same values as remote characters).
 */
export function setShipOpacity(render: ShipRender, opacity: number): void {
  if (render.mergedMesh) {
    render.mergedMesh.mesh.material = shipStateMaterial(stateKeyForOpacity(opacity));
  } else if (render.legacyMesh) {
    for (const mat of Object.values(render.legacyMesh.zones)) mat.opacity = opacity;
  }
}

/**
 * Free the per-ship resources (entity left / world swap — exactly once).
 * The shared state materials are module-level and never disposed.
 */
export function disposeShipRender(render: ShipRender): void {
  if (render.mergedMesh) {
    render.mergedMesh.geometry.dispose();
    render.group.clear();
  } else if (render.legacyMesh) {
    disposeShipMesh(render.legacyMesh);
  }
}
