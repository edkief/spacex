import { describe, expect, it } from 'vitest';

import type { InputPayload } from './schemas';
import { messageSchemas } from './schemas';
import { inputToCharacterInput, inputToShipInput, shipInputToPayload } from './inputs';
import type { ShipInput } from '@shared/physics/flight';

/**
 * TASK-32: the wire input frame → character channel mapping. The SAME
 * 'input' message type drives both regimes (no protocol change); the server
 * routes by the player's active entity kind, and this shared mapping must be
 * identical for the server (authority) and the client (prediction).
 */

function frame(partial: Partial<InputPayload> = {}): InputPayload {
  return {
    seq: 1,
    thrust: 0,
    turn: 0,
    pitch: 0,
    yaw: 0,
    fire: false,
    lock: false,
    ...partial,
  };
}

describe('inputToCharacterInput (TASK-32)', () => {
  it('zero frame → zero character input', () => {
    expect(inputToCharacterInput(frame())).toEqual({
      forward: false,
      back: false,
      left: false,
      right: false,
      run: false,
      jump: false,
    });
  });

  it('thrust axis → forward/back (W/S); yaw axis → left/right (A/D)', () => {
    expect(inputToCharacterInput(frame({ thrust: 1 })).forward).toBe(true);
    expect(inputToCharacterInput(frame({ thrust: -1 })).back).toBe(true);
    expect(inputToCharacterInput(frame({ yaw: 1 })).right).toBe(true);
    expect(inputToCharacterInput(frame({ yaw: -1 })).left).toBe(true);
    // Both ends of an axis at once → the channel is off (net zero demand).
    expect(inputToCharacterInput(frame({ thrust: 0 }))).toMatchObject({
      forward: false,
      back: false,
    });
  });

  it('action string: run / jump / the combined run+jump', () => {
    expect(inputToCharacterInput(frame({ action: 'run' }))).toMatchObject({
      run: true,
      jump: false,
    });
    expect(inputToCharacterInput(frame({ action: 'jump' }))).toMatchObject({
      run: false,
      jump: true,
    });
    expect(inputToCharacterInput(frame({ action: 'run+jump' }))).toMatchObject({
      run: true,
      jump: true,
    });
    // The atmosphere action never leaks into the character channels.
    expect(inputToCharacterInput(frame({ action: 'vtol' }))).toMatchObject({
      run: false,
      jump: false,
    });
  });
});

/**
 * TASK-73: the INVERSE mapping (client ship loop → wire). Every channel
 * must round-trip through inputToShipInput EXACTLY, because the server
 * integrates inputToShipInput(payload) and the client predicts the same
 * ShipInput — any asymmetry is a systematic prediction drift.
 */
describe('shipInputToPayload (TASK-73)', () => {
  const CASES: Array<{ name: string; input: ShipInput }> = [
    { name: 'coast (all zero)', input: { thrust: 0, yaw: 0, pitch: 0, roll: 0, up: 0 } },
    { name: 'thrust +', input: { thrust: 1, yaw: 0, pitch: 0, roll: 0, up: 0 } },
    { name: 'thrust -', input: { thrust: -1, yaw: 0, pitch: 0, roll: 0, up: 0 } },
    { name: 'yaw +', input: { thrust: 0, yaw: 1, pitch: 0, roll: 0, up: 0 } },
    { name: 'yaw -', input: { thrust: 0, yaw: -1, pitch: 0, roll: 0, up: 0 } },
    { name: 'pitch +', input: { thrust: 0, yaw: 0, pitch: 1, roll: 0, up: 0 } },
    { name: 'pitch -', input: { thrust: 0, yaw: 0, pitch: -1, roll: 0, up: 0 } },
    { name: 'roll +', input: { thrust: 0, yaw: 0, pitch: 0, roll: 1, up: 0 } },
    { name: 'roll -', input: { thrust: 0, yaw: 0, pitch: 0, roll: -1, up: 0 } },
    { name: 'VTOL up', input: { thrust: 0, yaw: 0, pitch: 0, roll: 0, up: 1 } },
    {
      name: 'combined burn',
      input: { thrust: 1, yaw: 0.5, pitch: -0.5, roll: 1, up: 1 },
    },
  ];

  it.each(CASES)('round-trips $name through inputToShipInput exactly', ({ input }) => {
    const payload = shipInputToPayload(42, input);
    expect(inputToShipInput(payload)).toEqual(input);
  });

  it('stamps the seq and reserves fire/lock (one-shot messages, not input channels)', () => {
    const p = shipInputToPayload(7, { thrust: 1, yaw: 0, pitch: 0, roll: 0, up: 0 });
    expect(p.seq).toBe(7);
    expect(p.fire).toBe(false);
    expect(p.lock).toBe(false);
  });

  it('VTOL demand rides the action string; zero up has no action', () => {
    expect(shipInputToPayload(1, { thrust: 0, yaw: 0, pitch: 0, roll: 0, up: 1 }).action).toBe(
      'vtol',
    );
    expect(
      shipInputToPayload(1, { thrust: 0, yaw: 0, pitch: 0, roll: 0, up: 0 }).action,
    ).toBeUndefined();
  });

  it('every produced payload is a valid wire frame (strict schema)', () => {
    for (const { input } of CASES) {
      const parsed = messageSchemas.input.safeParse(shipInputToPayload(1, input));
      expect(parsed.success, `schema rejected ${input}`).toBe(true);
    }
  });
});

describe('inputToShipInput (regression guard, TASK-14)', () => {
  it('still maps the flight channels exactly (character mapping did not disturb it)', () => {
    expect(
      inputToShipInput(frame({ thrust: 1, turn: -1, pitch: 0.5, yaw: 0.25, action: 'vtol' })),
    ).toEqual({
      thrust: 1,
      yaw: 0.25,
      pitch: 0.5,
      roll: -1,
      up: 1,
    });
    expect(inputToShipInput(frame()).up).toBe(0);
  });
});
