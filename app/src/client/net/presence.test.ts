/**
 * TASK-15 client presence store unit tests.
 *
 * Verifies the diff + emit + subscribe behaviour of `PresenceStore`:
 *
 *   - `setOwnCallsign` flips the `isYou` flag on matching rows.
 *   - `applyPresenceFrame` emits `join` events for new players,
 *     `leave` events for removed players, and a `snapshot` event
 *     at the end of every apply (the toast + list components both
 *     rely on the snapshot to commit a single render).
 *   - `leaveAll` emits a synthetic `leave` event for every player
 *     still in the roster (used on system change / disconnect).
 *   - Subscribers added twice with the same reference fire only
 *     once (Set semantics — important for React's StrictMode
 *     double-mount in dev).
 *   - Updates to an existing player's state (e.g. docked → flying)
 *     keep the row but stamp a fresh `lastSeenAt`.
 *
 * The pure store has no React / WebSocket dependencies, so the
 * tests run in `node` environment under Vitest's default config.
 */

import { describe, expect, it } from "vitest";

import { PresenceStore, toastTextFor, statusDotColor } from "./presence.js";
import type { PresenceEvent } from "./presence.js";
import type { PayloadFor } from "@shared/protocol/index.js";

/** Build a presence frame payload from a list of entries. */
function frame(players: PayloadFor<"presence">["players"]): PayloadFor<"presence"> {
  return { systemId: "sys-1", players };
}

/** Build one presence entry with the minimum required fields. */
function entry(
  playerId: string,
  callsign: string,
  opts: Partial<PayloadFor<"presence">["players"][number]> = {},
): PayloadFor<"presence">["players"][number] {
  return {
    playerId,
    callsign,
    shipId: opts.shipId ?? `ship-${playerId}`,
    state: opts.state ?? "flying",
  };
}

/** Collect every event emitted by the store into a flat array. */
function collect(store: PresenceStore): PresenceEvent[] {
  const events: PresenceEvent[] = [];
  store.subscribe((e) => events.push(e));
  return events;
}

