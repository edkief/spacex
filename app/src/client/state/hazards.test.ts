import { afterEach, describe, expect, it, vi } from 'vitest';

import { EXPOSURE_MAX } from '@shared/world/hazards';

import {
  __resetHazards,
  clearHazard,
  hazardState,
  hazardStateSubscribe,
  setHazardFrame,
} from './hazards';

describe('hazard store (TASK-48.2)', () => {
  afterEach(() => __resetHazards());

  it('starts clear: full pool, no hazard, not recovering', () => {
    expect(hazardState()).toEqual({
      exposure: EXPOSURE_MAX,
      inside: null,
      recovering: false,
    });
  });

  it('setHazardFrame stores the frame fields (store update)', () => {
    setHazardFrame({ exposure: 32, inside: 'storm' });
    expect(hazardState()).toEqual({ exposure: 32, inside: 'storm', recovering: false });

    setHazardFrame({ exposure: 7 });
    expect(hazardState()).toEqual({ exposure: 7, inside: null, recovering: false });
  });

  it('derives recovering from recoveringUntil relative to now (future = true, past = false)', () => {
    const now = Date.now();
    setHazardFrame({ exposure: 0, recoveringUntil: now + 10_000 });
    expect(hazardState().recovering).toBe(true);

    setHazardFrame({ exposure: 0, recoveringUntil: now - 1 });
    expect(hazardState().recovering).toBe(false);

    setHazardFrame({ exposure: 0 }); // omitted → clear
    expect(hazardState().recovering).toBe(false);
  });

  it('emits only on change, late subscribers catch up, unsubscribe stops emits', () => {
    const fn = vi.fn();
    const off = hazardStateSubscribe(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith(hazardState()); // immediate current value

    setHazardFrame({ exposure: EXPOSURE_MAX }); // no change → no emit
    expect(fn).toHaveBeenCalledTimes(1);

    setHazardFrame({ exposure: 41, inside: 'radzone' });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith({ exposure: 41, inside: 'radzone', recovering: false });

    off();
    setHazardFrame({ exposure: 13 });
    expect(fn).toHaveBeenCalledTimes(2); // unsubscribed → no more emits
  });

  it('clearHazard resets to the clear state (system swap / re-entry)', () => {
    setHazardFrame({ exposure: 4, inside: 'storm', recoveringUntil: Date.now() + 5_000 });
    clearHazard();
    expect(hazardState()).toEqual({
      exposure: EXPOSURE_MAX,
      inside: null,
      recovering: false,
    });
  });
});
