/**
 * Announcement wiring test — TASK-54.
 *
 * Asserts the transient game events reach the screen-reader queue
 * with the right priority:
 *   - joins / leaves → "navigation",
 *   - kills → "combat",
 *   - target lock / release → "combat" / "navigation".
 */
import { describe, expect, it } from "vitest";

import { Announcer } from "./announcer.js";
import { killAnnouncementText, wireAnnouncements } from "./wireAnnouncements.js";
import { KillFeedStore } from "../combat/killFeed.js";
import { TargetingStore } from "../combat/targeting.js";

describe("wireAnnouncements", () => {
  it("announces a kill with the combat priority", () => {
    const queue = new Announcer({ minIntervalMs: 0 });
    const killFeed = new KillFeedStore();
    const off = wireAnnouncements({ killFeed, queue });
    killFeed.applyKillEvent(
      { kind: "kill", attacker: "entity-a", target: "entity-t", tick: 1 },
      {
        resolver: (id) => (id === "entity-a" ? "Alice" : "Bob"),
        isPlayerId: () => true,
      },
    );
    off();
    expect(queue.getCurrent()?.text).toBe("Alice destroyed Bob.");
    expect(queue.getCurrent()?.priority).toBe("combat");
  });

  it("formats a kill line", () => {
    expect(
      killAnnouncementText({
        id: 1,
        attackerName: "Alice",
        targetName: "Bob",
        weapon: "laser",
        isPvP: true,
        pushedAt: 0,
        expiresAt: 1,
      }),
    ).toBe("Alice destroyed Bob.");
  });

  it("announces a target lock with the combat priority", () => {
    const queue = new Announcer({ minIntervalMs: 0 });
    const targeting = new TargetingStore();
    const off = wireAnnouncements({ targeting, queue });
    targeting.applyLocked({
      targetId: "entity-1",
      callsign: "Alice",
      range: 120,
      bearing: 0,
      lockedAt: Date.now(),
    });
    off();
    expect(queue.getCurrent()?.text).toBe("Target locked: Alice.");
    expect(queue.getCurrent()?.priority).toBe("combat");
  });

  it("announces a target release with the navigation priority", () => {
    const queue = new Announcer({ minIntervalMs: 0 });
    const targeting = new TargetingStore();
    const off = wireAnnouncements({ targeting, queue });
    targeting.applyLocked({
      targetId: "entity-1",
      callsign: "Alice",
      range: 120,
      bearing: 0,
      lockedAt: Date.now(),
    });
    targeting.applyReleased({ targetId: "entity-1", reason: "toggle" });
    off();
    expect(queue.getCurrent()?.text).toBe("Target released.");
  });

  it("detaches every listener on unsubscribe", () => {
    const queue = new Announcer({ minIntervalMs: 0 });
    const killFeed = new KillFeedStore();
    const off = wireAnnouncements({ killFeed, queue });
    off();
    killFeed.applyKillEvent(
      { kind: "kill", attacker: "entity-a", target: "entity-t", tick: 1 },
      {
        resolver: (id) => (id === "entity-a" ? "Alice" : "Bob"),
        isPlayerId: () => true,
      },
    );
    expect(queue.getCurrent()).toBeNull();
  });
});
