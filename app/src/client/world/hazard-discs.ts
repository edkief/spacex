import * as THREE from 'three';

import type { Vec3 } from '@shared/physics/vec';
import type { SystemGen } from '@shared/galaxy/types';
import { hazardsFor, HAZARD_RENDER_RANGE_M, type HazardKind } from '@shared/world/hazards';

/**
 * TASK-48.3: the 3D hazard markers (per-kind module, like remote-ships.ts).
 *
 * Hazard cells are DERIVED, never streamed (same contract as pads/deposits):
 * `hazardsFor(seed, system)` is the shared function the SERVER's exposure
 * math uses, so the discs sit exactly where the server says the hazards are.
 * Drone cells get NO ground disc — the drones themselves (streamed entities,
 * remote-entities.ts) are the marker.
 *
 * Cost budget (spec: hazards are a reason to route around, not spectacle):
 * - storm   = 8 flat quads radially arranged in a SPIN group (one shared
 *             geometry + one additive material per cell);
 * - radzone = a single flat additive green disc.
 * Everything is built ONCE in swapWorld (the groups live in the per-system
 * world group and die with it); the frame loop only flips `visible` (the
 * 500 m cull, same rule as the pad rings) and sets the spin group's
 * rotation — no per-frame allocation.
 */

/** One hazard disc placement (pure data, mirrors the shared Hazard). */
export interface HazardDiscPlacement {
  hazardId: string;
  /** Drone cells carry no disc — only these two kinds reach the build. */
  kind: Exclude<HazardKind, 'drones'>;
  x: number;
  y: number;
  z: number;
  radius: number;
  intensity: number;
}

/**
 * Pure: the hazard discs of a system — `hazardsFor` (the same shared
 * deterministic list the server's hazard math uses, cached per system)
 * minus the drone cells.
 */
export function hazardDiscsFor(
  seed: string,
  system: Pick<SystemGen, 'systemId' | 'planets'>,
): HazardDiscPlacement[] {
  return hazardsFor(seed, system)
    .filter((h) => h.kind !== 'drones')
    .map((h) => ({
      hazardId: h.hazardId,
      kind: h.kind as Exclude<HazardKind, 'drones'>,
      x: h.pos.x,
      y: h.pos.y,
      z: h.pos.z,
      radius: h.radius,
      intensity: h.intensity,
    }));
}

/**
 * Pure: is a hazard disc at `discPos` visible to the player at `pos` —
 * within HAZARD_RENDER_RANGE_M (3-D distance, metres = world units), the
 * same 500 m rule as the pad rings. No known player position → hidden.
 */
export function hazardDiscVisible(
  pos: Vec3 | null,
  discPos: { x: number; y: number; z: number },
): boolean {
  if (!pos) return false;
  return (
    Math.hypot(pos.x - discPos.x, pos.y - discPos.y, pos.z - discPos.z) <= HAZARD_RENDER_RANGE_M
  );
}

/** Quads around a storm cell center (spec: cheap swirling disc). */
export const STORM_QUAD_COUNT = 8;
/** Storm quads float this far above the cell's ground height (z-fight guard). */
export const HAZARD_DISC_SURFACE_OFFSET_M = 0.5;
/** Base storm spin (rad/s) — intensity scales it up. */
const STORM_BASE_SPIN_RAD_PER_S = 0.6;
const STORM_SPIN_PER_INTENSITY = 0.3;

/** One built hazard disc (attached to the per-system world group). */
export interface HazardDiscRender {
  group: THREE.Group;
  /** The cell center — the culling anchor. */
  center: THREE.Vector3;
  /** The storm's spin group (rotation driven per frame); null for rad zones. */
  spin: THREE.Group | null;
  /** Storm spin speed (rad/s, intensity-scaled); 0 for rad zones. */
  spinSpeed: number;
  /** The placement the disc was built from (dev probe / e2e). */
  placement: HazardDiscPlacement;
}

/** Opacity by intensity tier (1.0 → base, 2.0 → strongest). */
function discOpacity(base: number, perIntensity: number, intensity: number): number {
  return base + (intensity - 1) * perIntensity;
}

/**
 * One storm cell: 8 flat quads in a spin group, all sharing ONE geometry and
 * ONE additive material (the whole cell costs 8 draw-callable quads of a
 * trivial PlaneGeometry — no textures, no particles).
 */
function buildStormCell(pl: HazardDiscPlacement): {
  group: THREE.Group;
  spin: THREE.Group;
  spinSpeed: number;
} {
  const group = new THREE.Group();
  group.position.set(pl.x, pl.y + HAZARD_DISC_SURFACE_OFFSET_M, pl.z);
  const spin = new THREE.Group();
  group.add(spin);
  const quadGeometry = new THREE.PlaneGeometry(2.5, pl.radius * 1.8);
  const quadMaterial = new THREE.MeshBasicMaterial({
    color: '#a78bfa',
    transparent: true,
    opacity: discOpacity(0.3, 0.25, pl.intensity),
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  for (let i = 0; i < STORM_QUAD_COUNT; i++) {
    const angle = (i / STORM_QUAD_COUNT) * Math.PI * 2;
    // The holder aims the quad's long axis radially; the quad itself lies
    // flat on the ground inside it.
    const holder = new THREE.Group();
    holder.position.set(Math.cos(angle) * pl.radius * 0.5, 0, Math.sin(angle) * pl.radius * 0.5);
    // rotation.y = θ aims the holder's +Z (the quad's long axis) at (sinθ, 0,
    // cosθ); the radial direction at `angle` is (cos, 0, sin) → θ = π/2 − α.
    holder.rotation.y = Math.PI / 2 - angle;
    const quad = new THREE.Mesh(quadGeometry, quadMaterial);
    quad.rotation.x = -Math.PI / 2;
    holder.add(quad);
    spin.add(holder);
  }
  return {
    group,
    spin,
    spinSpeed: STORM_BASE_SPIN_RAD_PER_S + STORM_SPIN_PER_INTENSITY * pl.intensity,
  };
}

/** One rad zone: a single green-glowing ground disc. */
function buildRadZone(pl: HazardDiscPlacement): { group: THREE.Group } {
  const group = new THREE.Group();
  group.position.set(pl.x, pl.y + HAZARD_DISC_SURFACE_OFFSET_M, pl.z);
  const material = new THREE.MeshBasicMaterial({
    color: '#4ade80',
    transparent: true,
    opacity: discOpacity(0.25, 0.15, pl.intensity),
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const disc = new THREE.Mesh(new THREE.CircleGeometry(pl.radius, 40), material);
  disc.rotation.x = -Math.PI / 2;
  group.add(disc);
  return { group };
}

/**
 * Build the hazard discs of one system (called from swapWorld — the groups
 * are attached to the per-system world group, so a warp disposes them with
 * it). Each starts hidden; the frame loop reveals it while the player is
 * within HAZARD_RENDER_RANGE_M.
 */
export function buildHazardDiscs(
  seed: string,
  system: Pick<SystemGen, 'systemId' | 'planets'>,
): HazardDiscRender[] {
  const out: HazardDiscRender[] = [];
  for (const pl of hazardDiscsFor(seed, system)) {
    if (pl.kind === 'storm') {
      const { group, spin, spinSpeed } = buildStormCell(pl);
      group.visible = false;
      out.push({
        group,
        center: group.position.clone(),
        spin,
        spinSpeed,
        placement: pl,
      });
    } else {
      const { group } = buildRadZone(pl);
      group.visible = false;
      out.push({
        group,
        center: group.position.clone(),
        spin: null,
        spinSpeed: 0,
        placement: pl,
      });
    }
  }
  return out;
}
