/**
 * Announcement wiring — TASK-54.
 *
 * Turns the game's transient events into screen-reader
 * announcements. The rules live in the {@link Announcer}
 * (max 1 pending, 2 s min interval, combat > navigation > chat);
 * this module only decides *what* to say and *when* to say it.
 *
 * Wired events:
 *
 *   - **presence** — joins / leaves ("Alice joined the system"),
 *   - **kill feed** — kills ("Bob destroyed Carol"),
 *   - **targeting** — "target locked" / "target released",
 *   - **weapon state** — "low energy",
 *   - **prompts** — the interaction prompt ("E to take iron,
 *     3 units") — wired by the prompt component itself.
 *
 * @see ./announcer.ts for the queue.
 */

import { announcer, type Announcer } from "./announcer.js";
import type { KillFeedEntry, KillFeedStore } from "../combat/killFeed.js";
import type { TargetingStore } from "../combat/targeting.js";
import type { PresenceEvent, PresenceStore } from "../net/presence.js";

/** Options for {@link wireAnnouncements}. */
export interface WireAnnouncementsOptions {
  /** The presence store (join / leave events). */
  presence?: PresenceStore | null;
  /** The kill-feed store (kills). */
  killFeed?: KillFeedStore | null;
  /** The targeting store (lock / release). */
  targeting?: TargetingStore | null;
  /** The queue to publish to (defaults to the process-wide one). */
  queue?: Announcer;
  /** Injectable clock (tests). */
  now?: () => number;
}

/** Unsubscribe handle for the whole wiring. */
export type Unsubscribe = () => void;

/** Format a kill-feed entry as a spoken sentence. */
export function killAnnouncementText(entry: KillFeedEntry): string {
  return `${entry.attackerName} destroyed ${entry.targetName}.`;
}

/**
 * Subscribe the announcer to the game's transient events.
 *
 * Returns an unsubscribe handle that detaches every listener.
 */
export function wireAnnouncements(options: WireAnnouncementsOptions): Unsubscribe {
  const queue = options.queue ?? announcer;
  const now = options.now ?? (() => Date.now());
  const offs: Array<() => void> = [];

  if (options.presence) {
    const presence = options.presence;
    offs.push(
      presence.subscribe((event: PresenceEvent) => {
        if (event.kind === "join") {
          queue.announce(`${event.player.callsign} joined the system.`, "navigation", now());
        } else if (event.kind === "leave") {
          queue.announce(`${event.player.callsign} left the system.`, "navigation", now());
        }
      }),
    );
  }

  if (options.killFeed) {
    const killFeed = options.killFeed;
    let lastId = -1;
    offs.push(
      killFeed.subscribe(() => {
        const entries = killFeed.snapshot();
        const latest = entries[0];
        if (latest === undefined) return;
        if (latest.id === lastId) return;
        lastId = latest.id;
        queue.announce(killAnnouncementText(latest), "combat", now());
      }),
    );
  }

  if (options.targeting) {
    const targeting = options.targeting;
    let lastLockedId: string | null = null;
    offs.push(
      targeting.subscribe(() => {
        const locked = targeting.getLocked();
        const id = locked?.targetId ?? null;
        if (id === lastLockedId) return;
        lastLockedId = id;
        if (locked === null) {
          queue.announce("Target released.", "navigation", now());
        } else {
          queue.announce(`Target locked: ${locked.callsign ?? locked.targetId}.`, "combat", now());
        }
      }),
    );
  }

  return () => {
    for (const off of offs) off();
  };
}
