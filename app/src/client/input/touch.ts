/**
 * Touch input core (TASK-89, step 1) — touch synthesized as VIRTUAL KEYS.
 *
 * The whole touch feature rests on one decision: the held touch channels are
 * projected to the SAME key names the keyboard capture already produces
 * (lowercased `event.key`, 'Shift' verbatim — main.tsx `keyOf`) and merged
 * with the real keyboard pressed set at the two prediction loops. Everything
 * downstream (control schemes, prediction, wire mapping, server) is untouched
 * — the loops just read a larger set.
 *
 * Design split (mirrors how the keyboard drives the game):
 * - HELD actions (movement) become virtual keys in the pressed set, read
 *   every frame by the prediction loops.
 * - DISCRETE actions (drop, interact/mine, fire, weapon, lock) stay
 *   keydown/keyup EVENTS — the wiring tasks (91-93) call the same one-shot
 *   functions the keyboard handlers use. They are NOT virtual keys and do
 *   NOT belong in `virtualKeys()`.
 *
 * The deliberate collisions (boost+run → 'Shift', vtol+jump → ' ') are SAFE:
 * the active regime decides which loop reads the set, and the schemes/loops
 * interpret each key per regime — exactly like today, where one physical
 * Shift means 'cruise' in space and 'run' on foot.
 *
 * DOM-free (no window/document) so it unit-tests under Node.
 *
 * TASK-99 (analog): the HELD axis channels are also merged into the flight
 * ShipInput by MAGNITUDE (the virtual-key projection above stays binary and
 * unchanged — the analog path runs alongside it, not through it).
 */

import type { ShipInput } from '@shared/physics/flight';

import type { ControlScheme } from './controls';

/**
 * The HELD touch channels (all optional, default off). A value present in a
 * `setChannel` call replaces the channel; a channel absent from the call is
 * left as-is (a joystick writing {thrust, yaw} never clobbers a button).
 */
export interface TouchChannels {
  /** Thrust demand axis (−1..1); > 0 forward ('w'), < 0 backward ('s'). */
  thrust?: number;
  /** Yaw demand axis (−1..1); ON-SCREEN direction — > 0 turns the nose RIGHT ('d'). */
  yaw?: number;
  /** Pitch demand axis (−1..1); > 0 nose up ('f'), < 0 nose down ('r'). */
  pitch?: number;
  /** Roll demand axis (−1..1); > 0 rolls the top right ('e'), < 0 left ('q'). */
  roll?: number;
  /** VTOL vertical lift (atmosphere) → ' ' (same key as jump). */
  vtol?: boolean;
  /** Space cruise boost → 'Shift' (same key as run). */
  boost?: boolean;
  /** On-foot run → 'Shift'. */
  run?: boolean;
  /** On-foot jump → ' ' (same key as vtol). */
  jump?: boolean;
}

/** Virtual key names — MUST match the keyboard capture (main.tsx `keyOf`). */
const K = {
  thrustUp: 'w',
  thrustDown: 's',
  yawRight: 'd',
  yawLeft: 'a',
  pitchUp: 'f',
  pitchDown: 'r',
  rollRight: 'e',
  rollLeft: 'q',
  space: ' ',
  shift: 'Shift',
} as const;

/**
 * Owns the ACTIVE touch channels and projects the HELD ones to virtual key
 * names. Discrete actions are deliberately absent (see file header).
 */
export class TouchInputSource {
  private channels: TouchChannels = {};

  /**
   * Merge the given channels into the current set; channels NOT present in
   * `channels` are left as-is.
   */
  setChannel(channels: Partial<TouchChannels>): void {
    for (const [name, value] of Object.entries(channels)) {
      if (value !== undefined) (this.channels as Record<string, unknown>)[name] = value;
    }
  }

  /** Reset every channel off. */
  clear(): void {
    this.channels = {};
  }

  /** Snapshot of the ACTIVE channels (the debug hook + tests read this). */
  snapshot(): TouchChannels {
    return { ...this.channels };
  }

  /**
   * Project the ACTIVE HELD channels to virtual key names (the union of all
   * active projections; the deliberate collisions collapse inside the Set).
   */
  virtualKeys(): ReadonlySet<string> {
    const c = this.channels;
    const out = new Set<string>();
    const thrust = c.thrust ?? 0;
    if (thrust > 0) out.add(K.thrustUp);
    if (thrust < 0) out.add(K.thrustDown);
    const yaw = c.yaw ?? 0;
    if (yaw > 0) out.add(K.yawRight);
    if (yaw < 0) out.add(K.yawLeft);
    const pitch = c.pitch ?? 0;
    if (pitch > 0) out.add(K.pitchUp);
    if (pitch < 0) out.add(K.pitchDown);
    const roll = c.roll ?? 0;
    if (roll > 0) out.add(K.rollRight);
    if (roll < 0) out.add(K.rollLeft);
    if (c.vtol) out.add(K.space);
    if (c.boost) out.add(K.shift);
    if (c.run) out.add(K.shift);
    if (c.jump) out.add(K.space);
    return out;
  }
}

