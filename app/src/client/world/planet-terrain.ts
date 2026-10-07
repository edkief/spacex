/**
 * TASK-84 (step 3): WHICH planet's streamed terrain is mounted — pure
 * decision logic, no three.js, no I/O.
 *
 * The live game mounts at most ONE planet's ChunkStreamer + ChunkScene at a
 * time, in WORLD coordinates (the server's frame). This module decides the
 * mount target from the player's world position: the nearest LANDABLE
 * planet whose anchor is within MOUNT_RANGE_M (the island surface radius +
 * 2 km) horizontally, kept with a 500 m hysteresis band so a player on the
 * boundary cannot make the terrain flap on and off every frame. Gas giants
 * and other non-landable planets never mount (no landable settlement, no
 * pad, no surface regime).
 *
 * `chunkInSurface` is the island clip: the streamed terrain must not extend
 * past the planet's surface radius (the TASK-83 island extent), so the
 * live wiring passes it to the streamer as the `chunkFilter` — chunks whose
 * 320 m world square does not intersect the surface circle are never
 * generated or mounted.
 */

import { PLANET_SURFACE_RADIUS_M, planetAnchor } from '@shared/galaxy/planets';
import type { SystemGen } from '@shared/galaxy/types';
import type { Vec3 } from '@shared/physics/vec';
import { CHUNK_METERS } from './chunk-geometry';

/** A planet's terrain mounts while the player is this close (m) to its anchor, horizontally. */
export const MOUNT_RANGE_M = PLANET_SURFACE_RADIUS_M + 2_000;
/** A mounted planet stays mounted until the player is this far (m) — the anti-flap band. */
export const MOUNT_RELEASE_RANGE_M = MOUNT_RANGE_M + 500;

/**
 * The planet whose terrain should be mounted (null = none).
 *
 * - the CURRENT planet is kept while it stays within MOUNT_RELEASE_RANGE_M
 *   (hysteresis: a new mount needs MOUNT_RANGE_M, a release needs
 *   MOUNT_RANGE_M + 500 — no flapping on the boundary);
 * - otherwise the nearest landable planet within MOUNT_RANGE_M is acquired
 *   (ties break on planet order, deterministically);
 * - non-landable planets (gas giants, airless) never mount — and a current
 *   id that is not a landable planet of this system (a stale id, a system
 *   swap) releases immediately.
 */
export function terrainPlanetFor(
  pos: Vec3,
  system: Pick<SystemGen, 'planets'>,
  current: string | null,
): string | null {
  const anchors = system.planets.map((planet, index) => ({
    planet,
    dist: Math.hypot(pos.x - planetAnchor(index).x, pos.z - planetAnchor(index).z),
  }));
  if (current !== null) {
    const cur = anchors.find((a) => a.planet.id === current);
    if (cur && cur.planet.landable && cur.dist <= MOUNT_RELEASE_RANGE_M) return current;
  }
  let best: { planetId: string; dist: number } | null = null;
  for (const a of anchors) {
    if (!a.planet.landable) continue;
    if (a.dist > MOUNT_RANGE_M) continue;
    if (!best || a.dist < best.dist) best = { planetId: a.planet.id, dist: a.dist };
  }
  return best ? best.planetId : null;
}

/**
 * Island clip: does the chunk's 320 m world square intersect the circle of
 * radius PLANET_SURFACE_RADIUS_M around the anchor? Points exactly on the
 * boundary count as inside (the terrain edge may touch the island rim).
 */
export function chunkInSurface(
  chunkX: number,
  chunkZ: number,
  anchor: { x: number; z: number },
): boolean {
  const x0 = chunkX * CHUNK_METERS;
  const z0 = chunkZ * CHUNK_METERS;
  const cx = Math.min(Math.max(anchor.x, x0), x0 + CHUNK_METERS);
  const cz = Math.min(Math.max(anchor.z, z0), z0 + CHUNK_METERS);
  return Math.hypot(cx - anchor.x, cz - anchor.z) <= PLANET_SURFACE_RADIUS_M;
}
