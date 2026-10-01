import { beforeEach, describe, expect, it } from 'vitest';

import {
  REENTRY_TINT_MAX,
  REENTRY_TINT_RAMP,
  REENTRY_TINT_SPEED,
  reentryTintFactor,
} from '@shared/physics/atmosphere';

import { __resetReentryTint, reentryTint, reentryTintSubscribe, setReentryTint } from './reentry';

describe('reentryTintFactor (shared math used by the tint)', () => {
  it('is 0 in space (boundary 0), below the threshold, or when ascending', () => {
    expect(reentryTintFactor(500, 0)).toBe(0); // space: no boundary
    expect(reentryTintFactor(REENTRY_TINT_SPEED, 1)).toBe(0); // exactly at threshold
    expect(reentryTintFactor(50, 1)).toBe(0); // slow descent
    expect(reentryTintFactor(-300, 1)).toBe(0); // ascending (descentSpeed < 0)
  });

  it('ramps 0 → REENTRY_TINT_MAX over the ramp span above the threshold, scaled by boundary', () => {
    const ramp = REENTRY_TINT_RAMP;
    expect(reentryTintFactor(REENTRY_TINT_SPEED + ramp / 2, 1)).toBeCloseTo(
      REENTRY_TINT_MAX / 2,
      6,
    );
    expect(reentryTintFactor(REENTRY_TINT_SPEED + ramp, 1)).toBeCloseTo(REENTRY_TINT_MAX, 6);
    expect(reentryTintFactor(REENTRY_TINT_SPEED + ramp * 4, 1)).toBeCloseTo(REENTRY_TINT_MAX, 6);
    // Scaled by the boundary factor (mid-band = half max at full ramp).
    expect(reentryTintFactor(REENTRY_TINT_SPEED + ramp, 0.5)).toBeCloseTo(
      REENTRY_TINT_MAX * 0.5,
      6,
    );
  });
});

describe('re-entry tint state module (TASK-28.2)', () => {
  beforeEach(() => __resetReentryTint());

  it('starts at 0 and stores set values', () => {
    expect(reentryTint()).toBe(0);
    setReentryTint(0.2);
    expect(reentryTint()).toBe(0.2);
  });

  it('clamps into [0, REENTRY_TINT_MAX]', () => {
    setReentryTint(-1);
    expect(reentryTint()).toBe(0);
    setReentryTint(REENTRY_TINT_MAX * 10);
    expect(reentryTint()).toBe(REENTRY_TINT_MAX);
  });

  it('emits to subscribers ONLY when the value actually changes', () => {
    const seen: number[] = [];
    reentryTintSubscribe((v) => seen.push(v));
    expect(seen).toEqual([0]); // immediate catch-up call
    setReentryTint(0); // no change
    expect(seen).toEqual([0]);
    setReentryTint(0.1); // change
    expect(seen).toEqual([0, 0.1]);
    setReentryTint(0.1); // duplicate value: no re-emit
    expect(seen).toEqual([0, 0.1]);
  });

  it('late subscribers catch up with the current value', () => {
    setReentryTint(0.3);
    let late = -1;
    reentryTintSubscribe((v) => {
      late = v;
    });
    expect(late).toBe(0.3);
  });

  it('unsubscribe stops delivery', () => {
    const seen: number[] = [];
    const off = reentryTintSubscribe((v) => seen.push(v));
    expect(seen).toEqual([0]); // immediate catch-up only
    off();
    setReentryTint(0.5);
    expect(seen).toEqual([0]); // nothing after unsubscribe
  });

  it('__resetReentryTint clears subscribers and resets to 0', () => {
    const seen: number[] = [];
    reentryTintSubscribe((v) => seen.push(v));
    setReentryTint(0.3);
    __resetReentryTint();
    expect(reentryTint()).toBe(0);
    setReentryTint(0.9); // no subscribers left after the reset
    expect(seen).toEqual([0, 0.3]);
  });
});
