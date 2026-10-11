/**
 * useFireHold (TASK-101) — the functional hold-to-fire for the touch FIRE
 * button.
 *
 * Press starts a requestAnimationFrame loop that calls `onFire` at most
 * once per {@link FIRE_HOLD_MIN_INTERVAL_MS} (333 ms, via the DOM-free
 * {@link FirePacer}), plus one IMMEDIATE first shot on press, so a tap is
 * never slower than the old one-shot. Release stops the loop. The loop
 * SENDS FIRE INTENTS ONLY: the server is still the rate AUTHORITY (it
 * re-derives range / aim and rate-limits to the weapon's own cooldown,
 * TASK-42/43), but the client now PACES the intents because the
 * per-connection inbound bucket (20 msg/s, TASK-65) is a transport limit
 * the server cannot see per message type — pre-fix the per-frame intent
 * stream (60-120+ 'fire' messages/s) was the second 4009-flood path on
 * touch (TASK-104). The rAF loop itself keeps running every frame
 * (release detection + the held accent live in it); only the intent send
 * is gated by the pacer. `held` is the FUNCTIONAL held state (the FIRE
 * button's pressed accent reflects the live loop, not a visual echo of a
 * tap).
 *
 * The touchDebug `fireHold(on)` e2e driver (touch-debug.ts) drives the SAME
 * hook from main.tsx (a second instance) for deterministic start/stop;
 * each instance cleans up its own loop on unmount.
 */
import React from 'react';

/**
 * The touch FIRE hold's client-side pace (TASK-104): one fire INTENT per
 * 333 ms ≈ the laser's 3/s fireRate (app/src/shared/weapons.ts). The
 * server remains the rate AUTHORITY and re-derives the weapon cooldown
 * (TASK-42/43), so a 333 ms client pace never fires faster than the
 * weapon allows, and slower weapons (the 0.5/s missile) are simply deduped
 * server-side. The pacing exists ONLY to keep the 'fire' message stream
 * under the per-connection 20 msg/s inbound bucket (TASK-65).
 */
export const FIRE_HOLD_MIN_INTERVAL_MS = 333;

/**
 * DOM-free, clock-injected fire-intent pacer (TASK-104). `due()` returns
 * true at most once per {@link FIRE_HOLD_MIN_INTERVAL_MS}; a call inside
 * the interval returns false WITHOUT moving the clock, so a dense
 * frame-rate call pattern can never fire faster than the pace. The first
 * call is always due (last = -Infinity) — the immediate first shot on
 * press is preserved.
 */
export class FirePacer {
  private last = Number.NEGATIVE_INFINITY;
  private readonly minIntervalMs: number;
  private readonly now: () => number;

  constructor(
    minIntervalMs: number,
    /**
     * Defaults to a closure (NOT the bare `performance.now` method): called
     * as `this.now()` the bare method would lose its `performance` receiver
     * and throw "Illegal invocation" in the browser.
     */
    now: () => number = () => performance.now(),
  ) {
    this.minIntervalMs = minIntervalMs;
    this.now = now;
  }

  /** True when a fire intent may go out NOW (and stamps the clock). */
  due(): boolean {
    const t = this.now();
    if (t - this.last < this.minIntervalMs) return false;
    this.last = t;
    return true;
  }

  /** (Re)start the pace window at NOW — a press re-arms the pacer. */
  reset(): void {
    this.last = this.now();
  }
}

export interface FireHold {
  /** The functional held state (drives the FIRE button's pressed accent). */
  readonly held: boolean;
  /** Press: the immediate first shot, then the per-frame fire loop. */
  press: () => void;
  /** Release: stop the loop (a release never re-fires). */
  release: () => void;
  /** Stop the loop without a release (unmount / regime-flip cleanup). */
  stop: () => void;
  /** Start/stop the same functional hold (the touchDebug fireHold driver). */
  setHeld: (on: boolean) => void;
}

/**
 * The shared hold-to-fire loop (see the file header). `onFire` is the
 * shared fireWeapon path (the canvas LMB's) — guards included, so an open
 * modal surface naturally suppresses the hold.
 */
export function useFireHold(onFire?: () => void): FireHold {
  const [held, setHeldState] = React.useState(false);
  /** The fire loop's rAF handle (null = not holding). */
  const loopRef = React.useRef<number | null>(null);
  const onFireRef = React.useRef(onFire);
  onFireRef.current = onFire;
  /**
   * TASK-104: the fire-intent pacer (one intent per 333 ms). Created LAZY
   * on the first press (not at render) so the rAF clock (`performance.now`)
   * is never captured at module/render time — and so a test's fake clock is
   * in effect by the time the pacer reads it. The rAF loop keeps running
   * every frame; only the intent send is gated by `pacer.due()`.
   */
  const pacerRef = React.useRef<FirePacer | null>(null);

  const stop = React.useCallback((): void => {
    if (loopRef.current !== null) {
      cancelAnimationFrame(loopRef.current);
      loopRef.current = null;
    }
    setHeldState(false);
  }, []);

  const press = React.useCallback((): void => {
    if (loopRef.current !== null) return; // already holding
    setHeldState(true);
    const pacer = pacerRef.current ?? (pacerRef.current = new FirePacer(FIRE_HOLD_MIN_INTERVAL_MS));
    // The IMMEDIATE first shot on press is unconditional — a tap is never
    // slower than the old one-shot, and every fresh press (not just the
    // first) fires at once. Re-arm the pacer so the HELD loop paces from
    // HERE (the first paced intent lands 333 ms out, not a double-fire on
    // the first frame).
    onFireRef.current?.();
    pacer.reset();
    const step = (): void => {
      // TASK-104: pace the INTENT (at most one per 333 ms). The rAF loop
      // itself keeps running every frame (release detection + the held
      // accent live in it); only the send is gated by the pacer.
      if (pacer.due()) onFireRef.current?.();
      loopRef.current = requestAnimationFrame(step);
    };
    loopRef.current = requestAnimationFrame(step);
  }, []);

  const setHeld = React.useCallback(
    (on: boolean): void => {
      if (on) press();
      else stop();
    },
    [press, stop],
  );

  // Unmount: a still-running loop would keep firing with no visible control.
  React.useEffect(() => stop, [stop]);

  return { held, press, release: stop, stop, setHeld };
}
