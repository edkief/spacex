import { beforeEach, describe, expect, it } from 'vitest';
import { __resetWarpState, dispatchWarpEvent, lastWarpEvent, warpSubscribe } from './warp.js';

describe('warp event bus (TASK-7 stub)', () => {
  beforeEach(() => __resetWarpState());

  it('delivers warp-started to subscribers', () => {
    const seen: string[] = [];
    const off = warpSubscribe((e) => seen.push(e.type));
    dispatchWarpEvent({
      type: 'warp-started',
      fromSystemId: 'aaaa',
      toSystemId: 'bbbb',
      etaSeconds: 42,
    });
    expect(seen).toEqual(['warp-started']);
    off();
    dispatchWarpEvent({ type: 'warp-complete', toSystemId: 'bbbb' });
    expect(seen).toEqual(['warp-started']); // unsubscribed → no further events
  });

  it('remembers the last event for late subscribers', () => {
    expect(lastWarpEvent()).toBeNull();
    dispatchWarpEvent({ type: 'warp-complete', toSystemId: 'cccc' });
    expect(lastWarpEvent()).toEqual({ type: 'warp-complete', toSystemId: 'cccc' });
  });

  it('supports multiple independent subscribers', () => {
    let a = 0;
    let b = 0;
    warpSubscribe(() => a++);
    warpSubscribe(() => b++);
    dispatchWarpEvent({ type: 'warp-started', fromSystemId: 'x', toSystemId: 'y', etaSeconds: 1 });
    expect(a).toBe(1);
    expect(b).toBe(1);
  });
});
