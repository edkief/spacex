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

import { ENTER_SHIP_MAX_VELOCITY_U_S, ENTER_SHIP_RANGE_M } from "@shared/world/enterShip.js";
import type { ProtocolEntityState, ProtocolShipClassId } from "@shared/protocol/index.js";
import type { CargoHold } from "@shared/world/cargo.js";
import { ChatRingBuffer, type ChatEntry } from "../chat.js";

import {
  characterSpawnPos,
  entityToWire,
  makeAiEntity,
  makeCharacterEntity,
  makeCharacterId,
  makeEntityId,
  makePlayerEntity,
  makeWreckEntity,
  makeWreckId,
} from "./entity.js";
import { WRECK_TTL_MS } from "./combat.js";
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
import type { Repository } from "../db/repo.js";

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
  /**
   * TASK-12: initial generation counter (defaults to 1). The router
   * bumps this on every respawn so reconnect-storm tests can prove
   * that no DB reload happened mid-flight.
   */
  generation?: number;
  /**
   * TASK-25: optional clock for the sim loop. Production uses
   * `performance.now()` (default); tests inject a fake clock so
   * `simulateNTicks(...)` actually advances the accumulator.
   */
  clock?: () => number;
  /**
   * TASK-38: repository handle so the mining state machine can
   * persist inventory + deposit deltas. Production threads the
   * live repository through `GalaxyRouter` (TASK-11) so every
   * shard starts wired; tests that don't exercise mining can
   * leave it unset.
   */
  repo?: Repository | null;
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
    generation: args.generation ?? 1,
    // TASK-16: per-shard chat log. Fresh per shard (reaped shards
    // re-create from scratch so cross-system chat never leaks).
    chatLog: new ChatRingBuffer(),
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
    clock: args.clock,
    repo: args.repo ?? null,
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
    shard.chatLog.clear();
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
    /**
     * TASK-39: cargo hold carried by the ship. Optional —
     * defaults to an empty hold sized to the class. The hydrate
     * path threads the persisted `ShipRow.cargo` here so a restart
     * resumes the hold at the last saved shape.
     */
    cargo?: CargoHold;
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
    cargo: args.cargo,
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
 * Spawn a wreck entity at the given position. Idempotent on id — a
 * second call returns the existing wreck. Used by `applyCombatDamage`
 * (TASK-23) when a ship is destroyed and re-exposed here so tests
 * can build wreck-only fixtures without going through damage.
 *
 * `wreckExpiresAt` defaults to `Date.now() + WRECK_TTL_MS` (600 s);
 * tests can override via the `nowMs` parameter.
 */
export function spawnWreck(
  shard: Shard,
  args: {
    id?: string;
    classId: ProtocolShipClassId;
    pos: { x: number; y: number; z: number };
    quat?: { x: number; y: number; z: number; w: number };
    sourceEntityId?: string;
    nowMs?: number;
  },
): SimEntity {
  const now = args.nowMs ?? Date.now();
  const id = args.id ?? makeWreckId(args.sourceEntityId ?? `unknown-${now}`);
  const existing = shard.entities.get(id);
  if (existing !== undefined) return existing;
  const wreck = makeWreckEntity({
    id,
    classId: args.classId,
    pos: args.pos,
    quat: args.quat,
    wreckExpiresAt: now + WRECK_TTL_MS,
  });
  shard.entities.set(id, wreck);
  return wreck;
}

/**
 * Remove an entity from the shard. Broadcasts will not include it on
 * subsequent ticks.
 */
export function removeEntity(shard: Shard, entityId: string): boolean {
  return shard.entities.delete(entityId);
}

/**
 * TASK-31: spawn a character entity on a docked ship. Idempotent —
 * a second call returns the existing character (the spec's "one
 * player per ship" rule means each player owns at most one character
 * at a time).
 *
 * The character inherits the ship's pad id (`onPad`) so the renderer
 * can keep showing the "Ship is docked here" prompt until the
 * character moves away (TASK-32 wires the distance cull). The
 * `pos` is the ship's position offset by `CHARACTER_SIDE_OFFSET_M`
 * along the ship's local +X axis, on the pad plane.
 */
