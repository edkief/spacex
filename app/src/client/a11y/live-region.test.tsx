// @vitest-environment happy-dom
/**
 * TASK-54: the SR live region — updates at 1 Hz (the 1 Hz assertion: one
 * tick per second, never the 10 Hz snapshot cadence — a queued message
 * that is due at t+2.5 s can only appear on the t+3 s tick, which a 10 Hz
 * cadence would have shown at t+2.5 s), the announced text is the HUD
 * summary, and a due queued announcement wins over the summary for one
 * tick.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetAnnouncements, announcementQueue } from './announcement-queue';
import { LiveRegion, liveRegionText, LIVE_REGION_INTERVAL_MS } from './live-region';

describe('liveRegionText (the pure tick)', () => {
  beforeEach(() => __resetAnnouncements());

  it('the cadence is exactly 1 Hz', () => {
    expect(LIVE_REGION_INTERVAL_MS).toBe(1_000);
  });

  it('shows the summary when nothing is queued', () => {
    expect(liveRegionText(0, () => 'Speed 0 meters per second.')).toBe(
      'Speed 0 meters per second.',
    );
  });

  it('a due announcement wins over the summary', () => {
    // The first announcement is delivered immediately (no interval yet);
    // the second, 0.5 s later, is held pending until the interval elapses.
    announcementQueue.announce('a', 'combat', 1_000_000);
    announcementQueue.announce('Target locked', 'combat', 1_000_500);
    expect(liveRegionText(1_002_500, () => 'summary')).toBe('Target locked');
    // the message is consumed — the summary returns
    expect(liveRegionText(1_003_500, () => 'summary')).toBe('summary');
  });
});

describe('<LiveRegion />', () => {
  let root: Root | null = null;
  let region: Element;

  beforeEach(() => {
    vi.useFakeTimers();
    __resetAnnouncements();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const r = createRoot(container);
    root = r;
    act(() => r.render(<LiveRegion />));
    region = container.querySelector('#live-region')!;
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    vi.useRealTimers();
    region = null as unknown as Element;
  });

  it('is a polite live region', () => {
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.getAttribute('role')).toBe('status');
  });

  it('shows the HUD summary on the first 1 Hz tick', () => {
    act(() => vi.advanceTimersByTime(LIVE_REGION_INTERVAL_MS));
    const text = region.textContent;
    expect(text).toBeTruthy();
    // The (idle) summary speaks the on-foot exposure + no credits:
    expect(text).toContain('Exposure');
  });

  it('updates at most once per second (1 Hz, not the 10 Hz cadence)', () => {
    // Tick at t=1.0 s: the (idle) HUD summary lands in the region.
    act(() => vi.advanceTimersByTime(LIVE_REGION_INTERVAL_MS));
    const summary = region.textContent;
    expect(summary).toBeTruthy();

    // Queue a combat announcement at t=1.5 s. The 2 s min interval puts it
    // due at t=3.5 s: the t=2.0 s and t=3.0 s ticks must NOT show it (a
    // 10 Hz cadence would have shown it on a t≈3.5 s tick).
    act(() => {
      vi.advanceTimersByTime(500); // t = 1.5 s
      // fake timers mock Date.now() too. The first announce is delivered
      // immediately (no interval clock yet) — it arms the 2 s interval;
      // the SECOND is the one that must wait for the cadence.
      announcementQueue.announce('warming up', 'combat', Date.now());
      announcementQueue.announce('Target locked', 'combat', Date.now());
    });
    act(() => vi.advanceTimersByTime(1_500)); // t = 3.0 s: ticks at 2.0 + 3.0 s
    expect(region.textContent).toBe(summary);
    act(() => vi.advanceTimersByTime(1_000)); // t = 4.0 s: due at 3.5 s → shown
    expect(region.textContent).toBe('Target locked');

    // And the NEXT tick returns to the summary (one-tick announcement).
    act(() => vi.advanceTimersByTime(LIVE_REGION_INTERVAL_MS));
    expect(region.textContent).toBe(summary);
  });
});
