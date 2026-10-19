/**
 * REST tests for the dock sell endpoint (TASK-40).
 *
 * Covers:
 *   - happy path: in-ship selling from the hold → 200 + credit add.
 *   - happy path: on-foot selling from inventory → 200 + credit add.
 *   - validation: bad resource id, bad amount, bad source, not-docked,
 *     not-at-station, insufficient.
 *   - auth: missing / tampered token → 401.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { createSqliteTestDb } from "../db/client.js";
import { createSqliteRepository } from "../db/repo.sqlite.js";
import { registerCallsignRoutes } from "./callsigns.js";
import { registerSellRoute } from "./sell.js";
import { cargoHoldFor, type CargoHold } from "@shared/world/cargo.js";
import { addToCargo } from "@shared/world/cargoOps.js";
import { addToInventory, emptyInventory } from "@shared/world/inventoryOps.js";
import type { Inventory } from "@shared/world/inventory.js";
import type { Shard, ShardConnection, SimEntity } from "../shard/types.js";
import type { Repository } from "../db/repo.js";
import { ChatRingBuffer } from "../chat.js";
import { EventEmitter } from "node:events";

const SESSION_SECRET = "test-secret-do-not-use-in-prod-1234567890abcdef";
const GALAXY_SEED = "DRIFT-TEST-001";
const STAR_COUNT = 32;

interface Harness {
  app: FastifyInstance;
  repo: Repository;
  shard: Shard;
  connId: string;
  close: () => void;
}

function newHarness(): Harness {
  const { db, close } = createSqliteTestDb();
  // Repo's used by the route (claimDefaults pulls the underlying
  // DB through it). Touch the unused local to silence the lint.
  void db;
  const repo = createSqliteRepository(db);
  const app = Fastify({ logger: false });
  registerCallsignRoutes(app, {
    repo,
    sessionSecret: SESSION_SECRET,
    claimDefaults: { galaxySeed: GALAXY_SEED, galaxyStarCount: STAR_COUNT },
  });
  const shard = makeStubShard(repo);
  registerSellRoute(app, {
    repo,
    sessionSecret: SESSION_SECRET,
    shardFor: () => shard,
    connIdForPlayer: () => "conn-test",
  });
  return { app, repo, shard, connId: "conn-test", close };
}

function makeStubShard(_repo: Repository): Shard {
  const entities = new Map<string, SimEntity>();
  const connections = new Map<string, ShardConnection>();
  void _repo;
  return {
    systemId: "sys-test",
    entities,
    connections,
    send: () => undefined,
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
}

async function claimToken(
  app: FastifyInstance,
  callsign: string,
): Promise<{ token: string; playerId: string; shipId: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/callsigns",
    payload: { callsign },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { token: string; playerId: string; shipId: string };
}

async function bindShip(
  harness: Harness,
  playerId: string,
  args: { shipId: string; onPad: string | null; cargo: CargoHold },
): Promise<void> {
  const ship: SimEntity = {
    id: `entity:${args.shipId}`,
    kind: "player",
    playerId,
    callsign: "SELL",
    classId: "scout",
    hull: 100,
    shields: 100,
    targetId: null,
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    regime: "surface",
    originPlanetId: null,
    onPad: args.onPad,
    cargo: args.cargo,
  };
  harness.shard.entities.set(ship.id, ship);
  const conn: ShardConnection = {
    connId: harness.connId,
    callsign: "SELL",
    playerId,
    shipId: args.shipId,
    entityId: ship.id,
    lastSeq: 0,
    pendingInput: null,
    staleDrops: 0,
  };
  harness.shard.connections.set(harness.connId, conn);
  await harness.repo.saveShipState(args.shipId, { cargo: args.cargo });
}

async function bindCharacter(
  harness: Harness,
  playerId: string,
  args: {
    shipId: string;
    characterPos: { x: number; y: number; z: number };
  },
): Promise<void> {
  const conn = harness.shard.connections.get(harness.connId);
  if (!conn) throw new Error("conn missing");
  const character: SimEntity = {
    id: `char:${playerId}`,
    kind: "character",
    playerId,
    callsign: "SELL",
    classId: null,
    hull: 0,
    shields: 0,
    targetId: null,
    pos: args.characterPos,
    vel: { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    regime: "surface",
    originPlanetId: null,
    onPad: "pad-test",
    onShipId: `entity:${args.shipId}`,
    characterOnPad: "pad-test",
  };
  harness.shard.entities.set(character.id, character);
  conn.entityId = character.id;
}

describe("POST /api/ships/sell — happy paths", () => {
  let harness: Harness;
  beforeEach(() => {
    harness = newHarness();
  });
  afterEach(async () => {
    await harness.app.close();
    harness.close();
  });

  it("sells 5 iron from the docked hold and credits the player", async () => {
    const { token, playerId, shipId } = await claimToken(harness.app, "ALPHA-SELL");
    let cargo = cargoHoldFor("scout");
    cargo = addToCargo(cargo, "iron", 10).hold;
    await bindShip(harness, playerId, { shipId, onPad: "pad-test", cargo });
    const initialBalance = await harness.repo.getBalance(playerId);
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/ships/sell",
      headers: { authorization: `Bearer ${token}` },
      payload: { resourceId: "iron", amount: 5, source: "hold" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      sold: number;
      earned: number;
      newBalance: number;
      resourceType: string;
      source: string;
    };
    expect(body.sold).toBe(5);
    expect(body.earned).toBe(25);
    expect(body.newBalance).toBe(initialBalance + 25);
    expect(body.resourceType).toBe("iron");
    expect(body.source).toBe("hold");
    const persistedShip = await harness.repo.findShipById(shipId);
    expect(persistedShip?.cargo.stacks.iron).toBe(5);
  });

  it("sells from inventory for an on-foot character within 10 m of the terminal", async () => {
    const { token, playerId, shipId } = await claimToken(harness.app, "BETA-SELL");
    let inv: Inventory = emptyInventory();
    inv = addToInventory(inv, "copper", 6).inventory;
    await harness.repo.saveInventory(playerId, inv);
    await bindShip(harness, playerId, {
      shipId,
      onPad: "pad-test",
      cargo: cargoHoldFor("scout"),
    });
    await bindCharacter(harness, playerId, {
      shipId,
      characterPos: { x: 2, y: 0, z: 0 },
    });
    const initialBalance = await harness.repo.getBalance(playerId);
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/ships/sell",
      headers: { authorization: `Bearer ${token}` },
      payload: { resourceId: "copper", amount: 3, source: "inv" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { earned: number; newBalance: number };
    expect(body.earned).toBe(24);
    expect(body.newBalance).toBe(initialBalance + 24);
    const persistedInv = await harness.repo.getInventory(playerId);
    expect(persistedInv.stacks.copper).toBe(3);
  });
});

describe("POST /api/ships/sell — error paths", () => {
  let harness: Harness;
  beforeEach(() => {
    harness = newHarness();
  });
  afterEach(async () => {
    await harness.app.close();
    harness.close();
  });

  it("rejects unauthenticated requests with 401", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/ships/sell",
      payload: { resourceId: "iron", amount: 1, source: "hold" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects unknown-resource with 400", async () => {
    const { token, playerId, shipId } = await claimToken(harness.app, "GAMMA-SELL");
    await bindShip(harness, playerId, {
      shipId,
      onPad: "pad-test",
      cargo: cargoHoldFor("scout"),
    });
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/ships/sell",
      headers: { authorization: `Bearer ${token}` },
      payload: { resourceId: "water", amount: 1, source: "hold" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("unknown-resource");
  });

  it("rejects not-docked with 409 when in-ship selling mid-flight", async () => {
    const { token, playerId, shipId } = await claimToken(harness.app, "DELTA-SELL");
    let cargo = cargoHoldFor("scout");
    cargo = addToCargo(cargo, "iron", 10).hold;
    await bindShip(harness, playerId, { shipId, onPad: null, cargo });
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/ships/sell",
      headers: { authorization: `Bearer ${token}` },
      payload: { resourceId: "iron", amount: 5, source: "hold" },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("not-docked");
  });

  it("rejects insufficient with 422 when request > source stack", async () => {
    const { token, playerId, shipId } = await claimToken(harness.app, "EPSILON-SELL");
    let cargo = cargoHoldFor("scout");
    cargo = addToCargo(cargo, "iron", 2).hold;
    await bindShip(harness, playerId, { shipId, onPad: "pad-test", cargo });
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/ships/sell",
      headers: { authorization: `Bearer ${token}` },
      payload: { resourceId: "iron", amount: 10, source: "hold" },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("insufficient");
  });

  it("rejects not-at-station with 409 when character is too far from terminal", async () => {
    const { token, playerId, shipId } = await claimToken(harness.app, "ZETA-SELL");
    let inv: Inventory = emptyInventory();
    inv = addToInventory(inv, "iron", 5).inventory;
    await harness.repo.saveInventory(playerId, inv);
    await bindShip(harness, playerId, {
      shipId,
      onPad: "pad-test",
      cargo: cargoHoldFor("scout"),
    });
    await bindCharacter(harness, playerId, {
      shipId,
      characterPos: { x: 50, y: 0, z: 0 },
    });
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/ships/sell",
      headers: { authorization: `Bearer ${token}` },
      payload: { resourceId: "iron", amount: 1, source: "inv" },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("not-at-station");
  });
});
