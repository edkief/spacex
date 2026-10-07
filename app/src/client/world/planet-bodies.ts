/**
 * TASK-83: the planets rendered where the SIM has them — every planet of
 * the system as a floating surface ISLAND at its sim anchor
 * (`planetAnchor(i) = ((i + 1) × 10 000, 0, 0)`), with an outer atmosphere
 * DOME over atmospheric planets.
 *
 * The sim is the source of truth (1 u = 1 m): planets are FLAT regions of
 * the y = 0 plane (the regime machine, pads, deposits and terrain all
 * assume it) — never spheres. The island slab is a long-range stand-in for
 * terrain; TASK-84 mounts the real streamed terrain on top of it near the
 * planet.
 *
 * Anchors are 10–60 km away but the camera far plane is only 4000 m
 * (CAMERA_FAR, TASK-76), so `updatePlanetBodies` redraws every island as a
 * SCALED PROXY beyond PROXY_START_M (scaled-proxy.ts): exact direction and
 * angular size, never clipped. Within the threshold the group is at true
 * position and scale.
 */

import * as THREE from 'three';

import { ATMOSPHERE_BOUNDARY_M } from '@shared/physics/atmosphere';
import type { Vec3 } from '@shared/physics/vec';
import { PLANET_SURFACE_RADIUS_M, planetAnchor } from '@shared/galaxy/planets';
import type { PlanetClass, SystemGen } from '@shared/galaxy/types';
import { ATMOSPHERE_HAZE_COLORS, DOME_RADIUS_FACTOR } from '@client/render/atmosphere-dome';
import { proxyTransform } from '@client/render/scaled-proxy';

/** Planet-class palette (visual only; moved here from WorldManager — TASK-83). */
export const PLANET_COLORS: Record<PlanetClass, string> = {
  rocky: '#b08a5a',
  terran: '#5da463',
  ocean: '#4f83cc',
  gas: '#c9a36b',
  ice: '#a8cfe0',
};

/** Island slab thickness (m): edge-on at y ≈ 0 the slab's side wall shows. */
const ISLAND_SLAB_HEIGHT_M = 300;
/** The slab TOP's y (m): just below 0 so real terrain (TASK-84) + pads cover it. */
const ISLAND_TOP_Y_M = -2;
/** Outer atmosphere-dome shell opacity. */
const DOME_SHELL_OPACITY = 0.35;

/** One rendered planet: the island group at the sim anchor + its dome shell. */
export interface PlanetBody {
  planetId: string;
  /** Orbital-slot index (the anchor derives from it). */
  index: number;
  /** The sim anchor (y = 0) — where the slab TOP centrelines sit. */
  anchor: Vec3;
  hasAtmosphere: boolean;
  /** The group the WorldManager adds to the per-system world group. */
  group: THREE.Group;
  /** The OUTSIDE dome shell (null when airless); hidden while the camera is
   * inside this planet's atmosphere (setPlanetShellHidden). */
  shell: THREE.Mesh | null;
}

/**
 * Build one island group per planet of `system` (orbital-slot order).
 * Group origin = the anchor; the slab top sits at y = −2 in group space so
 * TASK-84's streamed terrain and the pad surface always cover it.
 */
export function buildPlanetBodies(system: SystemGen): PlanetBody[] {
  return system.planets.map((planet, index) => {
    const a = planetAnchor(index);
    const anchor: Vec3 = { x: a.x, y: 0, z: a.z };
    const group = new THREE.Group();
    group.position.set(anchor.x, anchor.y, anchor.z);

    // The island SLAB: a slightly tapered cylinder (top radius = the shared
    // surface extent, base × 0.9). A flat plane at y = 0 viewed from y ≈ 0
    // is invisible edge-on; a 300 m slab is not.
    const slab = new THREE.Mesh(
      new THREE.CylinderGeometry(
        PLANET_SURFACE_RADIUS_M,
        PLANET_SURFACE_RADIUS_M * 0.9,
        ISLAND_SLAB_HEIGHT_M,
        48,
      ),
      new THREE.MeshBasicMaterial({ color: PLANET_COLORS[planet.class] }),
    );
    slab.position.y = ISLAND_TOP_Y_M - ISLAND_SLAB_HEIGHT_M / 2;
    group.add(slab);

    // The OUTSIDE atmosphere shell: the upper hemisphere of the shared
    // atmosphere dome (same radius factor + class haze palette the INSIDE
    // BackSide dome uses), FrontSide, so a far camera sees the planet's
    // atmosphere bubble from OUTSIDE.
    let shell: THREE.Mesh | null = null;
    if (planet.hasAtmosphere) {
      shell = new THREE.Mesh(
        new THREE.SphereGeometry(
          ATMOSPHERE_BOUNDARY_M * DOME_RADIUS_FACTOR,
          32,
          16,
          0,
          Math.PI * 2,
          0,
          Math.PI / 2,
        ),
        new THREE.MeshBasicMaterial({
          color: ATMOSPHERE_HAZE_COLORS[planet.class],
          side: THREE.FrontSide,
          transparent: true,
          opacity: DOME_SHELL_OPACITY,
          depthWrite: false,
        }),
      );
      group.add(shell);
    }

    return { planetId: planet.id, index, anchor, hasAtmosphere: planet.hasAtmosphere, group, shell };
  });
}

/**
 * Per-frame: apply the scaled proxy to every island — group position +
 * uniform scale from `proxyTransform(cameraPos, anchor)`. Within
 * PROXY_START_M the group is at its true anchor and scale 1.
 */
export function updatePlanetBodies(bodies: PlanetBody[], cameraPos: Vec3): void {
  for (const body of bodies) {
    const t = proxyTransform(cameraPos, body.anchor);
    body.group.position.set(t.pos.x, t.pos.y, t.pos.z);
    body.group.scale.setScalar(t.scale);
  }
}

/**
 * Hide the outer shell of the planet the camera is INSIDE (its atmosphere
 * owns the view — the TASK-28.1 inside BackSide haze dome renders the sky;
 * the two must never double up). `planetId === null` (space) shows all.
 */
export function setPlanetShellHidden(bodies: PlanetBody[], planetId: string | null): void {
  for (const body of bodies) {
    if (body.shell) body.shell.visible = planetId === null || body.planetId !== planetId;
  }
}

/** Dispose all geometries + materials (swapWorld / manager teardown). */
export function disposePlanetBodies(bodies: PlanetBody[]): void {
  for (const body of bodies) {
    body.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const material = obj.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material.dispose();
      }
    });
  }
}
