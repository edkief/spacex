/**
 * System-shard public surface — TASK-13.
 *
 * A `Shard` is the authoritative runtime container for *one* star system.
 * It owns the simulation loop (20 Hz tick), every live connection
 * currently in the system, the entity registry (ships, characters, AI,
 * wrecks — populated as further tasks land), and the persistence hook
 * so the dirty-set flush at TASK-24 has a place to call home.
 *
 * Design invariants:
 *   - **Single writer.** Every entity mutation happens inside
 *     `sim.onTick`. Message handlers MUST only enqueue inputs / request
 *     state — never write to entities directly. This keeps the tick
 *     deterministic and debuggable.
 *   - **Typed at the boundary.** `ProtocolEntityState`, the same
 *     zod-derived type from `@shared/protocol`, flows as-is through
 *     `entity_update` so client and server agree on the wire shape.
 *   - **No transport.** The shard has no direct WS dependency. The
 *     router (TASK-11) and the WS handler loop over
 *     `shard.connections` and call `sendEntityUpdate` /
 *     `broadcastEntityUpdate` — keeps the sim testable without a
 *     network.
 *
 * @see ./sim.ts for the tick loop implementation.
 * @see ./entity.ts for the per-entity bookkeeping.
 * @see ./input-queue.ts for the seq-protected input slot.
 * @see ../../shared/protocol/schemas.ts for the wire shapes.
 */
import type { EventEmitter } from "node:events";

import type { Planet, SystemGen } from "@shared/galaxy/types.js";
import type { ProtocolEntityState, ProtocolShipClassId } from "@shared/protocol/index.js";
import type { ShipRow } from "../db/types.js";

import type { SimLoop, SimLoopStats } from "./sim.js";

// ---------------------------------------------------------------------------
// Per-connection bookkeeping
// ---------------------------------------------------------------------------

/**
 * One connection's state inside a shard.
 *
 * `lastSeq` is the highest input `seq` we've consumed for this
 * connection. Newer inputs with a `seq <= lastSeq` are dropped as stale
 * (out-of-order protection); those with `seq > lastSeq` win and become
 * the `pendingInput` applied on the next tick.
 *
 * `entityId` is the sim-side handle (the local entity being driven by
 * this connection's inputs). A future TASK-15 round-trips the
 * presence list through the same id.
 */
export interface ShardConnection {
  /** Stable WS connection id (matches `ws.connection.Connection.connId`). */
  readonly connId: string;
  /** Callsign asserted by the auth resolver. */
  readonly callsign: string;
  /** Player id from the `players` table. */
  readonly playerId: string;
  /** Ship entity id this connection controls (assigned on first input). */
  entityId: string | null;
  /** Highest input `seq` accepted so far. Older frames drop silently. */
  lastSeq: number;
  /** Last accepted input — applied during the next tick. */
  pendingInput: PlayerInput | null;
  /** Last tail of stale frames dropped for diagnostics. Visible for tests. */
  staleDrops: number;
}

/**
 * The server-side view of a player-driven input message.
 *
 * The wire shape (`InputSchema` in `@shared/protocol`) carries
 * `thrust / turn / pitch / yaw / fire / lock / action / seq` — the
 * full set lives in `InputSchema`. The sim only consumes the
 * continuous control axes (which the shared flight model accepts)
 * plus `seq` for ordering. `fire / lock / action` are reserved for
 * TASK-43 + TASK-44 + TASK-29; the shard passes them through as
 * passthrough so future tasks can plug them in without changing the
 * wire format.
 */
export interface PlayerInput {
  /** Wire seq — strict monotone increasing per connection. */
  seq: number;
  /** Forward throttle in [0, 1]. */
  thrust: number;
  /** Turn axis (combined yaw) in [-1, 1] — mapped to `ShipInput.yaw`. */
  turn: number;
  /** Pitch axis in [-1, 1]. */
  pitch: number;
  /** Combined yaw / roll helper (post future HUD rebinding) in [-1, 1]. */
  yaw: number;
  /** Future: fire primary weapon (TASK-43). */
  fire: boolean;
  /** Future: acquire target lock (TASK-44). */
  lock: boolean;
  /** Future: contextual action (TASK-29 / TASK-31). */
  action: string | null;
}

// ---------------------------------------------------------------------------
// Entity registry
// ---------------------------------------------------------------------------

