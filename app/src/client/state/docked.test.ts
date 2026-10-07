import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __resetDockedIndicator,
  dockedIndicator,
  dockedIndicatorSubscribe,
  isDocked,
  isWireDocked,
  setDockedIndicator,
  setWireDocked,
  wireDockedIndicator,
  wireDockedSubscribe,
} from './docked';

describe('isDocked predicate (TASK-29.3)', () => {
  it('requires BOTH regime "docked" AND a non-empty padId', () => {
    expect(isDocked('docked', 'pad-1')).toBe(true);
    expect(isDocked('docked', undefined)).toBe(false);
    expect(isDocked('docked', null)).toBe(false);
    expect(isDocked('docked', '')).toBe(false);
    expect(isDocked('sublight', 'pad-1')).toBe(false);
    expect(isDocked('cruise', 'pad-1')).toBe(false);
    expect(isDocked('warp', undefined)).toBe(false);
  });
});

describe('isWireDocked predicate (TASK-78 close-out)', () => {
  it('is true EXACTLY when the wire regime is "docked" — no padId required', () => {
    expect(isWireDocked('docked')).toBe(true); // pad-dock AND home-dock
    expect(isWireDocked('sublight')).toBe(false);
    expect(isWireDocked('cruise')).toBe(false);
    expect(isWireDocked('warp')).toBe(false);
  });

  it('covers the home-dock case the strict isDocked misses (regime docked, no padId)', () => {
    expect(isDocked('docked', undefined)).toBe(false); // pad predicate: not docked
    expect(isWireDocked('docked')).toBe(true); // wire predicate: IS docked
  });
});

describe('docked indicator state (TASK-29.3)', () => {
  afterEach(() => __resetDockedIndicator());

  it('starts hidden, emits only on change, and late subscribers catch up', () => {
    const fn = vi.fn();
    const off = dockedIndicatorSubscribe(fn);
    expect(dockedIndicator()).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith(false); // immediate current value

    setDockedIndicator(false); // no change → no emit
    expect(fn).toHaveBeenCalledTimes(1);

    setDockedIndicator(true);
    expect(dockedIndicator()).toBe(true);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith(true);

    off();
    setDockedIndicator(false); // unsubscribed → no more emits
    expect(dockedIndicator()).toBe(false);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('wire-docked state (TASK-78 close-out)', () => {
  afterEach(() => __resetDockedIndicator());

  it('starts false, emits only on change, and is independent of the pad store', () => {
    expect(wireDockedIndicator()).toBe(false);
    expect(dockedIndicator()).toBe(false);

    // Pad-dock: BOTH sources true (regime docked + padId).
    setDockedIndicator(isDocked('docked', 'pad-1'));
    setWireDocked(isWireDocked('docked'));
    expect(dockedIndicator()).toBe(true);
    expect(wireDockedIndicator()).toBe(true);

    // Home-dock: wire TRUE, pad indicator FALSE — the flight-loop gate must
    // still read docked so no idle frames leak.
    setDockedIndicator(isDocked('docked', undefined));
    setWireDocked(isWireDocked('docked'));
    expect(dockedIndicator()).toBe(false);
    expect(wireDockedIndicator()).toBe(true);

    // Undock: both clear.
    setDockedIndicator(isDocked('sublight', undefined));
    setWireDocked(isWireDocked('sublight'));
    expect(dockedIndicator()).toBe(false);
    expect(wireDockedIndicator()).toBe(false);
  });

  it('emits only on change and lets late subscribers catch up', () => {
    const fn = vi.fn();
    const off = wireDockedSubscribe(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith(false);

    setWireDocked(false); // no change → no emit
    expect(fn).toHaveBeenCalledTimes(1);

    setWireDocked(true);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith(true);

    off();
    setWireDocked(false); // unsubscribed → no more emits
    expect(wireDockedIndicator()).toBe(false);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
