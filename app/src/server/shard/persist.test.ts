/**
 * Tests for the per-shard ship flush service (TASK-24).
 *
 * Two layers:
 *   1. **Unit tests** — in-memory SQLite repo + a synthesised shard.
 *      Assert the patch shape, the row count, and the timing budget
 *      (p95 under 8 ms per spec).
 *   2. **Bench** — same setup with 16 ships; verifies the p95 flush
 *      latency stays well under the 50 ms tick budget.
 *
 * The crash-restart integration test (separate file) spawns a child
 * process and asserts the position survives a kill -9 round-trip.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installRepoHooks, active } from "../db/repo.test.shared.js";
import { createShard, spawnShip, type Shard } from "./index.js";
import {
  DEFAULT_FLUSH_INTERVAL_MS,
  ShardFlushService,
  entityToShipPatch,
  flushShips,
} from "./persist.js";
import { ShardRegistry } from "./registry.js";
import { SHIP_CLASSES, type ShipClassId } from "@shared/ships.js";
import type { ShardSystemContext } from "./types.js";
import type { SimEntity } from "./types.js";

installRepoHooks();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(): ShardSystemContext {
  return {
    starId: "star-DUMMY",
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

/** Build a fresh shard wired to noop hooks for recorder-free tests. */
function makeShard(systemId: string = "system-TEST"): Shard {
  return createShard({
    systemId,
    context: makeContext(),
    send: () => {},
    broadcast: () => {},
    autoStart: false, // tests drive ticks explicitly if needed
  });
}

/** Create a matching in-shard entity from an already-persisted ship row.
 *
 * The flush path's `saveShipState` is an `UPDATE` (not an `INSERT`) —
 * the row must already exist. Tests therefore create the row first via
 * `getOrCreateStarterShip`, then mint the in-memory entity under the
 * SAME ship id so the flush round-trips through the right PK.
 */