export function spawnCharacter(
  shard: Shard,
  args: {
    playerId: string;
    callsign: string;
    ship: SimEntity;
    bindConnId?: string;
  },
): SimEntity {
  const id = makeCharacterId(args.playerId);
  const existing = shard.entities.get(id);
  if (existing !== undefined) {
    if (args.bindConnId !== undefined) {
      const conn = shard.connections.get(args.bindConnId);
      if (conn) conn.entityId = id;
    }
    return existing;
  }
  const charPos = characterSpawnPos(args.ship);
  const character = makeCharacterEntity({
    id,
    playerId: args.playerId,
    callsign: args.callsign,
    shipId: args.ship.id,
    pos: charPos,
    quat: args.ship.quat,
    regime: "surface",
    originPlanetId: args.ship.originPlanetId,
    onPad: args.ship.onPad,
  });
  shard.entities.set(id, character);
  if (args.bindConnId !== undefined) {
    const conn = shard.connections.get(args.bindConnId);
    if (conn) conn.entityId = id;
  }
  return character;
}

/**
 * TASK-31: process a `disembark` request from a player connection.
 *
 * Steps (spec acceptance):
 *   1. Look up the connection's bound entity (must be a player ship).
 *   2. Verify the ship is docked (`onPad !== null`). Otherwise
 *      return `{ ok: false, code: 'not-docked' }` so the WS handler
 *      can emit a structured error frame.
 *   3. Spawn the character entity at `ship.pos + sideOffset`.
 *   4. Switch the connection's `entityId` from the ship to the
 *      character so subsequent `input` frames route into the
 *      character (TASK-32 will give the character walk/look
 *      meaning; for v1 the character is idle).
 *   5. Force a snapshot so every client sees the character appear
 *      on the next broadcast (≤ 100 ms after the disembark lands).
 *
 * The ship entity stays in the registry — the spec calls out that
 * "the ship remains docked and controllable-by-others state is
 * unchanged (single player per ship in v1 — the ship simply
 * becomes idle)". The sim loop stops integrating the ship because
 * its connection's `entityId` now points at the character (the
 * integration loop only touches entities whose `entityId` matches
 * a connection's bound entity).
 *
 * Returns:
 *   - `{ ok: true, ship, character }` on success.
 *   - `{ ok: false, code: 'not-docked' | 'no-ship' | 'unknown' }`
 *     on failure so the WS handler can map to a wire error code.
 */
export function handleDisembark(
  shard: Shard,
  args: { connId: string; nowMs?: number },
): DisembarkResult {
  const conn = shard.connections.get(args.connId);
  if (!conn) return { ok: false, code: "unknown", message: "Connection not in shard" };
  if (conn.entityId === null)
    return { ok: false, code: "no-ship", message: "No ship bound to connection" };
  const ship = shard.entities.get(conn.entityId);
  if (!ship) return { ok: false, code: "no-ship", message: "Bound entity missing" };
  if (ship.kind !== "player") {
    return { ok: false, code: "no-ship", message: "Bound entity is not a player ship" };
  }
  if (ship.onPad === null || ship.onPad === undefined) {
    return { ok: false, code: "not-docked", message: "Ship is not docked" };
  }
  const character = spawnCharacter(shard, {
    playerId: conn.playerId,
    callsign: conn.callsign,
    ship,
    bindConnId: conn.connId,
  });
  // Force a snapshot so every connection in the shard sees the
  // character appear on the next broadcast (≤ 100 ms). Without
  // this nudge the player could press E + alt-tab before the next
  // 10 Hz tick and watch an empty pad for a few hundred ms.
  const tick = shard.sim.currentTick;
  const entities = buildSnapshotEntities(shard);
  shard.broadcast(tick, entities, {});
  return { ok: true, ship, character };
}

/**
 * TASK-31: discriminated result of `handleDisembark`. The WS
 * handler maps `code` to the wire error code so a malformed
 * disembark surfaces as a structured `error` frame instead of a
 * silent drop.
 */