/**
 * The three flavors of ship entity the sim knows about for TASK-13.
 *
 *   `player` — driven by a WS connection via `pendingInput`.
 *   `ai`     — driven by the future AI state machine (TASK-46). For
 *              TASK-13 the stub integrator advances them straight
 *              (thrust=0, no rotation) so they sit still in the
 *              snapshot — enough to exercise the broadcast path.
 *   `wreck`  — destroyed hulls (TASK-49); broadcast-only, no input.
 */
export type EntityKind = "player" | "ai" | "wreck";

/**
 * The full per-entity state. Combines the flight-model's `ShipState`
 * with the combat-ready fields (hull / shields / target) the spec
 * requires on the wire.
 *
 * `id` is the entity id (matches `EntityStateSchema.id`). Stable for
 * the entity's lifetime — the wire uses it to identify the row across
 * snapshots.
 *
 * `playerId` is `null` for AI and wreck entities; non-null for player
 * ships. Lets the broadcast loop tie an entity back to a connection.
 *
 * `classId` is the ship class id (drives the integrand's tunables).
 * `hull` / `shields` are the HP values broadcast verbatim. `targetId`
 * is `null` until TASK-44 lands; the field already exists on the wire
 * so future tasks won't need a schema migration.
 */
export interface SimEntity {
  readonly id: string;
  readonly kind: EntityKind;
  /** Owning player id; null for `ai` and `wreck`. */
  readonly playerId: string | null;
  /** Callsign for player ships (drives HUD); null for AI/wreck. */
  readonly callsign: string | null;
  /** Ship class — drives `integrateShip`. */
  readonly classId: ProtocolShipClassId;
  /** Hull HP (broadcast verbatim in `EntityState.hull`). */
  hull: number;
  /** Shield HP (broadcast verbatim in `EntityState.shields`). */
  shields: number;
  /** Current target id (TASK-44 fills this in). */
  targetId: string | null;
  /**
   * Current flight-model position. Lives next to the entity so the
   * tick loop has one place to look. `originPlanetId` / `regime` are
   * split out below.
   */
  pos: { x: number; y: number; z: number };
  /** Current flight-model velocity. */
  vel: { x: number; y: number; z: number };
  /** Flight-model orientation quaternion (live — mutated each tick). */
  quat: { x: number; y: number; z: number; w: number };
  /** Current regime — drives the integrator branch. */
  regime: "space" | "atmosphere" | "surface";
  /** Planet id currently used as `heightAt` source (atmosphere/surface only). */
  originPlanetId: string | null;
  /** Optional pad id when landed (consumed by TASK-29). */
  onPad: string | null;
  /**
   * Wall-clock ms timestamp when this wreck should be cleaned up
   * (TASK-23). Set on entities with `kind === 'wreck'` only;
   * `undefined` on player/AI entities. The sim loop checks once per
   * tick and removes expired wrecks so the registry stays bounded.
   */
  wreckExpiresAt?: number;
}

/**
 * Persisted ship anchor used to mint a `SimEntity` when a player
 * first inputs into a system. The shard carries a `Map<shipId,
 * ShipRow>` so the same rows can be re-resolved after a reconnect
 * (TASK-17).
 */
export interface SpawnedShip {
  readonly shipId: string;
  readonly entityId: string;
  readonly shipRow: ShipRow;
  readonly entity: SimEntity;
}

// ---------------------------------------------------------------------------
// System context — surfaced to the integrator + future tasks
// ---------------------------------------------------------------------------

/**
 * The deterministic galaxy data the tick loop reads.
 *
 * `system` is the static `SystemGen` for the star (planet list,
 * star data); `heightAtFor` is the per-planet `heightAt` callback
 * that resolves an `(x, z)` to a terrain altitude in metres above
 * the planet's `radius`. The shard caches the active planets'
 * `heightAt` closures to keep the per-tick lookup O(1) per ship.
 *
 * `tileSizeM` is the chunk side length in metres (matches
 * `CHUNK_SIZE_CELLS` from the surface generator at 1 m / cell →
 * 64 m). Used by the 3×3 cache-neighborhood lookup.
 */
export interface ShardSystemContext {
  readonly system: SystemGen;
  /**
   * Resolve a planet by id. The shard loops over this when priming
   * the per-ship heightAt cache each tick — the cache is bounded to
   * the planets present in the active player ships' `originPlanetId`,
   * not every planet in the system.
   */
  readonly planetById: (planetId: string) => Planet | undefined;
  /**
   * Resolve the per-planet `heightAt` callback. Same lookup, but
   * returns the function directly so the loop doesn't need to
   * destructure.
   */
  readonly heightAtFor: (planetId: string) => ((x: number, z: number) => number) | undefined;
  /** Chunk side length in metres (informational; default 64). */
  readonly tileSizeM: number;
}