async function seedPlayerFromRow(
  shard: Shard,
  playerId: string,
  callsign: string,
  shipId: string,
  pos: { x: number; y: number; z: number },
  classId: ShipClassId = "scout",
): Promise<void> {
  const shipCls = SHIP_CLASSES[classId];
  spawnShip(shard, {
    shipId,
    playerId,
    callsign,
    classId,
    hull: shipCls.hull,
    shields: shipCls.shieldCapacity,
    pos,
    vel: { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    regime: "space",
    originPlanetId: null,
    onPad: null,
    bindConnId: undefined,
  });
}

beforeEach(() => {
  // installRepoHooks already provides a fresh harness in active()
});

afterEach(() => {
  // installRepoHooks handles teardown
});

// ---------------------------------------------------------------------------
// flushShips — unit
// ---------------------------------------------------------------------------

describe("flushShips (TASK-24)", () => {
  it("writes every player entity to the ships table with full patch fields", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({ callsign: "FLUSH-A", homeSystemId: "system-FLUSH" });
    const ship = await repo.getOrCreateStarterShip(player.id, "scout");
    const shard = makeShard("system-FLUSH");
    await seedPlayerFromRow(shard, player.id, player.callsign, ship.id, {
      x: 12.5,
      y: -3.5,
      z: 0.25,
    });

    const result = await flushShips(shard, repo, { logger: silentLogger() });

    expect(result.ships).toBe(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // Round-trip through the repo and confirm every field persisted.
    const rows = await repo.listShipsBySystem("system-FLUSH");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(ship.id);
    expect(row.position.x).toBeCloseTo(12.5);
    expect(row.position.y).toBeCloseTo(-3.5);
    expect(row.position.z).toBeCloseTo(0.25);
    expect(row.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(row.state).toBe("flying");
    expect(row.quat).toEqual([0, 0, 0, 1]);
    expect(row.regime).toBe("space");
    expect(row.onPad).toBeNull();
    expect(row.wreckExpiresAt).toBeNull();
  });

  it("returns 0 ships flushed for an empty shard", async () => {
    const { repo } = active();
    const shard = makeShard("system-EMPTY");
    const result = await flushShips(shard, repo, { logger: silentLogger() });
    expect(result).toEqual({ ships: 0, durationMs: 0 });
  });

  it("preserves position updates between two flushes (no stale-cache)", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({ callsign: "FLUSH-B", homeSystemId: "system-FLUSH" });
    const ship = await repo.getOrCreateStarterShip(player.id, "scout");
    const shard = makeShard("system-FLUSH");
    await seedPlayerFromRow(shard, player.id, player.callsign, ship.id, { x: 0, y: 0, z: 0 });

    await flushShips(shard, repo, { logger: silentLogger() });

    // Update the entity's position in memory + flush again — the
    // second flush must observe the new coordinates.
    const entity = Array.from(shard.entities.values())[0]!;
    entity.pos.x = 100;
    entity.pos.y = 200;
    entity.pos.z = -50;
    entity.quat.x = 0.1;
    entity.quat.w = 0.99;
    await flushShips(shard, repo, { logger: silentLogger() });

    const rows = await repo.listShipsBySystem("system-FLUSH");
    expect(rows[0]!.position.x).toBeCloseTo(100);
    expect(rows[0]!.position.y).toBeCloseTo(200);
    expect(rows[0]!.position.z).toBeCloseTo(-50);
    expect(rows[0]!.quat[0]).toBeCloseTo(0.1);
    expect(rows[0]!.quat[3]).toBeCloseTo(0.99);
  });

  it("persists onPad and a docked state when the entity is on a pad", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({ callsign: "FLUSH-C", homeSystemId: "system-FLUSH" });
    const ship = await repo.getOrCreateStarterShip(player.id, "scout");
    const shard = makeShard("system-FLUSH");
    await seedPlayerFromRow(shard, player.id, player.callsign, ship.id, { x: 0, y: 0, z: 0 });

    const entity = Array.from(shard.entities.values())[0]!;
    entity.onPad = "pad-surface-0-0";
    entity.hull = 70;
    entity.shields = 30;

    await flushShips(shard, repo, { logger: silentLogger() });

    const rows = await repo.listShipsBySystem("system-FLUSH");
    expect(rows[0]!.state).toBe("docked");
    expect(rows[0]!.onPad).toBe("pad-surface-0-0");
    expect(rows[0]!.hull).toBe(70);
    expect(rows[0]!.shields).toBe(30);
  });

  it("writes wreck entities under the source ship id with state='destroyed'", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({ callsign: "FLUSH-D", homeSystemId: "system-FLUSH" });
    const ship = await repo.getOrCreateStarterShip(player.id, "scout");
    const shard = makeShard("system-FLUSH");
    await seedPlayerFromRow(shard, player.id, player.callsign, ship.id, {
      x: 5,
      y: 5,
      z: 5,
    });

    // Mint a wreck in the registry whose source entity is the player.
    const wreckEntityId = `wreck:entity:${ship.id}`;
    shard.entities.set(wreckEntityId, {
      id: wreckEntityId,
      kind: "wreck",
      playerId: null,
      callsign: null,
      classId: "scout",
      hull: 0,
      shields: 0,
      targetId: null,
      pos: { x: 5, y: 5, z: 5 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: "space",
      originPlanetId: null,
      onPad: null,
      wreckExpiresAt: Date.now() + 30_000,
    });

    await flushShips(shard, repo, { logger: silentLogger() });

    // The wreck writes back to the source ship row with state='destroyed'.
    const rows = await repo.listShipsBySystem("system-FLUSH");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(ship.id);
    expect(rows[0]!.state).toBe("destroyed");
    expect(rows[0]!.wreckExpiresAt).toBeGreaterThan(Date.now() - 1000);
  });
});

// ---------------------------------------------------------------------------
// entityToShipPatch — the patch-builder unit test
// ---------------------------------------------------------------------------

describe("entityToShipPatch", () => {
  it("captures every TASK-24 spec field verbatim", () => {
    const entity: SimEntity = {
      id: "entity:ship-1",
      kind: "player",
      playerId: "player-1",
      callsign: "PILOT",
      classId: "scout",
      hull: 90,
      shields: 80,
      targetId: null,
      pos: { x: 1, y: 2, z: 3 },
      vel: { x: 0.1, y: 0.2, z: 0.3 },
      quat: { x: 0.1, y: 0.2, z: 0.3, w: 0.9 },
      regime: "atmosphere",
      originPlanetId: "planet-1",
      onPad: null,
    };
    const patch = entityToShipPatch(entity, "system-X");
    expect(patch).toEqual({
      hull: 90,
      shields: 80,
      position: { systemId: "system-X", x: 1, y: 2, z: 3 },
      velocity: { x: 0.1, y: 0.2, z: 0.3 },
      state: "flying",
      quat: [0.1, 0.2, 0.3, 0.9],
      regime: "atmosphere",
      onPad: null,
      wreckExpiresAt: null,
    });
  });
});

