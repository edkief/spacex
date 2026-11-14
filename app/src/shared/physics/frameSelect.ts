import { oppositeHemisphere } from '../galaxy/chart.ts';
import type { Body } from './bodies.ts';
import { frameSwitchAltitude } from './bodies.ts';
import {
  SYSTEM_FRAME,
  hemisphereOf,
  parseFrame,
  poleward,
  surfaceFrameId,
  type FrameId,
} from './frames.ts';
import { distance, type Vec3 } from './vec.ts';
import { CHART_SWITCH_SIN_LATITUDE, FRAME_EXIT_FACTOR } from './worldConstants.ts';

/**
 * Chooses the frame a ship should be in, given its current frame and its position. System frame
 * by default; it moves into a landable planet's surface chart (north or south, by which
 * hemisphere it is over) when its altitude drops below the frame-switch altitude, and back out
 * once altitude exceeds 1.1x that. Inside a chart it moves to the other hemisphere's chart once
 * it is a little past the equator (hysteresis, see CHART_SWITCH_SIN_LATITUDE). Solid bodies
 * (star, gas giants, unlandable planets) have no surface frame.
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
  const ref = parseFrame(current);
  if (ref) {
    const body = bodies.find((b) => b.id === ref.planetId);
    if (!body) return SYSTEM_FRAME;
    if (flatAltitude > frameSwitchAltitude(body) * FRAME_EXIT_FACTOR) return SYSTEM_FRAME;
    return poleward(body, ref.hemisphere, systemPos) < -CHART_SWITCH_SIN_LATITUDE
      ? surfaceFrameId(body.id, oppositeHemisphere(ref.hemisphere))
      : current;
  }
  let best: { body: Body; altitude: number } | undefined;
  for (const body of bodies) {
    if (!body.hasSurfaceFrame) continue;
    const altitude = distance(systemPos, body.center) - body.radius;
    if (altitude >= frameSwitchAltitude(body)) continue;
    if (!best || altitude < best.altitude) best = { body, altitude };
  }
  return best ? surfaceFrameId(best.body.id, hemisphereOf(best.body, systemPos)) : SYSTEM_FRAME;
}
