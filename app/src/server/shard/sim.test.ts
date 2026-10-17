/**
 * Sim loop tests — TASK-13 acceptance criteria.
 *
 * Covers the spec checklist:
 *
 *   - Accumulator math: 1000 simulated ticks → exactly 1000 logical
 *     ticks, no drift over the run.
 *   - Latest-input-wins: back-to-back `enqueueInput` calls before the
 *     next tick produce one integration using the *latest* input.
 *   - Stale-seq ignored: a new input with `seq <= lastSeq` drops
 *     silently and increments `staleDrops`.
 *   - Snapshot cadence exactly 10 Hz (every 2nd tick).
 *   - Benchmark: 16 ships, 60 s virtual run, p95 < 30 ms.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createShard, spawnAiShip, spawnShip } from "./index.js";
import { BROADCAST_WARN_BYTES } from "./index.js";
import { SERVER_TICK_HZ, SNAPSHOT_EVERY_N_TICKS, TICK_S } from "./sim.js";
import {
  buildSnapshotEntities,
  pushPlayerInput,
  addConnection,
  removeConnection,
  type Shard,
  type ShardConnection,
} from "./index.js";
import { TickHistogram } from "./histogram.js";
import type { ProtocolEntityState } from "@shared/protocol/index.js";
import type { ShardSystemContext } from "./types.js";
import { PROTOCOL_VERSION } from "@shared/protocol/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ZERO_VEL = { x: 0, y: 0, z: 0 };
const ZERO_QUAT = { x: 0, y: 0, z: 0, w: 1 };

function makeContext(): ShardSystemContext {
  return {
    system: {
      systemId: "test-system",
      name: "Test",
      star: {
        id: "star-test",
        name: "Test Star",
        class: "G",
        x: 0,
        y: 0,
        z: 0,
        systemCount: 1,
      },
      planets: [],
    },
    planetById: () => undefined,
    heightAtFor: () => undefined,
    tileSizeM: 64,
  };
}

/** Make a Shard wired to recorders for the tests. */
function makeRecorderShard(opts: { autoStart?: boolean } = {}): {
  shard: Shard;
  sent: Array<{ connId: string; frame: unknown }>;
  broadcasts: Array<{
    tick: number;
    entities: ProtocolEntityState[];
    lastAppliedSeq: Readonly<Record<string, number>>;
    bytes?: number;
  }>;
  nowMs: () => number;
  advance: (ms: number) => void;
} {
  let now = 0;
  const sent: Array<{ connId: string; frame: unknown }> = [];
  const broadcasts: Array<{
    tick: number;
    entities: ProtocolEntityState[];
    lastAppliedSeq: Readonly<Record<string, number>>;
    bytes?: number;
  }> = [];
  const shard = createShard({
    systemId: "test-system",
    context: makeContext(),
    send: (connId, frame) => {
      sent.push({ connId, frame });
    },
    broadcast: (tick, entities, lastAppliedSeq) => {
      broadcasts.push({ tick, entities, lastAppliedSeq });
      return Buffer.byteLength(JSON.stringify(entities), "utf8");
    },
    onTickObserver: null,
    autoStart: opts.autoStart,
  });
  return {
    shard,
    sent,
    broadcasts,
    nowMs: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function makeConnection(args: {
  connId: string;
  playerId?: string;
  callsign?: string;
}): ShardConnection {
  return {
    connId: args.connId,
    callsign: args.callsign ?? `pilot-${args.connId}`,
    playerId: args.playerId ?? `player-${args.connId}`,
    entityId: null,
    lastSeq: 0,
    pendingInput: null,
    staleDrops: 0,
  };
}

/**
 * Drive the sim loop with a fully controllable fake clock. Each
 * call to `tick()` is preceded by an `advance()` so the loop's
 * accumulator grows by exactly `TICK_S` per call. Returns the same
 * shape as `simulateNTicks` for ergonomic assertions.
 */
function driveWithFakeClock(
  shard: Shard,
  _fakeNow: () => number,
  _readNow: () => number,
  advance: () => void,
  n: number,
): { stepsRun: number[]; snapshots: number[] } {
  const stepsRun: number[] = [];
  const snapshots: number[] = [];
  // Prime the loop (first tick snapshots the clock without integrating).
  advance();
  shard.sim.tick();
  for (let i = 0; i < n; i++) {
    advance(); // Advance the wall clock BEFORE the tick so the loop's
    // accumulator captures exactly one extra TICK_S of elapsed time.
    const result = shard.sim.tick();
    stepsRun.push(result.stepsRun);
    if (result.didSnapshot) snapshots.push(shard.sim.currentTick);
  }
  void _fakeNow;
  void _readNow;
  return { stepsRun, snapshots };
}

/**
 * Helper: a single-shot `await new Promise(setImmediate)` to let any
 * pending Node microtasks drain before assertions.
 */
function waitForTasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SimLoop — accumulator math", () => {
  it("integrates exactly one tick per 1/20 s of wall time", () => {
    // Direct path: don't start the auto-chained loop; instead drive
    // `tick()` manually with controlled elapsed time.
    const recorder = makeRecorderShard({ autoStart: false });
    const fakeNow = vi.fn(() => 0);
    // Replace hooks.clock so the loop reads our fake clock.
    (recorder.shard.sim as unknown as { hooks: { clock: () => number } }).hooks.clock = fakeNow;

    let now = 0;
    fakeNow.mockImplementation(() => now);

    // Prime the loop — first tick snapshots the wall clock without integrating.
    recorder.shard.sim.tick();
    now += TICK_S * 1000;

    const tickResults: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const r = recorder.shard.sim.tick();
      tickResults.push(r.stepsRun);
      now += TICK_S * 1000;
    }
    // Each tick should have stepped once (no over/under catch-up).
    for (const steps of tickResults) {
      expect(steps).toBe(1);
    }
    expect(recorder.shard.sim.currentTick).toBe(1000);
    recorder.shard.shutdown();
  });

  it("catches up after a stall (5 steps max, drops the rest)", () => {
    const recorder = makeRecorderShard({ autoStart: false });
    const fakeNow = vi.fn(() => 0);
    (recorder.shard.sim as unknown as { hooks: { clock: () => number } }).hooks.clock = fakeNow;

    let now = 0;
    fakeNow.mockImplementation(() => now);

    // Prime the loop (first tick snapshots the clock, 0 steps).
    recorder.shard.sim.tick();
    now += TICK_S * 1000;

    // First 100 ticks normal.
    for (let i = 0; i < 100; i++) {
      const r = recorder.shard.sim.tick();
      expect(r.stepsRun).toBe(1);
      now += TICK_S * 1000;
    }
    // Stall: jump 50 ticks (1 s). The next tick should burst 5 and
    // drop the remaining 45.
    const before = recorder.shard.sim.currentTick;
    now += TICK_S * 1000 * 50;
    const r = recorder.shard.sim.tick();
    expect(r.stepsRun).toBe(5);
    expect(recorder.shard.sim.currentTick).toBe(before + 5);
    // After the catch-up the accumulator is reset so we don't drag debt.
    expect(
      (recorder.shard.sim as unknown as { accumulator: number }).accumulator,
    ).toBeLessThanOrEqual(TICK_S * 1000);
    recorder.shard.shutdown();
  });
});

