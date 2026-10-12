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

describe('inputToCharacterInput (TASK-32, analog TASK-100)', () => {
  it('zero frame → zero character input (canonical +0, not −0)', () => {
    expect(inputToCharacterInput(frame())).toEqual({
      move: 0,
      turn: 0,
      run: false,
      jump: false,
    });
    expect(Object.is(inputToCharacterInput(frame()).turn, 0)).toBe(true);
  });

  it('thrust axis → move (W/S forward-positive); yaw axis → turn (sign-flipped, A/D left-positive)', () => {
    expect(inputToCharacterInput(frame({ thrust: 1 })).move).toBe(1);
    expect(inputToCharacterInput(frame({ thrust: -1 })).move).toBe(-1);
    // Wire yaw is screen-RIGHT positive (D → +1); physics turn is
    // screen-LEFT positive (TASK-80) → D is turn = −1, A is turn = +1.
    expect(inputToCharacterInput(frame({ yaw: 1 })).turn).toBe(-1);
    expect(inputToCharacterInput(frame({ yaw: -1 })).turn).toBe(1);
    // Net-zero demand → zero channels.
    expect(inputToCharacterInput(frame({ thrust: 0, yaw: 0 }))).toMatchObject({
      move: 0,
      turn: 0,
    });
  });

  it('magnitudes pass through: a partial stick (0.5) maps to a partial channel', () => {
    expect(inputToCharacterInput(frame({ thrust: 0.5 })).move).toBe(0.5);
    expect(inputToCharacterInput(frame({ thrust: -0.25 })).move).toBe(-0.25);
    expect(inputToCharacterInput(frame({ yaw: 0.5 })).turn).toBe(-0.5);
    expect(inputToCharacterInput(frame({ yaw: -0.5 })).turn).toBe(0.5);
  });

  it('clamps to [−1, 1] (cheat-resistance: spoofed magnitudes cannot exceed ±1)', () => {
    // The TASK-55 sensitivity pre-scales the wire yaw into [±0.5, ±2] — at
    // 0.5x a full keyboard press turns at HALF rate (new, intended), at
    // 1x/2x the clamp caps the channel at ±1 (keyboard 1x unchanged).
    expect(inputToCharacterInput(frame({ thrust: 100 })).move).toBe(1);
    expect(inputToCharacterInput(frame({ thrust: -100 })).move).toBe(-1);
    expect(inputToCharacterInput(frame({ yaw: 2 })).turn).toBe(-1);
    expect(inputToCharacterInput(frame({ yaw: -2 })).turn).toBe(1);
    expect(inputToCharacterInput(frame({ yaw: 0.5 })).turn).toBe(-0.5); // 0.5x preset: half turn
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
    expect(inputToCharacterInput(frame({ action: 'hover' }))).toMatchObject({
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
    {
      name: 'coast (all zero)',
      input: { thrust: 0, yaw: 0, pitch: 0, roll: 0, up: 0, boost: 0, hover: 0 },
    },
    {
      name: 'thrust +',
      input: { thrust: 1, yaw: 0, pitch: 0, roll: 0, up: 0, boost: 0, hover: 0 },
    },
    {
      name: 'thrust -',
      input: { thrust: -1, yaw: 0, pitch: 0, roll: 0, up: 0, boost: 0, hover: 0 },
    },
    { name: 'yaw +', input: { thrust: 0, yaw: 1, pitch: 0, roll: 0, up: 0, boost: 0, hover: 0 } },
    { name: 'yaw -', input: { thrust: 0, yaw: -1, pitch: 0, roll: 0, up: 0, boost: 0, hover: 0 } },
    { name: 'pitch +', input: { thrust: 0, yaw: 0, pitch: 1, roll: 0, up: 0, boost: 0, hover: 0 } },
    {
      name: 'pitch -',
      input: { thrust: 0, yaw: 0, pitch: -1, roll: 0, up: 0, boost: 0, hover: 0 },
    },
    { name: 'roll +', input: { thrust: 0, yaw: 0, pitch: 0, roll: 1, up: 0, boost: 0, hover: 0 } },
    { name: 'roll -', input: { thrust: 0, yaw: 0, pitch: 0, roll: -1, up: 0, boost: 0, hover: 0 } },
    { name: 'VTOL up', input: { thrust: 0, yaw: 0, pitch: 0, roll: 0, up: 1, boost: 0, hover: 0 } },
    {
      name: 'combined burn',
      input: { thrust: 1, yaw: 0.5, pitch: -0.5, roll: 1, up: 1, boost: 0, hover: 0 },
    },
    // TASK-85: the cruise boost channel round-trips through the action string.
    {
      name: 'boost (space cruise)',
      input: { thrust: 1, yaw: 0, pitch: 0, roll: 0, up: 0, boost: 1, hover: 0 },
    },
    {
      name: 'VTOL + boost combined',
      input: { thrust: 1, yaw: 0, pitch: 0, roll: 0, up: 1, boost: 1, hover: 0 },
    },
    // TASK-106: the hover channel (the 'hover' tag implies up — the
    // normalized form is {up: 1, hover: 1}).
    {
      name: 'hover (altitude-hold)',
      input: { thrust: 0, yaw: 0, pitch: 0, roll: 0, up: 1, boost: 0, hover: 1 },
    },
    {
      name: 'hover + boost combined',
      input: { thrust: 1, yaw: 0, pitch: 0, roll: 0, up: 1, boost: 1, hover: 1 },
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
    expect(
      shipInputToPayload(1, { thrust: 0, yaw: 0, pitch: 0, roll: 0, up: 1, boost: 0 }).action,
    ).toBe('vtol');
    expect(
      shipInputToPayload(1, { thrust: 0, yaw: 0, pitch: 0, roll: 0, up: 0, boost: 0 }).action,
    ).toBeUndefined();
  });

  it('TASK-85: boost rides the action string; vtol wins (listed first) when both', () => {
    expect(
      shipInputToPayload(1, { thrust: 1, yaw: 0, pitch: 0, roll: 0, up: 0, boost: 1 }).action,
    ).toBe('boost');
    expect(
      shipInputToPayload(1, { thrust: 1, yaw: 0, pitch: 0, roll: 0, up: 1, boost: 1 }).action,
    ).toBe('vtol+boost');
  });

  it('TASK-106: hover rides the action string; the hover tag implies up (wins over vtol)', () => {
    expect(
      shipInputToPayload(1, { thrust: 0, yaw: 0, pitch: 0, roll: 0, up: 1, hover: 1 }).action,
    ).toBe('hover');
    // Legacy held-key VTOL (hover off) is unchanged.
    expect(
      shipInputToPayload(1, { thrust: 0, yaw: 0, pitch: 0, roll: 0, up: 1, hover: 0 }).action,
    ).toBe('vtol');
    // hover + boost: 'hover' first (same convention as 'vtol+boost').
    expect(
      shipInputToPayload(1, { thrust: 1, yaw: 0, pitch: 0, roll: 0, up: 1, boost: 1, hover: 1 })
        .action,
    ).toBe('hover+boost');
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
      boost: 0,
      hover: 0,
    });
    expect(inputToShipInput(frame()).up).toBe(0);
    // TASK-85: the boost channel (action 'boost' / the combined 'vtol+boost').
    expect(inputToShipInput(frame({ action: 'boost' })).boost).toBe(1);
    expect(inputToShipInput(frame({ action: 'vtol+boost' }))).toMatchObject({
      up: 1,
      boost: 1,
      hover: 0,
    });
    // TASK-106: the 'hover' tag → up = 1 (it implies the up demand) and
    // hover = 1; the legacy 'vtol' tag keeps hover = 0.
    expect(inputToShipInput(frame({ action: 'hover' }))).toMatchObject({
      up: 1,
      hover: 1,
      boost: 0,
    });
    expect(inputToShipInput(frame({ action: 'hover+boost' }))).toMatchObject({
      up: 1,
      hover: 1,
      boost: 1,
    });
    // a foreign action string never leaks into the ship channels
    expect(inputToShipInput(frame({ action: 'run' }))).toMatchObject({
      up: 0,
      boost: 0,
      hover: 0,
    });
  });
});
