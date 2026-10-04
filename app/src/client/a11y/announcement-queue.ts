/**
 * The screen-reader announcement queue (TASK-54).
 *
 * Combat floods the wire (kills, joins/leaves, lock-ons); a live region
 * that repeats every event is unusable. The queue's contract:
 * - at most ONE pending announcement (the newest higher-priority one
 *   replaces a waiting lower-priority one; same-or-lower is dropped);
 * - a minimum MIN_INTERVAL_MS between two announcements — a pending
 *   message is only flushed once the interval has elapsed;
 * - priority order: combat > navigation > chat.
 *
 * The LiveRegion (1 Hz) calls `flush(now)` each tick and reads back at
 * most one message per tick, so the SR hears ≤ 1 announcement / 2 s.
 */
export type AnnouncementPriority = 'combat' | 'navigation' | 'chat';

/** Minimum gap between two announcements (spec: 2 s). */
export const MIN_INTERVAL_MS = 2_000;

/** Lower rank = higher priority (combat first). */
const RANK: Record<AnnouncementPriority, number> = { combat: 0, navigation: 1, chat: 2 };

interface Entry {
  message: string;
  priority: AnnouncementPriority;
}

export class AnnouncementQueue {
  private pending: Entry | null = null;
  private lastAnnouncedAt = Number.NEGATIVE_INFINITY;

  /**
   * Enqueue an announcement. When nothing is pending and the min
   * interval has elapsed, it is delivered IMMEDIATELY (the returned
   * message may be shown at once). Otherwise it is held pending (a
   * strictly higher-priority arrival replaces a weaker pending one).
   */
  announce(message: string, priority: AnnouncementPriority, now: number): string | null {
    if (this.pending === null && now - this.lastAnnouncedAt >= MIN_INTERVAL_MS) {
      this.lastAnnouncedAt = now;
      return message;
    }
    const rank = RANK[priority];
    if (this.pending === null || rank < RANK[this.pending.priority])
      this.pending = { message, priority };
    return null;
  }

  /**
   * Flush the pending announcement once the min interval has elapsed;
   * null when nothing is due (the caller keeps the pending message).
   */
  flush(now: number): string | null {
    if (this.pending === null) return null;
    if (now - this.lastAnnouncedAt < MIN_INTERVAL_MS) return null;
    const message = this.pending.message;
    this.pending = null;
    this.lastAnnouncedAt = now;
    return message;
  }

  /** True while an announcement is waiting for the interval. */
  hasPending(): boolean {
    return this.pending !== null;
  }

  /** Test hook: drop the pending message and the interval clock. */
  reset(): void {
    this.pending = null;
    this.lastAnnouncedAt = Number.NEGATIVE_INFINITY;
  }
}

/** The module-level queue the LiveRegion flushes (one per client). */
export const announcementQueue = new AnnouncementQueue();

/** Announce to the SR (fire-and-forget; the LiveRegion drains the queue). */
export function announce(message: string, priority: AnnouncementPriority = 'navigation'): void {
  void announcementQueue.announce(message, priority, Date.now());
}

/** Test hook: reset the module queue. */
export function __resetAnnouncements(): void {
  announcementQueue.reset();
}
