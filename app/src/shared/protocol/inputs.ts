/**
 * Wire input frame → flight-model input mapping (TASK-14).
 *
 * Shared by the server sim (which integrates it) and the client predictor
 * (which must map the same frame identically for prediction to stay in lock
 * step with the authority). Lives in the protocol layer because it is a
 * pure mapping between two wire/protocol shapes — no simulation code.
 */

import type { ShipInput } from '../physics/flight';
import type { InputPayload } from './schemas';

/**
 * Map a wire input frame onto the flight-model input channels.
 * turn → roll; action 'vtol' engages full VTOL lift (the protocol v1 input
 * frame has no dedicated up channel); fire/lock are reserved for TASK-43/44.
 */
export function inputToShipInput(input: InputPayload): ShipInput {
  return {
    thrust: input.thrust,
    yaw: input.yaw,
    pitch: input.pitch,
    roll: input.turn,
    up: input.action === 'vtol' ? 1 : 0,
  };
}
