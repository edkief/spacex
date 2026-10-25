import { describe, it, expect, vi, beforeEach } from 'vitest';
import { frameMonitor } from './frameMonitor';

describe('frameMonitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (frameMonitor as any).reset();
  });

  it('calculates p50, p95, p99 correctly', () => {
    const mockInfo = { render: { calls: 0, triangles: 0 } };
    
    // Simulate 100 frames with known durations
    for (let i = 1; i <= 100; i++) {
      // Use a sequence that makes p50=5, p95=95, p99=99 (approx)
      // Actually let's just use a predictable set
      // 1-50: 10ms, 51-94: 20ms, 95-98: 30ms, 99-100: 40ms
      let duration = 10;
      if (i > 50) duration = 20;
      if (i > 94) duration = 30;
      if (i > 98) duration = 40;
      
      vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(duration);
      frameMonitor.frameStarted();
      frameMonitor.frameEnded();
    }

    const stats = frameMonitor.getFrameStats(mockInfo, 0);
    
    // p50: index 50 of sorted [10...10, 20...20, 30...30, 40...40] is 20
    expect(stats.p50).toBe(20);
    // p95: index 95 is 30
    expect(stats.p95).toBe(30);
    // p99: index 99 is 40
    expect(stats.p99).toBe(40);
  });

  it('calculates FPS over a 1s window (60 frames)', () => {
    const mockInfo = { render: { calls: 0, triangles: 0 } };
    
    // 60 frames at 16.67ms each = 60 FPS
    for (let i = 0; i < 60; i++) {
      vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(16.666666666666668);
      frameMonitor.frameStarted();
      frameMonitor.frameEnded();
    }

    const stats = frameMonitor.getFrameStats(mockInfo, 0);
    expect(stats.fps).toBeCloseTo(60, 1);
  });

  it('logs budget warnings when exceeded', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    
    // Budget 16ms, measured 20ms
    frameMonitor.budgetCheck('physics', 20, 16);
    
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[Perf Budget] physics exceeded budget'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('20.00ms > 16ms'));
    
    // Second call within 10s should NOT log
    warnSpy.mockClear();
    frameMonitor.budgetCheck('physics', 21, 16);
    expect(warnSpy).not.toHaveBeenCalled();
    
    warnSpy.mockRestore();
  });

  it('logs budget warnings again after 10s', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    
    vi.useFakeTimers();
    
    frameMonitor.budgetCheck('physics', 20, 16);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    
    vi.advanceTimersByTime(11000);
    
    frameMonitor.budgetCheck('physics', 21, 16);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    
    vi.useRealTimers();
    warnSpy.mockRestore();
  });
});
