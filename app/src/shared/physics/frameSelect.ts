import type { Body } from './bodies.ts';
import { frameSwitchAltitude } from './bodies.ts';
import { SYSTEM_FRAME, inSurfaceRange, type FrameId } from './frames.ts';
import { distance, type Vec3 } from './vec.ts';
import { FRAME_EXIT_FACTOR } from './worldConstants.ts';

/**
 * Chooses the frame a ship should be in, given its current frame and its position expressed in
 * that frame. System frame by default; it moves into a landable planet's surface frame when its
 * altitude drops below the frame-switch altitude (and it is inside the projection's usable
 * range), and back out once altitude exceeds 1.1x that. Solid bodies (star, gas giants,
 * unlandable planets) have no surface frame.
 *
 * `systemPos` is the ship's position in the system frame; `flatAltitude` is its altitude in the
 * current surface frame (ignored while in the system frame).
 */
export function selectFrame(
  current: FrameId,
  systemPos: Vec3,
  flatAltitude: number,
  bodies: readonly Body[],
): FrameId {
  if (current !== SYSTEM_FRAME) {
    const body = bodies.find((b) => b.id === current);
    if (!body) return SYSTEM_FRAME;
    return flatAltitude > frameSwitchAltitude(body) * FRAME_EXIT_FACTOR ? SYSTEM_FRAME : current;
  }
  let best: { id: string; altitude: number } | undefined;
  for (const body of bodies) {
    if (!body.hasSurfaceFrame) continue;
    const altitude = distance(systemPos, body.center) - body.radius;
    if (altitude >= frameSwitchAltitude(body) || !inSurfaceRange(body, systemPos)) continue;
    if (!best || altitude < best.altitude) best = { id: body.id, altitude };
  }
  return best ? best.id : SYSTEM_FRAME;
}