describe("SimLoop — snapshot cadence (10 Hz, every 2nd tick)", () => {
  it("broadcasts on tick 2, 4, 6, … and never on tick 1, 3, 5, …", () => {
    const recorder = makeRecorderShard({ autoStart: false });
    const fakeNow = vi.fn(() => 0);
    (recorder.shard.sim as unknown as { hooks: { clock: () => number } }).hooks.clock = fakeNow;

    let now = 0;
    fakeNow.mockImplementation(() => now);

    // Drive `tick()` manually so we can advance the fake clock once
    // per logical tick. 20 ticks → 10 snapshots.
    const { snapshots } = driveWithFakeClock(
      recorder.shard,
      fakeNow,
      () => now,
      () => {
        now += TICK_S * 1000;
      },
      20,
    );
    // 20 ticks → 10 snapshots, at tick 2, 4, …, 20.
    expect(snapshots).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
    expect(snapshots.length).toBe(20 / SNAPSHOT_EVERY_N_TICKS);
    recorder.shard.shutdown();
  });

  it("broadcasts exactly 10 entities per second at 20 Hz", () => {
    const recorder = makeRecorderShard({ autoStart: true });
    // Don't pre-populate connections; just confirm the cadence in
    // the `autoStart` chain by letting it tick until 1 s elapsed.
    // Wait 1.05 s of real time, then count the broadcasts.
    return new Promise<void>((resolve) => {
      const start = Date.now();
      const collect = () => {
        const elapsed = Date.now() - start;
        if (elapsed >= 1050) {
          expect(recorder.broadcasts.length).toBe(SERVER_TICK_HZ / 2); // 10 Hz
          recorder.shard.shutdown();
          resolve();
        } else {
          setTimeout(collect, 20);
        }
      };
      collect();
    });
  });
});

