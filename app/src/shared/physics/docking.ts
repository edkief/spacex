import type { Body, BodyDock } from './bodies.ts';
import { DOCK_MAX_SPEED, DOCK_RANGE_M, UNDOCK_SPEED } from './flightConstants.ts';
import type { FlightInput, ShipState } from './flightTypes.ts';
import { SYSTEM_FRAME } from './frames.ts';
import { add, distance, fromToQuat, length, normalize, scale, sub, type Vec3 } from './vec.ts';

interface Found {
  body: Body;
  dock: BodyDock;
}

/** Outward direction of a dock: from its planet's centre through the dock point. */
const outward = ({ body, dock }: Found): Vec3 => normalize(sub(dock.position, body.center));

function findDock(bodies: readonly Body[], id: string): Found | undefined {
  for (const body of bodies) {
    const dock = body.docks.find((d) => d.id === id);
    if (dock) return { body, dock };
  }
  return undefined;
}

function nearestDock(bodies: readonly Body[], pos: Vec3): (Found & { range: number }) | undefined {
  let best: (Found & { range: number }) | undefined;
  for (const body of bodies) {
    for (const dock of body.docks) {
      const range = distance(pos, dock.position);
      if (!best || range < best.range) best = { body, dock, range };
    }
  }
  return best;
}

/**
 * Orbital docking. `dock`: within 100 m of a dock and slower than 10 m/s (system frame only) the
 * ship is docked at that dock's pad: snapped to it, stopped, and oriented with its up axis along
 * the dock's outward normal. `undock`: releases it with a 5 m/s push away from the planet.
 */
export function applyDocking(
  state: ShipState,
  action: FlightInput['action'],
  bodies: readonly Body[],
): ShipState {
  if (action === 'undock' && state.dockedAt) {
    const found = findDock(bodies, state.dockedAt);
    const released: ShipState = { ...state };
    delete released.dockedAt;
    if (!found) return released;
    const normal = outward(found);
    return { ...released, vel: scale(normal, UNDOCK_SPEED), pos: add(state.pos, scale(normal, 1)) };
  }
  if (action === 'dock' && !state.dockedAt && state.frame === SYSTEM_FRAME) {
    const near = nearestDock(bodies, state.pos);
    if (near && near.range <= DOCK_RANGE_M && length(state.vel) < DOCK_MAX_SPEED) {
      return {
        ...state,
        dockedAt: near.dock.id,
        pos: near.dock.position,
        vel: { x: 0, y: 0, z: 0 },
        quat: fromToQuat({ x: 0, y: 1, z: 0 }, outward(near)),
        regime: 'space',
      };
    }
  }
  return state;
}
