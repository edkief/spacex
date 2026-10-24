import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SimLoop } from './sim';

describe('SimLoop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should tick at the correct rate', () => {
    let ticks = 0;
    const loop = new SimLoop(20, () => {
      ticks++;
    });

    loop.start();
    
    // Advance time by 1 second
    vi.advanceTimersByTime(1000);
    
    expect(ticks).toBe(20);
    loop.stop();
  });

  it('should handle drift and catch up', () => {
    let ticks = 0;
    const loop = new SimLoop(20, () => {
      ticks++;
    });

    loop.start();
    
    // Advance time by 1.5 ticks (75ms)
    vi.advanceTimersByTime(75);
    // Should have ticked once
    expect(ticks).toBe(1);
    
    // Advance another 75ms (Total 150ms = 3 ticks)
    vi.advanceTimersByTime(75);
    expect(ticks).toBe(3);
    
    loop.stop();
  });

  it('should limit catch-up to avoid spiral-of-death', () => {
    let ticks = 0;
    const loop = new SimLoop(20, () => {
      ticks++;
    });

    // Mock Date.now to control time exactly
    let currentTime = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => currentTime);

    loop.start(); // lastTime = 0, timer set for 50ms
    
    // Jump forward 1 second (20 ticks)
    currentTime = 1000;
    
    // Trigger the timer
    vi.runOnlyPendingTimers();
    
    // In one loop() call:
    // delta = 1000 - 0 = 1000
    // accumulator = 1000
    // while loop runs 5 times (maxCatchUp)
    // accumulator becomes 0 (because ticksProcessed >= maxCatchUp)
    
    expect(ticks).toBe(5);
    
    loop.stop();
  });

  it('should not drift over 1000 ticks', () => {
    let ticks = 0;
    const loop = new SimLoop(20, () => {
      ticks++;
    });

    loop.start();
    
    // Advance time by 50 seconds (1000 ticks)
    vi.advanceTimersByTime(50000);
    
    expect(ticks).toBe(1000);
    loop.stop();
  });
});
