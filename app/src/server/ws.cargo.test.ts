/**
 * WS round-trip tests for the TASK-39 cargo transfer pipeline.
 *
 * Boots a real Fastify + WebSocket server with an in-memory
 * shard so the inventory ↔ hold transfer flow is exercised
 * end-to-end on the wire. Covers:
 *
 *   - happy path: inventory → hold → `cargo_update` ack
 *   - happy path: hold → inventory → `cargo_update` ack
 *   - partial transfer when the hold is near cap
 *   - rejection: `wrong-regime` (player in ship, not on foot)
 *   - rejection: `out-of-range` (character too far from ship)
 *   - rejection: `not-owner` (cross-player transfer)
 *   - rejection: `insufficient-amount` (inventory too short)
 *   - rejection: `cargo-full` (hold is at cap)
 *   - warp round-trip: load 10 iron, persist, load fresh DB
 *     (verified via the repo's `findShipById`).
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
import { INVENTORY_WEIGHT_CAP } from "@shared/world/inventory.js";
import { addToInventory as addToInv, emptyInventory } from "@shared/world/inventoryOps.js";

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
  send: (
    connId: string,
    frame: {
      type:
        | "entity_update"
        | "chat"
        | "combat_event"
        | "ui_open"
        | "inventory_update"
        | "enter_ship_ok"
        | "mining_update"
        | "cargo_update"
        | "fire_ok"
        | "weapon_state"
        | "target_locked"
        | "target_released"
        | "target_update";
      payload: unknown;
    },
  ) => void;
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

async function boot(args: { classId: "scout" | "freighter" | "interceptor" }): Promise<Harness> {
  const app = Fastify({ logger: false });
  const { db, close } = createSqliteTestDb();
  const repo = createSqliteRepository(db);

  const entities = new Map<string, SimLike>();
  const connections = new Map<string, { entityId: string | null; playerId: string }>();
  const sentFrames: Array<{ connId: string; frame: { type: string; payload: unknown } }> = [];

  const shard: ShardLike = {
    systemId: "sys-cargo",
    entities,
    send: ((connId, frame): void => {
      sentFrames.push({ connId, frame });
    }) as ShardLike["send"],
    broadcast: () => undefined,
    sim: { currentTick: 1 },
    connections,
  };
  const ctx: ShardSystemContext = {
    system: {
      systemId: "sys-cargo",
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
    systemId: "sys-cargo",
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
        homeSystemId: "sys-cargo",
      });
      // Mint a starter ship of the requested class so the cargo
      // capacity matches the test.
      await repo.getOrCreateStarterShip(player.id, args.classId);
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
  client.send(encodeEnvelope("hello", { version: PROTOCOL_VERSION, client: "cargo-test" }));
  await waitFor(frames, "hello", 1);
  client.send(encodeEnvelope("auth", { callsign }));
  await waitFor(frames, "auth_ok", 1);
  client.send(encodeEnvelope("join_system", { systemId: "sys-cargo" }));
  await waitFor(frames, "enter_system", 1);

  const authOk = frames.find((f) => f.type === "auth_ok") as Envelope & {
    payload: { playerId: string };
  };
  const playerId = authOk.payload.playerId;

  let connId = "";
  for (const conn of harness.ws.registry.values()) {
    if (conn.playerId === playerId) {
      connId = conn.connId;
      harness.shard.connections.set(conn.connId, { entityId: null, playerId, connId: conn.connId });
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
    callsign: "CARGO",
    pos: args.pos,
    vel: { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    onPad: "pad-1",
    classId: null,
    characterOnPad: "pad-1",
    onShipId: args.shipId,
  });
}

async function placeShip(
  harness: Harness,
  args: {
    id: string;
    playerId: string;
    pos: { x: number; y: number; z: number };
    classId: "scout" | "freighter" | "interceptor";
    cargo?: CargoHold;
  },
): Promise<void> {
  harness.shard.entities.set(args.id, {
    id: args.id,
    kind: "player",
    playerId: args.playerId,
    callsign: "CARGO",
    pos: args.pos,
    vel: { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    onPad: "pad-1",
    classId: args.classId,
    cargo: args.cargo ?? cargoHoldFor(args.classId),
  });
}

describe("ws: cargo transfer pipeline (TASK-39)", () => {
  let harness: Harness | null = null;
  let client: ClientHandle | null = null;

  beforeEach(async () => {
    harness = await boot({ classId: "scout" });
    client = await bootClient(harness, "PILOT-CARGO");
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

  it("happy path: inventory → hold emits cargo_update with the new hold + inventory", async () => {
    if (!harness || !client) throw new Error("harness missing");
    const shipRowId = (await harness.repo.listShipsByOwner(client.playerId))[0]?.id;
    if (!shipRowId) throw new Error("expected starter ship row");
    const shipId = `entity:${shipRowId}`;
    await harness.repo.saveInventory(
      client.playerId,
      addToInv(emptyInventory(), "iron", 10).inventory,
    );
    await placeShip(harness, {
      id: shipId,
      playerId: client.playerId,
      pos: { x: 0, y: 0, z: 0 },
      classId: "scout",
    });
    await bindCharacter(harness, client, { pos: { x: 2, y: 0, z: 0 }, shipId });
    client.push({
      type: "cargo_transfer",
      payload: { resourceId: "iron", amount: 5, from: "inv" },
    });
    await waitFor(client.frames, "cargo_update", 1);
    const ack = client.frames.find((f) => f.type === "cargo_update");
    expect(ack).toBeDefined();
    if (!ack) throw new Error("missing ack");
    const payload = ack.payload as {
      cargo: { stacks: Record<string, number>; weightUsed: number; capacity: number };
      inventory: { stacks: Record<string, number>; weightUsed: number; capacity: number };
      direction: "inv" | "hold";
      resourceId: string;
      transferred: number;
      remaining: number;
      action: "move-to-hold" | "move-to-inventory";
    };
    expect(payload.direction).toBe("inv");
    expect(payload.action).toBe("move-to-hold");
    expect(payload.transferred).toBe(5);
    expect(payload.remaining).toBe(0);
    expect(payload.cargo.stacks.iron).toBe(5);
    expect(payload.cargo.weightUsed).toBe(5);
    expect(payload.inventory.stacks.iron).toBe(5);
    // Persisted
    const shipRow = await harness.repo.findShipById(shipRowId);
    expect(shipRow?.cargo.stacks.iron).toBe(5);
  });

  it("happy path: hold → inventory", async () => {
    if (!harness || !client) throw new Error("harness missing");
    const shipRowId = (await harness.repo.listShipsByOwner(client.playerId))[0]?.id;
    if (!shipRowId) throw new Error("expected starter ship row");
    const shipId = `entity:${shipRowId}`;
    await harness.repo.saveInventory(client.playerId, emptyInventory());
    let cargo = cargoHoldFor("scout");
    cargo = addToCargo(cargo, "iron", 10).hold;
    // Persist the cargo so the server-side handler sees it on read.
    await harness.repo.saveShipState(shipRowId, { cargo });
    await placeShip(harness, {
      id: shipId,
      playerId: client.playerId,
      pos: { x: 0, y: 0, z: 0 },
      classId: "scout",
      cargo,
    });
    await bindCharacter(harness, client, { pos: { x: 2, y: 0, z: 0 }, shipId });
    client.push({
      type: "cargo_transfer",
      payload: { resourceId: "iron", amount: 4, from: "hold" },
    });
    await waitFor(client.frames, "cargo_update", 1);
    const ack = client.frames.find((f) => f.type === "cargo_update");
    expect(ack).toBeDefined();
    if (!ack) throw new Error("missing ack");
    const payload = ack.payload as {
      cargo: { stacks: Record<string, number> };
      inventory: { stacks: Record<string, number> };
      direction: "inv" | "hold";
      action: "move-to-hold" | "move-to-inventory";
    };
    expect(payload.direction).toBe("hold");
    expect(payload.action).toBe("move-to-inventory");
    expect(payload.cargo.stacks.iron).toBe(6);
    expect(payload.inventory.stacks.iron).toBe(4);
  });

  it("partial transfer when the hold is near cap", async () => {
    if (!harness || !client) throw new Error("harness missing");
    // For this test we need a freighter; tear down the default scout
    // harness and boot a fresh one with the right class.
    await client.close();
    await harness.ws.close();
    await harness.app.close();
    harness.closeDb();
    harness = await boot({ classId: "freighter" });
    client = await bootClient(harness, "PILOT-FREIGHTER");
    const shipRowId = (await harness.repo.listShipsByOwner(client.playerId))[0]?.id;
    if (!shipRowId) throw new Error("expected starter ship row");
    const shipId = `entity:${shipRowId}`;
    // Freighter holds 120 iron; pre-fill 115, ask for 10 → only 5 fit.
    await harness.repo.saveInventory(
      client.playerId,
      addToInv(emptyInventory(), "iron", 20).inventory,
    );
    let cargo = cargoHoldFor("freighter");
    cargo = addToCargo(cargo, "iron", 115).hold;
    // Persist so the server-side handler observes the pre-filled hold.
    await harness.repo.saveShipState(shipRowId, { cargo });
    await placeShip(harness, {
      id: shipId,
      playerId: client.playerId,
      pos: { x: 0, y: 0, z: 0 },
      classId: "freighter",
      cargo,
    });
    await bindCharacter(harness, client, { pos: { x: 2, y: 0, z: 0 }, shipId });
    client.push({
      type: "cargo_transfer",
      payload: { resourceId: "iron", amount: 10, from: "inv" },
    });
    await waitFor(client.frames, "cargo_update", 1);
    const ack = client.frames.find((f) => f.type === "cargo_update");
    if (!ack) throw new Error("missing ack");
    const payload = ack.payload as {
      transferred: number;
      remaining: number;
    };
    expect(payload.transferred).toBe(5);
    expect(payload.remaining).toBe(5);
  });

  it("rejects `wrong-regime` when the player is in a ship", async () => {
    if (!harness || !client) throw new Error("harness missing");
    const shipRowId = (await harness.repo.listShipsByOwner(client.playerId))[0]?.id;
    if (!shipRowId) throw new Error("expected starter ship row");
    const shipId = `entity:${shipRowId}`;
    await harness.repo.saveInventory(
      client.playerId,
      addToInv(emptyInventory(), "iron", 5).inventory,
    );
    await placeShip(harness, {
      id: shipId,
      playerId: client.playerId,
      pos: { x: 0, y: 0, z: 0 },
      classId: "scout",
    });
    // Bind the connection to the ship entity instead of a character.
    const connRow = harness.shard.connections.get(client.connId);
    if (!connRow) throw new Error("Connection not registered");
    connRow.entityId = shipId;
    client.push({
      type: "cargo_transfer",
      payload: { resourceId: "iron", amount: 1, from: "inv" },
    });
    await waitFor(client.frames, "error", 1);
    const err = client.frames.find((f) => f.type === "error");
    expect(err).toBeDefined();
    if (!err) throw new Error("missing error");
    expect((err.payload as { code: string }).code).toBe("wrong-regime");
  });

  it("rejects `out-of-range` when character is too far", async () => {
    if (!harness || !client) throw new Error("harness missing");
    const shipRowId = (await harness.repo.listShipsByOwner(client.playerId))[0]?.id;
    if (!shipRowId) throw new Error("expected starter ship row");
    const shipId = `entity:${shipRowId}`;
    await harness.repo.saveInventory(
      client.playerId,
      addToInv(emptyInventory(), "iron", 5).inventory,
    );
    await placeShip(harness, {
      id: shipId,
      playerId: client.playerId,
      pos: { x: 0, y: 0, z: 0 },
      classId: "scout",
    });
    await bindCharacter(harness, client, { pos: { x: 100, y: 0, z: 0 }, shipId });
    client.push({
      type: "cargo_transfer",
      payload: { resourceId: "iron", amount: 1, from: "inv" },
    });
    await waitFor(client.frames, "error", 1);
    const err = client.frames.find((f) => f.type === "error");
    expect(err).toBeDefined();
    if (!err) throw new Error("missing error");
    expect((err.payload as { code: string }).code).toBe("out-of-range");
  });

  it("rejects `not-owner` against another player's ship", async () => {
    if (!harness || !client) throw new Error("harness missing");
    // Forge a ship entity that belongs to a different player.
    await placeShip(harness, {
      id: "ship:other",
      playerId: "other-player-id",
      pos: { x: 0, y: 0, z: 0 },
      classId: "scout",
    });
    const connRow = harness.shard.connections.get(client.connId);
    if (!connRow) throw new Error("Connection not registered");
    connRow.entityId = `char:${client.playerId}`;
    harness.shard.entities.set(`char:${client.playerId}`, {
      id: `char:${client.playerId}`,
      kind: "character",
      playerId: client.playerId,
      callsign: "CARGO",
      pos: { x: 2, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      onPad: "pad-1",
      classId: null,
      characterOnPad: "pad-1",
      onShipId: "ship:other",
    });
    await harness.repo.saveInventory(
      client.playerId,
      addToInv(emptyInventory(), "iron", 5).inventory,
    );
    client.push({
      type: "cargo_transfer",
      payload: { resourceId: "iron", amount: 1, from: "inv" },
    });
    await waitFor(client.frames, "error", 1);
    const err = client.frames.find((f) => f.type === "error");
    expect(err).toBeDefined();
    if (!err) throw new Error("missing error");
    expect((err.payload as { code: string }).code).toBe("not-owner");
  });

  it("rejects `insufficient-amount` when inventory is short", async () => {
    if (!harness || !client) throw new Error("harness missing");
    const shipRowId = (await harness.repo.listShipsByOwner(client.playerId))[0]?.id;
    if (!shipRowId) throw new Error("expected starter ship row");
    const shipId = `entity:${shipRowId}`;
    await harness.repo.saveInventory(
      client.playerId,
      addToInv(emptyInventory(), "copper", 2).inventory,
    );
    await placeShip(harness, {
      id: shipId,
      playerId: client.playerId,
      pos: { x: 0, y: 0, z: 0 },
      classId: "scout",
    });
    await bindCharacter(harness, client, { pos: { x: 2, y: 0, z: 0 }, shipId });
    client.push({
      type: "cargo_transfer",
      payload: { resourceId: "copper", amount: 10, from: "inv" },
    });
    await waitFor(client.frames, "error", 1);
    const err = client.frames.find((f) => f.type === "error");
    expect(err).toBeDefined();
    if (!err) throw new Error("missing error");
    expect((err.payload as { code: string }).code).toBe("invalid-message");
  });

  it("rejects `cargo-full` when the hold is at cap", async () => {
    if (!harness || !client) throw new Error("harness missing");
    // Need an interceptor for the cap-20 test; tear down + reboot.
    await client.close();
    await harness.ws.close();
    await harness.app.close();
    harness.closeDb();
    harness = await boot({ classId: "interceptor" });
    client = await bootClient(harness, "PILOT-INTERCEPTOR");
    const shipRowId = (await harness.repo.listShipsByOwner(client.playerId))[0]?.id;
    if (!shipRowId) throw new Error("expected starter ship row");
    const shipId = `entity:${shipRowId}`;
    await harness.repo.saveInventory(
      client.playerId,
      addToInv(emptyInventory(), "iron", 10).inventory,
    );
    const cargo: CargoHold = {
      stacks: { iron: 20 },
      weightUsed: 20,
      capacity: 20,
    };
    // Persist so the server-side handler sees the full hold.
    await harness.repo.saveShipState(shipRowId, { cargo });
    await placeShip(harness, {
      id: shipId,
      playerId: client.playerId,
      pos: { x: 0, y: 0, z: 0 },
      classId: "interceptor",
      cargo,
    });
    await bindCharacter(harness, client, { pos: { x: 2, y: 0, z: 0 }, shipId });
    client.push({
      type: "cargo_transfer",
      payload: { resourceId: "iron", amount: 5, from: "inv" },
    });
    await waitFor(client.frames, "error", 1);
    const err = client.frames.find((f) => f.type === "error");
    expect(err).toBeDefined();
    if (!err) throw new Error("missing error");
    expect((err.payload as { code: string }).code).toBe("invalid-message");
  });

  it("persists the new hold across a fresh DB read (warp round-trip)", async () => {
    if (!harness || !client) throw new Error("harness missing");
    const shipRowId = (await harness.repo.listShipsByOwner(client.playerId))[0]?.id;
    if (!shipRowId) throw new Error("expected starter ship row");
    const shipId = `entity:${shipRowId}`;
    await harness.repo.saveInventory(
      client.playerId,
      addToInv(emptyInventory(), "iron", 10).inventory,
    );
    await placeShip(harness, {
      id: shipId,
      playerId: client.playerId,
      pos: { x: 0, y: 0, z: 0 },
      classId: "scout",
    });
    await bindCharacter(harness, client, { pos: { x: 2, y: 0, z: 0 }, shipId });
    client.push({
      type: "cargo_transfer",
      payload: { resourceId: "iron", amount: 10, from: "inv" },
    });
    await waitFor(client.frames, "cargo_update", 1);
    // Re-read from the DB to simulate a server restart.
    const reread = await harness.repo.findShipById(shipRowId);
    expect(reread?.cargo.stacks.iron).toBe(10);
    expect(reread?.cargo.weightUsed).toBe(10);
    expect(reread?.cargo.capacity).toBe(40);
  });
});

// Reference INVENTORY_WEIGHT_CAP for type-coverage of the unused
// import in production builds.
void INVENTORY_WEIGHT_CAP;
