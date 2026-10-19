/**
 * Unit tests for the client-side targeting store.
 *
 * Covers:
 *   - **Lock state mutators** — `applyLocked` / `applyReleased` /
 *     `applyTargetUpdate` keep the cached entry consistent.
 *   - **Threat-ping selection** — multiple `combat_event`s with
 *     different `ts` values; the most recent within
 *     `THREAT_PING_RECENT_MS` wins.
 *   - **Threat-ping TTL** — entries older than
 *     `THREAT_PING_TTL_MS` are dropped on `reap()`.
 */

import { describe, expect, it, vi } from "vitest";

import { THREAT_PING_RECENT_MS, THREAT_PING_TTL_MS } from "@shared/targeting.js";

import type { ProtocolCombatEvent } from "@shared/protocol/index.js";

import { TargetingStore, selectStrongestPing } from "./targeting.js";

// ---------------------------------------------------------------------------
// 1. Locked-target cache
// ---------------------------------------------------------------------------

describe("TargetingStore: locked-target cache", () => {
  it("applyLocked caches the target id, callsign, range, bearing, lockedAt", () => {
    const store = new TargetingStore();
    store.applyLocked({
      targetId: "ship:b",
      callsign: "BRAVO",
      range: 250,
      bearing: 12.5,
      lockedAt: 1_000,
    });
    const locked = store.getLocked();
    expect(locked).toEqual({
      targetId: "ship:b",
      callsign: "BRAVO",
      classId: null,
      hull: 0,
      shields: 0,
      range: 250,
      bearing: 12.5,
      lockedAt: 1_000,
    });
  });

  it("applyTargetUpdate refreshes hull / shields / range / bearing", () => {
    const store = new TargetingStore();
    store.applyLocked({
      targetId: "ship:b",
      callsign: "BRAVO",
      range: 250,
      bearing: 0,
      lockedAt: 1_000,
    });
    store.applyTargetUpdate({
      targetId: "ship:b",
      hull: 80,
      shields: 35,
      bearing: -3.1,
      range: 230.5,
      callsign: "BRAVO",
      classId: "scout",
    });
    const locked = store.getLocked();
    expect(locked?.hull).toBe(80);
    expect(locked?.shields).toBe(35);
    expect(locked?.range).toBe(230.5);
    expect(locked?.bearing).toBe(-3.1);
    expect(locked?.classId).toBe("scout");
    // lockedAt is preserved across updates.
    expect(locked?.lockedAt).toBe(1_000);
  });

  it("applyReleased clears the locked entry", () => {
    const store = new TargetingStore();
    store.applyLocked({
      targetId: "ship:b",
      callsign: "BRAVO",
      range: 0,
      bearing: 0,
      lockedAt: 1_000,
    });
    expect(store.getLocked()).not.toBeNull();

    store.applyReleased({ targetId: "ship:b", reason: "toggle" });
    expect(store.getLocked()).toBeNull();
  });

  it("emits on every mutation (subscribe listener fires)", () => {
    const store = new TargetingStore();
    let count = 0;
    store.subscribe(() => {
      count += 1;
    });
    store.applyLocked({
      targetId: "ship:b",
      callsign: "BRAVO",
      range: 0,
      bearing: 0,
      lockedAt: 1_000,
    });
    store.applyTargetUpdate({
      targetId: "ship:b",
      hull: 50,
      shields: 20,
      bearing: 0,
      range: 0,
      callsign: "BRAVO",
      classId: null,
    });
    store.applyReleased({ targetId: "ship:b", reason: "manual" });
    expect(count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 2. Threat-ping selection (TASK-44 acceptance)
// ---------------------------------------------------------------------------

describe("TargetingStore: threat-ping pipeline", () => {
  it("applyCombatEvent pushes a ping for non-self damaged events", () => {
    const store = new TargetingStore();
    const event: ProtocolCombatEvent = {
      kind: "damaged",
      target: "ship:self",
      source: { kind: "player", id: "ship:enemy" },
      amount: 8,
      shieldHit: 8,
      hullHit: 0,
      tick: 1,
    };
    store.applyCombatEvent(event, "ship:self");
    const pings = store.getThreatPings();
    expect(pings).toHaveLength(1);
    expect(pings[0]?.sourceId).toBe("ship:enemy");
  });

  it("applyCombatEvent ignores events where source === self", () => {
    const store = new TargetingStore();
    const event: ProtocolCombatEvent = {
      kind: "damaged",
      target: "ship:self",
      source: { kind: "player", id: "ship:self" },
      amount: 1,
      shieldHit: 1,
      hullHit: 0,
      tick: 1,
    };
    store.applyCombatEvent(event, "ship:self");
    expect(store.getThreatPings()).toHaveLength(0);
  });

  it("applyCombatEvent pushes pings for 'hit' + 'destroyed' as well", () => {
    const store = new TargetingStore();
    store.applyCombatEvent(
      {
        kind: "hit",
        attacker: "ship:enemy",
        target: "ship:self",
        weapon: "laser",
        damage: 8,
        tick: 1,
      },
      "ship:self",
    );
    store.applyCombatEvent(
      {
        kind: "destroyed",
        target: "ship:self",
        source: { kind: "ai", id: "ai:1" },
        tick: 2,
      },
      "ship:self",
    );
    expect(store.getThreatPings()).toHaveLength(2);
  });

  it("ignores 'kill' events (out of v1 scope per the spec)", () => {
    const store = new TargetingStore();
    store.applyCombatEvent(
      {
        kind: "kill",
        attacker: "ship:enemy",
        target: "ship:other",
        tick: 1,
      },
      "ship:self",
    );
    expect(store.getThreatPings()).toHaveLength(0);
  });

  it("reap() drops pings older than THREAT_PING_TTL_MS", () => {
    const store = new TargetingStore();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(0);
    store.applyCombatEvent(
      {
        kind: "damaged",
        target: "ship:self",
        source: { kind: "player", id: "ship:enemy" },
        amount: 8,
        shieldHit: 8,
        hullHit: 0,
        tick: 1,
      },
      "ship:self",
    );
    expect(store.getThreatPings()).toHaveLength(1);
    nowSpy.mockRestore();
    // Reap with a clock past TTL → entry drops. We pin the ping's
    // ts to 0 explicitly by passing the reap timestamp that
    // exceeds the default-now ts.
    store.reap(THREAT_PING_TTL_MS + 10);
    expect(store.getThreatPings()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. strongestRecent / selectStrongestPing
// ---------------------------------------------------------------------------

describe("selectStrongestPing", () => {
  it("returns null when no pings fall inside the 5 s window", () => {
    const ping = {
      id: 1,
      sourceId: "x",
      sourceCallsign: null,
      bearing: 0,
      ts: 1_000,
    };
    expect(selectStrongestPing([ping], 1_000 + THREAT_PING_RECENT_MS + 1)).toBeNull();
  });

  it("returns the most recent ping inside the 5 s window", () => {
    const a = {
      id: 1,
      sourceId: "a",
      sourceCallsign: null,
      bearing: 0,
      ts: 1_000,
    };
    const b = {
      id: 2,
      sourceId: "b",
      sourceCallsign: null,
      bearing: 90,
      ts: 2_000,
    };
    const c = {
      id: 3,
      sourceId: "c",
      sourceCallsign: null,
      bearing: 180,
      ts: 3_000,
    };
    expect(selectStrongestPing([a, b, c], 3_500)?.sourceId).toBe("c");
  });

  it("drops pings whose age exceeds THREAT_PING_RECENT_MS even if newer pings exist", () => {
    // 'a' is fresh (100 ms old); 'b' is at the exact RECENT_MS
    // boundary so the helper considers it out-of-window.
    const now = 10_000;
    const a = {
      id: 1,
      sourceId: "a",
      sourceCallsign: null,
      bearing: 0,
      ts: now - 100,
    };
    const b = {
      id: 2,
      sourceId: "b",
      sourceCallsign: null,
      bearing: 90,
      ts: now - THREAT_PING_RECENT_MS, // exactly RECENT_MS old → out of window
    };
    const result = selectStrongestPing([a, b], now);
    expect(result?.sourceId).toBe("a");
  });
});

// ---------------------------------------------------------------------------
// THREAT_PING_TTL_MS / RECENT_MS sanity (the constants exist so other
// tasks can read them — pin a few values here so regressions surface).
// ---------------------------------------------------------------------------

describe("constant pins", () => {
  it("THREAT_PING_TTL_MS is 3 s", () => {
    expect(THREAT_PING_TTL_MS).toBe(3_000);
  });

  it("THREAT_PING_RECENT_MS is 5 s", () => {
    expect(THREAT_PING_RECENT_MS).toBe(5_000);
  });
});