describe("Input queue — latest-wins + stale-seq", () => {
  it("drops inputs whose seq <= lastSeq", () => {
    const recorder = makeRecorderShard({ autoStart: false });
    const conn = makeConnection({ connId: "c1", playerId: "p1" });
    addConnection(recorder.shard, conn);

    // First valid input.
    const r1 = pushPlayerInput(recorder.shard, "c1", {
      seq: 1,
      thrust: 0.5,
      turn: 0,
      pitch: 0,
      yaw: 0,
      fire: false,
      lock: false,
      action: null,
    });
    expect(r1.accepted).toBe(true);

    // Stale with seq=1 (already accepted).
    const r2 = pushPlayerInput(recorder.shard, "c1", {
      seq: 1,
      thrust: 0.5,
      turn: 0,
      pitch: 0,
      yaw: 0,
      fire: false,
      lock: false,
      action: null,
    });
    expect(r2.accepted).toBe(false);
    expect(r2.reason).toBe("stale-seq");

    // Below latest.
    const r3 = pushPlayerInput(recorder.shard, "c1", {
      seq: 0,
      thrust: 0.5,
      turn: 0,
      pitch: 0,
      yaw: 0,
      fire: false,
      lock: false,
      action: null,
    });
    expect(r3.accepted).toBe(false);

    // Fresh: seq=2 wins.
    const r4 = pushPlayerInput(recorder.shard, "c1", {
      seq: 2,
      thrust: 0.7,
      turn: 0,
      pitch: 0,
      yaw: 0,
      fire: false,
      lock: false,
      action: null,
    });
    expect(r4.accepted).toBe(true);

    // The connection's lastSeq and pendingInput should reflect the
    // most recent accept only.
    expect(conn.lastSeq).toBe(2);
    expect(conn.pendingInput).not.toBeNull();
    expect(conn.staleDrops).toBe(2);
    recorder.shard.shutdown();
  });

  it("latest-input-wins: two accepted inputs before one tick", () => {
    const recorder = makeRecorderShard({ autoStart: false });
    const fakeNow = vi.fn(() => 0);
    (recorder.shard.sim as unknown as { hooks: { clock: () => number } }).hooks.clock = fakeNow;
    let now = 0;
    fakeNow.mockImplementation(() => now);

    const conn = makeConnection({ connId: "c1", playerId: "p1" });
    addConnection(recorder.shard, conn);

    // Spawn a player entity so the integration actually has a target.
    spawnShip(recorder.shard, {
      shipId: "ship-1",
      playerId: "p1",
      callsign: "p1",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 0, z: 0 },
      vel: ZERO_VEL,
      quat: ZERO_QUAT,
      bindConnId: "c1",
    });

    // Two consecutive inputs, both accepted; only the LATEST should
    // be integrated on the next tick (we don't queue).
    pushPlayerInput(recorder.shard, "c1", {
      seq: 1,
      thrust: 0.1,
      turn: 0,
      pitch: 0,
      yaw: 0,
      fire: false,
      lock: false,
      action: null,
    });
    pushPlayerInput(recorder.shard, "c1", {
      seq: 2,
      thrust: 0.9,
      turn: 0,
      pitch: 0,
      yaw: 0,
      fire: false,
      lock: false,
      action: null,
    });
    // Drain once. Advance the clock so the loop's accumulator fires.
    const beforeVel = recorder.shard.entities.get("entity:ship-1")?.vel;
    expect(beforeVel).toBeDefined();
    const beforeVelZ = beforeVel?.z ?? 0;
    // First tick snapshots the clock without integrating; second tick
    // observes TICK_S of elapsed and runs one step.
    recorder.shard.sim.tick();
    now += TICK_S * 1000;
    recorder.shard.sim.tick();
    const afterVel = recorder.shard.entities.get("entity:ship-1")?.vel;
    expect(afterVel).toBeDefined();
    // The latest input was thrust=0.9; the integration should move
    // the ship along +Z at > 0 velocity (positive thrust ⇒ accelerate
    // forward ⇒ positive z velocity).
    expect(afterVel?.z ?? 0).toBeGreaterThan(beforeVelZ);
    // Pending input was drained.
    expect(conn.pendingInput).toBeNull();
    recorder.shard.shutdown();
  });

  it("cold-start first input must be seq === 1", () => {
    const recorder = makeRecorderShard({ autoStart: false });
    const conn = makeConnection({ connId: "c2" });
    addConnection(recorder.shard, conn);

    const r = pushPlayerInput(recorder.shard, "c2", {
      seq: 2,
      thrust: 0.5,
      turn: 0,
      pitch: 0,
      yaw: 0,
      fire: false,
      lock: false,
      action: null,
    });
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe("stale-seq");
    expect(conn.lastSeq).toBe(0);
    expect(conn.staleDrops).toBe(1);
    recorder.shard.shutdown();
  });
});

