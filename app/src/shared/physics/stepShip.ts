import { resolveRegime } from '../regime.ts';
import type { ShipClass } from '../ships/catalog.ts';
import { applyDocking } from './docking.ts';
import { integrateShip } from './flight.ts';
import type { FlightInput, FlightWorld, ShipState } from './flightTypes.ts';
import { selectFrame } from './frameSelect.ts';
import {
  SYSTEM_FRAME,
  bodyOfFrame,
  convertKinematics,
  parseFrame,
  surfaceToSystem,
} from './frames.ts';
import { length } from './vec.ts';

/**
 * One full sim step for a ship: docking commands, frame-local integration, frame switching
 * (with continuous state conversion, 1.1x hysteresis on the way out and chart changes across
 * the equator) and regime resolution.
 * This is what the server tick and the client prediction call; `integrateShip` is the physics
 * inside it. Pure given the world.
 */
export function stepShip(
  state: ShipState,
  input: FlightInput,
  dt: number,
  world: FlightWorld,
  shipClass: Readonly<ShipClass>,
): ShipState {
  const docked = applyDocking(state, input.action, world.bodies);
  const surface = docked.frame === SYSTEM_FRAME ? undefined : world.surface(docked.frame);
  const flatFallback = { heightAt: () => 0, pads: [] };
  const integrated = integrateShip(docked, input, dt, {
    shipClass,
    bodies: world.bodies,
    surface: docked.frame === SYSTEM_FRAME ? undefined : (surface ?? flatFallback),
  });
  if (integrated.dockedAt) return integrated;

  // Frame switch: where would the ship be in the system frame, and which frame does it belong in?
  const ref = parseFrame(integrated.frame);
  const body = bodyOfFrame(integrated.frame, world.bodies);
  const systemPos =
    !ref || !body ? integrated.pos : surfaceToSystem(body, ref.hemisphere, integrated.pos);
  const frame = selectFrame(integrated.frame, systemPos, integrated.pos.y, world.bodies);
  let next = integrated;
  if (frame !== integrated.frame) {
    const k = convertKinematics(integrated, integrated.frame, frame, world.bodies);
    next = { ...integrated, frame, pos: k.pos, vel: k.vel, quat: k.quat };
    delete next.onPad;
  }

  const planet = bodyOfFrame(next.frame, world.bodies);
  const provider = planet ? world.surface(next.frame) : undefined;
  const regime = resolveRegime({
    previous: next.regime,
    frame: next.frame,
    planet,
    altitude: next.pos.y,
    terrainHeight: provider ? provider.heightAt(next.pos.x, next.pos.z) : 0,
    speed: length(next.vel),
  });
  return { ...next, regime };
}