export type DisembarkResult =
  | {
      ok: true;
      ship: SimEntity;
      character: SimEntity;
    }
  | {
      ok: false;
      code: "not-docked" | "no-ship" | "unknown";
      message: string;
    };

// ---------------------------------------------------------------------------
// Re-entry (TASK-35) — `handleEnterShip`
// ---------------------------------------------------------------------------

/**
 * TASK-35: process an `enter_ship` request from a player connection.
 *
 * Steps (mirror of TASK-31's `handleDisembark`, in reverse):
 *
 *   1. Look up the connection's bound entity (must be a `character`).
 *   2. Read the character's `onShipId` to find the docked ship the
 *      player owns.
 *   3. **Ownership check:** `ship.playerId` must equal the
 *      connection's `playerId`. v1 doesn't support boarding other
 *      players' ships — a deliberate scope cut.
 *   4. **Velocity check:** `|ship.vel| < ENTER_SHIP_MAX_VELOCITY_U_S`.
 *      A drifting / idle ship (vel = 0 on the integration's
 *      magnitude metric) can be re-claimed; a moving one cannot.
 *   5. **Range check (reconnect safety):** when the connection
 *      returns after a disconnect, the character may live in a
 *      stale spot. We *don't* enforce range on the server side
 *      here because TASK-31's persistence pattern guarantees the
 *      character is on the same pad as the ship — but a test
 *      seam (re-entry at any range) keeps the surface predictable.
 *      The 5 m radius lives in the client prompt and is documented
 *      by `ENTER_SHIP_RANGE_M` for future rigour; this v1 trusts
 *      the persistence + the prologue tests.
 *   6. Switch the connection's `entityId` from the character to
 *      the ship, remove the character from the registry, force a
 *      snapshot. The owning player's next input frame routes into
 *      the ship again.
 *   7. Push an `enter_ship_ok { shipId }` ack so the client can
 *      surface a "Boarded <callsign>" toast.
 *
 * The handler is idempotent (TASK-35 acceptance: "double
 * enter_ship → second is `{code:'already-in-ship'}`"): calling it
 * when the connection's entity is already a ship returns
 * `{ok:false, code:'already-in-ship'}` without mutating state.
 *
 * On the wire, the rejection codes are exactly:
 *
 *   `'no-entity'`        — connection has no bound entity.
 *   `'not-on-foot'`      — connection's entity isn't a character.
 *   `'no-ship'`          — character lacks `onShipId` (corrupt).
 *   `'not-owner'`        — ship belongs to a different player.
 *   `'ship-moving'`      — ship velocity ≥ ENTER_SHIP_MAX_VELOCITY_U_S.
 *   `'already-in-ship'`  — connection is already bound to a ship.
 *   `'unknown'`          — connection not in the shard.
 */
