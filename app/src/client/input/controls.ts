/**
 * Client controls remap — TASK-25 step 3.
 *
 * The controls manager owns the per-regime key bindings and swaps
 * the active scheme whenever the regime state machine reports a
 * transition. The remap is **instant at the boundary frame** —
 * there is no menu, no fade, no animation, no "are you sure?" —
 * because the regime manager is authoritative; a frame where the
 * bindings lag the regime would produce a visible input glitch.
 *
 * Three schemes ship today:
 *
 *   - `'space'`      — full 6-DOF-ish flight: thrust / yaw / pitch
 *                      / roll + boost. No VTOL key (out of
 *                      atmosphere the VTOL key does nothing).
 *   - `'atmosphere'` — flight + VTOL lift key. Same flight axes as
 *                      space, plus an `up` action the integrator
 *                      uses to apply vertical thrust.
 *   - `'surface'`    — on-pad / landed. Stub for now; TASK-31
 *                      fills in the character-mode bindings
 *                      (walk / look / interact). We still register
 *                      the scheme here so the swap at the
 *                      atmosphere → surface boundary is observable
 *                      end-to-end.
 *
 * The module is intentionally framework-agnostic: no React, no
 * three.js, no event-loop coupling. Callers (the renderer, the
 * prediction layer) subscribe to the controls store and react to
 * `onRegimeChange` events. A unit test can drive the manager
 * directly without spinning up a browser.
 *
 * ## Determinism
 *
 * The same `(currentRegime, newRegime)` pair always produces the
 * same `ControlSchemeId`. Same `ControlSchemeId` always yields the
 * same `keyBindings` map. The class is pure with respect to time
 * and doesn't read `Date.now` or `Math.random`.
 *
 * @see @shared/regime.ts for the regime state machine this manager
 *      reacts to.
 * @see ./controls.test.ts for the regime → scheme swap coverage.
 */

import type { Regime } from "@shared/regime.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The four control schemes the renderer swaps between. Wire-stable
 * — adding a new id requires extending the `keyBindings` table and
 * the `SCHEME_BY_REGIME` map, but the existing ids stay the same
 * so older clients can still parse them.
 */
export type ControlSchemeId = "ship-space" | "ship-atmosphere" | "ship-surface" | "character";

/**
 * A single binding: the wire-stable action id (consumed by the
 * server's `input` frame) and the keyboard key that produces it.
 * v1 keys are WASD + arrows + Space; future tasks can rebind via
 * the settings UI (TASK-55) without changing the action ids.
 */
export interface KeyBinding {
  /** Wire-stable action id sent in `input` frames. */
  readonly action: string;
  /** Keyboard code (e.g. `'KeyW'`, `'ArrowUp'`). Single value per binding for v1. */
  readonly key: string;
}

/**
 * The active scheme — a flat list of `KeyBinding`s plus the
 * `regime` it corresponds to (so subscribers can tell which regime
 * is now in effect without tracking separately).
 */
export interface ControlScheme {
  readonly id: ControlSchemeId;
  readonly regime: Regime;
  readonly keyBindings: readonly KeyBinding[];
}

// ---------------------------------------------------------------------------
// Built-in schemes
// ---------------------------------------------------------------------------

/**
 * Space controls — full 6-DOF-ish flight. No VTOL key (it would
 * do nothing in space anyway).
 */
export const SPACE_SCHEME: ControlScheme = Object.freeze({
  id: "ship-space",
  regime: "space",
  keyBindings: Object.freeze([
    Object.freeze({ action: "thrust", key: "KeyW" }),
    Object.freeze({ action: "reverse", key: "KeyS" }),
    Object.freeze({ action: "yaw-left", key: "KeyA" }),
    Object.freeze({ action: "yaw-right", key: "KeyD" }),
    Object.freeze({ action: "pitch-up", key: "ArrowUp" }),
    Object.freeze({ action: "pitch-down", key: "ArrowDown" }),
    Object.freeze({ action: "roll-left", key: "KeyQ" }),
    Object.freeze({ action: "roll-right", key: "KeyE" }),
    Object.freeze({ action: "boost", key: "ShiftLeft" }),
  ] as const),
});

/**
 * Atmosphere controls — same flight axes as space plus the VTOL
 * lift key. The `up` action maps to the `Space` key (mnemonic:
 * "space bar = up") so the player's muscle memory transfers
 * between space and atmosphere.
 */
