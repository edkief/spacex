/**
 * useFireHold (TASK-101) — the functional hold-to-fire for the touch FIRE
 * button.
 *
 * Press starts a requestAnimationFrame loop that calls `onFire` once per
 * frame (plus one IMMEDIATE first shot on press, so a tap is never slower
 * than the old one-shot). Release stops the loop. The loop SENDS FIRE
 * INTENTS ONLY: the server is authoritative and re-derives range / aim and
 * rate-limits to the weapon's own cooldown (TASK-42/43), so there is NO
 * client-side rate limiter here — a second limiter would drift from the
 * server's. `held` is the FUNCTIONAL held state now (the FIRE button's
 * pressed accent reflects the live loop, not a visual echo of a tap).
 *
 * The touchDebug `fireHold(on)` e2e driver (touch-debug.ts) drives the SAME
 * hook from main.tsx (a second instance) for deterministic start/stop;
 * each instance cleans up its own loop on unmount.
 */
import React from 'react';

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
    onFireRef.current?.(); // first shot NOW (do not wait for the first frame)
    const step = (): void => {
      onFireRef.current?.();
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
