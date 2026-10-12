import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __resetCanExitShip,
  canExitLanded,
  canExitShip,
  canExitShipSubscribe,
  setCanExitShip,
} from './exit-ship';

describe('canExitLanded predicate (TASK-105)', () => {
  it('requires flight regime "surface" AND speed below the shared 2 u/s cap', () => {
    expect(canExitLanded('surface', 0)).toBe(true);
    expect(canExitLanded('surface', 1.99)).toBe(true);
    expect(canExitLanded('surface', 2)).toBe(false); // the cap is a strict <
    expect(canExitLanded('surface', 5)).toBe(false);
    expect(canExitLanded('atmosphere', 0)).toBe(false); // airborne, any speed
    expect(canExitLanded('space', 0)).toBe(false); // in space
    expect(canExitLanded('docked', 0)).toBe(false); // the docked store owns that case
    expect(canExitLanded('sublight', 0)).toBe(false);
  });
});

describe('can-exit state (TASK-105)', () => {
  afterEach(() => __resetCanExitShip());

  it('starts false, emits only on change, and late subscribers catch up', () => {
    const fn = vi.fn();
    const off = canExitShipSubscribe(fn);
    expect(canExitShip()).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith(false); // immediate current value

    setCanExitShip(false); // no change → no emit
    expect(fn).toHaveBeenCalledTimes(1);

    setCanExitShip(true);
    expect(canExitShip()).toBe(true);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith(true);

    off();
    setCanExitShip(false); // unsubscribed → no more emits
    expect(canExitShip()).toBe(false);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('drives from the self entity_update values (the main.tsx wiring contract)', () => {
    // Landed off-pad: regime 'surface', slow → the prompt arms.
    setCanExitShip(canExitLanded('surface', 0.4));
    expect(canExitShip()).toBe(true);

    // The ship accelerates to the cap → the prompt drops (the server would
    // deny with 'not-landed' anyway; the client stays in sync).
    setCanExitShip(canExitLanded('surface', 2.5));
    expect(canExitShip()).toBe(false);

    // On foot (self is the character, not a ship) → cleared by the caller.
    setCanExitShip(false);
    expect(canExitShip()).toBe(false);
  });
});