export const ATMOSPHERE_SCHEME: ControlScheme = Object.freeze({
  id: "ship-atmosphere",
  regime: "atmosphere",
  keyBindings: Object.freeze([
    Object.freeze({ action: "thrust", key: "KeyW" }),
    Object.freeze({ action: "reverse", key: "KeyS" }),
    Object.freeze({ action: "yaw-left", key: "KeyA" }),
    Object.freeze({ action: "yaw-right", key: "KeyD" }),
    Object.freeze({ action: "pitch-up", key: "ArrowUp" }),
    Object.freeze({ action: "pitch-down", key: "ArrowDown" }),
    Object.freeze({ action: "roll-left", key: "KeyQ" }),
    Object.freeze({ action: "roll-right", key: "KeyE" }),
    Object.freeze({ action: "boost", key: "ShiftLeft" }),
    Object.freeze({ action: "up", key: "Space" }),
  ] as const),
});

/**
 * Surface controls — docked-on-pad. While the ship sits on the pad
 * the player can interact (TASK-33) and lift off (Space = up). The
 * ship itself is still locally controllable via the predict-and-
 * reconcile pipeline, so the axes here only matter for the
 * on-pad interaction prompt + the lift-off key.
 */
export const SURFACE_SCHEME: ControlScheme = Object.freeze({
  id: "ship-surface",
  regime: "surface",
  keyBindings: Object.freeze([
    Object.freeze({ action: "thrust", key: "KeyW" }),
    Object.freeze({ action: "up", key: "Space" }),
    // Interact key — TASK-33 will wire the prompt UI to this.
    Object.freeze({ action: "interact", key: "KeyE" }),
  ] as const),
});

/**
 * TASK-31 / TASK-32: character-mode scheme. The player has
 * disembarked from the docked ship and is now on foot.
 *
 * v1 bindings:
 *   - W / S → forward / back (moveZ ± 1 in the character input)
 *   - A / D → strafe left / right (moveX ± 1)
 *   - Space → jump (single-impulse, only honoured on ground)
 *   - ShiftLeft → run / sprint (sends `fire: true` on the wire —
 *     the wire's `fire` flag is unused for characters so we
 *     overload it as the sprint flag)
 *   - KeyE → interact (TASK-33 wires the prompt UI to this; the
 *     binding ships here so the regime-swap is observable in v1)
 *
 * The `regime` field is a *display* hint; characters don't really
 * have a flight-model regime. We tag it `'surface'` because the
 * renderer still wants to know "this is a ground-level entity".
 */
export const CHARACTER_SCHEME: ControlScheme = Object.freeze({
  id: "character",
  regime: "surface",
  keyBindings: Object.freeze([
    Object.freeze({ action: "move-forward", key: "KeyW" }),
    Object.freeze({ action: "move-back", key: "KeyS" }),
    Object.freeze({ action: "strafe-left", key: "KeyA" }),
    Object.freeze({ action: "strafe-right", key: "KeyD" }),
    Object.freeze({ action: "jump", key: "Space" }),
    Object.freeze({ action: "run", key: "ShiftLeft" }),
    Object.freeze({ action: "interact", key: "KeyE" }),
  ] as const),
});

/**
 * Lookup table mapping each `Regime` to its `ControlScheme`. The
 * `'surface'` regime maps to `SURFACE_SCHEME` even though it's a
 * stub today — that keeps the lookup total and lets the manager
 * swap into the stub at the right frame.
 */
export const SCHEME_BY_REGIME: Readonly<Record<Regime, ControlScheme>> = Object.freeze({
  space: SPACE_SCHEME,
  atmosphere: ATMOSPHERE_SCHEME,
  surface: SURFACE_SCHEME,
});

// ---------------------------------------------------------------------------
// Controls store
// ---------------------------------------------------------------------------

/**
 * Listener callback for regime transitions. Fires AFTER the scheme
 * has been swapped, so subscribers can read `controls.scheme()` to
 * see the new active scheme.
 */
export type RegimeChangeListener = (event: RegimeChangeEvent) => void;

/**
 * Payload emitted on every regime change. Mirrors the server's
 * `RegimeChangeEvent` shape (TASK-25) but carries the scheme id
 * the controls layer just swapped to.
 */
export interface RegimeChangeEvent {
  readonly from: Regime;
  readonly to: Regime;
  readonly schemeId: ControlSchemeId;
}

/**
 * The client-side controls manager.
 *
 * Lifecycle:
 *   1. Construct with the *current* regime (the local prediction
 *      layer is the immediate source).
 *   2. Subscribe via `onRegimeChange(...)` for regime transitions.
 *   3. On every server `entity_update`, call `applyRegime(newRegime)`.
 *      The manager decides whether the regime changed (vs just
 *      matched the local prediction) and fires the listener if it
 *      did.
 *   4. Use `scheme()` to read the active bindings.
 *
 * Pure with respect to time — no `Date.now`, no timers. Multiple
 * instances can coexist (e.g. one per local ship) without
 * contention because each owns its own `scheme` + listener list.
 */
