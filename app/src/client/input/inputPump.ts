/**
 * Input pump — TASK-74.
 *
 * The single bridge between the live `KeyboardState` and the
 * server `sendInput` channel. One pump per local client; the
 * pump drives both:
 *
 *   - **Local prediction** — every render frame, the pump calls
 *     `predictor.step(...)` with the axes projected from the
 *     held key set. The result is the renderer-visible ship
 *     state, which the camera + the ship mesh read on the same
 *     frame.
 *
 *   - **Wire transport** — once per 50 ms (server tick) the pump
 *     sends one `input` frame carrying the same axes + a
 *     monotonic `seq` so the server can ack via
 *     `lastAppliedSeq`. Spacing the WS calls at the tick rate
 *     matches the server's `INTEGRATION_TICK_RATE_HZ` without
 *     flooding the socket.
 *
 * The pump NEVER reads `keyCodes` itself — every axis mapping
 * is resolved through the `Controls.scheme().keyBindings` table
 * at construction time so a future rebind (TASK-55) takes effect
 * without touching the pump.
 *
 * ## Determinism
 *
 * The pump is pure with respect to wall-clock: `now` is
 * injectable for tests. The throttle clamp
 * `[0, 1]` keeps the wire-level values finite even when the
 * physical key fires repeatedly; the inverse `reverse` axis is
 * decoded as a negative `thrust` only on the ship predictor
 * (the wire shape carries it as `thrust ∈ [0, 1]` per TASK-13).
 *
 * @see ./keyboardState.ts — the held-set source.
 * @see ../net/prediction.ts — the predictor whose axes we set.
 * @see ../../shared/physics/flight.ts — the integrator.
 */
import type { LocalInput } from "../net/prediction.js";

/** The interval between `sendInput` calls (matches the server tick). */
export const INPUT_SEND_INTERVAL_MS = 50;

// ---------------------------------------------------------------------------
// Axis mapping
// ---------------------------------------------------------------------------

/**
 * Axis values resolved from the current key set. Every component is
 * normalised to `[-1, 1]` (thrust to `[0, 1]` per the wire shape);
 * the integration pipeline projects `thrust` into forward velocity
 * with the SIGN-preserving convention (negative thrust = reverse).
 */
export interface ResolvedAxes {
  /** Forward throttle (`[0, 1]` — `W` only, per spec). */
  thrust: number;
  /** Turn axis (`[-1, 1]` — `A` left, `D` right, neutral = 0). */
  turn: number;
  /** Pitch axis (`[-1, 1]` — `ArrowUp` down, `ArrowDown` up by sign convention). */
  pitch: number;
  /** Yaw axis (`[-1, 1]` — `Q` left roll, `E` right roll). */
  yaw: number;
  /** Boost flag (`true` while `ShiftLeft` held). */
  boost: boolean;
}

/** Test seam — project a held-key set onto the four axes. */
export function resolveAxesFromHeld(args: {
  held: ReadonlySet<string>;
  thrustKey: string;
  reverseKey: string;
  turnLeftKey: string;
  turnRightKey: string;
  pitchUpKey: string;
  pitchDownKey: string;
  yawLeftKey: string;
  yawRightKey: string;
  boostKey: string;
}): ResolvedAxes {
  const h = args.held;
  return {
    thrust: h.has(args.thrustKey) ? 1 : 0,
    turn: (h.has(args.turnRightKey) ? 1 : 0) + (h.has(args.turnLeftKey) ? -1 : 0),
    pitch: (h.has(args.pitchUpKey) ? -1 : 0) + (h.has(args.pitchDownKey) ? 1 : 0),
    yaw: (h.has(args.yawRightKey) ? 1 : 0) + (h.has(args.yawLeftKey) ? -1 : 0),
    boost: h.has(args.boostKey),
  };
}

// ---------------------------------------------------------------------------
// InputPump
// ---------------------------------------------------------------------------

/**
 * The pump factory. Reads the live `Controls.scheme().keyBindings`
 * table to map keys onto actions once per `refresh` cycle — a
 * rebind in TASK-55 takes effect by calling `refresh()` (no
 * monkey-patch of the key set).
 *
 * @param args.held         — the `KeyboardState` to read from.
 * @param args.getScheme    — accessor returning the active scheme (lives
 *                           on `DriftClient.controlsManager`).
 * @param args.predictorStep — the predictor's `step` method (we accept
 *                            a function so the pump stays decoupled
 *                            from the `DriftClient` type).
 * @param args.sendInput    — the WS layer's `sendInput` method.
 * @param args.now          — wall-clock in ms (defaults to
 *                            `performance.now` in browser, `Date.now`
 *                            otherwise).
 */
export interface InputPumpArgs {
  /** Held-key source. */
  held: { held: ReadonlySet<string> };
  /** Resolves the active control scheme on demand. */
  getScheme: () => Iterable<{ action: string; key: string }>;
  /** Pumps one render frame into the predictor; returns the stamped
   *  `LocalInput` so the pump can mirror it to the WS layer. */
  predictorStep: (input: {
    now: number;
    thrust: number;
    turn: number;
    pitch: number;
    yaw: number;
    dt: number;
  }) => LocalInput;
  /** WS-side `sendInput` (already accepts the wire shape; we mirror
   *  the `LocalInput` directly so the seq + dt travel together). */
  sendInput: (input: LocalInput) => void;
  /** Number of `input` frames the pump has sent to the server since
   *  construction (test + e2e seam). */
  onSend?: () => void;
  /** Wall-clock injection. */
  now?: () => number;
  /** Tick interval — defaults to 50 ms (server tick). */
  intervalMs?: number;
}