/**
 * Merge the keyboard and touch pressed sets into a FRESH Set (union). With
 * touch off (an empty touch set) the result is exactly the keyboard set, so
 * the merge is a no-op until touch channels go active.
 */
export function mergePressed(
  keyboard: ReadonlySet<string>,
  touch: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>(keyboard);
  for (const key of touch) out.add(key);
  return out;
}

// --- TASK-99: analog flight magnitudes ---------------------------------------

/**
 * Per-axis merge of the keyboard readout (binary ±1/0) with the live touch
 * channel magnitude (analog, −1..1). The LARGER ABSOLUTE VALUE wins; with
 * equal magnitudes (including both zero, and equal-magnitude opposition)
 * the KEYBOARD wins — a held key is a deliberate player action that must
 * not be cancelled by a stick that merely rests at the same deflection.
 */
export function mergeAxis(kb: number, touch: number): number {
  return Math.abs(kb) >= Math.abs(touch) ? kb : touch;
}

/**
 * The touch axis channels in the FLIGHT-MODEL physics convention, at their
 * ANALOG magnitudes (the virtual-key projection above collapses them to
 * ±1; this keeps the stick deflection).
 *
 * The channels are ON-SCREEN direction (thrust > 0 forward, yaw > 0 nose
 * RIGHT, pitch > 0 nose UP, roll > 0 top RIGHT — see {@link TouchChannels}),
 * and readSchemeInput (TASK-80) is the ONE place that translates on-screen
 * key pairs to the physics convention, so a channel at ±1 must land on
 * exactly the physics sign the same key produces there:
 * - thrust: the pair is [forward, back] = [w, s] and is NOT flipped → +c;
 * - yaw: the pair is [right, left] = [d, a] and IS flipped → −c (physics
 *   yaw + is a nose-LEFT turn, so on-screen right is negative);
 * - pitch: the pair is [down, up] = [r, f], unflipped, and +c is nose UP
 *   = pair[1] → −c (physics pitch + is nose DOWN);
 * - roll: the pair is [left, right] = [q, e], flipped, and +c is top RIGHT
 *   = pair[1] → −(−c) = +c (physics roll + IS roll right, so it agrees).
 * A scheme with a NULL flight axis (the surface/character scheme) projects
 * to zero — the merge must never invent flight demand from a character
 * scheme, whatever the touch source holds.
 */
export function touchFlightAxes(
  scheme: ControlScheme,
  channels: TouchChannels,
): Pick<ShipInput, 'thrust' | 'yaw' | 'pitch' | 'roll'> {
  const mag = (v: number | undefined): number => (v === 0 ? 0 : (v ?? 0));
  // Negate without producing −0 (Object.is/toEqual distinguish −0 from +0 —
  // the idle frame must stay the canonical zero frame, the readSchemeInput
  // `flip` rule).
  const flip = (v: number): number => (v === 0 ? 0 : -v);
  return {
    thrust: scheme.thrust ? mag(channels.thrust) : 0,
    yaw: scheme.yaw ? flip(mag(channels.yaw)) : 0,
    pitch: scheme.pitch ? flip(mag(channels.pitch)) : 0,
    roll: scheme.roll ? mag(channels.roll) : 0,
  };
}

/**
 * The ship loop's merged flight demand: the keyboard's binary readout
 * (readSchemeInput) merged per axis with the live touch magnitudes
 * ({@link touchFlightAxes}) via {@link mergeAxis}. `up` (VTOL) and `boost`
 * stay the keyboard readout's — they are BUTTON-driven binary channels
 * (the touch buttons write the ' ' / 'Shift' virtual keys that the
 * merged pressed-set readout already picks up; the ship loop ORs them in
 * from that readout, since the AXIS readout must be keyboard-only so the
 * sticks' own virtual keys cannot flatten the analog magnitudes). With no
 * active touch axis channels the result deep-equals the keyboard input
 * (the legacy path unchanged).
 */
export function mergeFlightInput(
  keyboardInput: ShipInput,
  touchChannels: TouchChannels,
  scheme: ControlScheme,
): ShipInput {
  const touch = touchFlightAxes(scheme, touchChannels);
  return {
    thrust: mergeAxis(keyboardInput.thrust, touch.thrust),
    yaw: mergeAxis(keyboardInput.yaw, touch.yaw),
    pitch: mergeAxis(keyboardInput.pitch, touch.pitch),
    roll: mergeAxis(keyboardInput.roll, touch.roll),
    up: keyboardInput.up,
    boost: keyboardInput.boost,
  };
}