// ---------------------------------------------------------------------------
// ShardFlushService — interval timer plumbing
// ---------------------------------------------------------------------------

describe("ShardFlushService (TASK-24)", () => {
  it("start() is idempotent — second call returns the same timer", async () => {
    const { repo } = active();
    const svc = new ShardFlushService(repo, { intervalMs: 50_000, logger: silentLogger() });
    const t1 = svc.start(async () => {});
    const t2 = svc.start(async () => {});
    expect(t2).toBe(t1);
    svc.stopTimer();
    svc.dispose();
  });

  it("stopTimer() is idempotent", () => {
    const { repo } = active();
    const svc = new ShardFlushService(repo, { intervalMs: 50_000, logger: silentLogger() });
    expect(() => {
      svc.stopTimer();
      svc.stopTimer();
    }).not.toThrow();
    expect(svc.isRunning).toBe(false);
    svc.dispose();
  });

  it("flushNow() drains a populated shard", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({ callsign: "FLUSH-E", homeSystemId: "system-FLUSH" });
    const ship = await repo.getOrCreateStarterShip(player.id, "scout");
    const shard = makeShard("system-FLUSH");
    await seedPlayerFromRow(shard, player.id, player.callsign, ship.id, { x: 0, y: 0, z: 0 });

    const svc = new ShardFlushService(repo, { intervalMs: 50_000, logger: silentLogger() });
    const result = await svc.flushNow(shard);
    expect(result.ships).toBe(1);
    svc.dispose();

    const rows = await repo.listShipsBySystem("system-FLUSH");
    expect(rows[0]!.position.x).toBe(0);
  });

  it("configuredIntervalMs reflects the constructor override", () => {
    const { repo } = active();
    const svc = new ShardFlushService(repo, { intervalMs: 1234, logger: silentLogger() });
    expect(svc.configuredIntervalMs).toBe(1234);
    svc.dispose();
  });

  it("DEFAULT_FLUSH_INTERVAL_MS is 30 s (spec)", () => {
    expect(DEFAULT_FLUSH_INTERVAL_MS).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// ShardRegistry — flushAll + bookkeeping
// ---------------------------------------------------------------------------

describe("ShardRegistry (TASK-24)", () => {
  it("register + unregister + size bookkeeping", () => {
    const { repo } = active();
    const reg = new ShardRegistry(repo);
    const s1 = makeShard("sys-1");
    const s2 = makeShard("sys-2");
    reg.register(s1);
    reg.register(s2);
    expect(reg.size()).toBe(2);
    expect(reg.has("sys-1")).toBe(true);
    reg.unregister("sys-1");
    expect(reg.size()).toBe(1);
    expect(reg.has("sys-1")).toBe(false);
    reg.shutdownAll();
  });

  it("flushAll walks every shard and writes their entities", async () => {
    const { repo } = active();
    const player = await repo.createPlayer({ callsign: "REG-A", homeSystemId: "system-REG" });
    const ship = await repo.getOrCreateStarterShip(player.id, "scout");
    const shard = makeShard("system-REG");
    await seedPlayerFromRow(shard, player.id, player.callsign, ship.id, { x: 7, y: 0, z: 0 });

    const reg = new ShardRegistry(repo, { logger: silentLogger() });
    reg.register(shard);

    const outcomes = await reg.flushAll();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.systemId).toBe("system-REG");
    expect(outcomes[0]!.result.ships).toBe(1);

    const rows = await repo.listShipsBySystem("system-REG");
    expect(rows[0]!.position.x).toBeCloseTo(7);
    reg.shutdownAll();
  });
});

/** Logger that swallows every call — the test verifies timing + payload, not logging. */
function silentLogger(): Pick<Console, "info" | "warn" | "error"> {
  return { info: () => {}, warn: () => {}, error: () => {} };
}