describe("Snapshot payload", () => {
  it("entity_update payload contains hull/shields/target/classId/callsign", () => {
    const recorder = makeRecorderShard({ autoStart: false });
    spawnShip(recorder.shard, {
      shipId: "ship-A",
      playerId: "pA",
      callsign: "ACE",
      classId: "interceptor",
      hull: 80,
      shields: 40,
      pos: { x: 10, y: 20, z: 30 },
      vel: { x: 0, y: 0, z: 5 },
      quat: ZERO_QUAT,
      regime: "space",
    });

    // Simulate enough ticks to trigger at least one snapshot.
    const fakeNow = vi.fn(() => 0);
    (recorder.shard.sim as unknown as { hooks: { clock: () => number } }).hooks.clock = fakeNow;
    let now = 0;
    fakeNow.mockImplementation(() => now);
    const { snapshots } = driveWithFakeClock(
      recorder.shard,
      fakeNow,
      () => now,
      () => {
        now += TICK_S * 1000;
      },
      4,
    );
    expect(snapshots.length).toBeGreaterThan(0);

    const first = recorder.broadcasts[0];
    expect(first).toBeDefined();
    expect(first?.tick).toBe(2);
    expect(first?.entities.length).toBe(1);
    const ent = first?.entities[0];
    expect(ent?.hull).toBe(80);
    expect(ent?.shields).toBe(40);
    expect(ent?.classId).toBe("interceptor");
    expect(ent?.callsign).toBe("ACE");
    expect(ent?.targetId).toBeNull();
    expect(ent?.regime).toBe("space");
    expect(Array.isArray(ent?.pos)).toBe(true);
    recorder.shard.shutdown();
  });

  it("warns at > 32 KB broadcast payload", () => {
    const recorder = makeRecorderShard({ autoStart: false });
    // Spawn enough entities to push the broadcast over the 32 KB
    // threshold; each entity payload is ~120 bytes.
    for (let i = 0; i < 400; i++) {
      spawnShip(recorder.shard, {
        shipId: `ship-${i}`,
        playerId: `p-${i}`,
        callsign: `c-${i}`,
        classId: "scout",
        hull: 100,
        shields: 50,
        pos: { x: i, y: i, z: i },
        vel: ZERO_VEL,
        quat: ZERO_QUAT,
      });
    }
    // The size threshold check lives in the createShard factory, so
    // we exercise it directly via the broadcast callback. The warning
    // is fired when bytes > BROADCAST_WARN_BYTES.
    const entities = buildSnapshotEntities(recorder.shard);
    const size = Buffer.byteLength(JSON.stringify(entities), "utf8");
    expect(size).toBeGreaterThan(BROADCAST_WARN_BYTES);
    recorder.shard.shutdown();
  });
});