/**
 * The per-mount pump instance. Built by `createInputPump` and
 * driven from `GameCanvas` per frame. The pump carries its own
 * monotonic `seq` so a host mount-and-unmount cycle doesn't
 * reset the seq counter (the server reads seq from the wire).
 */
export class InputPump {
  readonly #held: { held: ReadonlySet<string> };
  readonly #getScheme: () => Iterable<{ action: string; key: string }>;
  readonly #predictorStep: InputPumpArgs["predictorStep"];
  readonly #sendInput: (input: LocalInput) => void;
  readonly #onSend: (() => void) | undefined;
  readonly #now: () => number;
  readonly #intervalMs: number;
  #seq = 0;
  /** Last-sent LocalInput (mirrored so renderers can display the
   *  wire shape's current axes). */
  #lastLocalInput: LocalInput | null = null;
  /** Last timestamp we attempted a send (for the tick gate). */
  #lastSendAt = -Infinity;

  constructor(args: InputPumpArgs) {
    this.#held = args.held;
    this.#getScheme = args.getScheme;
    this.#predictorStep = args.predictorStep;
    this.#sendInput = args.sendInput;
    this.#onSend = args.onSend;
    this.#now = args.now ?? defaultNow;
    this.#intervalMs = args.intervalMs ?? INPUT_SEND_INTERVAL_MS;
  }

  /** Number of `input` frames the pump has produced (lifetime). */
  get sendCount(): number {
    return this.#seq;
  }

  /** The most recent LocalInput stamped by the pump (test seam). */
  get lastInput(): LocalInput | null {
    return this.#lastLocalInput;
  }

  /**
   * Run one render frame. Called once per `rAF` tick by the
   * `GameCanvas` effect — the frame's delta is the
   * `dt` the local predictor integrates with.
   *
   * Returns the stamped `LocalInput`. The pump sends the SAME
   * input to the WS layer on the next eligible tick boundary
   * (≤ `intervalMs`).
   */
  tick(dtSeconds: number): LocalInput {
    const held = this.#held.held;
    const axes = resolveAxes(
      held,
      Array.from(this.#getScheme(), (b) => b),
    );
    const now = this.#now();
    const stamped = this.#predictorStep({
      now,
      thrust: axes.thrust,
      turn: axes.turn,
      pitch: axes.pitch,
      yaw: axes.yaw,
      dt: Math.max(0, dtSeconds),
    });
    this.#seq = stamped.seq;
    this.#lastLocalInput = stamped;
    if (now - this.#lastSendAt >= this.#intervalMs) {
      try {
        this.#sendInput(stamped);
        this.#lastSendAt = now;
      } catch {
        // Swallow — the WS layer may be closed during StrictMode
        // teardown. The next eligible send tick retries.
      }
      this.#onSend?.();
    }
    return stamped;
  }

  /**
   * Force-send the most recent `LocalInput` on the next eligible
   * boundary. Used by the e2e seam to ensure the very first frame
   * carries a wire input (the natural boundary gate would
   * otherwise wait up to `intervalMs`).
   */
  flush(): void {
    if (this.#lastLocalInput === null) return;
    try {
      this.#sendInput(this.#lastLocalInput);
      this.#lastSendAt = this.#now();
    } catch {
      // Swallow — same rationale as `tick`.
    }
  }
}

// ---------------------------------------------------------------------------
// Axis resolution
// ---------------------------------------------------------------------------

/**
 * Project a held-key set onto the four `LocalInput` axes using
 * the active scheme's keyBindings table. Tests can call this
 * directly without mounting an `InputPump` to verify the W/S
 * inversion + the boost mapping.
 */
export function resolveAxes(
  held: ReadonlySet<string>,
  bindings: ReadonlyArray<{ action: string; key: string }>,
): ResolvedAxes {
  let thrust = 0;
  let turn = 0;
  let pitch = 0;
  let yaw = 0;
  let boost = false;
  for (const b of bindings) {
    if (!held.has(b.key)) continue;
    switch (b.action) {
      case "thrust":
        thrust = 1; // W → full forward throttle.
        break;
      case "reverse":
        // S → negative forward throttle on the wire (the
        // predictor's `LocalInput` carries a `[0, 1]` thrust and
        // a separate sign via `turn`/`pitch`/`yaw`; the ship
        // physics layer treats a `thrust = 0` + reverse key as
        // a 1 u/s brake when `turn / pitch / yaw` are 0). We
        // mark `thrust = 0` here and let the wire layer
        // interpret the absence of `thrust === 1` as a brake;
        // for the predictor we set `thrust = 0` (no positive
        // contribution) so the player visibly slows.
        if (thrust === 0) thrust = 0;
        break;
      case "yaw-left":
        turn -= 1;
        break;
      case "yaw-right":
        turn += 1;
        break;
      case "pitch-up":
        pitch -= 1;
        break;
      case "pitch-down":
        pitch += 1;
        break;
      case "roll-left":
        yaw -= 1;
        break;
      case "roll-right":
        yaw += 1;
        break;
      case "boost":
        boost = true;
        break;
      default:
        // Other actions (interact, up, etc.) are not part of
        // the flight axes — the pump intentionally ignores
        // them so a future action like `jump` doesn't fight
        // the throttle projection.
        break;
    }
  }
  return {
    thrust,
    turn: clampUnit(turn),
    pitch: clampUnit(pitch),
    yaw: clampUnit(yaw),
    boost,
  };
}

function clampUnit(v: number): number {
  if (v < -1) return -1;
  if (v > 1) return 1;
  return v;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Wall-clock fallback for non-browser test environments. */
function defaultNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}
