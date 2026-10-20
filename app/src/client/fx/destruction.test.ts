/**
 * Destruction FX store tests — TASK-49 client acceptance.
 *
 * Covers the presentation contracts the spec pins: 1 s flash, 3 s
 * debris fade, 1 s slow-mo at `timeScale 0.3`, the 2 s "SHIP LOST"
 * moment (callsign / killer / nearest dock), and the 200 m wreck
 * marker radius.
 */
import { describe, expect, it } from "vitest";

import {
  DEBRIS_COUNT,
  DEBRIS_MS,
  DestructionStore,
  EXPLOSION_FLASH_MS,
  SLOWMO_MS,
  SLOWMO_SCALE,
  SHIP_LOST_MS,
  SHOCKWAVE_MS,
  WRECK_MARKER_RANGE_M,
  debrisOffsets,
  explosionProgress,
  killerLabelFor,
  respawnLabelFor,
} from "./destruction.js";
import type { ProtocolCombatEvent } from "@shared/protocol/index.js";

const DESTROYED_WITH_RESPAWN: ProtocolCombatEvent = {
  kind: "destroyed",
  target: "entity:ship-b",
  source: { kind: "player", id: "ALPHA" },
  tick: 42,
  respawn: {
    wreckId: "wreck:entity:ship-b",
    padId: "pad-7f3a",
    planetId: "planet-2",
    callsign: "BRAVO",
    killer: "ALPHA",
    cargoLost: { iron: 40 },
  },
};

describe("DestructionStore", () => {
  it("ignores non-destroyed combat events", () => {
    const store = new DestructionStore();
    const evt: ProtocolCombatEvent = {
      kind: "damaged",
      target: "entity:x",
      source: { kind: "ai", id: "rogue" },
      amount: 5,
      shieldHit: 5,
      hullHit: 0,
      tick: 1,
    };
    expect(store.applyCombatEvent(evt)).toBe(false);
    expect(store.snapshot().explosions).toHaveLength(0);
  });

  it("spawns an explosion + a 1 s slow-mo dip at timeScale 0.3", () => {
    const store = new DestructionStore();
    store.applyCombatEvent(DESTROYED_WITH_RESPAWN, 1_000);
    const snap = store.snapshot();
    expect(snap.explosions).toHaveLength(1);
    expect(snap.timeScale).toBe(SLOWMO_SCALE);
    expect(SLOWMO_MS).toBe(1_000);
    store.reap(1_000 + SLOWMO_MS);
    expect(store.snapshot().timeScale).toBe(1);
  });

  it("opens the 2 s SHIP LOST moment with callsign, killer and dock", () => {
    const store = new DestructionStore();
    store.applyCombatEvent(DESTROYED_WITH_RESPAWN, 0);
    const moment = store.snapshot().shipLost!;
    expect(moment.callsign).toBe("BRAVO");
    expect(killerLabelFor(moment)).toBe("Destroyed by ALPHA");
    expect(respawnLabelFor(moment)).toBe("Respawning at pad-7f3a");
    expect(SHIP_LOST_MS).toBe(2_000);
    store.reap(SHIP_LOST_MS - 1);
    expect(store.snapshot().shipLost).not.toBeNull();
    store.reap(SHIP_LOST_MS);
    expect(store.snapshot().shipLost).toBeNull();
  });

  it("keeps the explosion for the 3 s debris fade then reaps it", () => {
    const store = new DestructionStore();
    store.applyCombatEvent(DESTROYED_WITH_RESPAWN, 0);
    store.reap(EXPLOSION_FLASH_MS);
    expect(store.snapshot().explosions).toHaveLength(1);
    store.reap(SHOCKWAVE_MS);
    expect(store.snapshot().explosions).toHaveLength(1);
    store.reap(DEBRIS_MS);
    expect(store.snapshot().explosions).toHaveLength(0);
  });

  it("shows a wreck marker only within 200 m", () => {
    const store = new DestructionStore();
    store.applyWrecks(
      [
        { id: "w1", x: 100, y: 0, z: 0, killerCallsign: "ALPHA" },
        { id: "w2", x: 0, y: 0, z: WRECK_MARKER_RANGE_M + 1, killerCallsign: "BRAVO" },
      ],
      { x: 0, y: 0, z: 0 },
    );
    const markers = store.snapshot().markers;
    expect(markers).toHaveLength(1);
    expect(markers[0]!.wreckId).toBe("w1");
    expect(markers[0]!.killerCallsign).toBe("ALPHA");
    expect(markers[0]!.distanceM).toBe(100);
  });

  it("notifies subscribers and resets cleanly", () => {
    const store = new DestructionStore();
    let hits = 0;
    const off = store.subscribe(() => {
      hits++;
    });
    store.applyCombatEvent(DESTROYED_WITH_RESPAWN, 0);
    expect(hits).toBe(1);
    store.reset();
    expect(hits).toBe(2);
    expect(store.snapshot()).toEqual({
      explosions: [],
      shipLost: null,
      markers: [],
      timeScale: 1,
    });
    off();
    store.applyCombatEvent(DESTROYED_WITH_RESPAWN, 0);
    expect(hits).toBe(2);
  });
});

describe("debrisOffsets", () => {
  it("lays out 8 unit-sphere debris vectors with distinct spins", () => {
    const offsets = debrisOffsets();
    expect(DEBRIS_COUNT).toBe(8);
    expect(offsets).toHaveLength(8);
    for (const d of offsets) {
      expect(Math.hypot(d.dx, d.dy, d.dz)).toBeCloseTo(1, 5);
      expect(d.spin).toBeGreaterThan(0);
    }
    expect(new Set(offsets.map((d) => d.spin)).size).toBe(8);
  });

  it("clamps explosionProgress to 0..1", () => {
    const boom = { id: "b", x: 0, y: 0, z: 0, startedAt: 500 };
    expect(explosionProgress(boom, 400)).toBe(0);
    expect(explosionProgress(boom, 500 + DEBRIS_MS / 2)).toBeCloseTo(0.5, 5);
    expect(explosionProgress(boom, 500 + DEBRIS_MS * 2)).toBe(1);
  });
});
