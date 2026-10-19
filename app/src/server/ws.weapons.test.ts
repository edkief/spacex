/**
 * WS round-trip tests for the TASK-43 weapon pipeline.
 *
 * Boots a real Fastify + WebSocket server with an in-memory shard
 * so the laser / missile / select_weapon flow is exercised
 * end-to-end on the wire. Covers:
 *
 *   - Happy path: ship A fires a laser at B → `fire_ok` lands,
 *     a `combat_event { kind: 'damaged' }` is broadcast to every
 *     connection in the shard, B's shields drop by the laser
 *     damage value.
 *   - Weapon-not-equipped: scout (no missile bay) fires a
 *     missile → server pushes an `error` frame with the wire
 *     code `weapon-not-equipped`, energy is unchanged.
 *   - Anti-spam lockout: 30 fires within a 1 s window → the
 *     31st fire surfaces `weapon-locked`.
 *   - Missile fire: interceptor fires at B → `fire_ok` lands
 *     with a `projectileId`, a `kind: 'missile'` entity is
 *     added to the shard, and `combat_event` fires on impact
 *     when the contact check resolves (driven manually here).
 *   - `select_weapon` round-trip: server echoes the new
 *     `activeWeapon` via `weapon_state` so the HUD's selector
 *     flips on the same frame.
 *
 * Why the manual connection binding?
 *   `attachWs` does not bind the connection into the shard by
 *   itself — production does that through `buildGalaxy({shardFor})`
 *   which threads the `router` into `attachWs`. The production
 *   router calls `joinResolver` and registers the connection into
 *   `shard.connections`. In the unit test we skip the galaxy
 *   router (the resolver would need a full galaxy seed) and bind
 *   the connection into the shard manually after `join_system`
 *   lands. This mirrors what the sell test does for the same
 *   reason.
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
import { emptyInventory } from "@shared/world/inventoryOps.js";
import { cargoHoldFor, type CargoHold } from "@shared/world/cargo.js";

import { attachWs, type WsHandle } from "./ws.js";
import { createSqliteTestDb } from "./db/client.js";
import { createSqliteRepository } from "./db/repo.sqlite.js";
import type { Repository } from "./db/repo.js";
import { createShard } from "./shard/index.js";
import { makeAiEntity, makePlayerEntity } from "./shard/entity.js";
import { advanceMissiles, initWeaponState } from "./shard/weapons.js";
import type { ShardSystemContext, SimEntity } from "./shard/types.js";

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
  hull: number;
  shields: number;
  targetId: string | null;
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

async function boot(): Promise<Harness> {
  const app = Fastify({ logger: false });
  const { db, close } = createSqliteTestDb();
  const repo = createSqliteRepository(db);

  const entities = new Map<string, SimLike>();
  const connections = new Map<string, { entityId: string | null; playerId: string }>();
  const sentFrames: Array<{ connId: string; frame: { type: string; payload: unknown } }> = [];
  const shard: ShardLike = {
    systemId: "sys-weapons",
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
      systemId: "sys-weapons",
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
    systemId: "sys-weapons",
    context: ctx,
    send: shard.send,
    broadcast: shard.broadcast,
    autoStart: false,
    repo,
  });
  shard.entities = realShard.entities as unknown as Map<string, SimLike>;
  shard.connections = realShard.connections as unknown as Map<
    string,
    { entityId: string | null; playerId: string; connId?: string }
  >;
  shard.sim = realShard.sim;

  const ws = attachWs(app, "/ws", {
    authResolver: async (payload) => {
      const callsign = (payload as { callsign?: string }).callsign ?? "anon";
      const player = await repo.createPlayer({
        callsign,
        homeSystemId: "sys-weapons",
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

// Class max HP table (mirrors the shared/ships.ts catalog). The
// combat pipeline clamps incoming HP to these values, so the
// fixtures MUST use the class maxes rather than over-spec'ing.
const DEFAULT_HULL: Record<"scout" | "freighter" | "interceptor", number> = {
  scout: 100,
  freighter: 200,
  interceptor: 80,
};
const DEFAULT_SHIELDS: Record<"scout" | "freighter" | "interceptor", number> = {
  scout: 50,
  freighter: 80,
  interceptor: 60,
};

function entityToWire(e: SimLike): ProtocolEntityState {
  return {
    id: e.id,
    kind: e.kind as never,
    pos: [e.pos.x, e.pos.y, e.pos.z],
    vel: [e.vel.x, e.vel.y, e.vel.z],
    regime: "surface",
    hull: e.hull,
    shields: e.shields,
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
  client.send(encodeEnvelope("hello", { version: PROTOCOL_VERSION, client: "weapons-test" }));
  await waitFor(frames, "hello", 1);
  client.send(encodeEnvelope("auth", { callsign }));
  await waitFor(frames, "auth_ok", 1);
  client.send(encodeEnvelope("join_system", { systemId: "sys-weapons" }));
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
    callsign: string;
    hull?: number;
    shields?: number;
  },
): Promise<{ shipId: string; entity: SimEntity }> {
  const connRow = harness.shard.connections.get(client.connId);
  if (!connRow) throw new Error("Connection not registered");
  const shipRowId = (await harness.repo.listShipsByOwner(client.playerId))[0]?.id;
  if (!shipRowId) throw new Error("expected starter ship row");
  await harness.repo.saveShipState(shipRowId, { cargo: args.cargo });
  const shipId = `entity:${shipRowId}`;
  const classId = args.classId ?? "scout";
  const entity: SimEntity = makePlayerEntity({
    id: shipId,
    shipId: shipRowId,
    playerId: client.playerId,
    callsign: args.callsign,
    classId,
    pos: args.pos,
    vel: { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    regime: "space",
    originPlanetId: null,
    // The combat pipeline clamps HP to the class max, so defaulting
    // to 100/100 would silently get truncated to the class shield
    // cap (e.g. scout = 50) the moment the first hit lands.
    // Default to the class maxes instead so the test's
    // `initialShields - N` assertions match the wire math.
    hull: args.hull ?? DEFAULT_HULL[classId],
    shields: args.shields ?? DEFAULT_SHIELDS[classId],
    onPad: args.onPad,
    cargo: args.cargo,
  });
  // Persist into the shard so the resolver finds the entity.
  connRow.entityId = shipId;
  harness.shard.entities.set(shipId, entity as unknown as SimLike);
  // Initialise the weapon state so `handleFire` doesn't lazy-init.
  initWeaponState(entity);
  return { shipId, entity };
}

function bindAiTarget(
  harness: Harness,
  args: {
    id: string;
    classId: "scout" | "freighter" | "interceptor";
    pos: { x: number; y: number; z: number };
    hull?: number;
    shields?: number;
  },
): SimEntity {
  const entity: SimEntity = makeAiEntity({
    id: args.id,
    classId: args.classId,
    pos: args.pos,
  });
  entity.hull = args.hull ?? DEFAULT_HULL[args.classId];
  entity.shields = args.shields ?? DEFAULT_SHIELDS[args.classId];
  harness.shard.entities.set(args.id, entity as unknown as SimLike);
  return entity;
}

describe("ws: weapon fire pipeline (TASK-43)", () => {
  let harness: Harness | null = null;
  let attacker: ClientHandle | null = null;
  let target: ClientHandle | null = null;
  let spectator: ClientHandle | null = null;

  beforeEach(async () => {
    harness = await boot();
    attacker = await bootClient(harness, "PILOT-A");
    target = await bootClient(harness, "PILOT-B");
    spectator = await bootClient(harness, "PILOT-C");
  });

  afterEach(async () => {
    await attacker?.close();
    await target?.close();
    await spectator?.close();
    if (harness) {
      await harness.ws.close();
      await harness.app.close();
      harness.closeDb();
    }
    harness = null;
    attacker = null;
    target = null;
    spectator = null;
  });

  it("happy path: in-space laser hit → fire_ok + combat_event + B's shields drop", async () => {
    if (!harness || !attacker || !target) throw new Error("harness missing");

    const { shipId: attackerShipId } = await bindShip(harness, attacker, {
      pos: { x: 0, y: 0, z: 0 },
      onPad: null,
      cargo: cargoHoldFor("scout"),
      classId: "scout",
      callsign: "Alpha",
    });
    const { shipId: targetShipId } = await bindShip(harness, target, {
      pos: { x: 100, y: 0, z: 0 },
      onPad: null,
      cargo: cargoHoldFor("scout"),
      classId: "scout",
      callsign: "Bravo",
    });

    const initialShields =
      /** @type {SimLike} */ harness.shard.entities.get(targetShipId)?.shields ?? 50;

    // Fire at B's ship id.
    attacker.push({ type: "fire", payload: { weapon: "laser", targetId: targetShipId } });

    // Attacker gets the fire_ok ack.
    await waitFor(attacker.frames, "fire_ok", 1);
    const ack = attacker.frames.find((f) => f.type === "fire_ok");
    if (!ack) throw new Error("missing fire_ok");
    const ackPayload = ack.payload as {
      weapon: string;
      kind: string;
      damage: number;
      projectileId: string | null;
      energy: number;
      denialCode: string | null;
    };
    expect(ackPayload.weapon).toBe("laser");
    expect(ackPayload.kind).toBe("laser");
    expect(ackPayload.damage).toBe(8);
    expect(ackPayload.projectileId).toBeNull();
    expect(ackPayload.energy).toBe(98);
    expect(ackPayload.denialCode).toBeNull();

    // Attacker gets a `weapon_state` push after the fired energy.
    await waitFor(attacker.frames, "weapon_state", 1);

    // B's shields drop by 8.
    const targetAfter = /** @type {SimLike} */ harness.shard.entities.get(targetShipId);
    // Capture how many `damaged` frames landed on the target.
    const damages = harness.sentFrames.filter((s) => {
      const p = s.frame.payload as { kind?: string; target?: string };
      return s.frame.type === "combat_event" && p.kind === "damaged" && p.target === targetShipId;
    });
    // 3 connections × 1 damaged broadcast = 3 sentFrame entries.
    expect(damages.length).toBe(3);
    expect(targetAfter?.shields).toBe(initialShields - 8);

    // Every connection in the shard (A + B + C) receives the
    // `combat_event { kind: 'damaged' }` broadcast — that's the
    // task acceptance ("C sees the FX events").
    await waitFor(target.frames, "combat_event", 1);
    await waitFor(spectator!.frames, "combat_event", 1);
    const damaged = target.frames.find(
      (f) => f.type === "combat_event" && (f.payload as { kind?: string }).kind === "damaged",
    );
    expect(damaged).toBeDefined();
    expect((damaged?.payload as { target: string }).target).toBe(targetShipId);
    expect((damaged?.payload as { amount: number }).amount).toBe(8);
    void attackerShipId;
  });

  it("scout firing a missile is denied with weapon-not-equipped", async () => {
    if (!harness || !attacker || !target) throw new Error("harness missing");

    const { shipId: targetShipId } = await bindShip(harness, target, {
      pos: { x: 100, y: 0, z: 0 },
      onPad: null,
      cargo: cargoHoldFor("scout"),
      classId: "scout",
      callsign: "Bravo",
    });
    await bindShip(harness, attacker, {
      pos: { x: 0, y: 0, z: 0 },
      onPad: null,
      cargo: cargoHoldFor("scout"),
      classId: "scout", // scout has only laser, no missiles.
      callsign: "Alpha",
    });

    attacker.push({ type: "fire", payload: { weapon: "missile", targetId: targetShipId } });

    // No fire_ok is pushed on a denial; instead the server emits
    // an `error` frame with the wire code.
    await waitFor(attacker.frames, "error", 1);
    const err = attacker.frames.find((f) => f.type === "error");
    expect(err).toBeDefined();
    expect((err?.payload as { code: string }).code).toBe("weapon-not-equipped");
    const ackFrames = attacker.frames.filter((f) => f.type === "fire_ok");
    expect(ackFrames).toHaveLength(0);

    // B's shields are unchanged.
    const targetAfter = /** @type {SimLike} */ harness.shard.entities.get(targetShipId);
    expect(targetAfter?.shields).toBe(DEFAULT_SHIELDS.scout);
  });

  it("anti-spam lockout: 31 fires within a 1 s window → 31st denied as weapon-locked", async () => {
    if (!harness || !attacker || !target) throw new Error("harness missing");

    const { shipId: targetShipId } = await bindShip(harness, target, {
      pos: { x: 100, y: 0, z: 0 },
      onPad: null,
      cargo: cargoHoldFor("scout"),
      classId: "scout",
      callsign: "Bravo",
    });
    await bindShip(harness, attacker, {
      pos: { x: 0, y: 0, z: 0 },
      onPad: null,
      cargo: cargoHoldFor("scout"),
      classId: "scout",
      callsign: "Alpha",
    });

    // Drive 31 fires in tight loop. The anti-spam detector walks
    // the rolling 1 s window on every fire attempt, so once we
    // exceed 30 in 1 s the next attempt surfaces `weapon-locked`
    // regardless of the per-weapon cooldown outcome. We pass a
    // real targetId so the fire attempt actually exercises the
    // "counter ticks up" path (a no-target fire would reject
    // before the counter advances because resolveHit fails first).
    for (let i = 0; i < 30; i += 1) {
      attacker.push({ type: "fire", payload: { weapon: "laser", targetId: targetShipId } });
    }

    // Wait for the rate-limited errors to land so we can reliably
    // look at the codes array without the lockout error arriving
    // between `waitFor(1)` and the assertion.
    await waitFor(attacker.frames, "error", 25);
    // Brief settle for the last few rate-limited errors before
    // we send the lockout-triggering fire.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Fire #31 — the lockout window should be active now.
    attacker.push({ type: "fire", payload: { weapon: "laser", targetId: targetShipId } });

    // Wait specifically for the weapon-locked error to land.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const codes = attacker.frames
        .filter((f) => f.type === "error")
        .map((e) => (e.payload as { code: string }).code);
      if (codes.includes("weapon-locked")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const errors = attacker.frames.filter((f) => f.type === "error");
    const codes = errors.map((e) => (e.payload as { code: string }).code);
    // The 31st fire (this one) must be `weapon-locked`. There may
    // also be earlier `rate-limited` codes from the loop — those
    // are expected because the per-weapon cooldown (333 ms) fires
    // before the anti-spam detector sees the rolling window.
    expect(codes).toContain("weapon-locked");
  });

  it("select_weapon round-trip: server echoes the new activeWeapon via weapon_state", async () => {
    if (!harness || !attacker) throw new Error("harness missing");

    await bindShip(harness, attacker, {
      pos: { x: 0, y: 0, z: 0 },
      onPad: null,
      cargo: cargoHoldFor("scout"),
      classId: "interceptor",
      callsign: "Alpha",
    });

    attacker.push({ type: "select_weapon", payload: { weapon: "missile" } });
    await waitFor(attacker.frames, "weapon_state", 1);

    const stateFrames = attacker.frames.filter((f) => f.type === "weapon_state");
    const last = stateFrames[stateFrames.length - 1];
    expect(last).toBeDefined();
    expect((last?.payload as { activeWeapon: string }).activeWeapon).toBe("missile");

    // The bindShip() init seeded energy=100; the select_weapon
    // path doesn't deduct energy so the bar is still 100.
    expect((last?.payload as { energy: number }).energy).toBe(100);
  });

  it("missile fire: interceptor spawns a projectile entity that the server can advance", async () => {
    if (!harness || !attacker || !target) throw new Error("harness missing");

    const { shipId: targetShipId } = await bindShip(harness, target, {
      pos: { x: 200, y: 0, z: 0 },
      onPad: null,
      cargo: cargoHoldFor("scout"),
      classId: "scout",
      callsign: "Bravo",
    });
    await bindShip(harness, attacker, {
      pos: { x: 0, y: 0, z: 0 },
      onPad: null,
      cargo: cargoHoldFor("scout"),
      classId: "interceptor", // interceptor has missiles
      callsign: "Alpha",
    });

    attacker.push({ type: "fire", payload: { weapon: "missile", targetId: targetShipId } });
    await waitFor(attacker.frames, "fire_ok", 1);

    const ack = attacker.frames.find((f) => f.type === "fire_ok");
    const ackPayload = ack?.payload as {
      weapon: string;
      kind: string;
      damage: number;
      projectileId: string | null;
      energy: number;
    };
    expect(ackPayload.kind).toBe("missile");
    expect(ackPayload.weapon).toBe("missile");
    expect(ackPayload.projectileId).toBeTruthy();
    expect(ackPayload.energy).toBe(90); // missile costs 10 energy

    // The projectile is registered on the shard.
    const projectileId = ackPayload.projectileId!;
    const projectile = /** @type {SimLike} */ harness.shard.entities.get(projectileId);
    expect(projectile).toBeDefined();
    expect(projectile?.kind).toBe("missile");
  });

  it("AI target takes splash damage when a missile lands within 5 m", async () => {
    if (!harness || !attacker) throw new Error("harness missing");

    await bindShip(harness, attacker, {
      pos: { x: 0, y: 0, z: 0 },
      onPad: null,
      cargo: cargoHoldFor("scout"),
      classId: "interceptor",
      callsign: "Alpha",
    });
    // Two AI targets in the splash radius (5 m). The contact
    // resolution sets the missile at the *primary* target's pos
    // when it detonates, then walks the splash list — both AIs
    // should be in that walk.
    const aiA = bindAiTarget(harness, {
      id: "ai-a",
      classId: "scout",
      pos: { x: 100, y: 0, z: 0 },
      shields: 50,
      hull: 50,
    });
    const aiB = bindAiTarget(harness, {
      id: "ai-b",
      classId: "scout",
      pos: { x: 96, y: 3, z: 0 }, // within 5 m of the impact point
      shields: 50,
      hull: 50,
    });

    attacker.push({ type: "fire", payload: { weapon: "missile", targetId: "ai-a" } });
    await waitFor(attacker.frames, "fire_ok", 1);

    // The missile should detonate in ≤ 5 s (120 u/s, 100 m → ~1 s).
    // The test bypasses the sim loop (autoStart:false) and drives
    // `advanceMissiles` directly so the homing + contact check
    // resolves deterministically without a wall-clock wait.
    let missileResult = { despawned: 0, impacted: 0 };
    for (let i = 0; i < 30; i += 1) {
      missileResult = advanceMissiles(
        harness.shard as unknown as Parameters<typeof advanceMissiles>[0],
        Date.now(),
      );
      if (missileResult.impacted > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // Both AI targets received `damaged` broadcasts.
    const allDamaged = harness.sentFrames.filter((s) => s.frame.type === "combat_event");
    const damagedTargets = new Set(
      allDamaged
        .map((s) => s.frame.payload as { kind?: string; target?: string })
        .filter((p) => p.kind === "damaged")
        .map((p) => p.target),
    );
    expect(missileResult.impacted).toBeGreaterThanOrEqual(1);
    expect(damagedTargets.has("ai-a")).toBe(true);
    expect(damagedTargets.has("ai-b")).toBe(true);
    void aiA;
    void aiB;
  });
});
