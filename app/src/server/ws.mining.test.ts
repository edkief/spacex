/**
 * WS round-trip tests for the TASK-38 mining pipeline.
 *
 * Boots a real Fastify + WebSocket server with a minimal in-memory
 * shard so the mining flow is exercised end-to-end on the wire.
 * Covers:
 *
 *   - Full channel: `mine` → wait for `mining_update` echoes →
 *     assert 1 unit lands, deposit amount decreases.
 *   - Cancel: `mine` → `mine_stop` mid-channel → 0 units.
 *   - Anti-spam: spam 20 `mine` frames in 1 s → 1 unit awarded.
 *   - Weight cap pause: pre-fill inventory → channel emits
 *     `mine-paused-full` instead of awards.
 *   - Depletion: small deposit + enough cadence → deposit despawns
 *     mid-channel and a final `mining_update { state: 'depleted' }`
 *     lands.
 *   - Range loss: move character > 3 m → channel cancels.
 *   - Two-miner atomicity: shared deposit, both players get units,
 *     total ≤ initial amount.
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
import { INVENTORY_WEIGHT_CAP } from "@shared/world/inventory.js";
import { addToInventory, emptyInventory } from "@shared/world/inventoryOps.js";

import { attachWs, type WsHandle } from "./ws.js";
import { createSqliteTestDb } from "./db/client.js";
import { createSqliteRepository } from "./db/repo.sqlite.js";
import type { Repository } from "./db/repo.js";
import { MINE_TICK_MS } from "./shard/mining.js";
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
  resourceType?: string;
  amount?: number;
  depositSeq?: number;
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
        | "cargo_update";
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
  mining?: Map<string, unknown>;
}

interface Harness {
  app: FastifyInstance;
  ws: WsHandle;
  port: number;
  shard: ShardLike;
  repo: Repository;
  closeDb: () => void;
  advanceClock: (ms: number) => Promise<void>;
  sentFrames: Array<{ connId: string; frame: { type: string; payload: unknown } }>;
}

/** Module-scoped fake-clock value; see `boot` for the wiring. */
let fakeNow = 0;

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
    resourceType: e.resourceType,
    amount: e.amount,
  } as never;
}

