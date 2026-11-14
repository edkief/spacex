import { rotateVector, sub, type Quat, type Vec3 } from '@shared/physics/vec.ts';

/**
 * Camera-relative placement. World positions are float64 metres and reach 1e8 m from the star,
 * far beyond what the GPU's float32 can hold precisely; so the camera sits at the render origin
 * and every object is placed at (world - camera), computed in float64 on the CPU each frame.
 * Near the camera the result is small and therefore exact to well under a millimetre.
 */
export function relativeTo(world: Vec3, cameraWorld: Vec3): Vec3 {
  return sub(world, cameraWorld);
}

/** Chase camera offset in ship-local axes (right, up, back): behind and above the ship. */
export const CHASE_OFFSET: Vec3 = { x: 0, y: 7, z: 26 };

/** World position of the chase camera for a ship pose. */
export function chaseCameraPosition(
  shipPos: Vec3,
  shipQuat: Quat,
  offset: Vec3 = CHASE_OFFSET,
): Vec3 {
  const rotated = rotateVector(shipQuat, offset);
  return { x: shipPos.x + rotated.x, y: shipPos.y + rotated.y, z: shipPos.z + rotated.z };
}
