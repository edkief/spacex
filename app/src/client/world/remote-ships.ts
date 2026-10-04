import * as THREE from 'three';

import {
  applyLivery,
  buildShipMesh,
  disposeShipMesh,
  type ShipMesh,
} from '@client/render/ship-mesh';
import type { Livery } from '@shared/protocol/schemas';

/**
 * TASK-74: the SHIP render path for the remote-entity layer (the per-kind
 * module pattern — remote-entities.ts stays the dispatcher).
 *
 * One buildShipMesh (TASK-21) per remote ship id, riding the same 200 ms
 * interpolation buffer as remote characters. The three paint zones are
 * MeshStandardMaterials, so the stale/dimmed opacity rule works on them
 * (transparent = true, set once at creation — never toggled per frame).
 *
 * - `ship`    — a remote player's ship, livery-tinted when the wire livery
 *   changes (dedup: the wire livery is stable, most frames are a no-op).
 * - `ai-ship` — a rogue AI: the class silhouette + livery fallback, but the
 *   TRIM zone is always forced to AI_SHIP_TRIM_COLOR so players can tell a
 *   hostile apart at a glance.
 *
 * No per-frame material churn: creation applies the livery once, per-frame
 * work is transform + opacity, and disposeShipMesh frees geometries +
 * materials exactly once when the entity leaves.
 */

/** The single hostile accent — every ai-ship's trim zone, no exceptions. */
export const AI_SHIP_TRIM_COLOR = '#e5484d';
/** Label anchor above the ship origin (m — clears the 0.7 m dorsal fin). */
export const SHIP_LABEL_HEIGHT_M = 2.0;

export interface ShipRender {
  mesh: ShipMesh;
  group: THREE.Group;
  /** kind 'ai-ship' — the trim zone is forced to AI_SHIP_TRIM_COLOR. */
  ai: boolean;
  /**
   * The wire livery last applied, canonicalized (null = none seen yet).
   * The dedup guard — applyShipLivery is a no-op when it is unchanged.
   */
  liveryKey: string | null;
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
 * Create the render for one remote ship: build the class silhouette, arm
 * the zone materials for opacity fades, apply the initial livery (the class
 * default when absent — applyLivery already falls back per slot), and force
 * the hostile trim on AI ships.
 */
export function createShipRender(classId: string, ai: boolean, livery?: Livery): ShipRender {
  const mesh = buildShipMesh(classId);
  for (const mat of Object.values(mesh.zones)) mat.transparent = true;
  const render: ShipRender = { mesh, group: mesh.group, ai, liveryKey: null };
  applyShipLivery(render, livery);
  return render;
}

/**
 * Re-tint in place: recolors only when the wire livery CHANGED (the dedup
 * guard — the livery is stable across most 10 Hz batches). AI ships always
 * end with the hostile trim, livery or not (applyLivery would overwrite it).
 */
export function applyShipLivery(render: ShipRender, livery: Livery | null | undefined): void {
  const key = liveryKey(livery);
  if (key === render.liveryKey) return;
  render.liveryKey = key;
  applyLivery(render.mesh, livery);
  if (render.ai) render.mesh.zones.trim.color.set(AI_SHIP_TRIM_COLOR);
}

/** The stale/dimmed opacity rule (same values as remote characters). */
export function setShipOpacity(render: ShipRender, opacity: number): void {
  for (const mat of Object.values(render.mesh.zones)) mat.opacity = opacity;
}

/** Free geometries + materials (entity left / world swap — exactly once). */
export function disposeShipRender(render: ShipRender): void {
  disposeShipMesh(render.mesh);
}
