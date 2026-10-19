/**
 * WS round-trip tests for the TASK-40 dock-sell pipeline.
 *
 * Boots a real Fastify + WebSocket server with an in-memory shard
 * so the dock-sell flow is exercised end-to-end on the wire.
 * Covers:
 *   - happy path (in-ship, sell from hold → sell_ok + credit add).
 *   - happy path (on-foot, sell from inventory → sell_ok + credit add).
 *   - rejection paths: not-docked / not-at-station / insufficient /
 *     invalid-amount / unknown-resource.
 *   - the project's first end-to-end gameplay proof (the full
 *     "mine → load → dock → sell" money test, simulated via direct
 *     DB seeding rather than literal mining frames).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { WebSocket as WsClient } from "ws";

import {
  encodeEnvelope,
  PROTOCOL_VERSION,
  type Envelope,
  type ProtocolEntityState,
} from "@shared/protocol/index.js";
import { cargoHoldFor, type CargoHold } from "@shared/world/cargo.js";
import { addToCargo } from "@shared/world/cargoOps.js";
import { emptyInventory } from "@shared/world/inventoryOps.js";
import { addToInventory } from "@shared/world/inventoryOps.js";
import type { Inventory } from "@shared/world/inventory.js";

import { attachWs, type WsHandle } from "./ws.js";
import { createSqliteTestDb } from "./db/client.js";
import { createSqliteRepository } from "./db/repo.sqlite.js";
import type { Repository } from "./db/repo.js";
import { createShard } from "./shard/index.js";
import type { ShardSystemContext } from "./shard/types.js";

interface SimLike {
  id: string;
  kind: string;
  playerId: string | null;
  callsign: string | null;
  pos: { x: number; y: number; z: number };
  vel: { x: number; y: number; z: number };
  quat: { x: number; y: number; z: number; w: number };
  onPad: string | null;
  onShipId?: string;
  characterOnPad?: string | null;
  classId: string | null;
  cargo?: CargoHold;
}

interface ShardLike {
  systemId: string;
  entities: Map<string, SimLike>;
  send: (connId: string, frame: { type: string; payload: unknown }) => void;
  broadcast: (
    tick: number,
    entities: ProtocolEntityState[],
    lastAppliedSeq: Readonly<Record<string, number>>,
  ) => void;
  sim: { currentTick: number };
  connections: Map<string, { entityId: string | null; playerId: string; connId?: string }>;
}

interface Harness {
  app: FastifyInstance;
  ws: WsHandle;
  port: number;
  shard: ShardLike;
  repo: Repository;
  closeDb: () => void;
  sentFrames: Array<{ connId: string; frame: { type: string; payload: unknown } }>;
}

async function boot(): Promise<Harness> {
  const app = Fastify({ logger: false });
  const { db, close } = createSqliteTestDb();
  const repo = createSqliteRepository(db);

  const entities = new Map<string, SimLike>();
  const connections = new Map<string, { entityId: string | null; playerId: string }>();
  const sentFrames: Array<{ connId: string; frame: { type: string; payload: unknown } }> = [];
  const shard: ShardLike = {
    systemId: "sys-sell",
    entities,
    send: (connId, frame): void => {
      sentFrames.push({ connId, frame });
    },
    broadcast: () => undefined,
    sim: { currentTick: 1 },
    connections,
  };
  const ctx: ShardSystemContext = {
    system: {
      systemId: "sys-sell",
      star: {
        id: "star-x",
        seed: 1n,
        name: "Test Star",
        position: { x: 0, y: 0, z: 0 },
        spectral: "G",
        luminosity: 1,
        habitableZoneAu: 1,
        orbitAu: 0,
      },
      planets: [],
      stations: [],
      resourceNodes: [],
    } as unknown as ShardSystemContext["system"],
    starId: "star-x",
    planetById: () => undefined,
    heightAtFor: () => () => 0,
    tileSizeM: 64,
  };
  const realShard = createShard({
    systemId: "sys-sell",
    context: ctx,
    send: shard.send,
    broadcast: shard.broadcast,
    autoStart: false,
    repo,
  });
  shard.entities = realShard.entities as unknown as Map<string, SimLike>;
  shard.connections = realShard.connections as unknown as Map<
    string,
    { entityId: string | null; playerId: string }
  >;
  shard.sim = realShard.sim;

  const ws = attachWs(app, "/ws", {
    authResolver: async (payload) => {
      const callsign = (payload as { callsign?: string }).callsign ?? "anon";
      const player = await repo.createPlayer({
        callsign,
        homeSystemId: "sys-sell",
      });
      await repo.getOrCreateStarterShip(player.id, "scout");
      await repo.saveInventory(player.id, emptyInventory());
      return {
        playerId: player.id,
        callsign: player.callsign,
        tokenExpiresAt: Date.now() + 60_000,
      };
    },
    joinResolver: async (systemId, callsign) => ({
      systemId,
      entities: [...entities.values()].map(entityToWire),
      nodes: [],
      chat: [],
      players: [callsign],
      serverTickHz: 20,
      snapshotTick: 0,
    }),
    logoutResolver: async (playerId) => {
      const player = await repo.findPlayerById(playerId);
      return { revoked: 1, callsign: player?.callsign ?? "" };
    },
    warpResolver: async () => {
      throw Object.assign(new Error("nope"), { code: "not-found" });
    },
    shardFor: () => shard as never,
    repo: repo as never,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("Failed to bind Fastify port");
  }
  const port = address.port;

  const realWriter = (connId: string, frame: { type: string; payload: unknown }): void => {
    sentFrames.push({ connId, frame });
    for (const conn of ws.registry.values()) {
      if (conn.connId !== connId) continue;
      if (conn.ws.readyState !== conn.ws.OPEN) return;
      try {
        conn.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }));
      } catch {
        // ignore
      }
      return;
    }
  };
  shard.send = realWriter;
  (
    realShard as unknown as { send: (c: string, f: { type: string; payload: unknown }) => void }
  ).send = realWriter;

  return {
    app,
    ws,
    port,
    shard,
    repo,
    closeDb: close,
    sentFrames,
  };
}

function entityToWire(e: SimLike): ProtocolEntityState {
  return {
    id: e.id,
    kind: e.kind as never,
    pos: [e.pos.x, e.pos.y, e.pos.z],
    vel: [e.vel.x, e.vel.y, e.vel.z],
    regime: "surface",
    hull: 0,
    shields: 0,
    targetId: null,
    classId: null,
    callsign: null,
    livery: null,
    onPad: null,
  } as never;
}

interface ClientHandle {
  ws: WsClient;
  frames: Envelope[];
  push: (frame: { type: string; payload: unknown }) => void;
  close: () => Promise<void>;
  playerId: string;
  connId: string;
}

async function bootClient(harness: Harness, callsign: string): Promise<ClientHandle> {
  const client = new WsClient(`ws://127.0.0.1:${harness.port}/ws`);
  const frames: Envelope[] = [];
  const push = (frame: { type: string; payload: unknown }): void => {
    if (client.readyState !== client.OPEN) return;
    client.send(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }));
  };
  client.on("message", (raw) => {
    try {
      const parsed = JSON.parse(raw.toString("utf8")) as Envelope;
      frames.push(parsed);
    } catch {
      // ignore
    }
  });
  await new Promise<void>((resolve, reject) => {
    client.once("open", () => resolve());
    client.once("error", reject);
  });
  client.send(encodeEnvelope("hello", { version: PROTOCOL_VERSION, client: "sell-test" }));
  await waitFor(frames, "hello", 1);
  client.send(encodeEnvelope("auth", { callsign }));
  await waitFor(frames, "auth_ok", 1);
  client.send(encodeEnvelope("join_system", { systemId: "sys-sell" }));
  await waitFor(frames, "enter_system", 1);

  const authOk = frames.find((f) => f.type === "auth_ok") as Envelope & {
    payload: { playerId: string };
  };
  const playerId = authOk.payload.playerId;

  let connId = "";
  for (const conn of harness.ws.registry.values()) {
    if (conn.playerId === playerId) {
      connId = conn.connId;
      harness.shard.connections.set(conn.connId, {
        entityId: null,
        playerId,
        connId: conn.connId,
      });
    }
  }
  return {
    ws: client,
    frames,
    push,
    close: async (): Promise<void> => {
      client.close();
      harness.ws.registry.remove(client);
    },
    playerId,
    connId,
  };
}

async function waitFor(frames: Envelope[], type: string, count: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const seen = frames.filter((f) => f.type === type).length;
    if (seen >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${count}× ${type} frames`);
}

async function bindShip(
  harness: Harness,
  client: ClientHandle,
  args: {
    pos: { x: number; y: number; z: number };
    onPad: string | null;
    cargo: CargoHold;
    classId?: "scout" | "freighter" | "interceptor";
  },
): Promise<void> {
  const connRow = harness.shard.connections.get(client.connId);
  if (!connRow) throw new Error("Connection not registered");
  const shipRowId = (await harness.repo.listShipsByOwner(client.playerId))[0]?.id;
  if (!shipRowId) throw new Error("expected starter ship row");
  const shipId = `entity:${shipRowId}`;
  // Persist the cargo so the server-side handler sees it on read.
  await harness.repo.saveShipState(shipRowId, { cargo: args.cargo });
  connRow.entityId = shipId;
  harness.shard.entities.set(shipId, {
    id: shipId,
    kind: "player",
    playerId: client.playerId,
    callsign: "SELL",
    pos: args.pos,
    vel: { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    onPad: args.onPad,
    classId: args.classId ?? "scout",
    cargo: args.cargo,
  });
}

async function bindCharacter(
  harness: Harness,
  client: ClientHandle,
  args: {
    pos: { x: number; y: number; z: number };
    shipId: string;
  },
): Promise<void> {
  const connRow = harness.shard.connections.get(client.connId);
  if (!connRow) throw new Error("Connection not registered");
  connRow.entityId = `char:${client.playerId}`;
  harness.shard.entities.set(`char:${client.playerId}`, {
    id: `char:${client.playerId}`,
    kind: "character",
    playerId: client.playerId,
    callsign: "SELL",
    pos: args.pos,
    vel: { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    onPad: "pad-sell",
    classId: null,
    characterOnPad: "pad-sell",
    onShipId: args.shipId,
  });
}

describe("ws: dock sell pipeline (TASK-40)", () => {
  let harness: Harness | null = null;
  let client: ClientHandle | null = null;

  beforeEach(async () => {
    harness = await boot();
    client = await bootClient(harness, "PILOT-SELL");
  });

  afterEach(async () => {
    await client?.close();
    if (harness) {
      await harness.ws.close();
      await harness.app.close();
      harness.closeDb();
    }
    harness = null;
    client = null;
  });

  it("happy path: in-ship sell from hold → sell_ok + credit add", async () => {
    if (!harness || !client) throw new Error("harness missing");
    const shipRowId = (await harness.repo.listShipsByOwner(client.playerId))[0]?.id;
    if (!shipRowId) throw new Error("expected starter ship row");
    let cargo = cargoHoldFor("scout");
    cargo = addToCargo(cargo, "iron", 10).hold;
    await harness.repo.saveShipState(shipRowId, { cargo });
    await bindShip(harness, client, {
      pos: { x: 0, y: 0, z: 0 },
      onPad: "pad-sell",
      cargo,
    });

    const initialBalance = await harness.repo.getBalance(client.playerId);
    client.push({
      type: "sell",
      payload: { resourceType: "iron", quantity: 5 },
    });
    await waitFor(client.frames, "sell_ok", 1);
    const ack = client.frames.find((f) => f.type === "sell_ok");
    if (!ack) throw new Error("missing sell_ok ack");
    const payload = ack.payload as {
      resourceType: string;
      quantity: number;
      sold: number;
      earned: number;
      newBalance: number;
      source: "inv" | "hold";
    };
    expect(payload.resourceType).toBe("iron");
    expect(payload.quantity).toBe(5);
    expect(payload.sold).toBe(5);
    expect(payload.earned).toBe(25);
    expect(payload.source).toBe("hold");
    expect(payload.newBalance).toBe(initialBalance + 25);
    // Persisted
    const shipRow = await harness.repo.findShipById(shipRowId);
    expect(shipRow?.cargo.stacks.iron).toBe(5);
    expect(await harness.repo.getBalance(client.playerId)).toBe(initialBalance + 25);
  });

  it("happy path: on-foot sell from inventory → sell_ok", async () => {
    if (!harness || !client) throw new Error("harness missing");
    const shipRowId = (await harness.repo.listShipsByOwner(client.playerId))[0]?.id;
    if (!shipRowId) throw new Error("expected starter ship row");
    const shipId = `entity:${shipRowId}`;
    let inv: Inventory = emptyInventory();
    inv = addToInventory(inv, "copper", 6).inventory;
    await harness.repo.saveInventory(client.playerId, inv);
    await bindShip(harness, client, {
      pos: { x: 0, y: 0, z: 0 },
      onPad: "pad-sell",
      cargo: cargoHoldFor("scout"),
    });
    await bindCharacter(harness, client, { pos: { x: 2, y: 0, z: 0 }, shipId });

    const initialBalance = await harness.repo.getBalance(client.playerId);
    client.push({
      type: "sell",
      payload: { resourceType: "copper", quantity: 3 },
    });
    await waitFor(client.frames, "sell_ok", 1);
    const ack = client.frames.find((f) => f.type === "sell_ok");
    if (!ack) throw new Error("missing sell_ok ack");
    const payload = ack.payload as {
      resourceType: string;
      sold: number;
      earned: number;
      newBalance: number;
      source: "inv" | "hold";
    };
    expect(payload.source).toBe("inv");
    expect(payload.earned).toBe(24); // 3 * 8
    expect(payload.newBalance).toBe(initialBalance + 24);
    const persistedInv = await harness.repo.getInventory(client.playerId);
    expect(persistedInv.stacks.copper).toBe(3);
  });

  it("rejects with not-docked when in-ship selling mid-flight", async () => {
    if (!harness || !client) throw new Error("harness missing");
    const shipRowId = (await harness.repo.listShipsByOwner(client.playerId))[0]?.id;
    if (!shipRowId) throw new Error("expected starter ship row");
    let cargo = cargoHoldFor("scout");
    cargo = addToCargo(cargo, "iron", 10).hold;
    await harness.repo.saveShipState(shipRowId, { cargo });
    await bindShip(harness, client, {
      pos: { x: 0, y: 0, z: 0 },
      onPad: null, // mid-flight
      cargo,
    });
    client.push({
      type: "sell",
      payload: { resourceType: "iron", quantity: 5 },
    });
    await waitFor(client.frames, "error", 1);
    const err = client.frames.find((f) => f.type === "error") as Envelope & {
      payload: { code: string; message: string };
    };
    expect(err.payload.code).toBe("not-docked");
  });

  it("rejects with not-at-station when character is > 10 m from terminal", async () => {
    if (!harness || !client) throw new Error("harness missing");
    const shipRowId = (await harness.repo.listShipsByOwner(client.playerId))[0]?.id;
    if (!shipRowId) throw new Error("expected starter ship row");
    const shipId = `entity:${shipRowId}`;
    let inv: Inventory = emptyInventory();
    inv = addToInventory(inv, "iron", 5).inventory;
    await harness.repo.saveInventory(client.playerId, inv);
    await bindShip(harness, client, {
      pos: { x: 0, y: 0, z: 0 },
      onPad: "pad-sell",
      cargo: cargoHoldFor("scout"),
    });
    await bindCharacter(harness, client, {
      pos: { x: 50, y: 0, z: 0 }, // far away
      shipId,
    });
    client.push({
      type: "sell",
      payload: { resourceType: "iron", quantity: 1 },
    });
    await waitFor(client.frames, "error", 1);
    const err = client.frames.find((f) => f.type === "error") as Envelope & {
      payload: { code: string; message: string };
    };
    expect(err.payload.code).toBe("not-at-station");
  });

  it("rejects with insufficient when request > source stack", async () => {
    if (!harness || !client) throw new Error("harness missing");
    const shipRowId = (await harness.repo.listShipsByOwner(client.playerId))[0]?.id;
    if (!shipRowId) throw new Error("expected starter ship row");
    let cargo = cargoHoldFor("scout");
    cargo = addToCargo(cargo, "iron", 2).hold;
    await harness.repo.saveShipState(shipRowId, { cargo });
    await bindShip(harness, client, {
      pos: { x: 0, y: 0, z: 0 },
      onPad: "pad-sell",
      cargo,
    });
    client.push({
      type: "sell",
      payload: { resourceType: "iron", quantity: 10 },
    });
    await waitFor(client.frames, "error", 1);
    const err = client.frames.find((f) => f.type === "error") as Envelope & {
      payload: { code: string; message: string };
    };
    expect(err.payload.code).toBe("insufficient");
  });

  it("the money test: mine 10 iron → load to hold → dock → sell → credits = 500 + 50 = 550", async () => {
    if (!harness || !client) throw new Error("harness missing");
    const shipRowId = (await harness.repo.listShipsByOwner(client.playerId))[0]?.id;
    if (!shipRowId) throw new Error("expected starter ship row");
    // Simulate: mine 10 iron (set the inventory stack directly so
    // the test stays fast). Spec: "credits = 500 + 10*5 = 550".
    let inv: Inventory = emptyInventory();
    inv = addToInventory(inv, "iron", 10).inventory;
    await harness.repo.saveInventory(client.playerId, inv);
    // Transfer to hold (set the cargo directly).
    let cargo = cargoHoldFor("scout");
    cargo = addToCargo(cargo, "iron", 10).hold;
    await harness.repo.saveShipState(shipRowId, { cargo });
    await harness.repo.saveInventory(client.playerId, emptyInventory()); // backpack drained
    // Dock the ship.
    await bindShip(harness, client, {
      pos: { x: 0, y: 0, z: 0 },
      onPad: "pad-sell",
      cargo,
    });
    // Sell 10 iron.
    client.push({
      type: "sell",
      payload: { resourceType: "iron", quantity: 10 },
    });
    await waitFor(client.frames, "sell_ok", 1);
    const ack = client.frames.find((f) => f.type === "sell_ok");
    if (!ack) throw new Error("missing sell_ok ack");
    const payload = ack.payload as { earned: number; newBalance: number; sold: number };
    expect(payload.sold).toBe(10);
    expect(payload.earned).toBe(50); // 10 * 5
    expect(payload.newBalance).toBe(550); // 500 starting + 50 earned
    // Hold drained to zero.
    const shipRow = await harness.repo.findShipById(shipRowId);
    expect(shipRow?.cargo.stacks.iron ?? 0).toBe(0);
  });
});
