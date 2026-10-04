/**
 * TASK-51: ship-HUD store tests — emit-on-change view publishing (10 Hz
 * dedup), on-foot clearing, and the hull-hit flash window (300 ms).
 */
import { describe, expect, it } from 'vitest';

import {
  HIT_FLASH_MS,
  __resetShipHud,
  flashHullHit,
  hitFlashActive,
  hullHitSubscribe,
  lastHullHitAtMs,
  selfShipView,
  selfShipViewSubscribe,
  setSelfShipView,
  type SelfShipView,
} from './ship-hud';

const VIEW: SelfShipView = {
  pos: { x: 1, y: 1234, z: 2 },
  vel: { x: 0, y: 0, z: 5 },
  rot: { x: 0, y: 0, z: 0, w: 1 },
  hull: 0.75,
  shields: 1,
  regime: 'atmosphere',
  padId: null,
  atMs: 1000,
};

describe('self-ship view store', () => {
  it('starts empty and publishes on change (emit-on-change)', () => {
    __resetShipHud();
    const seen: Array<SelfShipView | null> = [];
    const off = selfShipViewSubscribe((v) => seen.push(v));
    expect(seen).toEqual([null]); // immediate catch-up

    setSelfShipView(VIEW);
    setSelfShipView({ ...VIEW }); // identical payload (same atMs) → no emit
    setSelfShipView({ ...VIEW, atMs: 1100 }); // new frame → emit
    off();
    setSelfShipView(null);
    expect(seen.map((v) => v?.atMs ?? null)).toEqual([null, 1000, 1100]);
  });

  it('null clears the HUD (on foot / new system)', () => {
    __resetShipHud();
    setSelfShipView(VIEW);
    expect(selfShipView()).not.toBeNull();
    setSelfShipView(null);
    expect(selfShipView()).toBeNull();
  });
});

describe('hull-hit flash', () => {
  it('records self hits and reports the 300 ms window (fake clocks)', () => {
    __resetShipHud();
    const seen: number[] = [];
    const off = hullHitSubscribe((atMs) => seen.push(atMs));

    flashHullHit(1_000);
    expect(lastHullHitAtMs()).toBe(1_000);
    expect(hitFlashActive(1_000)).toBe(true);
    expect(hitFlashActive(1_000 + HIT_FLASH_MS - 1)).toBe(true);
    expect(hitFlashActive(1_000 + HIT_FLASH_MS)).toBe(false); // 300 ms is over

    flashHullHit(1_500); // a second hit re-arms the window
    expect(hitFlashActive(1_500)).toBe(true);
    expect(hitFlashActive(1_500 + HIT_FLASH_MS)).toBe(false);

    // "Now" before the hit is outside the window (no negative-window bug).
    expect(hitFlashActive(999)).toBe(false);

    // Stale hits never move the clock backwards.
    flashHullHit(1_400);
    expect(lastHullHitAtMs()).toBe(1_500);
    off();
    expect(seen).toEqual([1_000, 1_500]);
  });

  it('HIT_FLASH_MS is the spec window', () => {
    expect(HIT_FLASH_MS).toBe(300);
  });
});
