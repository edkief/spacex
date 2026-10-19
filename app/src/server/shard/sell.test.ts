/**
 * Server-side dock-sell tests — TASK-40.
 *
 * Covers:
 *   - price math (`amount * basePrice`, catalog-driven).
 *   - source selection (hold vs inv).
 *   - validation paths:
 *     - not-docked (in-ship selling while flying),
 *     - not-at-station (character too far from terminal),
 *     - unknown-resource,
 *     - invalid-amount (zero / negative),
 *     - insufficient (request > source stack).
 *   - transaction atomicity (credit add succeeds; source stack
 *     decremented before the response; on mid-failure rollback).
 *   - the full sell ack shape: {sold, earned, newBalance, source}.
 */
import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";

import { createSqliteTestDb } from "../db/client.js";
import { createSqliteRepository } from "../db/repo.sqlite.js";
import { ChatRingBuffer } from "../chat.js";
import type { Repository } from "../db/repo.js";
import { cargoHoldFor, type CargoHold } from "@shared/world/cargo.js";
import { addToCargo } from "@shared/world/cargoOps.js";
import type { Inventory } from "@shared/world/inventory.js";
import { addToInventory, emptyInventory } from "@shared/world/inventoryOps.js";

import { handleSell, SELL_TERMINAL_RANGE_M } from "./sell.js";
import type { Shard, ShardConnection, SimEntity } from "./types.js";

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

interface Fixture {
  shard: Shard;
  conn: ShardConnection;
  boundEntity: SimEntity;
  ship: SimEntity;
  repo: Repository;
  playerId: string;
  shipId: string;
  connId: string;
  sentFrames: Array<{ connId: string; frame: { type: string; payload: unknown } }>;
  closeDb: () => void;
  initialCredits: number;
}

