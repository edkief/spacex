import { describe, expect, it } from 'vitest';

import { TickHistogram } from './histogram';

describe('TickHistogram', () => {
  it('percentile: nearest-rank over the recorded window', () => {
    const h = new TickHistogram();
    for (let i = 1; i <= 100; i += 1) h.record(i);
    expect(h.percentile(0.95)).toBe(95);
    expect(h.percentile(0.5)).toBe(50);
    expect(h.percentile(1)).toBe(100);
  });

  it('percentile of an empty window is 0', () => {
    expect(new TickHistogram().percentile(0.95)).toBe(0);
    expect(new TickHistogram().trimmedPercentile(0.95, 2)).toBe(0);
  });

  it('trimmedPercentile discards the longest durations', () => {
    const h = new TickHistogram();
    for (let i = 1; i <= 100; i += 1) h.record(i);
    // Two external load spikes in the window: plain p95 is dragged up by
    // them (97th smallest instead of 95th), trimmed p95 is not (both
    // outliers are discarded outright).
    h.record(150);
    h.record(250);
    expect(h.percentile(0.95)).toBe(97);
    expect(h.trimmedPercentile(0.95, 2)).toBe(95);
  });

  it('trimmedPercentile tolerates up to trimCount isolated outliers', () => {
    // The scale test's real shape: a ~30 sample (1.5 s at 20 Hz) window
    // where plain p95 is "second-worst tick" — one GC spike away.
    const h = new TickHistogram();
    for (let i = 0; i < 29; i += 1) h.record(10); // flat 10 ms window
    h.record(25);
    h.record(60);
    expect(h.percentile(0.95)).toBe(25);
    expect(h.trimmedPercentile(0.95, 2)).toBe(10);
  });

  it('trimmedPercentile clamps trimCount to the sample count', () => {
    const h = new TickHistogram();
    h.record(5);
    h.record(10);
    expect(h.trimmedPercentile(0.95, 10)).toBe(5);
  });

  it('trimmedPercentile still reflects a sustained shift', () => {
    const h = new TickHistogram();
    for (let i = 0; i < 100; i += 1) h.record(10); // baseline window: flat 10
    // Loaded window: every tick +6 (sustained cost, not an outlier).
    const h2 = new TickHistogram();
    for (let i = 0; i < 100; i += 1) h2.record(16);
    expect(h2.trimmedPercentile(0.95, 2) - h.trimmedPercentile(0.95, 2)).toBe(6);
  });
});
