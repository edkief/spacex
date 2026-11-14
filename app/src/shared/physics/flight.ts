import { REGIMES } from '../regime.ts';
import { SYSTEM_FRAME } from './frames.ts';
import { sweepBodies, slideVelocity } from './collision.ts';
import type { FlightContext, FlightInput, ShipState } from './flightTypes.ts';
import { integrateSurface } from './surfaceFlight.ts';
import { FORWARD, UP, rotate } from './rotation.ts';
import { brakeBy, capVelocity, clampMagnitude } from './motion.ts';
import { distanceToNearest, speedFactor } from './travel.ts';
import { add, rotateVector, scale } from './vec.ts';

/** One step of flight in the system frame: Newtonian thrust, scaled soft cap, solid bodies. */
function integrateSystem(
  state: ShipState,
  input: FlightInput,
  dt: number,
  ctx: FlightContext,
  quat: ShipState['quat'],
): ShipState {
  const cls = ctx.shipClass;
  const factor = speedFactor(distanceToNearest(state.pos, ctx.bodies));
  const accel = cls.acceleration * factor;
  const command = clampMagnitude(
    add(scale(rotateVector(quat, FORWARD), input.thrust), scale(rotateVector(quat, UP), input.up)),
  );
  let vel = add(state.vel, scale(command, accel * dt));
  if (input.brake) vel = brakeBy(vel, accel * dt);
  vel = capVelocity(vel, cls.maxVelocity * factor, dt);

  let pos = add(state.pos, scale(vel, dt));
  const contact = sweepBodies(state.pos, pos, ctx.bodies);
  if (contact) {
    pos = contact.pos;
    vel = slideVelocity(vel, contact.normal);
  }
  return { ...state, pos, vel, quat };
}

/**
 * Advances a ship by `dt` seconds in its current frame. Pure and deterministic: no randomness, no
 * clock, no side effects. The same function runs on the server (authority, fixed dt = 1/20 s) and
 * in client prediction (variable dt allowed). Orientation turns at up to the class turn rate;
 * thrust, the speed cap and (on a surface) VTOL scale with distance to the nearest surface.
 * A docked ship is held in place.
 * @throws RangeError for an unknown regime or a non-positive/non-finite `dt`.
 */
export function integrateShip(
  state: ShipState,
  input: FlightInput,
  dt: number,
  ctx: FlightContext,
): ShipState {
  if (!REGIMES.includes(state.regime))
    throw new RangeError(`unknown regime: ${String(state.regime)}`);
  if (!(dt > 0) || !Number.isFinite(dt))
    throw new RangeError(`dt must be positive and finite, got ${dt}`);
  if (state.dockedAt) return state;

  const quat = rotate(state.quat, input, ctx.shipClass.turnRate, dt);
  return state.frame === SYSTEM_FRAME
    ? integrateSystem(state, input, dt, ctx, quat)
    : integrateSurface(state, input, dt, ctx, quat);
}
