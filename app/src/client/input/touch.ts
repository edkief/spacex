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
 */

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
