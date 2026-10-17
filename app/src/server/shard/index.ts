/**
 * System shard — TASK-13 public surface.
 *
 * A `Shard` is the authoritative runtime container for one star
 * system. This module wires the sim loop to the entity registry,
 * the per-connection input slots, and the broadcast hooks. The
 * router (TASK-11) will instantiate one per active system; the
 * WS handler layer in `src/server/ws.handlers.ts` will route
 * `input` messages into the right shard's connection slot via
 * `shard.connections.get(connId)?.pendingInput = ...`.
 *
 * Public API:
 *   - `createShard({...})` — construct a new shard, start the sim loop.
 *   - `addConnection(shard, conn)` — register a WS connection.
 *   - `removeConnection(shard, connId)` — drop a disconnected client.
 *   - `spawnShip(shard, args)` — mint a player entity on join.
 *   - `spawnAiShip(shard, args)` — mint an AI entity (stub state machine).
 *   - `pushPlayerInput(shard, connId, input)` — push a player input.
 *   - `broadcastSizeFor(shard, entities)` — estimate broadcast bytes.
 *   - `simulateNTicks(shard, n)` — TEST-ONLY: drive the sim manually.
 *
 * The shard is intentionally transport-agnostic: it has no
 * `ws.WebSocket` references. The router injects `send` and `broadcast`
 * callbacks (already part of `Shard`). Tests inject recorders.
 *
 * @see ./types.ts for the type-level surface.
 * @see ./sim.ts for the tick loop.
 * @see ./entity.ts for the per-entity bookkeeping.
 * @see ./input-queue.ts for the seq-protected slot.
 */
import { EventEmitter } from "node:events";

import type { ProtocolEntityState, ProtocolShipClassId } from "@shared/protocol/index.js";

