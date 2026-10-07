/**
 * Controls remap (TASK-25, step 3) — one ControlScheme per regime.
 *
 * The active scheme swaps INSTANTLY on the boundary-crossing frame (the
 * regime manager's change event, predicted or server-confirmed): no menu,
 * no fade. Space = full 6-DOF-ish flight (thrust/yaw/pitch/roll);
 * atmosphere = flight + a vertical VTOL key; surface (on pad / landed) =
 * walk/look/interact — the character-mode keys exist NOW as a stub, the
 * on-foot behavior is filled in by TASK-31.
 *
 * DOM-free and deterministic by design: schemes are plain key maps and
 * `readInput` is a pure function of the pressed-key set, so the whole
 * remap is unit-testable without a browser.
 */

import type { Regime } from '@shared/regime';
import type { ShipInput } from '@shared/physics/flight';

/** One control channel binding: the key (event.key value) that drives it. */
export type Key = string;

/** Key map for one regime. Flight channels are the flight model's ShipInput. */
export interface ControlScheme {
  regime: Regime;
  /** Human-readable label (HUD/debug). */
  label: string;
  /** Thrust demand axis (flight regimes; W/S style pairs). */
  thrust: [Key, Key] | null; // [up, down]
  /**
   * Yaw axis [right, left] — pair[0] is the key that turns the NOSE TO THE
   * RIGHT ON SCREEN (the remap UI will label the pair that way, TASK-80).
   * `readInput` translates the on-screen direction into the physics
   * convention (positive yaw = nose toward local +X = a LEFT turn), so the
   * pair stays [right, left] no matter what the physics signs are.
   */
  yaw: [Key, Key] | null;
  /** Pitch axis [down, up] (nose down / nose up; R = down, F = up). */
  pitch: [Key, Key] | null;
  /**
   * Roll axis [left, right] — pair[0] is the key that ROLLS THE TOP TO THE
   * LEFT AS SEEN FROM BEHIND (TASK-80); `readInput` applies the same
   * sign translation as yaw (positive roll = clockwise seen from behind =
   * roll right in the physics convention).
   */
  roll: [Key, Key] | null;
  /** VTOL vertical lift key (atmosphere only; full demand while held). */
  vtol: Key | null;
  /**
   * Space cruise boost key (TASK-85; full demand while held). Space only —
   * null in atmosphere/surface so the SAME Shift key keeps meaning 'run'
   * on foot (the on-foot loop reads it directly from the pressed set).
   */
  boost: Key | null;
  /** Character-mode channels (surface; behavior is the TASK-31 stub). */
  move: { forward?: Key; back?: Key; left?: Key; right?: Key } | null;
  interact: Key | null;
}

/** The v1 key maps: flight on WASD+QE, VTOL on Space, character on WASD+E. */
export const CONTROL_SCHEMES: Record<Regime, ControlScheme> = {
  space: {
    regime: 'space',
    label: 'FLIGHT (SPACE)',
    thrust: ['w', 's'],
    yaw: ['d', 'a'],
    pitch: ['r', 'f'],
    roll: ['q', 'e'],
    vtol: null,
    boost: 'Shift',
    move: null,
    interact: null,
  },
  atmosphere: {
    regime: 'atmosphere',
    label: 'FLIGHT (ATMOSPHERE)',
    thrust: ['w', 's'],
    yaw: ['d', 'a'],
    pitch: ['r', 'f'],
    roll: ['q', 'e'],
    vtol: ' ',
    boost: null,
    move: null,
    interact: null,
  },
  surface: {
    regime: 'surface',
    label: 'CHARACTER (ON FOOT)',
    thrust: null,
    yaw: null,
    pitch: null,
    roll: null,
    vtol: null,
    boost: null,
    move: { forward: 'w', back: 's', left: 'a', right: 'd' },
    interact: 'e',
  },
};

/** Character-mode readout (the TASK-31 stub — behavior lands there). */
export interface CharacterInput {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  interact: boolean;
}

/** Log sink for scheme swaps (debug; injectable in tests). */
export type ControlsLogger = (msg: string, meta?: Record<string, unknown>) => void;

/**
 * Owns the ACTIVE ControlScheme. `setRegime` swaps in place (instant) when
 * the regime changes and logs the swap (debug); repeated sets of the same
 * regime are no-ops (no duplicate logs).
 */
export class ControlsRemapper {
  private active: ControlScheme;
  private readonly log: ControlsLogger;
  private readonly listeners = new Set<(regime: Regime) => void>();

  constructor(initial: Regime = 'space', log?: ControlsLogger) {
    this.active = CONTROL_SCHEMES[initial];
    this.log = log ?? ((msg, meta) => console.debug(`[controls] ${msg}`, meta ?? ''));
  }

  get regime(): Regime {
    return this.active.regime;
  }

  /** The active key map (read-only view). */
  get scheme(): ControlScheme {
    return this.active;
  }

  /**
   * Swap the active scheme when the regime changes. Returns true when a
   * swap happened (the boundary-crossing frame) so callers can react.
   */
  setRegime(regime: Regime): boolean {
    if (regime === this.active.regime) return false;
    const from = this.active.regime;
    this.active = CONTROL_SCHEMES[regime];
    this.log('controls remap', { from, to: regime, scheme: this.active.label });
    for (const listener of this.listeners) listener(regime);
    return true;
  }

  /** Subscribe to regime changes (the HUD binds here); returns unsubscribe. */
  subscribe(listener: (regime: Regime) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Map the currently pressed keys to this tick's flight input (the active
   * scheme's key map; surface returns a zero frame — walking is
   * CharacterInput, TASK-31).
   *
   * Sign translation (TASK-80, the ONE place the on-screen key pairs meet
   * the physics convention): the flight model is right-handed with +Y up
   * and +Z forward, where positive yaw turns the nose toward local +X —
   * screen LEFT for the chase camera, and positive roll is clockwise seen
   * from behind — roll RIGHT. The scheme pairs are documented ON SCREEN
   * ([right, left] / [left, right]), so yaw and roll demands are negated
   * here; pitch (R down / F up) already matches and is left alone.
   * `integrateShip`, the server AI and the wire mapping all keep the raw
   * physics convention untouched.
   */
  readInput(pressed: ReadonlySet<Key>): ShipInput {
    const s = this.active;
    const axis = (pair: [Key, Key] | null): number =>
      pair ? (pressed.has(pair[0]) ? 1 : 0) - (pressed.has(pair[1]) ? 1 : 0) : 0;
    // Negate without producing −0 (Object.is/toEqual distinguish −0 from +0
    // — the idle frame must stay the canonical zero frame).
    const flip = (v: number): number => (v === 0 ? 0 : -v);
    return {
      thrust: axis(s.thrust),
      yaw: flip(axis(s.yaw)),
      pitch: axis(s.pitch),
      roll: flip(axis(s.roll)),
      up: s.vtol && pressed.has(s.vtol) ? 1 : 0,
      boost: s.boost && pressed.has(s.boost) ? 1 : 0,
    };
  }

  /** Character-mode readout (surface scheme only; stub until TASK-31). */
  readCharacterInput(pressed: ReadonlySet<Key>): CharacterInput {
    const m = this.active.move;
    const i = this.active.interact;
    return {
      forward: !!m?.forward && pressed.has(m.forward),
      back: !!m?.back && pressed.has(m.back),
      left: !!m?.left && pressed.has(m.left),
      right: !!m?.right && pressed.has(m.right),
      interact: !!i && pressed.has(i),
    };
  }
}