describe("PresenceStore", () => {
  it("starts empty with no listeners", () => {
    const store = new PresenceStore();
    expect(store.isEmpty()).toBe(true);
    expect(store.snapshot()).toEqual([]);
    expect(store.ownCallsignValue()).toBeNull();
  });

  it("applies a snapshot of two players and emits join + snapshot", () => {
    const store = new PresenceStore();
    const events = collect(store);
    store.applyPresenceFrame(frame([entry("1", "ALICE"), entry("2", "BOB")]), 1_000);

    expect(events.map((e) => e.kind)).toEqual(["join", "join", "snapshot"]);
    expect(events[0]!.kind === "join" && events[0]!.player.callsign).toBe("ALICE");
    expect(events[1]!.kind === "join" && events[1]!.player.callsign).toBe("BOB");
    const snapshot = events[2]!;
    expect(snapshot.kind).toBe("snapshot");
    if (snapshot.kind === "snapshot") {
      expect(snapshot.players.map((p) => p.callsign)).toEqual(["ALICE", "BOB"]);
    }
    expect(store.snapshot().map((p) => p.callsign)).toEqual(["ALICE", "BOB"]);
    expect(store.isEmpty()).toBe(false);
  });

  it("emits leave events for roster deltas", () => {
    const store = new PresenceStore();
    store.applyPresenceFrame(frame([entry("1", "ALICE"), entry("2", "BOB")]), 1_000);

    const events = collect(store);
    store.applyPresenceFrame(frame([entry("2", "BOB")]), 2_000);

    expect(events.map((e) => e.kind)).toEqual(["leave", "snapshot"]);
    const leave = events[0]!;
    expect(leave.kind).toBe("leave");
    if (leave.kind === "leave") {
      expect(leave.player.callsign).toBe("ALICE");
    }
    const snapshot = events[1]!;
    if (snapshot.kind === "snapshot") {
      expect(snapshot.players.map((p) => p.callsign)).toEqual(["BOB"]);
    }
  });

  it("stamps `isYou: true` on the local player's row", () => {
    const store = new PresenceStore();
    store.setOwnCallsign("ALICE");
    store.applyPresenceFrame(frame([entry("1", "ALICE"), entry("2", "BOB")]), 1_000);
    const alice = store.snapshot().find((p) => p.callsign === "ALICE")!;
    const bob = store.snapshot().find((p) => p.callsign === "BOB")!;
    expect(alice.isYou).toBe(true);
    expect(bob.isYou).toBe(false);
  });

  it("flips `isYou` when ownCallsign is reassigned", () => {
    const store = new PresenceStore();
    store.applyPresenceFrame(frame([entry("1", "ALICE")]), 1_000);
    expect(store.snapshot()[0]!.isYou).toBe(false);

    store.setOwnCallsign("ALICE");
    expect(store.snapshot()[0]!.isYou).toBe(true);

    // No-op when set to the same value (no extra events fire).
    const events = collect(store);
    store.setOwnCallsign("ALICE");
    expect(events).toEqual([]);

    // Flipping to a different callsign clears the previous "you" flag.
    store.setOwnCallsign("NOT-PRESENT");
    expect(store.snapshot()[0]!.isYou).toBe(false);
  });

  it("leaveAll fires a leave event for every player + a final snapshot", () => {
    const store = new PresenceStore();
    store.applyPresenceFrame(
      frame([entry("1", "ALICE"), entry("2", "BOB"), entry("3", "CARL")]),
      1_000,
    );
    const events = collect(store);
    store.leaveAll();

    expect(events.map((e) => e.kind)).toEqual(["leave", "leave", "leave", "snapshot"]);
    const left = events
      .filter((e): e is Extract<PresenceEvent, { kind: "leave" }> => e.kind === "leave")
      .map((e) => e.player.callsign);
    expect(left).toEqual(["ALICE", "BOB", "CARL"]);
    const snap = events[events.length - 1]!;
    if (snap.kind === "snapshot") {
      expect(snap.players).toEqual([]);
    }
    expect(store.isEmpty()).toBe(true);
  });

  it("leaveAll fires a snapshot even when the roster is already empty", () => {
    const store = new PresenceStore();
    const events = collect(store);
    store.leaveAll();
    // Defensive — a hot-reload could re-mount the store with stale
    // internal state; the snapshot still notifies subscribers.
    expect(events.map((e) => e.kind)).toEqual(["snapshot"]);
  });

  it("updates an existing row's state without firing a toast event", () => {
    const store = new PresenceStore();
    store.applyPresenceFrame(frame([entry("1", "ALICE", { state: "flying" })]), 1_000);
    const events = collect(store);
    store.applyPresenceFrame(frame([entry("1", "ALICE", { state: "docked" })]), 2_000);

    // No join or leave — the row is updated silently.
    expect(events.map((e) => e.kind)).toEqual(["snapshot"]);
    expect(store.snapshot()[0]!.state).toBe("docked");
    expect(store.snapshot()[0]!.lastSeenAt).toBe(2_000);
  });

  it("subscribers added with the same reference fire only once", () => {
    const store = new PresenceStore();
    let count = 0;
    const listener = () => count++;
    store.subscribe(listener);
    store.subscribe(listener); // duplicate — should be deduped by the Set
    store.applyPresenceFrame(frame([entry("1", "ALICE")]), 1_000);
    // `applyPresenceFrame` emits `join` + `snapshot`. With dedupe,
    // the listener fires once per event → count === 2.
    expect(count).toBe(2);
  });

  it("unsubscribe stops further events", () => {
    const store = new PresenceStore();
    const events: PresenceEvent[] = [];
    const off = store.subscribe((e) => events.push(e));
    store.applyPresenceFrame(frame([entry("1", "ALICE")]), 1_000);
    expect(events.length).toBe(2);
    off();
    store.applyPresenceFrame(frame([entry("1", "ALICE"), entry("2", "BOB")]), 2_000);
    expect(events.length).toBe(2);
  });

  it("tolerates a faulty subscriber without breaking the rest", () => {
    const store = new PresenceStore();
    let secondFired = 0;
    store.subscribe(() => {
      throw new Error("boom");
    });
    store.subscribe(() => {
      secondFired++;
    });
    store.applyPresenceFrame(frame([entry("1", "ALICE")]), 1_000);
    expect(secondFired).toBe(2); // join + snapshot — the faulty listener was swallowed
  });

  it("reset clears state and listeners", () => {
    const store = new PresenceStore();
    store.setOwnCallsign("ALICE");
    store.applyPresenceFrame(frame([entry("1", "ALICE")]), 1_000);
    expect(store.snapshot()).toHaveLength(1);
    store.reset();
    expect(store.snapshot()).toEqual([]);
    expect(store.ownCallsignValue()).toBeNull();
  });

  it("renders predictable toast headlines", () => {
    const store = new PresenceStore();
    store.setOwnCallsign("ALICE");
    store.applyPresenceFrame(frame([entry("1", "ALICE"), entry("2", "BOB")]), 1_000);
    const events: PresenceEvent[] = [];
    store.subscribe((e) => events.push(e));
    store.applyPresenceFrame(frame([entry("1", "ALICE")]), 2_000);
    const leave = events.find((e) => e.kind === "leave")!;
    expect(toastTextFor(leave)).toBe("BOB left");

    const events2: PresenceEvent[] = [];
    store.subscribe((e) => events2.push(e));
    store.applyPresenceFrame(frame([entry("1", "ALICE"), entry("3", "CARL")]), 3_000);
    const join = events2.find((e) => e.kind === "join")!;
    expect(toastTextFor(join)).toBe("CARL joined");
  });

  it("maps activity tags to dot colours", () => {
    expect(statusDotColor("flying")).toMatch(/^#[0-9a-f]{6}$/u);
    expect(statusDotColor("docked")).toMatch(/^#[0-9a-f]{6}$/u);
    expect(statusDotColor("onfoot")).toMatch(/^#[0-9a-f]{6}$/u);
    // Each tag gets a distinct colour so the HUD never confuses them.
    const tags = ["flying", "docked", "onfoot"] as const;
    const colours = tags.map((t) => statusDotColor(t));
    expect(new Set(colours).size).toBe(3);
  });
});
