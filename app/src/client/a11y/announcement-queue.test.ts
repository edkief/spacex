// TASK-54: the SR announcement queue — max 1 pending, 2 s min interval,
// priority combat > navigation > chat.
import { describe, expect, it } from 'vitest';
import { AnnouncementQueue, MIN_INTERVAL_MS } from './announcement-queue';

const T0 = 1_000_000;

describe('AnnouncementQueue', () => {
  it('delivers the first announcement immediately', () => {
    const q = new AnnouncementQueue();
    expect(q.announce('Target locked', 'combat', T0)).toBe('Target locked');
    expect(q.hasPending()).toBe(false);
  });

  it('defers a second announcement inside the 2 s min interval', () => {
    const q = new AnnouncementQueue();
    q.announce('a', 'combat', T0);
    expect(q.announce('b', 'combat', T0 + 1_999)).toBeNull();
    expect(q.hasPending()).toBe(true);
    expect(q.flush(T0 + 1_999)).toBeNull(); // still inside the interval
    expect(q.flush(T0 + MIN_INTERVAL_MS)).toBe('b');
    expect(q.hasPending()).toBe(false);
  });

  it('holds AT MOST one pending message (max 1 pending)', () => {
    const q = new AnnouncementQueue();
    // The first announcement is delivered immediately (no interval yet).
    expect(q.announce('a', 'combat', T0)).toBe('a');
    // Inside the 2 s interval: 'b' becomes the ONE pending message and the
    // same-rank 'c' is dropped (the queue never holds more than one).
    expect(q.announce('b', 'combat', T0 + 100)).toBeNull();
    expect(q.announce('c', 'combat', T0 + 200)).toBeNull();
    expect(q.hasPending()).toBe(true);
    expect(q.flush(T0 + MIN_INTERVAL_MS)).toBe('b');
    expect(q.hasPending()).toBe(false);
    expect(q.flush(T0 + MIN_INTERVAL_MS + 1)).toBeNull(); // nothing held
  });

  it('a higher-priority arrival replaces a weaker pending message', () => {
    const q = new AnnouncementQueue();
    q.announce('chat line', 'chat', T0);
    q.announce('target locked', 'combat', T0 + 100);
    expect(q.flush(T0 + MIN_INTERVAL_MS)).toBe('target locked');
    // and a lower-priority arrival does NOT replace a combat one
    // (the new interval clock starts at the flush, T0 + 2 s)
    q.announce('combat two', 'combat', T0 + 2_500);
    q.announce('chat again', 'chat', T0 + 2_600);
    expect(q.flush(T0 + 2_500 + MIN_INTERVAL_MS)).toBe('combat two');
  });

  it('respects the priority order combat > navigation > chat', () => {
    const q = new AnnouncementQueue();
    q.announce('nav', 'navigation', T0);
    q.announce('chat', 'chat', T0 + 10); // dropped
    q.announce('combat', 'combat', T0 + 20); // replaces
    q.announce('nav2', 'navigation', T0 + 30); // dropped (combat pending)
    expect(q.flush(T0 + MIN_INTERVAL_MS)).toBe('combat');
  });

  it('the min interval is exactly 2 s', () => {
    expect(MIN_INTERVAL_MS).toBe(2_000);
  });
});