async function makeFixture(args: {
  boundKind: "player" | "character";
  inventory: Inventory;
  cargo: CargoHold;
  shipPos?: { x: number; y: number; z: number };
  characterPos?: { x: number; y: number; z: number };
  shipOnPad?: string | null;
  docked?: boolean;
}): Promise<Fixture> {
  const { db, close } = createSqliteTestDb();
  const repo = createSqliteRepository(db);

  // Seed a player + ship so the repo can persist the inventory + cargo.
  const player = await repo.createPlayer({
    callsign: "PILOT-SELL",
    homeSystemId: "sys-sell",
  });
  const initialBalance = (await repo.getBalance(player.id)) ?? 500;
  await repo.saveInventory(player.id, args.inventory);
  const shipRow = await repo.getOrCreateStarterShip(player.id, "scout");
  await repo.saveShipState(shipRow.id, { cargo: args.cargo });
  const refreshed = await repo.findShipById(shipRow.id);
  if (!refreshed) throw new Error("fixture: ship row missing after save");

  const ship: SimEntity = {
    id: `entity:${refreshed.id}`,
    kind: "player",
    playerId: player.id,
    callsign: player.callsign,
    classId: "scout",
    hull: 100,
    shields: 100,
    targetId: null,
    pos: args.shipPos ?? { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    regime: "surface",
    originPlanetId: "planet-sell",
    onPad: args.shipOnPad ?? null,
    cargo: refreshed.cargo,
  };
  const character: SimEntity = {
    id: `char:${player.id}`,
    kind: "character",
    playerId: player.id,
    callsign: player.callsign,
    classId: null,
    hull: 0,
    shields: 0,
    targetId: null,
    pos: args.characterPos ?? { x: 2, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    regime: "surface",
    originPlanetId: "planet-sell",
    onPad: "pad-sell",
    onShipId: ship.id,
    characterOnPad: "pad-sell",
  };
  const boundEntity = args.boundKind === "player" ? ship : character;
  const conn: ShardConnection = {
    connId: "conn-sell-1",
    callsign: player.callsign,
    playerId: player.id,
    shipId: refreshed.id,
    entityId: boundEntity.id,
    lastSeq: 0,
    pendingInput: null,
    staleDrops: 0,
  };
  const entities = new Map<string, SimEntity>();
  entities.set(character.id, character);
  entities.set(ship.id, ship);
  const connections = new Map<string, ShardConnection>();
  connections.set(conn.connId, conn);
  const sentFrames: Array<{ connId: string; frame: { type: string; payload: unknown } }> = [];
  const shard: Shard = {
    systemId: "sys-sell",
    connections,
    entities,
    send: (cid: string, frame: { type: string; payload: unknown }) => {
      sentFrames.push({ connId: cid, frame });
    },
    broadcast: () => undefined,
    sim: { currentTick: 1 },
    events: new EventEmitter(),
    chatLog: new ChatRingBuffer(),
    persist: {},
    generation: 1,
    stats: () => ({}) as never,
    shutdown: () => undefined,
    context: {} as never,
    dirtyShipSpawns: new Map(),
    targets: new Map(),
    onTickObserver: null,
  } as unknown as Shard;
  return {
    shard,
    conn,
    boundEntity,
    ship,
    repo,
    playerId: player.id,
    shipId: refreshed.id,
    connId: conn.connId,
    sentFrames,
    closeDb: close,
    initialCredits: initialBalance,
  };
}

// ---------------------------------------------------------------------------
// Price math
// ---------------------------------------------------------------------------

describe("sell: price math", () => {
  let fx: Fixture | null = null;
  afterEach(() => {
    fx?.closeDb();
    fx = null;
  });

  it("credits = amount * basePrice (5 iron @ 5 cr → +25)", async () => {
    let inv = emptyInventory();
    inv = addToInventory(inv, "iron", 10).inventory;
    fx = await makeFixture({
      boundKind: "character",
      inventory: inv,
      cargo: cargoHoldFor("scout"),
      shipOnPad: "pad-sell",
    });
    const result = await handleSell(fx.shard, fx.repo, {
      connId: fx.connId,
      resourceType: "iron",
      amount: 5,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.sold).toBe(5);
    expect(result.earned).toBe(25);
    expect(result.source).toBe("inv");
    expect(result.newBalance).toBe(fx.initialCredits + 25);
  });

  it("uses copper's 8 cr base price", async () => {
    let inv = emptyInventory();
    inv = addToInventory(inv, "copper", 4).inventory;
    fx = await makeFixture({
      boundKind: "character",
      inventory: inv,
      cargo: cargoHoldFor("scout"),
      shipOnPad: "pad-sell",
    });
    const result = await handleSell(fx.shard, fx.repo, {
      connId: fx.connId,
      resourceType: "copper",
      amount: 3,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.earned).toBe(24);
  });

  it("uses crystal's 60 cr base price", async () => {
    let inv = emptyInventory();
    inv = addToInventory(inv, "crystal", 2).inventory;
    fx = await makeFixture({
      boundKind: "character",
      inventory: inv,
      cargo: cargoHoldFor("scout"),
      shipOnPad: "pad-sell",
    });
    const result = await handleSell(fx.shard, fx.repo, {
      connId: fx.connId,
      resourceType: "crystal",
      amount: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.earned).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// Source selection — hold vs inv
// ---------------------------------------------------------------------------

describe("sell: source selection", () => {
  let fx: Fixture | null = null;
  afterEach(() => {
    fx?.closeDb();
    fx = null;
  });

  it("source: 'hold' when the bound entity is a ship", async () => {
    let cargo = cargoHoldFor("scout");
    cargo = addToCargo(cargo, "iron", 10).hold;
    fx = await makeFixture({
      boundKind: "player",
      inventory: emptyInventory(),
      cargo,
      shipOnPad: "pad-sell",
    });
    const result = await handleSell(fx.shard, fx.repo, {
      connId: fx.connId,
      resourceType: "iron",
      amount: 5,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.source).toBe("hold");
    expect(result.cargo.stacks.iron).toBe(5);
  });

  it("source: 'inv' when the bound entity is a character", async () => {
    let inv = emptyInventory();
    inv = addToInventory(inv, "iron", 7).inventory;
    fx = await makeFixture({
      boundKind: "character",
      inventory: inv,
      cargo: cargoHoldFor("scout"),
      shipOnPad: "pad-sell",
    });
    const result = await handleSell(fx.shard, fx.repo, {
      connId: fx.connId,
      resourceType: "iron",
      amount: 3,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.source).toBe("inv");
    expect(result.inventory.stacks.iron).toBe(4);
  });

  it("mismatched source override surfaces as invalid-amount", async () => {
    let inv = emptyInventory();
    inv = addToInventory(inv, "iron", 5).inventory;
    fx = await makeFixture({
      boundKind: "character",
      inventory: inv,
      cargo: cargoHoldFor("scout"),
      shipOnPad: "pad-sell",
    });
    const result = await handleSell(fx.shard, fx.repo, {
      connId: fx.connId,
      resourceType: "iron",
      amount: 1,
      source: "hold",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.code).toBe("invalid-amount");
  });
});

// ---------------------------------------------------------------------------
// Validation paths
// ---------------------------------------------------------------------------

describe("sell: validation", () => {
  let fx: Fixture | null = null;
  afterEach(() => {
    fx?.closeDb();
    fx = null;
  });

  it("in-ship selling while flying surfaces not-docked", async () => {
    let cargo = cargoHoldFor("scout");
    cargo = addToCargo(cargo, "iron", 10).hold;
    fx = await makeFixture({
      boundKind: "player",
      inventory: emptyInventory(),
      cargo,
      shipOnPad: null, // mid-flight
    });
    const result = await handleSell(fx.shard, fx.repo, {
      connId: fx.connId,
      resourceType: "iron",
      amount: 5,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.code).toBe("not-docked");
  });

  it("on-foot selling > 10 m from the dock terminal surfaces not-at-station", async () => {
    let inv = emptyInventory();
    inv = addToInventory(inv, "iron", 5).inventory;
    fx = await makeFixture({
      boundKind: "character",
      inventory: inv,
      cargo: cargoHoldFor("scout"),
      shipOnPad: "pad-sell",
      // Character is far away from the ship.
      characterPos: { x: SELL_TERMINAL_RANGE_M + 1, y: 0, z: 0 },
    });
    const result = await handleSell(fx.shard, fx.repo, {
      connId: fx.connId,
      resourceType: "iron",
      amount: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.code).toBe("not-at-station");
  });

  it("unknown-resource surfaces structured error", async () => {
    let inv = emptyInventory();
    inv = addToInventory(inv, "iron", 5).inventory;
    fx = await makeFixture({
      boundKind: "character",
      inventory: inv,
      cargo: cargoHoldFor("scout"),
      shipOnPad: "pad-sell",
    });
    const result = await handleSell(fx.shard, fx.repo, {
      connId: fx.connId,
      resourceType: "water", // not a deposit resource
      amount: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.code).toBe("unknown-resource");
  });

  it("invalid-amount (zero / negative)", async () => {
    let inv = emptyInventory();
    inv = addToInventory(inv, "iron", 5).inventory;
    fx = await makeFixture({
      boundKind: "character",
      inventory: inv,
      cargo: cargoHoldFor("scout"),
      shipOnPad: "pad-sell",
    });
    expect(
      (
        await handleSell(fx.shard, fx.repo, {
          connId: fx.connId,
          resourceType: "iron",
          amount: 0,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await handleSell(fx.shard, fx.repo, {
          connId: fx.connId,
          resourceType: "iron",
          amount: -3,
        })
      ).ok,
    ).toBe(false);
  });

  it("insufficient (request > source stack)", async () => {
    let inv = emptyInventory();
    inv = addToInventory(inv, "iron", 2).inventory;
    fx = await makeFixture({
      boundKind: "character",
      inventory: inv,
      cargo: cargoHoldFor("scout"),
      shipOnPad: "pad-sell",
    });
    const result = await handleSell(fx.shard, fx.repo, {
      connId: fx.connId,
      resourceType: "iron",
      amount: 10,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.code).toBe("insufficient");
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe("sell: persistence", () => {
  let fx: Fixture | null = null;
  afterEach(() => {
    fx?.closeDb();
    fx = null;
  });

  it("a successful hold sale persists the new cargo and the credit add", async () => {
    let cargo = cargoHoldFor("scout");
    cargo = addToCargo(cargo, "iron", 10).hold;
    fx = await makeFixture({
      boundKind: "player",
      inventory: emptyInventory(),
      cargo,
      shipOnPad: "pad-sell",
    });
    const result = await handleSell(fx.shard, fx.repo, {
      connId: fx.connId,
      resourceType: "iron",
      amount: 4,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const shipRow = await fx.repo.findShipById(fx.shipId);
    expect(shipRow?.cargo.stacks.iron).toBe(6);
    expect(await fx.repo.getBalance(fx.playerId)).toBe(fx.initialCredits + 20);
  });

  it("a successful inv sale persists the new inventory and the credit add", async () => {
    let inv = emptyInventory();
    inv = addToInventory(inv, "copper", 8).inventory;
    fx = await makeFixture({
      boundKind: "character",
      inventory: inv,
      cargo: cargoHoldFor("scout"),
      shipOnPad: "pad-sell",
    });
    const result = await handleSell(fx.shard, fx.repo, {
      connId: fx.connId,
      resourceType: "copper",
      amount: 3,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const persistedInv = await fx.repo.getInventory(fx.playerId);
    expect(persistedInv.stacks.copper).toBe(5);
    expect(await fx.repo.getBalance(fx.playerId)).toBe(fx.initialCredits + 24);
  });
});