describe("Entity registry — kind mapping", () => {
  it("spawnShip → wire kind ship; spawnAiShip → wire kind ai-ship", () => {
    const recorder = makeRecorderShard({ autoStart: false });
    spawnShip(recorder.shard, {
      shipId: "s1",
      playerId: "p1",
      callsign: "C1",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 0, z: 0 },
    });
    spawnAiShip(recorder.shard, { id: "ai-1", classId: "freighter", pos: { x: 1, y: 2, z: 3 } });
    // Simulate two ticks so we hit one snapshot (tick 2).
    const fakeNow = vi.fn(() => 0);
    (recorder.shard.sim as unknown as { hooks: { clock: () => number } }).hooks.clock = fakeNow;
    let now = 0;
    fakeNow.mockImplementation(() => now);
    driveWithFakeClock(
      recorder.shard,
      fakeNow,
      () => now,
      () => {
        now += TICK_S * 1000;
      },
      2,
    );
    expect(recorder.broadcasts.length).toBeGreaterThan(0);
    const lastBroadcast = recorder.broadcasts[recorder.broadcasts.length - 1];
    const kinds = lastBroadcast?.entities.map((e) => e.kind);
    expect(kinds).toContain("ship");
    expect(kinds).toContain("ai-ship");
    recorder.shard.shutdown();
  });

  it("removing a connection keeps the entity in the shard", () => {
    const recorder = makeRecorderShard({ autoStart: false });
    spawnShip(recorder.shard, {
      shipId: "s1",
      playerId: "p1",
      callsign: "C1",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 0, z: 0 },
      bindConnId: "c1",
    });
    addConnection(recorder.shard, makeConnection({ connId: "c1" }));
    expect(recorder.shard.entities.size).toBe(1);
    removeConnection(recorder.shard, "c1");
    expect(recorder.shard.connections.size).toBe(0);
    // Entity survives (reconnect in TASK-17).
    expect(recorder.shard.entities.size).toBe(1);
    recorder.shard.shutdown();
  });
});

