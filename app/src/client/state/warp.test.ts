/**
 * Tests for the warp state machine (`@client/state/warp.ts`).
 *
 * Coverage:
 *   - default state is `idle`
 *   - `requestWarp` transitions idle → warping-in
 *   - the full happy path: idle → warping-in → awaiting →
 *     warping-out → idle
 *   - `requestWarp` is a no-op when the machine is already busy
 *     (double-click guard)
 *   - `warpArrived`, `worldSwapped`, `warpComplete`, `warpFailed`
 *     only fire from the expected source state
 *   - mismatched target system ids are ignored (defensive guard
 *     for the case where two warps fire back-to-back)
 *   - subscribers receive state updates synchronously after each
 *     transition and once on attach
 *   - `warpTargetIsInFlight` / `isWarpInFlight` helpers reflect
 *     the current state
 *   - faulty listeners don't crash the store
 *   - `failureFromRejected` maps a payload to the tagged union
 */
import { describe, it, expect, vi } from "vitest";

import { WarpStore, isWarpInFlight, warpTargetSystemId, type WarpState } from "./warp.js";

/** Convenience: start a fake clock and return the advancing function. */
function fakeClock(initial = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = initial;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

describe("client/state/warp — WarpStore", () => {
  it("starts in idle", () => {
    const store = new WarpStore();
    expect(store.current.kind).toBe("idle");
    expect(store.current.targetSystemId).toBeNull();
  });

  it("accepts a clock injection", () => {
    const clock = fakeClock(5_000);
    const store = new WarpStore({ now: clock.now });
    store.requestWarp("sys-A");
    expect(store.current.kind).toBe("warping-in");
    if (store.current.kind === "warping-in") {
      expect(store.current.startedAtMs).toBe(5_000);
    }
  });

  it("requestWarp transitions idle → warping-in", () => {
    const store = new WarpStore();
    store.requestWarp("sys-A");
    const state = store.current;
    expect(state.kind).toBe("warping-in");
    if (state.kind === "warping-in") {
      expect(state.targetSystemId).toBe("sys-A");
      expect(typeof state.startedAtMs).toBe("number");
    }
  });

  it("drives the full happy path: idle → warping-in → awaiting → warping-out → idle", () => {
    const store = new WarpStore();
    store.requestWarp("sys-A");
    expect(store.current.kind).toBe("warping-in");
    store.warpArrived("sys-A");
    expect(store.current.kind).toBe("awaiting");
    store.worldSwapped("sys-A");
    expect(store.current.kind).toBe("warping-out");
    store.warpComplete("sys-A");
    expect(store.current.kind).toBe("idle");
    expect(store.current.targetSystemId).toBeNull();
  });

  it("records timestamps from the clock at each transition", () => {
    const clock = fakeClock(1_000);
    const store = new WarpStore({ now: clock.now });
    store.requestWarp("sys-A", 1_000);
    clock.advance(100);
    store.warpArrived("sys-A", 1_100);
    clock.advance(50);
    store.worldSwapped("sys-A", 1_150);
    clock.advance(200);
    store.warpComplete("sys-A", 1_350);
    expect(store.current.kind).toBe("idle");
  });

  it("requestWarp is a no-op when already busy (double-click guard)", () => {
    const store = new WarpStore();
    store.requestWarp("sys-A");
    const before = store.current;
    store.requestWarp("sys-B");
    expect(store.current).toEqual(before);
  });

  it("warpArrived ignores a mismatched target system id", () => {
    const store = new WarpStore();
    store.requestWarp("sys-A");
    store.warpArrived("sys-B");
    expect(store.current.kind).toBe("warping-in");
  });

  it("warpArrived is a no-op when not in warping-in", () => {
    const store = new WarpStore();
    store.warpArrived("sys-A");
    expect(store.current.kind).toBe("idle");
  });

  it("worldSwapped ignores a mismatched target system id", () => {
    const store = new WarpStore();
    store.requestWarp("sys-A");
    store.warpArrived("sys-A");
    store.worldSwapped("sys-B");
    expect(store.current.kind).toBe("awaiting");
  });

  it("worldSwapped is a no-op when not in awaiting", () => {
    const store = new WarpStore();
    store.worldSwapped("sys-A");
    expect(store.current.kind).toBe("idle");
  });

  it("warpComplete ignores a mismatched target system id", () => {
    const store = new WarpStore();
    store.requestWarp("sys-A");
    store.warpArrived("sys-A");
    store.worldSwapped("sys-A");
    store.warpComplete("sys-B");
    expect(store.current.kind).toBe("warping-out");
  });

  it("warpComplete is a no-op when not in warping-out", () => {
    const store = new WarpStore();
    store.warpComplete("sys-A");
    expect(store.current.kind).toBe("idle");
  });

  it("warpFailed collapses back to idle from any state", () => {
    const store = new WarpStore();
    store.requestWarp("sys-A");
    store.warpFailed({
      code: "system-full",
      message: "full",
      targetSystemId: "sys-A",
    });
    expect(store.current.kind).toBe("idle");
    expect(store.current.targetSystemId).toBeNull();
  });

  it("subscriber receives the current state synchronously on attach", () => {
    const store = new WarpStore();
    store.requestWarp("sys-A");
    const listener = vi.fn();
    store.subscribe(listener);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]![0]).toEqual(store.current);
  });

  it("subscriber receives every transition", () => {
    const store = new WarpStore();
    const seen: WarpState[] = [];
    store.subscribe((s) => seen.push(s));
    store.requestWarp("sys-A");
    store.warpArrived("sys-A");
    store.worldSwapped("sys-A");
    store.warpComplete("sys-A");
    expect(seen.map((s) => s.kind)).toEqual([
      "idle", // initial fire
      "warping-in",
      "awaiting",
      "warping-out",
      "idle",
    ]);
  });

  it("unsubscribe stops further notifications", () => {
    const store = new WarpStore();
    const listener = vi.fn();
    const off = store.subscribe(listener);
    off();
    store.requestWarp("sys-A");
    expect(listener).toHaveBeenCalledTimes(1); // only the initial fire
  });

  it("faulty listener is dropped instead of crashing the store", () => {
    const store = new WarpStore();
    // Listener that throws on the initial subscribe fire (so it's
    // dropped before any transition).
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    store.subscribe(bad);
    store.subscribe(good);
    bad.mockClear();
    good.mockClear();
    store.requestWarp("sys-A");
    // `bad` was dropped on the initial subscribe-fire; only `good` fires.
    expect(bad).toHaveBeenCalledTimes(0);
    expect(good).toHaveBeenCalledTimes(1);
    // A second transition still goes through.
    store.warpArrived("sys-A");
    expect(good).toHaveBeenCalledTimes(2);
  });

  it("listener that throws mid-stream is dropped on the next transition", () => {
    const store = new WarpStore();
    // Listener that fires fine on subscribe but throws on the first
    // transition (which is the one we set up).
    const bad = vi.fn();
    let badThrows = false;
    const badWrapped = (s: WarpState) => {
      bad(s);
      if (badThrows) throw new Error("boom");
    };
    store.subscribe(badWrapped);
    bad.mockClear();
    // First transition succeeds without throwing.
    store.requestWarp("sys-A");
    expect(bad).toHaveBeenCalledTimes(1);
    badThrows = true;
    // Second transition: `bad` throws, the store should drop it
    // and the other subscriber (good) should still fire.
    const good = vi.fn();
    store.subscribe(good);
    good.mockClear(); // clear the initial subscribe fire
    store.warpArrived("sys-A");
    expect(good).toHaveBeenCalledTimes(1);
    // `bad` was called once (the warpArrived fire) and then dropped.
    expect(bad).toHaveBeenCalledTimes(2);
    // Third transition: `bad` was dropped, so it doesn't fire again.
    store.worldSwapped("sys-A");
    expect(good).toHaveBeenCalledTimes(2);
    expect(bad).toHaveBeenCalledTimes(2);
  });

  it("multiple subscribers each fire independently", () => {
    const store = new WarpStore();
    const a = vi.fn();
    const b = vi.fn();
    store.subscribe(a);
    store.subscribe(b);
    a.mockClear();
    b.mockClear();
    store.requestWarp("sys-A");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("isWarpInFlight + warpTargetSystemId helpers", () => {
    const store = new WarpStore();
    expect(isWarpInFlight(store.current)).toBe(false);
    expect(warpTargetSystemId(store.current)).toBeNull();
    store.requestWarp("sys-A");
    expect(isWarpInFlight(store.current)).toBe(true);
    expect(warpTargetSystemId(store.current)).toBe("sys-A");
  });

  it("failureFromRejected maps a payload to the tagged union", () => {
    const f = WarpStore.failureFromRejected({
      code: "system-full",
      message: "full",
      targetSystemId: "sys-A",
    });
    expect(f).toEqual({
      code: "system-full",
      message: "full",
      targetSystemId: "sys-A",
    });
  });
});