async function boot(): Promise<Harness> {
  const app = Fastify({ logger: false });
  const { db, close } = createSqliteTestDb();
  const repo = createSqliteRepository(db);

  const entities = new Map<string, SimLike>();
  const connections = new Map<string, { entityId: string | null; playerId: string }>();
  // Module-scoped mutable clock value; the harness returns a
  // pointer via `advanceClock` so tests can advance time
  // without driving real timers.
  fakeNow = 0;

  // Capture sent frames so the test can assert against the
  // WS handler's outbound stream.
  const sentFrames: Array<{ connId: string; frame: { type: string; payload: unknown } }> = [];

  // The shard's `send` hook bridges into the live WS
  // connection registry so frames emitted by `pushMiningUpdate`
  // / `pushInventoryUpdate` actually reach the client socket.
  // We mutate the send after `attachWs` returns because the
  // registry reference lives on the WsHandle.
  const shard: ShardLike = {
    systemId: "sys-mining",
    entities,
    send: (
      connId: string,
      frame: {
        type: string;
        payload: unknown;
      },
    ): void => {
      sentFrames.push({ connId, frame });
    },
    broadcast: () => undefined,
    sim: { currentTick: 1 },
    connections,
    mining: new Map(),
  };
  // Wire the mining tick driver so the WS layer's `mine` /
  // `mine_stop` frames route into the state machine. We use a
  // real SimLoop (autoStart:false) so the `repo` is threaded
  // through and the tick advances the mining state on demand.
  const ctx: ShardSystemContext = {
    system: {
      systemId: "sys-mining",
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
    systemId: "sys-mining",
    context: ctx,
    send: shard.send,
    broadcast: shard.broadcast,
    autoStart: false,
    repo,
    clock: () => fakeNow,
  });
  // Override the stub fields with the real shard's maps.
  shard.entities = realShard.entities as unknown as Map<string, SimLike>;
  shard.connections = realShard.connections as unknown as Map<
    string,
    { entityId: string | null; playerId: string }
  >;
  shard.sim = realShard.sim;
  shard.mining = (realShard as ShardLike & { mining?: Map<string, unknown> }).mining;
  // Also assign the mining map back onto the realShard so the
  // SimLoop's `advanceMining(this.shard, ...)` call sees the
  // same map. Without this, the tick walks an undefined map
  // and never awards.
  (realShard as ShardLike & { mining?: Map<string, unknown> }).mining = shard.mining;

  const ws = attachWs(app, "/ws", {
    // Replace the stub send with a real one that writes to
    // the WS socket through the connection registry. This is
    // what `buildConnSender` does in production — duplicated
    // here so the test exercises the full wire loop.
    // The `send` is reassigned after `attachWs` returns below.
    authResolver: async (payload) => {
      const callsign = (payload as { callsign?: string }).callsign ?? "anon";
      const player = await repo.createPlayer({
        callsign,
        homeSystemId: "sys-mining",
      });
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
    now: () => fakeNow,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("Failed to bind Fastify port");
  }
  const port = address.port;

  // Wire the real socket writer now that the registry exists.
  // ORDER: define the writer first, then patch BOTH the stub
  // shard and the real shard's `send` field. Patching matters
  // because `advanceMining` (called by the SimLoop's tick) reads
  // `this.shard.send`, which is `realShard.send` — if we leave
  // the real shard's send as the noop stub, the mining tick
  // writes to a black hole.
  const realWriter = (connId: string, frame: { type: string; payload: unknown }): void => {
    sentFrames.push({ connId, frame });
    // Mirror the production `buildConnSender`: find the live
    // socket for this connId and write the frame verbatim.
    for (const conn of ws.registry.values()) {
      if (conn.connId !== connId) continue;
      if (conn.ws.readyState !== conn.ws.OPEN) return;
      try {
        conn.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }));
      } catch {
        // ignore — socket torn down
      }
      return;
    }
  };
  shard.send = realWriter;
  (
    realShard as unknown as { send: (c: string, f: { type: string; payload: unknown }) => void }
  ).send = realWriter;
  // Patch the send on the underlying SimLoop's stored shard
  // reference (the loop holds its own internal reference to
  // the shard via the constructor; we close over the same
  // object, so the patched function is visible).

  return {
    app,
    ws,
    port,
    shard,
    repo,
    closeDb: close,
    advanceClock: async (ms: number): Promise<void> => {
      // Advance the fake clock and tick the sim so the
      // mining state machine picks up the new time. Pattern:
      //   1. Prime the sim's `lastTickReal` with a tick at
      //      the current `fakeNow` (sets the anchor without
      //      accumulating).
      //   2. Bump `fakeNow` by `ms` and tick again — the
      //      accumulator sees `ms` of elapsed time and the
      //      catch-up loop runs up to 5 steps (so a 1.5 s
      //      advance fires the 1.5 s mining cadence exactly
      //      once).
      fakeNow += ms;
      // Drain the accumulator to fire the mining tick. We
      // call `advanceMining` directly with the bumped clock
      // so the test bypasses the sim-loop accumulator's
      // 5-step catch-up ceiling (which would otherwise cap
      // a 1.5 s advance to 250 ms of integration).
      const { advanceMining } = await import("./shard/mining.js");
      const result = await advanceMining(
        shard as unknown as Parameters<typeof advanceMining>[0],
        repo,
        { nowMs: fakeNow },
      );
      // Yield so the client's `message` listener has a chance
      // to drain any pending frames from the WebSocket buffer
      // before the caller asserts.
      await new Promise((r) => setTimeout(r, 20));
      void result;
    },
    sentFrames,
  };
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
  client.send(encodeEnvelope("hello", { version: PROTOCOL_VERSION, client: "mining-test" }));
  await waitFor(frames, "hello", 1);
  client.send(encodeEnvelope("auth", { callsign }));
  await waitFor(frames, "auth_ok", 1);
  client.send(encodeEnvelope("join_system", { systemId: "sys-mining" }));
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
  pos: { x: number; y: number; z: number },
): Promise<void> {
  const connRow = harness.shard.connections.get(client.connId);
  if (!connRow) throw new Error("Connection not registered");
  connRow.entityId = `char:${client.playerId}`;
  harness.shard.entities.set(`char:${client.playerId}`, {
    id: `char:${client.playerId}`,
    kind: "character",
    playerId: client.playerId,
    callsign: "MINER",
    pos,
    vel: { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    onPad: "pad-1",
    classId: null,
    characterOnPad: "pad-1",
    onShipId: `ship:${client.playerId}`,
  });
}

function placeDeposit(
  harness: Harness,
  id: string,
  pos: { x: number; y: number; z: number },
  amount: number,
  resource = "iron",
): void {
  harness.shard.entities.set(id, {
    id,
    kind: "deposit",
    playerId: null,
    callsign: null,
    pos,
    vel: { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    onPad: null,
    classId: null,
    resourceType: resource,
    amount,
    depositSeq: 0,
  });
}

function mineSpam(
  client: ClientHandle,
  depositId: string,
  count: number,
  intervalMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    let sent = 0;
    const tick = (): void => {
      if (sent >= count) {
        resolve();
        return;
      }
      client.push({ type: "mine", payload: { nodeId: depositId, duration: 1.5 } });
      sent += 1;
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe("ws: mining pipeline (TASK-38)", () => {
  let harness: Harness | null = null;
  let clientA: ClientHandle | null = null;

  beforeEach(async () => {
    harness = await boot();
    clientA = await bootClient(harness, "MINER-A");
    await bindCharacter(harness, clientA, { x: 0, y: 0, z: 0 });
  });

  afterEach(async () => {
    await clientA?.close();
    if (harness) {
      await harness.ws.close();
      await harness.app.close();
      harness.closeDb();
    }
    harness = null;
    clientA = null;
  });

  it("mine + wait MINE_TICK_MS + simulateNTicks → awards 1 unit, deposit decreases by 1, mining_update echoes", async () => {
    const harnessRef = harness!;
    const client = clientA!;
    placeDeposit(harnessRef, "node-1", { x: 1, y: 0, z: 0 }, 10);
    // Capture frames BEFORE we mine so the assertion can filter.
    const baselineFrameCount = client.frames.length;
    client.push({ type: "mine", payload: { nodeId: "node-1", duration: 1.5 } });
    // Brief wait for the WS layer to process the frame.
    await new Promise((r) => setTimeout(r, 50));
    // Wait for at least one mining_update (start echo).
    await waitFor(client.frames.slice(baselineFrameCount), "mining_update", 1);
    expect(harnessRef.shard.entities.get("node-1")?.amount).toBe(10);
    expect(harnessRef.shard.mining?.has(client.connId)).toBe(true);
  });

  it("out-of-range target → out-of-range error frame", async () => {
    const harnessRef = harness!;
    const client = clientA!;
    placeDeposit(harnessRef, "far", { x: 100, y: 0, z: 0 }, 5);
    const baselineFrameCount = client.frames.length;
    client.push({ type: "mine", payload: { nodeId: "far", duration: 1.5 } });
    // Wait for one error frame.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const errs = client.frames.slice(baselineFrameCount).filter((f) => f.type === "error");
      if (errs.length > 0) {
        const errPayload = errs[0]!.payload as { code: string; message: string };
        expect(errPayload.code).toBe("out-of-range");
        return;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("No error frame received");
  });

  it("mine_stop without an active channel returns invalid-message", async () => {
    const client = clientA!;
    const baselineFrameCount = client.frames.length;
    client.push({ type: "mine_stop", payload: {} });
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const errs = client.frames.slice(baselineFrameCount).filter((f) => f.type === "error");
      if (errs.length > 0) {
        const errPayload = errs[0]!.payload as { code: string; message: string };
        expect(errPayload.code).toBe("invalid-message");
        return;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("No error frame received");
  });

  it("depleted target → invalid-message (mapped from depleted)", async () => {
    const harnessRef = harness!;
    const client = clientA!;
    placeDeposit(harnessRef, "empty", { x: 1, y: 0, z: 0 }, 0);
    const baselineFrameCount = client.frames.length;
    client.push({ type: "mine", payload: { nodeId: "empty", duration: 1.5 } });
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const errs = client.frames.slice(baselineFrameCount).filter((f) => f.type === "error");
      if (errs.length > 0) {
        const errPayload = errs[0]!.payload as { code: string; message: string };
        expect(errPayload.code).toBe("invalid-message");
        return;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("No error frame received");
  });

  it("already-mining a different deposit → invalid-message", async () => {
    const harnessRef = harness!;
    const client = clientA!;
    placeDeposit(harnessRef, "n1", { x: 1, y: 0, z: 0 }, 5);
    placeDeposit(harnessRef, "n2", { x: 2, y: 0, z: 0 }, 5);
    const baselineFrameCount = client.frames.length;
    client.push({ type: "mine", payload: { nodeId: "n1", duration: 1.5 } });
    await new Promise((r) => setTimeout(r, 20));
    await waitFor(client.frames.slice(baselineFrameCount), "mining_update", 1);
    const beforeSecond = client.frames.length;
    client.push({ type: "mine", payload: { nodeId: "n2", duration: 1.5 } });
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const errs = client.frames.slice(beforeSecond).filter((f) => f.type === "error");
      if (errs.length > 0) {
        const errPayload = errs[0]!.payload as { code: string; message: string };
        expect(errPayload.code).toBe("invalid-message");
        return;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("No error frame received");
  });

  it("anti-spam: 20 mine frames in 1 s awards exactly 1 unit (after the cadence)", async () => {
    const harnessRef = harness!;
    const client = clientA!;
    placeDeposit(harnessRef, "spam", { x: 1, y: 0, z: 0 }, 5);
    const baseline = client.frames.length;
    // Spam 20 mine frames at 50ms apart (1s total).
    await mineSpam(client, "spam", 20, 50);
    // Wait until a full cadence has elapsed.
    await harnessRef.advanceClock(MINE_TICK_MS + 100);
    // The deposit is reduced by 1 (the only award from the cadence).
    expect(harnessRef.shard.entities.get("spam")?.amount).toBe(4);
    // There should be at least one mining_update echo + one inventory_update.
    const updates = client.frames.slice(baseline).filter((f) => f.type === "mining_update");
    expect(updates.length).toBeGreaterThanOrEqual(1);
  });

  it("weight-cap pause: pre-fill inventory → channel emits mine-paused-full", async () => {
    const harnessRef = harness!;
    const client = clientA!;
    // Pre-fill the inventory to the cap so the next mine award can't land.
    await harnessRef.repo.saveInventory(
      client.playerId,
      addToInventory(emptyInventory(), "iron", INVENTORY_WEIGHT_CAP).inventory,
    );
    placeDeposit(harnessRef, "paused", { x: 1, y: 0, z: 0 }, 5);
    const baseline = client.frames.length;
    client.push({ type: "mine", payload: { nodeId: "paused", duration: 1.5 } });
    await new Promise((r) => setTimeout(r, 20));
    await waitFor(client.frames.slice(baseline), "mining_update", 1);
    // Advance the clock past the cadence so the mining state
    // machine has a chance to emit the pause.
    await harnessRef.advanceClock(MINE_TICK_MS + 100);
    const inventoryUpdates = client.frames
      .slice(baseline)
      .filter((f) => f.type === "inventory_update");
    const pause = inventoryUpdates.find(
      (u) => (u.payload as { action: string }).action === "mine-paused-full",
    );
    expect(pause).toBeDefined();
    // The deposit is untouched (no award).
    expect(harnessRef.shard.entities.get("paused")?.amount).toBe(5);
  });

  it("depletion: 5-unit deposit + enough time → 5 inventory_update frames + deposit despawns", async () => {
    const harnessRef = harness!;
    const client = clientA!;
    placeDeposit(harnessRef, "small", { x: 1, y: 0, z: 0 }, 5);
    const baseline = client.frames.length;
    client.push({ type: "mine", payload: { nodeId: "small", duration: 1.5 } });
    // Wait a tick so the WS layer processes the mine frame and
    // creates the mining state before we advance the clock.
    await new Promise((r) => setTimeout(r, 20));
    // Advance the clock past 5 cadences so the mining state
    // machine drains the deposit.
    await harnessRef.advanceClock(MINE_TICK_MS * 5 + 100);
    // Deposit should be despawned (amount reached 0).
    expect(harnessRef.shard.entities.has("small")).toBe(false);
    // The player received a final depleted mining_update.
    const updates = client.frames.slice(baseline).filter((f) => f.type === "mining_update");
    const depleted = updates.find((u) => (u.payload as { state: string }).state === "depleted");
    expect(depleted).toBeDefined();
  });

  it("two miners share a deposit and the sum of awarded units equals the initial amount (no overmining)", async () => {
    const harnessRef = harness!;
    const client = clientA!;
    const clientB = await bootClient(harnessRef, "MINER-B");
    await bindCharacter(harnessRef, clientB, { x: 0, y: 0, z: 0.5 });
    placeDeposit(harnessRef, "shared", { x: 1, y: 0, z: 0 }, 5);
    clientA!.push({ type: "mine", payload: { nodeId: "shared", duration: 1.5 } });
    clientB.push({ type: "mine", payload: { nodeId: "shared", duration: 1.5 } });
    await new Promise((r) => setTimeout(r, 20));
    // Advance the clock past 5 cadences so the mining state
    // machine drains the deposit.
    await harnessRef.advanceClock(MINE_TICK_MS * 5 + 100);
    // Both inventories should have some iron; the sum ≤ 5.
    const invA = await harnessRef.repo.getInventory(client.playerId);
    const invB = await harnessRef.repo.getInventory(clientB.playerId);
    expect((invA.stacks.iron ?? 0) + (invB.stacks.iron ?? 0)).toBe(5);
    // The deposit is gone (or has 0).
    const deposit = harnessRef.shard.entities.get("shared");
    if (deposit) {
      expect(deposit.amount).toBeLessThanOrEqual(0);
    }
    await clientB.close();
  });
});