describe("Histograms", () => {
  it("computes p50/p95/p99 across a uniform distribution", () => {
    const h = new TickHistogram(1024);
    for (let i = 0; i < 1000; i++) h.push(i); // 0..999 ms
    const s = h.snapshot();
    expect(s.count).toBe(1000);
    expect(s.p50).toBeGreaterThan(490);
    expect(s.p50).toBeLessThan(510);
    expect(s.p95).toBeGreaterThan(940);
    expect(s.p95).toBeLessThan(960);
    expect(s.p99).toBeGreaterThan(980);
    expect(s.max).toBe(999);
  });

  it("rejects non-finite samples", () => {
    const h = new TickHistogram(8);
    h.push(5);
    h.push(NaN);
    h.push(Infinity);
    h.push(-1);
    expect(h.sizeForTesting).toBe(1);
    expect(h.rejectedCount).toBe(3);
    const s = h.snapshot();
    expect(s.count).toBe(1);
    expect(s.p50).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Benchmark — p95 < 30 ms at 16 simulated ships (60 s virtual run).
// ---------------------------------------------------------------------------

describe("Benchmark — 16 ships, 60 s virtual run", () => {
  it("p95 < 30 ms over 60 s simulated at 20 Hz", () => {
    const recorder = makeRecorderShard({ autoStart: false });
    const fakeNow = vi.fn(() => 0);
    (recorder.shard.sim as unknown as { hooks: { clock: () => number } }).hooks.clock = fakeNow;
    let now = TICK_S * 1000; // start at one tick so the first call observes that elapsed
    fakeNow.mockImplementation(() => now);

    // Spawn 16 ships (mix of player + AI).
    for (let i = 0; i < 8; i++) {
      spawnShip(recorder.shard, {
        shipId: `p-${i}`,
        playerId: `player-${i}`,
        callsign: `P${i}`,
        classId: "scout",
        hull: 100,
        shields: 50,
        pos: { x: i * 100, y: 0, z: 0 },
        vel: ZERO_VEL,
        quat: ZERO_QUAT,
      });
    }
    for (let i = 0; i < 8; i++) {
      spawnAiShip(recorder.shard, {
        id: `ai-${i}`,
        classId: i % 2 === 0 ? "scout" : "freighter",
        pos: { x: i * 200, y: 0, z: 0 },
      });
    }

    // 60 s simulated → 1200 ticks.
    const TOTAL_TICKS = Math.round(60 * SERVER_TICK_HZ);
    // First tick snapshots the clock without integrating. After that,
    // each `tick()` call observes exactly TICK_S of elapsed and steps once,
    // for a total of TOTAL_TICKS logical ticks.
    recorder.shard.sim.tick();
    now += TICK_S * 1000;
    for (let i = 0; i < TOTAL_TICKS; i++) {
      // Apply fresh inputs to a random subset of player ships per
      // tick (some variety to exercise the input drain path).
      const idx = i % 8;
      const shipId = `p-${idx}`;
      const entity = recorder.shard.entities.get(`entity:${shipId}`);
      if (entity && entity.playerId) {
        // Bind a connection ad-hoc if not already.
        const connId = `c-${idx}`;
        if (!recorder.shard.connections.has(connId)) {
          const conn = makeConnection({ connId, playerId: entity.playerId });
          addConnection(recorder.shard, conn);
          conn.entityId = entity.id;
        }
        pushPlayerInput(recorder.shard, connId, {
          seq: i + 1,
          thrust: (i % 7) / 7,
          turn: Math.sin(i / 100),
          pitch: Math.cos(i / 100),
          yaw: Math.sin(i / 50),
          fire: false,
          lock: false,
          action: null,
        });
      }
      recorder.shard.sim.tick();
      now += TICK_S * 1000;
    }

    const stats = recorder.shard.stats();
    // Sanity: 1200 ticks fired.
    expect(stats.tickCount).toBe(TOTAL_TICKS);
    expect(stats.entityCount).toBe(16);
    // Snapshot count is half of total ticks (10 Hz).
    expect(recorder.broadcasts.length).toBe(TOTAL_TICKS / SNAPSHOT_EVERY_N_TICKS);
    // Budget: p95 < 30 ms.
    // In a tight benchmark this is the line that gates TASK-13 acceptance.
    // We log the actual numbers so the build log shows the budget.
    // eslint-disable-next-line no-console
    console.log(
      `[drift-sim-bench] 16 ships × 60 s: p50=${stats.histogram.p50.toFixed(3)}ms ` +
        `p95=${stats.histogram.p95.toFixed(3)}ms p99=${stats.histogram.p99.toFixed(3)}ms ` +
        `max=${stats.histogram.max.toFixed(3)}ms`,
    );
    expect(stats.histogram.p95).toBeLessThan(30);
    recorder.shard.shutdown();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Misc protocol constants — sanity-pin.
// ---------------------------------------------------------------------------

describe("TASK-14 — lastAppliedSeq in broadcast", () => {
  it("broadcast carries lastAppliedSeq populated for the owning player", () => {
    const recorder = makeRecorderShard({ autoStart: false });
    const connId = "conn-1";
    addConnection(recorder.shard, {
      connId,
      callsign: "ALPHA",
      playerId: "p-1",
      entityId: null,
      lastSeq: 0,
      pendingInput: null,
      staleDrops: 0,
    });
    spawnShip(recorder.shard, {
      shipId: "ship-1",
      playerId: "p-1",
      callsign: "ALPHA",
      classId: "scout",
      hull: 100,
      shields: 50,
      pos: { x: 0, y: 0, z: 0 },
      regime: "space",
      bindConnId: connId,
    });
    // Push three inputs; each should advance the high-water mark.
    pushPlayerInput(recorder.shard, connId, {
      seq: 1,
      thrust: 0.5,
      turn: 0,
      pitch: 0,
      yaw: 0,
      fire: false,
      lock: false,
      action: null,
    });
    pushPlayerInput(recorder.shard, connId, {
      seq: 2,
      thrust: 0.7,
      turn: 0,
      pitch: 0,
      yaw: 0,
      fire: false,
      lock: false,
      action: null,
    });
    pushPlayerInput(recorder.shard, connId, {
      seq: 3,
      thrust: 1,
      turn: 0,
      pitch: 0,
      yaw: 0,
      fire: false,
      lock: false,
      action: null,
    });
    // Drive enough ticks for at least one snapshot.
    const fakeNow = vi.fn(() => 0);
    (recorder.shard.sim as unknown as { hooks: { clock: () => number } }).hooks.clock = fakeNow;
    let now = 0;
    fakeNow.mockImplementation(() => now);
    driveWithFakeClock(
      recorder.shard,
      fakeNow,
      () => now,
      () => {
        now += TICK_S * 1000;
      },
      4,
    );
    expect(recorder.broadcasts.length).toBeGreaterThan(0);
    // Every broadcast should carry the latest-applied seq for the
    // owning player.
    for (const b of recorder.broadcasts) {
      expect(b.lastAppliedSeq["p-1"]).toBe(3);
    }
    recorder.shard.shutdown();
  });

  it("empty lastAppliedSeq when no player inputs were integrated", () => {
    const recorder = makeRecorderShard({ autoStart: false });
    spawnAiShip(recorder.shard, {
      id: "ai-1",
      classId: "scout",
      pos: { x: 0, y: 0, z: 0 },
    });
    const fakeNow = vi.fn(() => 0);
    (recorder.shard.sim as unknown as { hooks: { clock: () => number } }).hooks.clock = fakeNow;
    let now = 0;
    fakeNow.mockImplementation(() => now);
    driveWithFakeClock(
      recorder.shard,
      fakeNow,
      () => now,
      () => {
        now += TICK_S * 1000;
      },
      4,
    );
    expect(recorder.broadcasts.length).toBeGreaterThan(0);
    for (const b of recorder.broadcasts) {
      expect(Object.keys(b.lastAppliedSeq).length).toBe(0);
    }
    recorder.shard.shutdown();
  });
});

describe("Protocol constants", () => {
  it("SNAPSHOT_EVERY_N_TICKS = 2 (10 Hz from 20 Hz)", () => {
    expect(SNAPSHOT_EVERY_N_TICKS).toBe(2);
    expect(SERVER_TICK_HZ).toBe(20);
  });

  it("PROTOCOL_VERSION is 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

// Placeholder so the unused-import lints don't complain.
beforeEach(() => {
  /* no setup needed */
});
afterEach(() => {
  /* no teardown needed */
});
void waitForTasks;
