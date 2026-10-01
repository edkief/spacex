/**
 * Character (on-foot) math (TASK-31) — the disembark spawn point shared by
 * the sim (authority) and the tests. Deterministic and DOM-free.
 *
 * A disembarking player spawns on the side of their docked ship: 2.5 m
 * perpendicular to the ship's forward axis (the ship-local +X "right"), on
 * the pad plane (y = pad height, so the character stands on the flat disc,
 * never floating or clipping into terrain).
 */

import { quatIdentity, quatRotateVector, type Quat, type Vec3 } from './vec';

/** Lateral offset from the ship's centerline to the character spawn (m). */
export const CHAR_SHIP_SIDE_OFFSET_M = 2.5;

/** The ship's forward axis is local +Z (the flight model's thrust axis). */
export const SHIP_RIGHT_LOCAL: Vec3 = { x: 1, y: 0, z: 0 };

/**
 * Pure: the disembark spawn position. The ship's world position shifted 2.5 m
 * along its world-right (forward-perpendicular), with y pinned to the pad
 * surface height (the character stands on the pad plane).
 */
export function characterSpawnPos(shipPos: Vec3, shipQuat: Quat, padHeight: number): Vec3 {
  const side = quatRotateVector(shipQuat ?? quatIdentity(), {
    x: CHAR_SHIP_SIDE_OFFSET_M,
    y: 0,
    z: 0,
  });
  return { x: shipPos.x + side.x, y: padHeight, z: shipPos.z + side.z };
}
