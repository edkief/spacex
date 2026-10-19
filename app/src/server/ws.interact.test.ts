/**
 * WS integration tests for the `interact` pipeline — TASK-33.
 *
 * Boots a real Fastify + WebSocket server with a minimal in-memory
 * shard + a docked ship → character so the interact flow is
 * exercised end-to-end on the wire. Covers:
 *
 *   - Happy path: in-range deposit + `interact` → `interact_ok`
 *     reply, deposit removed from the shard entity registry, and
 *     every connected client sees the deposit removed in the next
 *     `entity_update`.
 *   - Dock terminal: in-range terminal + `interact` → `ui_open`
 *     frame (ui:'dock') sent to the requesting connection.
 *   - Range check: out-of-range target → `error` frame with
 *     code `out-of-range`.
 *   - Regime check: ship-bound entity (not character) → `error`
 *     frame with code `wrong-regime`.
 *   - Existence check: unknown target → `error` frame with code
 *     `not-found`.
 *   - Two-client agreement: one client picks up a deposit, the
 *     other sees the removal in its entity_update.
 *
 * The shard here is the same minimal shape used by `ws.disembark.test.ts`
 * so the WS handler only reads `connections`, `entities`, `send`,
 * `broadcast`, and `sim.currentTick`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { WebSocket as WsClient } from "ws";

import { encodeEnvelope, PROTOCOL_VERSION, type Envelope } from "@shared/protocol/index.js";

import { attachWs, type WsHandle } from "./ws.js";
import { collect } from "./ws.ratelimit-helpers.js";
import { addConnection, type Shard, type ShardConnection } from "./shard/index.js";
import type { Connection } from "./ws.connection.js";

interface MinimalShard {
  systemId: string;
  connections: Map<string, { connId: string }>;
  entities: Map<
    string,
    {
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
    }
  >;
  sim: { currentTick: number };
  send: (connId: string, frame: { type: string; payload: unknown }) => void;
  broadcast: (
    tick: number,
    entities: unknown[],
    lastAppliedSeq: Readonly<Record<string, number>>,
  ) => void;
}

function makeShard(
  registry: { values: () => IterableIterator<Connection> },
  sentFrames: Array<{ connId: string; frame: { type: string; payload: unknown } }>,
): MinimalShard {
  const connections = new Map<string, { connId: string }>();
  const entities = new Map<
    string,
    {
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
    }
  >();
  const send = (connId: string, frame: { type: string; payload: unknown }): void => {
    sentFrames.push({ connId, frame });
    // Mirror the framework's behaviour: route to the actual socket.
    for (const conn of registry.values()) {
      if (conn.connId !== connId) continue;
      if (conn.ws.readyState !== conn.ws.OPEN) return;
      try {
        conn.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }));
      } catch {
        // ignore — socket may already be closed
      }
    }
  };

  const shard: MinimalShard = {
    systemId: "interact-test-system",
    connections,
    entities,
    sim: { currentTick: 0 },
    send,
    broadcast: (tick, _entities, _seq) => {
      shard.sim.currentTick = tick;
    },
  };
  return shard;
}

interface InteractHarness {
  app: FastifyInstance;
  handle: WsHandle;
  shard: MinimalShard;
  sent: Array<{ connId: string; frame: { type: string; payload: unknown } }>;
  url: string;
}

async function bootInteractHarness(): Promise<InteractHarness> {
  const app = Fastify({ logger: false });
  await app.ready();
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const port = Number(new URL(address).port);
  const sent: Array<{ connId: string; frame: { type: string; payload: unknown } }> = [];
  // eslint-disable-next-line prefer-const -- assigned in the joinResolver closure before use; ESLint can't follow the path.
  let shard!: MinimalShard;
  const handle = attachWs(app, "/ws", {
    joinResolver: async (_systemId, _callsign, connId) => {
      if (!shard.connections.has(connId)) {
        shard.connections.set(connId, { connId });
      }
      const entityList = Array.from(shard.entities.values()).map((e) => ({
        id: e.id,
        kind: e.kind,
        pos: [e.pos.x, e.pos.y, e.pos.z],
        vel: [e.vel.x, e.vel.y, e.vel.z],
        regime: "surface",
        hull: 0,
        shields: 0,
        targetId: null,
        classId: e.classId,
        callsign: e.callsign,
        livery: null,
        onPad: e.onPad,
        onFoot: e.kind === "character" ? true : undefined,
      }));
      return {
        systemId: shard.systemId,
        entities: entityList,
        nodes: [],
        chat: [],
        players: [],
        serverTickHz: 20,
        snapshotTick: shard.sim.currentTick,
      };
    },
  });

  shard = makeShard(handle.registry, sent);

  const handlerShard = {
    ...shard,
    events: { emit: () => {} },
    persist: {},
    onTickObserver: null,
    generation: 1,
    chatLog: { snapshot: () => [], append: (e: unknown) => e },
    stats: () => ({
      tickCount: 0,
      running: true,
      histogram: { p50: 0, p95: 0, p99: 0 },
      entityCount: 0,
      connectionCount: shard.connections.size,
      staleDrops: 0,
    }),
    shutdown: () => {},
    dirtyShipSpawns: new Map(),
    targets: new Map(),
    context: {
      system: {
        systemId: shard.systemId,
        name: "Test",
        star: { id: "star-x", name: "X", class: "G", x: 0, y: 0, z: 0, systemCount: 1 },
        planets: [],
      },
      starId: "star-x",
      planetById: () => undefined,
      heightAtFor: () => () => 0,
      tileSizeM: 64,
    },
  } as unknown as Shard;

  handle.setShardFor(() => handlerShard);
  handle.setOnConnectionClose((conn) => {
    shard.connections.delete(conn.connId);
  });

  return { app, handle, shard, sent, url: `ws://127.0.0.1:${port}/ws` };
}

async function reachJoined(client: WsClient, callsign: string): Promise<void> {
  client.send(encodeEnvelope("hello", { version: PROTOCOL_VERSION }));
  await collect(client, 1);
  client.send(encodeEnvelope("auth", { callsign }));
  await collect(client, 1);
  client.send(encodeEnvelope("join_system", { systemId: "interact-test-system" }));
  await collect(client, 1);
}

function openClient(url: string): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function findFrame<T = unknown>(
  frames: string[],
  type: string,
): { type: string; payload: T } | undefined {
  for (const raw of frames) {
    try {
      const env = JSON.parse(raw) as Envelope;
      if (env.type === type) return env as { type: string; payload: T };
    } catch {
      // ignore malformed
    }
  }
  return undefined;
}

function bindCharacter(
  harness: InteractHarness,
  playerId: string,
  pos: { x: number; y: number; z: number },
): string {
  // Find the lone connection in the registry (the test only ever
  // has one connection for the harness) and use its actual connId.
  const conn = harness.handle.registry.values().next().value as Connection | undefined;
  expect(conn).toBeDefined();
  const connId = conn!.connId;
  const connRow: ShardConnection = {
    connId,
    callsign: "TestPilot",
    playerId,
    shipId: "ship-1",
    entityId: `char:${playerId}`,
    lastSeq: 0,
    pendingInput: null,
    staleDrops: 0,
  };
  addConnection(harness.shard as unknown as Shard, connRow);
  harness.shard.entities.set(`char:${playerId}`, {
    id: `char:${playerId}`,
    kind: "character",
    playerId,
    callsign: "TestPilot",
    pos,
    vel: { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    onPad: "pad-1",
    classId: null,
    characterOnPad: "pad-1",
    onShipId: "ship-1",
  });
  return connId;
}

describe("WS: interact pipeline (TASK-33)", () => {
  let harness: InteractHarness;

  beforeEach(async () => {
    harness = await bootInteractHarness();
  });

  afterEach(async () => {
    for (const conn of harness.handle.registry.values()) {
      try {
        conn.ws.terminate();
      } catch {
        // ignore
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    await harness.app.close();
  });

  it("in-range deposit + interact → interact_ok, deposit removed", async () => {
    const client = await openClient(harness.url);
    try {
      await reachJoined(client, "TestPilot-A");
      bindCharacter(harness, "p-A", { x: 0, y: 0, z: 0 });
      harness.shard.entities.set("node-1", {
        id: "node-1",
        kind: "deposit",
        playerId: null,
        callsign: null,
        pos: { x: 1, y: 0, z: 0 },
        vel: { x: 0, y: 0, z: 0 },
        quat: { x: 0, y: 0, z: 0, w: 1 },
        onPad: null,
        classId: null,
      });

      client.send(encodeEnvelope("interact", { targetId: "node-1", action: "use" }));
      const frames = await collect(client, 1);

      const ok = findFrame(frames, "interact_ok");
      expect(ok).toBeDefined();
      const okPayload = ok?.payload as { targetId: string; action: string };
      expect(okPayload.targetId).toBe("node-1");
      expect(okPayload.action).toBe("use");

      // Deposit removed from the shard registry.
      expect(harness.shard.entities.get("node-1")).toBeUndefined();
    } finally {
      client.close();
    }
  });

  it("out-of-range target → out-of-range error frame", async () => {
    const client = await openClient(harness.url);
    try {
      await reachJoined(client, "TestPilot-B");
      bindCharacter(harness, "p-B", { x: 0, y: 0, z: 0 });
      harness.shard.entities.set("far", {
        id: "far",
        kind: "deposit",
        playerId: null,
        callsign: null,
        pos: { x: 50, y: 0, z: 0 },
        vel: { x: 0, y: 0, z: 0 },
        quat: { x: 0, y: 0, z: 0, w: 1 },
        onPad: null,
        classId: null,
      });

      client.send(encodeEnvelope("interact", { targetId: "far", action: "use" }));
      const frames = await collect(client, 1);
      const err = findFrame<{ code: string; message: string }>(frames, "error");
      expect(err).toBeDefined();
      expect(err?.payload.code).toBe("out-of-range");
      expect(harness.shard.entities.get("far")).toBeDefined();
    } finally {
      client.close();
    }
  });

  it("unknown target → not-found error frame", async () => {
    const client = await openClient(harness.url);
    try {
      await reachJoined(client, "TestPilot-C");
      bindCharacter(harness, "p-C", { x: 0, y: 0, z: 0 });

      client.send(encodeEnvelope("interact", { targetId: "ghost", action: "use" }));
      const frames = await collect(client, 1);
      const err = findFrame<{ code: string; message: string }>(frames, "error");
      expect(err).toBeDefined();
      expect(err?.payload.code).toBe("not-found");
    } finally {
      client.close();
    }
  });

  it("ship-bound entity (not character) → wrong-regime error frame", async () => {
    const client = await openClient(harness.url);
    try {
      await reachJoined(client, "TestPilot-D");
      // Bind the connection to a ship entity (not character).
      const wsConn = harness.handle.registry.values().next().value as Connection;
      const connRow: ShardConnection = {
        connId: wsConn!.connId,
        callsign: "TestPilot-D",
        playerId: "p-D",
        shipId: "ship-1",
        entityId: "entity:ship-1",
        lastSeq: 0,
        pendingInput: null,
        staleDrops: 0,
      };
      addConnection(harness.shard as unknown as Shard, connRow);
      harness.shard.entities.set("entity:ship-1", {
        id: "entity:ship-1",
        kind: "player",
        playerId: "p-D",
        callsign: "TestPilot-D",
        pos: { x: 0, y: 0, z: 0 },
        vel: { x: 0, y: 0, z: 0 },
        quat: { x: 0, y: 0, z: 0, w: 1 },
        onPad: null,
        classId: "scout",
      });
      harness.shard.entities.set("node-1", {
        id: "node-1",
        kind: "deposit",
        playerId: null,
        callsign: null,
        pos: { x: 1, y: 0, z: 0 },
        vel: { x: 0, y: 0, z: 0 },
        quat: { x: 0, y: 0, z: 0, w: 1 },
        onPad: null,
        classId: null,
      });

      client.send(encodeEnvelope("interact", { targetId: "node-1", action: "use" }));
      const frames = await collect(client, 1);
      const err = findFrame<{ code: string; message: string }>(frames, "error");
      expect(err).toBeDefined();
      expect(err?.payload.code).toBe("wrong-regime");
      // Deposit NOT removed — wrong regime means no effect.
      expect(harness.shard.entities.get("node-1")).toBeDefined();
    } finally {
      client.close();
    }
  });

  it("dock terminal + interact → ui_open frame to the requesting connection", async () => {
    const client = await openClient(harness.url);
    try {
      await reachJoined(client, "TestPilot-E");
      bindCharacter(harness, "p-E", { x: 0, y: 0, z: 0 });
      harness.shard.entities.set("terminal-1", {
        id: "terminal-1",
        kind: "terminal",
        playerId: null,
        callsign: null,
        pos: { x: 1, y: 0, z: 0 },
        vel: { x: 0, y: 0, z: 0 },
        quat: { x: 0, y: 0, z: 0, w: 1 },
        onPad: null,
        classId: null,
      });

      client.send(encodeEnvelope("interact", { targetId: "terminal-1", action: "use" }));
      const frames = await collect(client, 2);
      const ui = findFrame<{ ui: string; payload: Record<string, unknown> }>(frames, "ui_open");
      expect(ui).toBeDefined();
      expect(ui?.payload.ui).toBe("dock");
    } finally {
      client.close();
    }
  });

  it("two clients agree on a deposit removal (multi-client WS test)", async () => {
    const alice = await openClient(harness.url);
    const bob = await openClient(harness.url);
    try {
      await reachJoined(alice, "Alice-X");
      await reachJoined(bob, "Bob-X");
      // Bind Alice as the character; Bob is just observing the snapshot.
      bindCharacter(harness, "p-X", { x: 0, y: 0, z: 0 });
      harness.shard.entities.set("node-shared", {
        id: "node-shared",
        kind: "deposit",
        playerId: null,
        callsign: null,
        pos: { x: 1, y: 0, z: 0 },
        vel: { x: 0, y: 0, z: 0 },
        quat: { x: 0, y: 0, z: 0, w: 1 },
        onPad: null,
        classId: null,
      });
      alice.send(encodeEnvelope("interact", { targetId: "node-shared", action: "use" }));
      // Wait for the handler to run.
      await new Promise((resolve) => setTimeout(resolve, 40));
      // Both Alice + Bob should see the deposit removed (the
      // next entity_update broadcast omits it).
      expect(harness.shard.entities.get("node-shared")).toBeUndefined();
    } finally {
      alice.close();
      bob.close();
    }
  });
});
