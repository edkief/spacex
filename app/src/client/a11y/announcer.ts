/**
 * Screen-reader announcement queue — TASK-54.
 *
 * The client talks to the player through three channels:
 *
 *   - the **HUD summary** (1 Hz, polite) — speed / hull / credits /
 *     exposure, read from the live game state,
 *   - the **prompt line** — "E to take iron, 3 units", and
 *   - **transient events** — joins / leaves, kills, "target locked",
 *     "low energy".
 *
 * Events are the noisy ones: a firefight can produce a dozen
 * announcements a second, and a screen reader that reads them all
 * becomes unusable. The queue therefore enforces two rules:
 *
 *   1. **Max one pending announcement.** A new announcement
 *      replaces the pending one only when it is *higher* priority
 *      (combat > navigation > chat) — otherwise it is dropped.
 *   2. **Min 2 s between announcements.** {@link Announcer.drain}
 *      refuses to speak anything until the interval has elapsed.
 *
 * The store is transport-agnostic: the React live region subscribes
 * to it and writes the current text into an `aria-live` node.
 *
 * @see ./announcer.test.ts
 * @see ./liveRegion.tsx
 */

/** Announcement priority — higher wins the pending slot. */
export type AnnouncementPriority = "combat" | "navigation" | "chat";

/** Priority ranks (higher = more important). */
const PRIORITY_RANK: Readonly<Record<AnnouncementPriority, number>> = {
  combat: 3,
  navigation: 2,
  chat: 1,
};

/** One queued announcement. */
export interface Announcement {
  /** The text the screen reader will speak. */
  readonly text: string;
  /** The priority class. */
  readonly priority: AnnouncementPriority;
}

/** The minimum gap between two spoken announcements (ms). */
export const MIN_ANNOUNCE_INTERVAL_MS = 2_000;

/** Listener signature for {@link Announcer.subscribe}. */
export type AnnouncementListener = (announcement: Announcement | null) => void;

/** Options for the announcer constructor. */
export interface AnnouncerOptions {
  /** Minimum gap between announcements (ms). */
  minIntervalMs?: number;
}

/**
 * The announcement queue.
 *
 * `announce()` never throws and never blocks — it either speaks
 * immediately (when the interval has elapsed and nothing is
 * pending) or parks the text in the single pending slot.
 */
export class Announcer {
  private pending: Announcement | null = null;
  private current: Announcement | null = null;
  private lastSpokenAt = Number.NEGATIVE_INFINITY;
  private readonly listeners = new Set<AnnouncementListener>();
  private readonly minIntervalMs: number;

  constructor(options: AnnouncerOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? MIN_ANNOUNCE_INTERVAL_MS;
  }

  /** Subscribe to announcements. Returns an unsubscribe handle. */
  subscribe = (listener: AnnouncementListener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The announcement currently shown in the live region. */
  getCurrent = (): Announcement | null => this.current;

  /** The announcement waiting for its turn (at most one). */
  getPending = (): Announcement | null => this.pending;

  /**
   * Queue an announcement.
   *
   * - When nothing is pending and the min interval has elapsed the
   *   text is spoken immediately.
   * - Otherwise it is parked in the pending slot — replacing the
   *   pending text when it is *at least* as important (combat >
   *   navigation > chat). A lower-priority announcement is dropped
   *   so a burst of chat cannot displace a pending combat call.
   */
  announce = (
    text: string,
    priority: AnnouncementPriority = "navigation",
    now = Date.now(),
  ): void => {
    const candidate: Announcement = { text, priority };
    if (this.pending === null && now - this.lastSpokenAt >= this.minIntervalMs) {
      this.speak(candidate, now);
      return;
    }
    if (this.pending === null) {
      this.pending = candidate;
      return;
    }
    if (PRIORITY_RANK[priority] >= PRIORITY_RANK[this.pending.priority]) {
      this.pending = candidate;
    }
  };

  /**
   * Speak the pending announcement if the interval has elapsed.
   *
   * Returns the spoken announcement, or `null` when nothing was
   * due. The live region calls this on its 1 Hz tick.
   */
  drain = (now = Date.now()): Announcement | null => {
    if (this.pending === null) return null;
    if (now - this.lastSpokenAt < this.minIntervalMs) return null;
    const next = this.pending;
    this.pending = null;
    this.speak(next, now);
    return next;
  };

  /** Reset the queue (used by tests + on session restart). */
  reset = (): void => {
    this.pending = null;
    this.current = null;
    this.lastSpokenAt = Number.NEGATIVE_INFINITY;
  };

  /** Publish an announcement to every listener. */
  private speak(announcement: Announcement, now: number): void {
    this.current = announcement;
    this.lastSpokenAt = now;
    for (const listener of this.listeners) {
      try {
        listener(announcement);
      } catch {
        // A faulty listener must not break the announcement queue.
      }
    }
  }
}

/** The process-wide announcer used by the HUD + the live region. */
export const announcer = new Announcer();