// ---------------------------------------------------------------------------
// Callback contracts
// ---------------------------------------------------------------------------

/**
 * Per-tick observer fired after the sim has integrated every ship but
 * BEFORE the snapshot broadcast. Lets the host (router, persistence)
 * react — currently unused for TASK-13 but the seams are in place for
 * TASK-23/24/46 to hook damage + dirty marking.
 */
export type SimTickObserver = (stats: SimTickStats) => void;

/** Tick-side stats. `tickDurationMs` is what the histogram buckets. */
export interface SimTickStats {
  /** Tick number since `SimLoop.start()` (starts at 1). */
  readonly tick: number;
  /** Wall-clock duration of just the integration + entity mutation. */
  readonly tickDurationMs: number;
  /** Number of entities integrated this tick. */
  readonly entityCount: number;
  /** Number of *fresh* inputs consumed this tick (after de-dup). */
  readonly inputsApplied: number;
  /** Number of stale inputs dropped this tick. */
  readonly staleInputs: number;
}

/**
 * Broadcast hook — fired on every 2nd tick (10 Hz). The default impl
 * the router wires simply walks `shard.connections` and calls
 * `send` on each. For TASK-13 the test harness subscribes its own
 * listener to assert cadence + payload shape.
 *
 * `lastAppliedSeq` (TASK-14) is a map of `playerId → highest input
 * seq the server integrated this tick`. Routers should include it
 * verbatim in the outgoing `entity_update` so the owning client can
 * reconcile its input queue. When the shard ran no player inputs
 * this tick (e.g. an AI-only frame) the map is empty.
 */
export type SnapshotBroadcaster = (
  tick: number,
  entities: ProtocolEntityState[],
  lastAppliedSeq: Readonly<Record<string, number>>,
) => void;

/**
 * Connection send hook — keeps the shard transport-agnostic. The
 * router injects a function that writes an `entity_update` frame to
 * the right WS connection. For TASK-13 the tests inject a recorder.
 */
export type ConnSender = (
  connId: string,
  frame: { type: "entity_update"; payload: unknown },
) => void;

/**
 * Persistence hook — TASK-13 calls this once per interval (every Nth
 * tick) to mark "this ship is dirty, persist it" so the future
 * `PersistService` (TASK-24) saves state without the sim having to
 * know the repository shape.
 *
 * For TASK-13 the function signature is exposed but nothing inside
 * the implementation calls it — the seam is here so TASK-24 can plug
 * in without touching the shard code.
 */
export type DirtyMarker = (shipId: string, patch: { hull?: number; shields?: number }) => void;

// ---------------------------------------------------------------------------
// Shard — the public aggregate
// ---------------------------------------------------------------------------

/**
 * The full per-system runtime container.
 *
 * One `Shard` lives in the process for every system that currently
 * has at least one connection (TASK-11 owns the lifecycle). TASK-13
 * tests construct one directly.
 */
export interface Shard {
  /** Stable canonical system id (matches `SystemGen.systemId`). */
  readonly systemId: string;
  /** Static galaxy context the sim reads. */
  readonly context: ShardSystemContext;
  /** The 20 Hz simulation loop. */
  readonly sim: SimLoop;
  /** Per-connection bookkeeping (playerId + last seq + pending input). */
  readonly connections: Map<string, ShardConnection>;
  /** All live entities (ships / characters / AI / wrecks). */
  readonly entities: Map<string, SimEntity>;
  /** Connection id → list of `entity_update` frames the broadcast will send. */
  readonly dirtyShipSpawns: Map<string, SpawnedShip>;
  /** Internal: bridge to the future persistence layer (TASK-24). */
  readonly persist: { markDirty?: DirtyMarker };
  /** Shared event bus for cross-shard signals (TASK-15 presence…). */
  readonly events: EventEmitter;
  /** Send a frame to one connection. Plugged by the router. */
  send: ConnSender;
  /** Snapshot broadcast hook. Plugged by the router. */
  broadcast: SnapshotBroadcaster;
  /** Per-tick observer. Plugged by the router / tests. */
  onTickObserver: SimTickObserver | null;
  /** Read-only snapshot of sim loop health (p50/p95/p99 + tick count). */
  readonly stats: () => SimLoopStats;
  /** Detach every connection + stop the sim. Idempotent. */
  shutdown: () => void;
}
