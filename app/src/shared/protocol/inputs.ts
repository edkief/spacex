/**
 * Wire input frame → flight-model input mapping (TASK-14).
 *
 * Shared by the server sim (which integrates it) and the client predictor
 * (which must map the same frame identically for prediction to stay in lock
 * step with the authority). Lives in the protocol layer because it is a
 * pure mapping between two wire/protocol shapes — no simulation code.
 */

import type { CharacterInput } from '../physics/character';
import type { ShipInput } from '../physics/flight';
import type { InputPayload } from './schemas';

/** The 'action' string is a '+'-joined channel list ('vtol', 'boost', …). */
function actionTags(action: string | undefined): string[] {
  return action ? action.split('+') : [];
}

/**
 * Map a wire input frame onto the flight-model input channels.
 * turn → roll; action 'vtol' engages full VTOL lift and action 'boost'
 * (the combined form 'vtol+boost' carries both) engages the space-cruise
 * boost (TASK-85 — the protocol v1 input frame has no dedicated up/boost
 * channel, so the `action` string carries them); fire/lock are reserved
 * for TASK-43/44.
 */
export function inputToShipInput(input: InputPayload): ShipInput {
  const tags = actionTags(input.action);
  return {
    thrust: input.thrust,
    yaw: input.yaw,
    pitch: input.pitch,
    roll: input.turn,
    up: tags.includes('vtol') ? 1 : 0,
    boost: tags.includes('boost') ? 1 : 0,
  };
}

/**
 * Inverse of {@link inputToShipInput} (TASK-73): a flight-model input →
 * wire frame. The client's ship prediction loop maps the active control
 * scheme's readout through this so the EXACT same channels the server
 * integrates (`inputToShipInput`) leave the socket:
 * thrust → thrust, yaw → yaw, pitch → pitch, ROLL → turn, VTOL demand
 * (`up > 0`) → 'vtol' and cruise demand (`boost > 0`, TASK-85) → 'boost'
 * in the `action` string (VTOL wins: it is listed first in the combined
 * 'vtol+boost' form — boost only engages in space anyway, where VTOL lift
 * does nothing, so 'vtol wins' is physics-neutral). `fire`/`lock` stay
 * false — firing and target lock are separate one-shot messages
 * ('fire' / 'target_lock', TASK-43/44). Round-trips exactly:
 * `inputToShipInput(shipInputToPayload(s, i)) === i`.
 */
export function shipInputToPayload(seq: number, input: ShipInput): InputPayload {
  const tags: string[] = [];
  if (input.up > 0) tags.push('vtol');
  if ((input.boost ?? 0) > 0) tags.push('boost');
  return {
    seq,
    thrust: input.thrust,
    yaw: input.yaw,
    pitch: input.pitch,
    turn: input.roll,
    fire: false,
    lock: false,
    ...(tags.length > 0 ? { action: tags.join('+') } : {}),
  };
}

/**
 * Map a wire input frame onto the surface-regime character channels
 * (TASK-32). The SAME 'input' message drives both regimes — the server
 * routes by the player's active entity kind, so no protocol change:
 * - forward/back ride the thrust axis (W/S → +1/−1),
 * - left/right ride the yaw axis (A/D → ±1, or ±0.5..±2 when the client's
 *   TASK-55 sensitivity scales the demand — the 0.5 INCLUSIVE threshold is
 *   what keeps the 0.5x preset still registering a turn),
 * - run/jump ride the `action` string ('run', 'jump', or the combined
 *   'run+jump' while both are held — the surface analogue of 'vtol').
 * Fire/lock stay reserved (combat, TASK-43/44).
 */
export function inputToCharacterInput(input: InputPayload): CharacterInput {
  const action = input.action ?? '';
  return {
    forward: input.thrust > 0.5,
    back: input.thrust < -0.5,
    // INCLUSIVE: the TASK-55 sensitivity scales the client's yaw demand into
    // [±0.5, ±2] — at the 0.5x minimum a full-hold demand is exactly 0.5
    // and must still turn (the server's turn RATE stays the v1 constant;
    // magnitude-scaled turning lands with mouse look).
    left: input.yaw <= -0.5,
    right: input.yaw >= 0.5,
    run: action === 'run' || action === 'run+jump',
    jump: action === 'jump' || action === 'run+jump',
  };
}