export function handleEnterShip(
  shard: Shard,
  args: { connId: string; nowMs?: number },
  opts: { rangeM?: number } = {},
): EnterShipResult {
  const conn = shard.connections.get(args.connId);
  if (!conn) return { ok: false, code: "unknown", message: "Connection not in shard" };

  // Idempotency: double-tap `enter_ship` while already in ship is a
  // structured error, not a silent success. The owning client uses
  // the `enter_ship_ok` ack for the genuine path; this is the
  // "defensive" path for a misfiring prompt.
  if (conn.entityId !== null) {
    const existing = shard.entities.get(conn.entityId);
    if (existing && existing.kind === "player") {
      return {
        ok: false,
        code: "already-in-ship",
        message: "Connection is already bound to a ship",
      };
    }
    if (existing && existing.kind === "character") {
      // Continue — the happy path.
    } else if (existing && existing.kind === "ai") {
      // Defensive: AI entities can't be controlled by players.
      return {
        ok: false,
        code: "not-on-foot",
        message: "Connection is bound to an AI ship",
      };
    } else if (existing === undefined) {
      // entityId is set but the entity is gone (stale character
      // after persistence GC, or an interrupted disconnect). Reset
      // the connection's binding and fall through to the failure
      // paths below so the caller sees the truth.
      conn.entityId = null;
      return {
        ok: false,
        code: "no-entity",
        message: "Stale entity binding cleared",
      };
    }
  }
  if (conn.entityId === null) {
    return { ok: false, code: "no-entity", message: "No character bound to connection" };
  }
  const character = shard.entities.get(conn.entityId);
  if (!character) {
    // Defensive: entityId pointed at something the registry
    // doesn't have. Clear the binding so future frames don't
    // crash the input queue.
    conn.entityId = null;
    return { ok: false, code: "no-entity", message: "Character not in registry" };
  }
  if (character.kind !== "character") {
    return {
      ok: false,
      code: "not-on-foot",
      message: "Connection's active entity is not a character",
    };
  }
  const shipId = character.onShipId;
  if (!shipId) {
    return {
      ok: false,
      code: "no-ship",
      message: "Character has no associated ship id",
    };
  }
  const ship = shard.entities.get(shipId);
  if (!ship) {
    return {
      ok: false,
      code: "no-ship",
      message: "Associated ship not in registry",
    };
  }
  if (ship.kind !== "player") {
    return {
      ok: false,
      code: "no-ship",
      message: "Associated entity is not a player ship",
    };
  }
  // Ownership: v1 single-player-per-ship. Future tasks can relax
  // this for party-boarding flows.
  if (ship.playerId !== conn.playerId) {
    return {
      ok: false,
      code: "not-owner",
      message: "Ship belongs to a different player",
    };
  }
  // Range check (server-authoritative, NOT cone-limited — the
  // spec calls for "within 5 m of its hull", and a cone would
  // reject a player standing on the *back* side of their ship).
  // The TASK-31 persistence pattern guarantees the character
  // spawns on the same pad as the ship, so the only way range
  // fails is if the player walked far away while on foot — and
  // that walking reads the shared `character.ts` integrator
  // (TASK-32). We accept `rangeM` from the options so tests can
  // verify; production uses `ENTER_SHIP_RANGE_M` from the shared
  // module.
  const rangeM = opts.rangeM ?? ENTER_SHIP_RANGE_M;
  const dx = character.pos.x - ship.pos.x;
  const dy = character.pos.y - ship.pos.y;
  const dz = character.pos.z - ship.pos.z;
  const distSq = dx * dx + dy * dy + dz * dz;
  if (distSq > rangeM * rangeM) {
    return {
      ok: false,
      code: "out-of-range",
      message: `Character is ${Math.sqrt(distSq).toFixed(2)} m from ship (max ${rangeM})`,
    };
  }
  // Velocity check: spec "drifting ship can be re-claimed; a moving
  // ship cannot". Uses the magnitude metric `integrateShip` reads
  // (sqrt(vel.x² + vel.y² + vel.z²)).
  const velMagSq = ship.vel.x * ship.vel.x + ship.vel.y * ship.vel.y + ship.vel.z * ship.vel.z;
  if (velMagSq >= ENTER_SHIP_MAX_VELOCITY_U_S * ENTER_SHIP_MAX_VELOCITY_U_S) {
    const vel = Math.sqrt(velMagSq);
    return {
      ok: false,
      code: "ship-moving",
      message: `Ship moving at ${vel.toFixed(2)} u/s (max ${ENTER_SHIP_MAX_VELOCITY_U_S})`,
    };
  }

  // Happy path:
  //   1. Drop the character entity (the player is in the ship now).
  //   2. Rebind the connection to the ship.
  //   3. Force a snapshot so every client sees the entity switch.
  //   4. Push `enter_ship_ok { shipId }` so the owning client can
  //      swap the camera + controls synchronously.
  shard.entities.delete(character.id);
  conn.entityId = ship.id;

  const tick = shard.sim.currentTick;
  const entities = buildSnapshotEntities(shard);
  shard.broadcast(tick, entities, {});

  shard.send(conn.connId, {
    type: "enter_ship_ok",
    payload: { shipId: ship.id },
  });

  return { ok: true, ship, character };
}