import { entityToWire, makeAiEntity, makeEntityId, makePlayerEntity } from "./entity.js";
import { enqueueInput } from "./input-queue.js";
import { SimLoop } from "./sim.js";
import type {
  ConnSender,
  Shard,
  ShardConnection,
  ShardSystemContext,
  SimEntity,
  SimTickObserver,
  SnapshotBroadcaster,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Soft warning threshold for broadcast payload size (bytes). Spec calls
 * out > 32 KB as the tuning input for TASK-60.
 */
export const BROADCAST_WARN_BYTES = 32 * 1024;

// ---------------------------------------------------------------------------
// createShard
// ---------------------------------------------------------------------------

/**
 * Factory. Builds and *starts* the sim loop. Caller is responsible
 * for `shard.shutdown()` once the shard is no longer needed.
 */
export function createShard(args: {
  systemId: string;
  context: ShardSystemContext;
  send: ConnSender;
  broadcast: SnapshotBroadcaster;
  onTickObserver?: SimTickObserver | null;
  persist?: { markDirty?: Shard["persist"]["markDirty"] };
  events?: EventEmitter;
  logger?: Pick<Console, "warn" | "debug" | "error">;
  /** When false, the loop is constructed but `start()` is deferred. */
  autoStart?: boolean;
}): Shard {
  const events = args.events ?? new EventEmitter();
  const shard: Shard = {
    systemId: args.systemId,
    context: args.context,
    sim: undefined as unknown as SimLoop, // populated below to break the self-cycle
    connections: new Map(),
    entities: new Map(),
    dirtyShipSpawns: new Map(),
    persist: args.persist ?? {},
    events,
    send: args.send,
    broadcast: args.broadcast,
    onTickObserver: args.onTickObserver ?? null,
    stats: () => {
      // The shape is sealed below; this stub is replaced once `sim`
      // is constructed.
      throw new Error("shard.stats() called before sim constructed");
    },
    shutdown: () => {
      // same — replaced below.
    },
  };
  const sim = new SimLoop(shard, {
    buildSnapshot: () => buildSnapshotEntities(shard),
    onSnapshot: (tick, bytes) => {
      if (bytes > BROADCAST_WARN_BYTES) {
        args.logger?.warn?.(
          `[drift-shard:${shard.systemId}] tick ${tick} broadcast ${bytes} B >= ${BROADCAST_WARN_BYTES} B tuning-budget`,
        );
      }
    },
    onTick: args.onTickObserver ?? undefined,
    logger: args.logger,
  });
  // Wire the sim into the shard. We construct the `Shard` shape
  // above with `sim: undefined` because `SimLoop` needs the shard
  // back-reference; this loop breaks the cycle.
  (shard as unknown as { sim: SimLoop }).sim = sim;
  // stats() calls shard.sim.stats(); re-bind so the closure sees the
  // real `sim`.
  (shard as unknown as { stats: () => ReturnType<SimLoop["stats"]> }).stats = () => sim.stats();
  (shard as unknown as { shutdown: () => void }).shutdown = () => {
    sim.stop();
    shard.connections.clear();
    shard.entities.clear();
  };
  if (args.autoStart !== false) sim.start();
  return shard;
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

/**
 * Register a WS connection with the shard. Pending inputs from this
 * connection start being consumed on the next tick.
 */
export function addConnection(shard: Shard, conn: ShardConnection): void {
  shard.connections.set(conn.connId, conn);
}

/**
 * Drop a WS connection. The entity (if any) survives — players can
 * re-enter the same ship on reconnect (TASK-17).
 */
export function removeConnection(shard: Shard, connId: string): void {
  shard.connections.delete(connId);
}

// ---------------------------------------------------------------------------
// Entity spawning
// ---------------------------------------------------------------------------

/**
 * Spawn a player-owned entity and link it to its connection. Idempotent
 * on entity id: a second call returns the existing entity.
 *
 * `pos` is world-relative to the system origin; `vel` defaults to
 * zero. The integrator will mutate pos/vel on every tick.
 */
export function spawnShip(
  shard: Shard,
  args: {
    shipId: string;
    playerId: string;
    callsign: string;
    classId: ProtocolShipClassId;
    hull: number;
    shields: number;
    pos: { x: number; y: number; z: number };
    vel?: { x: number; y: number; z: number };
    quat?: { x: number; y: number; z: number; w: number };
    regime?: SimEntity["regime"];
    originPlanetId?: string | null;
    onPad?: string | null;
    /** Connection id to bind the entity to. If omitted, the entity stays orphaned. */
    bindConnId?: string;
  },
): SimEntity {
  const id = makeEntityId(args.shipId);
  const existing = shard.entities.get(id);
  if (existing !== undefined) {
    if (args.bindConnId !== undefined) {
      const conn = shard.connections.get(args.bindConnId);
      if (conn) conn.entityId = id;
    }
    return existing;
  }
  const entity = makePlayerEntity({
    id,
    shipId: args.shipId,
    playerId: args.playerId,
    callsign: args.callsign,
    classId: args.classId,
    hull: args.hull,
    shields: args.shields,
    pos: args.pos,
    vel: args.vel ?? { x: 0, y: 0, z: 0 },
    quat: args.quat ?? { x: 0, y: 0, z: 0, w: 1 },
    regime: args.regime ?? "space",
    originPlanetId: args.originPlanetId ?? null,
    onPad: args.onPad ?? null,
  });
  shard.entities.set(id, entity);
  if (args.bindConnId !== undefined) {
    const conn = shard.connections.get(args.bindConnId);
    if (conn) conn.entityId = id;
  }
  return entity;
}

/**
 * Spawn an AI ship — populated by the future AI state machine (TASK-46)
 * but exported now so the snapshot / entity-update broadcast path is
 * exercised end-to-end with multiple entity kinds.
 */
export function spawnAiShip(
  shard: Shard,
  args: {
    id: string;
    classId: ProtocolShipClassId;
    pos: { x: number; y: number; z: number };
  },
): SimEntity {
  const existing = shard.entities.get(args.id);
  if (existing !== undefined) return existing;
  const entity = makeAiEntity(args);
  shard.entities.set(args.id, entity);
  return entity;
}

/**
 * Remove an entity from the shard. Broadcasts will not include it on
 * subsequent ticks.
 */
export function removeEntity(shard: Shard, entityId: string): boolean {
  return shard.entities.delete(entityId);
}

// ---------------------------------------------------------------------------
// Input plumbing
// ---------------------------------------------------------------------------

/**
 * Push a player input for the given connection. Returned object
 * mirrors the underlying `enqueueInput` decision so the WS handler
 * can ack or silently drop without depending on the input-queue module
 * directly.
 */
export function pushPlayerInput(
  shard: Shard,
  connId: string,
  input: ShardConnection["pendingInput"] & object,
): { accepted: boolean; reason?: "stale-seq" | "malformed" } {
  const conn = shard.connections.get(connId);
  if (!conn) return { accepted: false, reason: "malformed" };
  // Cast through `unknown` so the input shape stays a private detail
  // of this module while still benefiting from `enqueueInput`'s
  // narrow type signature.
  return enqueueInput(conn, input as never, () => {
    shard.events.emit("input-debug", { connId, seq: (input as { seq: number }).seq });
  });
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

/**
 * Build the `EntityState` array for the current tick. The sim loop
 * calls this lazily (only when broadcasting) so the per-tick hot
 * path doesn't pay the serializer cost on the 50% of ticks that
 * don't broadcast.
 */
export function buildSnapshotEntities(shard: Shard): ProtocolEntityState[] {
  const out: ProtocolEntityState[] = [];
  for (const entity of shard.entities.values()) {
    out.push(entityToWire(entity));
  }
  return out;
}

/**
 * Estimate the broadcast byte budget — `JSON.stringify` once and
 * measure the byte length. Used by the sim loop and by tests to
 * assert the > 32 KB tuning threshold.
 */
export function broadcastSizeFor(_shard: Shard, entities: ProtocolEntityState[]): number {
  // We deliberately use the wire serializer shape (a tuple of
  // numbers for pos/vel) so the byte count is what the client would
  // actually see on the wire.
  return Buffer.byteLength(JSON.stringify(entities), "utf8");
}

/**
 * Helper: send one entity_update frame to one connection via the
 * shard's `send` hook. Lets the test harness subscribe without
 * wiring a full WS server.
 */
export function sendEntityUpdate(
  shard: Shard,
  connId: string,
  tick: number,
  entities: ProtocolEntityState[],
): void {
  shard.send(connId, {
    type: "entity_update",
    payload: {
      systemId: shard.systemId,
      tick,
      entities,
    },
  });
}

// ---------------------------------------------------------------------------
// Test helper — drive the sim loop manually for unit tests.
// ---------------------------------------------------------------------------

/**
 * Run `n` logical ticks. Each call advances the accumulator once and
 * returns the delta. Test-only: production uses the `setTimeout(0)`
 * chain.
 */
export function simulateNTicks(
  shard: Shard,
  n: number,
): {
  stepsRun: number[];
  snapshots: number[];
} {
  const stepsRun: number[] = [];
  const snapshots: number[] = [];
  for (let i = 0; i < n; i++) {
    const result = shard.sim.tick();
    stepsRun.push(result.stepsRun);
    if (result.didSnapshot) snapshots.push(shard.sim.currentTick);
  }
  return { stepsRun, snapshots };
}

// ---------------------------------------------------------------------------
// Re-exports — convenient barrel for downstream consumers
// ---------------------------------------------------------------------------

export {
  SERVER_TICK_HZ,
  TICK_MS,
  TICK_S,
  MAX_CATCHUP_STEPS,
  SNAPSHOT_EVERY_N_TICKS,
} from "./sim.js";
export { entityToWire, makeEntityId } from "./entity.js";
export { enqueueInput, STALE_LOG_THRESHOLD } from "./input-queue.js";
export { TickHistogram, DEFAULT_CAPACITY } from "./histogram.js";
export { SimLoop } from "./sim.js";
export type {
  Shard,
  ShardConnection,
  ShardSystemContext,
  SimEntity,
  SimTickObserver,
  SimTickStats,
  PlayerInput,
  ConnSender,
  SnapshotBroadcaster,
  DirtyMarker,
} from "./types.js";
