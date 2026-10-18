/**
 * Server-side on-foot inventory tests — TASK-34.
 *
 * Covers:
 *   - handlePickup path (full + partial + cap boundary)
 *   - handleDrop path (drops a ground item entity at the character's pos)
 *   - Ground item TTL expiry (cleanupExpiredGroundItems)
 *   - Persistence round-trip via an in-memory SQLite repo
 *   - Drop and re-pickup of a self-dropped ground item
 *
 * The harness builds a minimal `Shard`-shaped object plus a
 * SQLite-backed repository so the handlers can read / write the
 * `players.inventory` column without a full Fastify server.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";

import { createSqliteTestDb } from "../db/client.js";
import { createSqliteRepository } from "../db/repo.sqlite.js";
import { ChatRingBuffer } from "../chat.js";
import type { Repository } from "../db/repo.js";
import {
  cleanupExpiredGroundItems,
  GROUND_ITEM_TTL_MS,
  handleDrop,
  handlePickup,
  makeGroundItemEntity,
  makeGroundItemId,
} from "./inventory.js";
import { addToInventory, emptyInventory } from "@shared/world/inventoryOps.js";
import type { Shard, ShardConnection, SimEntity } from "./types.js";

// ---------------------------------------------------------------------------
// Minimal shard fixture
// ---------------------------------------------------------------------------

interface Fixture {
  shard: Shard;
  conn: ShardConnection;
  character: SimEntity;
  repo: Repository;
  closeDb: () => void;
}

function makeFixture(characterPos: { x: number; y: number; z: number }): Fixture {
  const { db, close } = createSqliteTestDb();
  const repo = createSqliteRepository(db);
  const entityId = "char:player-1";
  const connId = "conn-1";
  const playerId = "00000000-0000-0000-0000-000000000001";
  const character: SimEntity = {
    id: entityId,
    kind: "character",
    playerId,
    callsign: "TESTER",
    classId: null,
    hull: 0,
    shields: 0,
    targetId: null,
    pos: { ...characterPos },
    vel: { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    regime: "surface",
    originPlanetId: null,
    onPad: "pad-test",
  };
  const conn: ShardConnection = {
    connId,
    callsign: "TESTER",
    playerId,
    shipId: "ship-1",
    entityId,
    lastSeq: 0,
    pendingInput: null,
    staleDrops: 0,
  };
  const entities = new Map<string, SimEntity>();
  entities.set(entityId, character);
  const connections = new Map<string, ShardConnection>();
  connections.set(connId, conn);

  // We cast the minimal object to `Shard` via `unknown`; only the
  // methods the inventory handlers touch are populated. The
  // remaining `Shard` fields exist on the type but are unused.
  const shard = {
    systemId: "sys-1",
    connections,
    entities,
    send: () => undefined,
    broadcast: () => undefined,
    sim: { currentTick: 1 },
    events: new EventEmitter(),
    chatLog: new ChatRingBuffer(),
    persist: {},
    generation: 1,
    stats: () => ({}) as unknown,
    shutdown: () => undefined,
    context: {} as unknown,
    dirtyShipSpawns: new Map(),
    onTickObserver: null,
  } as unknown as Shard;
  return { shard, conn, character, repo, closeDb: close };
}

async function makePlayer(repo: Repository): Promise<{ id: string }> {
  const created = await repo.createPlayer({
    callsign: "TESTER",
    homeSystemId: "system-1",
  });
  return { id: created.id };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handlePickup", () => {
  let fixture: Fixture | null = null;

  beforeEach(async () => {
    fixture = makeFixture({ x: 0, y: 0, z: 0 });
    const player = await makePlayer(fixture.repo);
    // Update the connection's playerId via the cast (Conn isn't
    // part of the public ConnectionRecord but we stretch here).
    (fixture.conn as unknown as { playerId: string }).playerId = player.id;
  });

  afterEach(() => {
    fixture?.closeDb();
    fixture = null;
  });

  it("removes the entity on a full pickup and adds the resources to the inventory", async () => {
    const { shard, conn, repo } = fixture!;
    const depositId = "deposit-1";
    const deposit: SimEntity = {
      id: depositId,
      kind: "deposit",
      playerId: null,
      callsign: null,
      classId: null,
      hull: 0,
      shields: 0,
      targetId: null,
      pos: { x: 1, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: "surface",
      originPlanetId: null,
      onPad: null,
      resourceType: "iron",
      amount: 10,
    };
    shard.entities.set(depositId, deposit);

    const result = await handlePickup(shard, repo, {
      connId: conn.connId,
      targetId: depositId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.taken).toBe(10);
    expect(result.remaining).toBe(0);
    expect(result.consumedSource).toBe(true);
    expect(result.inventory.weightUsed).toBe(10);
    expect(result.inventory.stacks.iron).toBe(10);

    // Entity removed from the shard (next snapshot won't include it).
    expect(shard.entities.has(depositId)).toBe(false);
  });

  it("leaves the entity in the world on a partial pickup at the cap boundary", async () => {
    const { shard, conn, repo } = fixture!;
    // Pre-fill the inventory to 30/40 used.
    const starting = addToInventory(emptyInventory(), "iron", 30);
    await repo.saveInventory(conn.playerId, starting.inventory);

    // The deposit holds 100 iron; only 10 should fit (remaining 90 stay).
    const depositId = "deposit-partial";
    shard.entities.set(depositId, {
      id: depositId,
      kind: "deposit",
      playerId: null,
      callsign: null,
      classId: null,
      hull: 0,
      shields: 0,
      targetId: null,
      pos: { x: 1, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: "surface",
      originPlanetId: null,
      onPad: null,
      resourceType: "iron",
      amount: 100,
    });

    const result = await handlePickup(shard, repo, {
      connId: conn.connId,
      targetId: depositId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.taken).toBe(10);
    expect(result.remaining).toBe(90);
    expect(result.inventory.weightUsed).toBe(40);
    // Entity stays — its amount now reads 90.
    expect(shard.entities.has(depositId)).toBe(true);
    expect((shard.entities.get(depositId) as SimEntity).amount).toBe(90);
  });

  it("rejects with overflow when the inventory is already full", async () => {
    const { shard, conn, repo } = fixture!;
    await repo.saveInventory(conn.playerId, addToInventory(emptyInventory(), "iron", 40).inventory);
    shard.entities.set("deposit-full", {
      id: "deposit-full",
      kind: "deposit",
      playerId: null,
      callsign: null,
      classId: null,
      hull: 0,
      shields: 0,
      targetId: null,
      pos: { x: 1, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: "surface",
      originPlanetId: null,
      onPad: null,
      resourceType: "iron",
      amount: 5,
    });
    const result = await handlePickup(shard, repo, {
      connId: conn.connId,
      targetId: "deposit-full",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("overflow");
  });

  it("rejects out-of-range when the deposit is >3 m away", async () => {
    const { shard, conn, repo } = fixture!;
    shard.entities.set("deposit-far", {
      id: "deposit-far",
      kind: "deposit",
      playerId: null,
      callsign: null,
      classId: null,
      hull: 0,
      shields: 0,
      targetId: null,
      pos: { x: 10, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: "surface",
      originPlanetId: null,
      onPad: null,
      resourceType: "iron",
      amount: 5,
    });
    const result = await handlePickup(shard, repo, {
      connId: conn.connId,
      targetId: "deposit-far",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("out-of-range");
  });

  it("rejects when the connection is not on foot (kind !== character)", async () => {
    const { shard, conn, repo } = fixture!;
    const shipEntity: SimEntity = {
      id: "ship-1",
      kind: "player",
      playerId: conn.playerId,
      callsign: "TESTER",
      classId: "scout",
      hull: 100,
      shields: 100,
      targetId: null,
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: "space",
      originPlanetId: null,
      onPad: null,
    };
    shard.entities.set(shipEntity.id, shipEntity);
    conn.entityId = "ship-1";
    shard.entities.set("deposit-x", {
      id: "deposit-x",
      kind: "deposit",
      playerId: null,
      callsign: null,
      classId: null,
      hull: 0,
      shields: 0,
      targetId: null,
      pos: { x: 1, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: "surface",
      originPlanetId: null,
      onPad: null,
      resourceType: "iron",
      amount: 3,
    });
    const result = await handlePickup(shard, repo, {
      connId: conn.connId,
      targetId: "deposit-x",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("wrong-regime");
  });

  it("rejects unknown resource types on the entity", async () => {
    const { shard, conn, repo } = fixture!;
    shard.entities.set("deposit-bad", {
      id: "deposit-bad",
      kind: "deposit",
      playerId: null,
      callsign: null,
      classId: null,
      hull: 0,
      shields: 0,
      targetId: null,
      pos: { x: 1, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: "surface",
      originPlanetId: null,
      onPad: null,
      resourceType: "banana",
      amount: 5,
    });
    const result = await handlePickup(shard, repo, {
      connId: conn.connId,
      targetId: "deposit-bad",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("unknown-resource");
  });

  it("rejects missing target as not-found", async () => {
    const { shard, conn, repo } = fixture!;
    const result = await handlePickup(shard, repo, {
      connId: conn.connId,
      targetId: "no-such-id",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("not-found");
  });
});

describe("handleDrop + pickup round-trip", () => {
  let fixture: Fixture | null = null;

  beforeEach(async () => {
    fixture = makeFixture({ x: 5, y: 0, z: 7 });
    const player = await makePlayer(fixture.repo);
    (fixture.conn as unknown as { playerId: string }).playerId = player.id;
  });

  afterEach(() => {
    fixture?.closeDb();
    fixture = null;
  });

  it("spawns a ground item entity at the character position and persists the inventory delta", async () => {
    const { shard, conn, repo } = fixture!;
    // Carry 5 iron + 4 crystal.
    await repo.saveInventory(
      conn.playerId,
      addToInventory(addToInventory(emptyInventory(), "iron", 5).inventory, "crystal", 4).inventory,
    );

    const drop = await handleDrop(shard, repo, {
      connId: conn.connId,
      resourceType: "iron",
      amount: 3,
    });
    expect(drop.ok).toBe(true);
    if (!drop.ok) throw new Error("unreachable");
    expect(drop.dropped).toBe(3);
    expect(drop.inventory.stacks.iron).toBe(2);

    const groundItem = shard.entities.get(drop.groundItemId);
    expect(groundItem?.kind).toBe("groundItem");
    expect((groundItem as SimEntity).resourceType).toBe("iron");
    expect((groundItem as SimEntity).amount).toBe(3);
    expect((groundItem as SimEntity).pos.x).toBe(5);
    expect((groundItem as SimEntity).pos.z).toBe(7);

    // Persisted across the DB.
    const reloaded = await repo.getInventory(conn.playerId);
    expect(reloaded.stacks.iron).toBe(2);
  });

  it("rejects drop > owned and leaves the inventory untouched", async () => {
    const { shard, conn, repo } = fixture!;
    const sizeBefore = shard.entities.size;
    await repo.saveInventory(conn.playerId, addToInventory(emptyInventory(), "iron", 4).inventory);
    const result = await handleDrop(shard, repo, {
      connId: conn.connId,
      resourceType: "iron",
      amount: 10,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("insufficient-amount");
    // No ground item entity was added to the shard.
    expect(shard.entities.size).toBe(sizeBefore);
  });

  it("rejects unknown resource types as unknown-resource", async () => {
    const { shard, conn, repo } = fixture!;
    const result = await handleDrop(shard, repo, {
      connId: conn.connId,
      resourceType: "banana",
      amount: 3,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("unknown-resource");
  });

  it("round-trip: drop 3 iron then re-pickup yields the original inventory", async () => {
    const { shard, conn, repo } = fixture!;
    await repo.saveInventory(conn.playerId, addToInventory(emptyInventory(), "iron", 5).inventory);
    // Walk to the entity after dropping so it is in range.
    const drop = await handleDrop(shard, repo, {
      connId: conn.connId,
      resourceType: "iron",
      amount: 3,
    });
    expect(drop.ok).toBe(true);
    if (!drop.ok) throw new Error("unreachable");

    // Move the character next to the dropped item (it sits on
    // the character pos from the drop).
    const groundId = drop.groundItemId;
    const groundItem = shard.entities.get(groundId);
    expect(groundItem).toBeDefined();
    shard.entities.get(conn.entityId!)!.pos = { ...groundItem!.pos };

    const pickup = await handlePickup(shard, repo, {
      connId: conn.connId,
      targetId: groundId,
    });
    expect(pickup.ok).toBe(true);
    if (!pickup.ok) throw new Error("unreachable");
    expect(pickup.taken).toBe(3);
    expect(pickup.remaining).toBe(0);
    expect(pickup.inventory.stacks.iron).toBe(5);
    expect(pickup.inventory.weightUsed).toBe(5);

    // Ground item removed after a full pickup.
    expect(shard.entities.has(groundId)).toBe(false);
  });

  it("rejects wrong-regime when the player is bound to a ship, not a character", async () => {
    const { shard, conn, repo } = fixture!;
    conn.entityId = "ship-1";
    shard.entities.set("ship-1", {
      id: "ship-1",
      kind: "player",
      playerId: conn.playerId,
      callsign: "TESTER",
      classId: "scout",
      hull: 100,
      shields: 100,
      targetId: null,
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: "space",
      originPlanetId: null,
      onPad: null,
    });
    await repo.saveInventory(conn.playerId, addToInventory(emptyInventory(), "iron", 5).inventory);
    const result = await handleDrop(shard, repo, {
      connId: conn.connId,
      resourceType: "iron",
      amount: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("wrong-regime");
  });
});

describe("ground-item TTL", () => {
  it("cleanupExpiredGroundItems removes entities whose expiresAtMs has passed", () => {
    const entities = new Map<string, SimEntity>();
    entities.set("fresh", {
      id: "fresh",
      kind: "groundItem",
      playerId: null,
      callsign: null,
      classId: null,
      hull: 0,
      shields: 0,
      targetId: null,
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: "surface",
      originPlanetId: null,
      onPad: null,
      resourceType: "iron",
      amount: 1,
      expiresAtMs: 1000,
    });
    entities.set("expired", {
      id: "expired",
      kind: "groundItem",
      playerId: null,
      callsign: null,
      classId: null,
      hull: 0,
      shields: 0,
      targetId: null,
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: "surface",
      originPlanetId: null,
      onPad: null,
      resourceType: "iron",
      amount: 1,
      expiresAtMs: 500,
    });
    entities.set("deposit", {
      id: "deposit",
      kind: "deposit",
      playerId: null,
      callsign: null,
      classId: null,
      hull: 0,
      shields: 0,
      targetId: null,
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: "surface",
      originPlanetId: null,
      onPad: null,
      resourceType: "iron",
      amount: 1,
    });

    const shard = { entities } as unknown as Shard;
    const removed = cleanupExpiredGroundItems(shard, 750);
    expect(removed).toBe(1);
    expect(entities.has("fresh")).toBe(true);
    expect(entities.has("expired")).toBe(false);
    // Deposits are never touched by the cleanup loop.
    expect(entities.has("deposit")).toBe(true);
  });
});

describe("makeGroundItemId / makeGroundItemEntity", () => {
  it("ids are stable per (player, resource, spawnMs)", () => {
    const id1 = makeGroundItemId("player-1", "iron", 123);
    expect(id1).toBe("ground:player-1:iron:123");
    expect(makeGroundItemId("player-1", "iron", 123)).toBe(id1);
  });

  it("entities carry resourceType + amount + expiresAtMs", () => {
    const entity = makeGroundItemEntity({
      id: "ground:1",
      pos: { x: 1, y: 0, z: 2 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      resourceType: "crystal",
      amount: 5,
      spawnedAtMs: 100,
    });
    expect(entity.kind).toBe("groundItem");
    expect(entity.resourceType).toBe("crystal");
    expect(entity.amount).toBe(5);
    expect(entity.expiresAtMs).toBe(100 + GROUND_ITEM_TTL_MS);
  });
});

describe("persistence survives a simulated restart", () => {
  it("saveInventory → getInventory round-trips on the same connection (the hot path)", async () => {
    const { db, close } = createSqliteTestDb();
    const repo = createSqliteRepository(db);
    const player = await repo.createPlayer({
      callsign: "ROUND",
      homeSystemId: "system-1",
    });
    const target = addToInventory(
      addToInventory(emptyInventory(), "iron", 7).inventory,
      "crystal",
      3,
    ).inventory;
    await repo.saveInventory(player.id, target);
    // Re-read through `findPlayerById` — exercises the same
    // SELECT path the loader uses on server boot.
    const reloaded = await repo.findPlayerById(player.id);
    expect(reloaded?.inventory).toEqual(target);
    close();
  });
});