/**
 * TASK-35: discriminated result of `handleEnterShip`. The WS
 * handler maps `code` to the wire error code so a malformed
 * re-entry surfaces as a structured `error` frame instead of a
 * silent drop.
 *
 * On success the ship's existing fields are returned (the
 * character is consumed — the entity no longer exists).
 */
export type EnterShipResult =
  | {
      ok: true;
      ship: SimEntity;
      /** The character that was removed (caller can inspect pos). */
      character: SimEntity;
    }
  | {
      ok: false;
      code:
        | "already-in-ship"
        | "no-entity"
        | "not-on-foot"
        | "no-ship"
        | "not-owner"
        | "out-of-range"
        | "ship-moving"
        | "unknown";
      message: string;
    };

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
 *
 * The optional `lastAppliedSeq` map (TASK-14) is the per-player
 * acknowledgement that drives the client-side input reconciliation.
 * When omitted (e.g. for a unit test that only cares about the
 * entity list) the field defaults to an empty object — the wire
 * schema requires the key to be present.
 */
export function sendEntityUpdate(
  shard: Shard,
  connId: string,
  tick: number,
  entities: ProtocolEntityState[],
  lastAppliedSeq: Readonly<Record<string, number>> = {},
): void {
  shard.send(connId, {
    type: "entity_update",
    payload: {
      systemId: shard.systemId,
      tick,
      entities,
      lastAppliedSeq: { ...lastAppliedSeq },
    },
  });
}

// ---------------------------------------------------------------------------
// Chat helpers — TASK-16
// ---------------------------------------------------------------------------

/**
 * Append a chat message to the shard's log AND emit a `chat` frame
 * to every connection currently in the shard (sender included).
 * The caller has already validated / sanitized the text and passed
 * the per-connection rate limit.
 *
 * The function is transport-agnostic: it walks `shard.connections`
 * and calls `shard.send(connId, ...)` per connection, matching the
 * pattern the entity-update broadcast uses. The router injects
 * `send` so the test harness can substitute a recorder.
 *
 * Returns the stored entry so callers (tests) can match the
 * server-assigned id.
 */
export function broadcastChat(
  shard: Shard,
  args: { author: string; text: string; ts: number },
): ChatRingBufferEntry {
  const entry = shard.chatLog.append(args);
  const frame = {
    type: "chat",
    payload: {
      id: entry.id,
      author: entry.author,
      text: entry.text,
      ts: entry.ts,
    },
  } as const;
  // Cast to the wider `ConnSender` shape (entity_update | chat) so
  // the same hook can drive both broadcast paths. The router wires
  // a single function that handles both frame types.
  const send = shard.send as (
    connId: string,
    frame: { type: "entity_update" | "chat"; payload: unknown },
  ) => void;
  for (const conn of shard.connections.values()) {
    send(conn.connId, frame);
  }
  return entry;
}

/**
 * Re-export of `ChatRingBuffer.ChatEntry` so the public surface
 * stays co-located with the rest of the shard helpers.
 */
export type ChatRingBufferEntry = ChatEntry;

// ---------------------------------------------------------------------------
// Test helper — drive the sim loop manually for unit tests.
// ---------------------------------------------------------------------------

/**
 * Run `n` logical ticks. Each call advances the accumulator once and
 * returns the delta. Test-only: production uses the `setTimeout(0)`
 * chain.
 */
export async function simulateNTicks(
  shard: Shard,
  n: number,
): Promise<{
  stepsRun: number[];
  snapshots: number[];
}> {
  const stepsRun: number[] = [];
  const snapshots: number[] = [];
  for (let i = 0; i < n; i++) {
    const result = await shard.sim.tick();
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
export { entityToWire, makeEntityId, makeWreckEntity, makeWreckId } from "./entity.js";
export {
  applyCombatDamage,
  broadcastCombatEvent,
  cleanupExpiredWrecks,
  WRECK_TTL_S,
  WRECK_TTL_MS,
  type ApplyCombatDamageResult,
  aiSource,
  playerSource,
} from "./combat.js";
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
