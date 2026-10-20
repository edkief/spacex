/**
 * Announcer queue test — TASK-54.
 *
 * The queue rules under test:
 *   - max one pending announcement,
 *   - a 2 s minimum interval between spoken announcements,
 *   - priority combat > navigation > chat (a higher-priority
 *     announcement replaces a lower-priority pending one).
 */
import { describe, expect, it, vi } from "vitest";

import { Announcer, MIN_ANNOUNCE_INTERVAL_MS } from "./announcer.js";

describe("Announcer", () => {
  it("speaks the first announcement immediately", () => {
    const queue = new Announcer();
    const seen: string[] = [];
    queue.subscribe((a) => seen.push(a?.text ?? ""));
    queue.announce("Alice joined the system.", "navigation", 1_000);
    expect(seen).toEqual(["Alice joined the system."]);
    expect(queue.getCurrent()?.text).toBe("Alice joined the system.");
  });

  it("queues a second announcement while the interval is open", () => {
    const queue = new Announcer();
    const seen: string[] = [];
    queue.subscribe((a) => seen.push(a?.text ?? ""));
    queue.announce("first", "navigation", 1_000);
    queue.announce("second", "navigation", 1_100);
    expect(seen).toEqual(["first"]);
    expect(queue.getPending()?.text).toBe("second");
  });

  it("drains the pending announcement once the interval elapsed", () => {
    const queue = new Announcer();
    const seen: string[] = [];
    queue.subscribe((a) => seen.push(a?.text ?? ""));
    queue.announce("first", "navigation", 1_000);
    queue.announce("second", "navigation", 1_100);
    expect(queue.drain(1_500)).toBeNull();
    expect(queue.drain(1_000 + MIN_ANNOUNCE_INTERVAL_MS)).not.toBeNull();
    expect(seen).toEqual(["first", "second"]);
    expect(queue.getPending()).toBeNull();
  });

  it("keeps at most one pending announcement", () => {
    const queue = new Announcer();
    queue.announce("first", "navigation", 1_000);
    queue.announce("second", "navigation", 1_100);
    queue.announce("third", "navigation", 1_200);
    expect(queue.getPending()?.text).toBe("third");
  });

  it("lets a combat announcement replace a lower-priority pending one", () => {
    const queue = new Announcer();
    queue.announce("first", "navigation", 1_000);
    queue.announce("chat line", "chat", 1_100);
    queue.announce("target locked", "combat", 1_200);
    expect(queue.getPending()?.text).toBe("target locked");
    expect(queue.getPending()?.priority).toBe("combat");
  });

  it("does not let a low-priority announcement replace a higher-priority pending one", () => {
    const queue = new Announcer();
    queue.announce("first", "navigation", 1_000);
    queue.announce("target locked", "combat", 1_100);
    queue.announce("chat line", "chat", 1_200);
    expect(queue.getPending()?.text).toBe("target locked");
  });

  it("survives a faulty listener", () => {
    const queue = new Announcer();
    queue.subscribe(() => {
      throw new Error("boom");
    });
    expect(() => queue.announce("still works", "navigation", 1_000)).not.toThrow();
    expect(queue.getCurrent()?.text).toBe("still works");
  });

  it("resets the queue", () => {
    const queue = new Announcer();
    queue.announce("first", "navigation", 1_000);
    queue.reset();
    expect(queue.getCurrent()).toBeNull();
    expect(queue.getPending()).toBeNull();
  });

  it("uses a 2 s default interval", () => {
    expect(MIN_ANNOUNCE_INTERVAL_MS).toBe(2_000);
    const queue = new Announcer();
    const spy = vi.fn();
    queue.subscribe(spy);
    queue.announce("a", "navigation", 0);
    queue.announce("b", "navigation", 1_999);
    expect(spy).toHaveBeenCalledTimes(1);
    queue.drain(2_000);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
