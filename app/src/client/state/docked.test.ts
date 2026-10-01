import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __resetDockedIndicator,
  dockedIndicator,
  dockedIndicatorSubscribe,
  isDocked,
  setDockedIndicator,
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