export class Controls {
  private current: ControlScheme;
  private listeners: Set<RegimeChangeListener> = new Set();
  /**
   * TASK-31: when true the manager serves `CHARACTER_SCHEME`
   * instead of the regime-mapped scheme. Survives a regime change
   * (the character is always "on foot" regardless of which surface
   * or atmosphere the ship was in at the moment of disembark).
   */
  private onFoot = false;

  constructor(initialRegime: Regime = "space") {
    this.current = SCHEME_BY_REGIME[initialRegime];
  }

  /** The active scheme (current bindings). */
  scheme(): ControlScheme {
    return this.current;
  }

  /** The regime currently driving the scheme. */
  regime(): Regime {
    return this.current.regime;
  }

  /**
   * Apply a new regime — fires the listener iff the regime
   * actually changed. Idempotent: calling with the current regime
   * is a no-op (no listener fired, no internal state mutated).
   *
   * Returns `true` if a transition occurred, `false` otherwise.
   * Useful for callers that want to log without subscribing.
   */
  applyRegime(next: Regime): boolean {
    if (next === this.current.regime) return false;
    const prev = this.current.regime;
    this.current = this.onFoot ? CHARACTER_SCHEME : SCHEME_BY_REGIME[next];
    const event: RegimeChangeEvent = {
      from: prev,
      to: next,
      schemeId: this.current.id,
    };
    // Copy the listeners so a listener that unsubscribes itself
    // (or subscribes a new one) doesn't perturb the iteration.
    const snapshot = [...this.listeners];
    for (const listener of snapshot) {
      try {
        listener(event);
      } catch {
        // Swallow listener errors so one buggy subscriber can't
        // take the controls layer down. Production callers
        // surface errors via the dev console; tests assert via
        // direct inspection of `scheme()` after the call.
      }
    }
    return true;
  }

  /**
   * TASK-31: toggle on-foot (character) mode. When `true`, the
   * active scheme is `CHARACTER_SCHEME`; when `false`, the
   * scheme is the regime-mapped one. Fires the listener iff the
   * scheme id actually changed.
   *
   * Called by the WS layer when the local entity's kind flips
   * between `'ship'` and `'character'`. TASK-35 (re-entry) calls
   * this with `false` on the way back into the ship.
   */
  setOnFoot(next: boolean): boolean {
    if (next === this.onFoot) return false;
    const prev = this.current.regime;
    this.onFoot = next;
    this.current = next ? CHARACTER_SCHEME : SCHEME_BY_REGIME[this.current.regime];
    const event: RegimeChangeEvent = {
      from: prev,
      to: this.current.regime,
      schemeId: this.current.id,
    };
    const snapshot = [...this.listeners];
    for (const listener of snapshot) {
      try {
        listener(event);
      } catch {
        // swallow
      }
    }
    return true;
  }

  /** True while the controls manager is in character mode. */
  isOnFoot(): boolean {
    return this.onFoot;
  }

  /**
   * Subscribe to regime changes. The returned function unsubscribes.
   * Listener exceptions are swallowed (see `applyRegime`).
   */
  onRegimeChange(listener: RegimeChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

// ---------------------------------------------------------------------------
// Convenience: pick the right scheme for a (server, client) pair
// ---------------------------------------------------------------------------

/**
 * Detect a client/server regime divergence per the spec's
 * "> 500 ms divergence" rule. Returns the *predicted* regime the
 * client should snap to after the timeout.
 *
 * The caller (typically the prediction layer) tracks:
 *
 *   - `serverRegime` — the regime in the latest `entity_update`
 *   - `predictedRegime` — the regime the client's local `regimeFor`
 *     call just resolved
 *   - `divergenceStartMs` — wall-clock ms when the divergence first
 *     appeared (set on the first mismatching frame, cleared on a
 *     match)
 *
 * When `serverRegime !== predictedRegime` for more than 500 ms,
 * the client snaps to `serverRegime` and surfaces a debug warning.
 *
 * This function does NOT track time itself; it just returns the
 * decision. The caller wires the timer (the renderer, the
 * prediction layer, or a dedicated dev hook).
 */
export function shouldSnapToServer(
  args: {
    serverRegime: Regime;
    predictedRegime: Regime;
    divergenceMs: number;
  },
  divergenceThresholdMs: number = 500,
): boolean {
  if (args.serverRegime === args.predictedRegime) return false;
  return args.divergenceMs > divergenceThresholdMs;
}

/**
 * Log a debug message when a regime divergence is detected. The
 * caller passes the formatted message; we provide the helper so
 * every divergence site uses the same prefix and shape.
 */
export function debugRegimeDivergenceMessage(args: {
  entityId: string;
  serverRegime: Regime;
  predictedRegime: Regime;
  divergenceMs: number;
}): string {
  return (
    `[drift-controls] entity=${args.entityId} regime divergence ` +
    `(server=${args.serverRegime} client=${args.predictedRegime}) for ${args.divergenceMs.toFixed(0)} ms — snapping to server`
  );
}
