import type { Body, BodyDock } from './bodies.ts';
import { DOCK_MAX_SPEED, DOCK_RANGE_M, UNDOCK_SPEED } from './flightConstants.ts';
import type { FlightInput, ShipState } from './flightTypes.ts';
import { SYSTEM_FRAME } from './frames.ts';
import {
  add,
  cross,
  distance,
  fromMat3,
  length,
  normalize,
  scale,
  sub,
  type Quat,
  type Vec3,
} from './vec.ts';

interface Found {
  body: Body;
  dock: BodyDock;
}

/** Outward direction of a dock: from its planet's centre through the dock point. */
const outward = ({ body, dock }: Found): Vec3 => normalize(sub(dock.position, body.center));

/** How far a docked ship's nose is turned from the orbit tangent towards the planet. */
const DOCK_NOSE_IN = Math.PI / 6;

/**
 * Orientation of a ship held at a dock: wings level with the planet off to one side, nose
 * turned 30 degrees in from the orbit tangent so the planet's limb is in view on arrival.
 * Shared by docking, spawning and the client's dock model.
 */
export function dockOrientation(body: Body, dock: BodyDock): Quat {
  const out = outward({ body, dock });
  const reference = Math.abs(out.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const tangent = normalize(cross(reference, out));
  const up = cross(out, tangent);
  const forward = normalize(
    sub(scale(tangent, Math.cos(DOCK_NOSE_IN)), scale(out, Math.sin(DOCK_NOSE_IN))),
  );
  const back = scale(forward, -1);
  const right = cross(up, back);
  return fromMat3([right.x, up.x, back.x, right.y, up.y, back.y, right.z, up.z, back.z]);
}

/** The body and dock with the given dock id, if it exists in `bodies`. */
export function findDock(bodies: readonly Body[], id: string): Found | undefined {
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
 * ship is docked at that dock's pad: snapped to it, stopped, and given the dock's berth
 * orientation (`dockOrientation`). `undock`: releases it with a 5 m/s push away from the planet.
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
        quat: dockOrientation(near.body, near.dock),
        regime: 'space',
      };
    }
  }
  return state;
}
