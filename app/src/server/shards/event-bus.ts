/**
 * In-process event bus used to notify system shards of cross-cutting
 * mutations (TASK-20 ship purchase + future TASK-11/12/15 broadcasts).
 *
 * Design notes:
 *
 *  - The Drift server runs as a single Node process per shard (PRD §7).
 *    A `ws.Server` and its `system_registry` row live in the same
 *    event-loop tick, so `EventEmitter` is the right primitive — no
 *    inter-process pub/sub required.
 *
 *  - The bus is a singleton. Both the REST handler that triggers the
 *    event (`routes/ships.ts`) and the WS handler that consumes it
 *    (the future TASK-15 presence broadcaster, plus tests) call
 *    `getShardsBus()` to share one instance.
 *
 *  - The shape of every event payload is declared as a typed constant
 *    in `ShardEvents`, so both publishers and consumers get a single
 *    source of truth that the compiler can check.
 *
 *  - The bus survives across the lifetime of the process. Tests that
 *    want a clean bus call `resetShardsBus()` between cases.
 */
import { EventEmitter } from "node:events";
import type { ShipRow } from "../db/types.js";

/**
 * Payload of every bus event. Today: `shipSwapped` + `liveryChanged`.
 * Future events (player joined shard, AI spawned, etc.) extend this
 * union without changing the listener signature.
 */
export interface ShipSwapEvent {
  /** Canonical id of the player whose ship was replaced. */
  playerId: string;
  /** The fresh ship row the caller just inserted. */
  newShip: ShipRow;
  /** The previous class id (so subscribers can detect an upgrade /
   *  downgrade without diffing snapshots). */
  previousClassId: ShipRow["classId"];
}

/**
 * Payload of `livery-changed` events (TASK-21). Published whenever a
 * player updates their ship's paint at a dock; an active system shard
 * (future TASK-11) consumes this and broadcasts `entity_update` so
 * remote clients can re-paint the owning player's ship in place.
 *
 * The payload deliberately carries the ship id, system id, and the
 * full `ShipLivery` so the consumer does not have to re-read the DB —
 * saves a round-trip on every paint.
 */
export interface LiveryChangedEvent {
  playerId: string;
  shipId: string;
  livery: ShipRow["livery"];
  systemId: string;
}

/**
 * Static event-name registry so producers and consumers reference a
 * single literal per event. Adding an event is a one-line change.
 */
export const ShardEvents = {
  /** A player completed a ship purchase at a dock (TASK-20). */
  ShipSwapped: "ship-swapped",
  /** A player updated their ship's livery at a dock (TASK-21). */
  LiveryChanged: "livery-changed",
} as const;

export type ShardEventName = (typeof ShardEvents)[keyof typeof ShardEvents];

/**
 * Listener for `ship-swapped`. The first arg is the payload; the
 * second is the typed event name, which makes it easy to add
 * additional listeners later without breaking call-sites.
 */
export type ShipSwapListener = (event: ShipSwapEvent) => void | Promise<void>;

/** Listener for `livery-changed` (TASK-21). Same shape as `ShipSwapListener`. */
export type LiveryChangedListener = (event: LiveryChangedEvent) => void | Promise<void>;

export interface ShardsBus {
  /** Subscribe to `ship-swapped` events (TASK-20). */
  on(eventName: typeof ShardEvents.ShipSwapped, listener: ShipSwapListener): this;
  off(eventName: typeof ShardEvents.ShipSwapped, listener: ShipSwapListener): this;
  /** Subscribe to `livery-changed` events (TASK-21). */
  on(eventName: typeof ShardEvents.LiveryChanged, listener: LiveryChangedListener): this;
  off(eventName: typeof ShardEvents.LiveryChanged, listener: LiveryChangedListener): this;
  removeAllListeners(
    eventName?: typeof ShardEvents.ShipSwapped | typeof ShardEvents.LiveryChanged,
  ): this;
  /** Publish a ship-swap event. Fire-and-forget from the route. */
  publishShipSwap(event: ShipSwapEvent): void;
  /** Publish a livery-changed event. Fire-and-forget from the route. */
  publishLiveryChanged(event: LiveryChangedEvent): void;
}

/**
 * Build a fresh in-process bus. Exposed so tests can construct an
 * isolated bus and avoid cross-test pollution.
 */
export function createShardsBus(): ShardsBus {
  const emitter = new EventEmitter();
  // Listeners should never block the publisher. Bumping the cap
  // silently absorbs unbounded fan-out when a subscriber misbehaves.
  emitter.setMaxListeners(64);
  return {
    on(eventName, listener): ShardsBus {
      emitter.on(eventName, (...args: unknown[]) => {
        // The `on` overload types narrow per-event-name, but at the
        // emitter level we only have `unknown[]`. Cast to the union
        // so the listener can decide based on its own type signature.
        const payload = args[0] as ShipSwapEvent | LiveryChangedEvent;
        // The listener signature is either type; the union is the
        // narrowest shape that satisfies both. Cast through `unknown`
        // so TS does not try to enforce the intersection.
        void Promise.resolve((listener as (e: unknown) => unknown)(payload)).catch(
          (err: unknown) => {
            emitter.emit("error", err);
          },
        );
      });
      return this;
    },
    off(eventName, listener): ShardsBus {
      emitter.off(eventName, listener);
      return this;
    },
    removeAllListeners(eventName?): ShardsBus {
      emitter.removeAllListeners(eventName);
      return this;
    },
    publishShipSwap(event: ShipSwapEvent): void {
      // `emit` is synchronous and rethrows listener exceptions, which
      // would propagate back into the buy endpoint. We swallow that
      // by going through `process.nextTick` — listeners run async
      // and any throw is reported via `error`.
      process.nextTick(() => {
        try {
          emitter.emit(ShardEvents.ShipSwapped, event);
        } catch (err) {
          // A misbehaving subscriber cannot break the publisher.
          // Re-emit through the standard `error` channel so a logger
          // attached via `bus.on('error', ...)` still sees it.
          emitter.emit("error", err);
        }
      });
    },
    publishLiveryChanged(event: LiveryChangedEvent): void {
      // Symmetric with `publishShipSwap` — TASK-21 mirrors the
      // buy-endpoint broadcast semantics: async dispatch, isolated
      // listener errors, never fails the publisher.
      process.nextTick(() => {
        try {
          emitter.emit(ShardEvents.LiveryChanged, event);
        } catch (err) {
          emitter.emit("error", err);
        }
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Singleton — process-scoped bus shared by the live server's REST
// routes, WS handlers, and tests. Constructed lazily so unit tests
// can call `resetShardsBus()` between cases.
// ---------------------------------------------------------------------------

let bus: ShardsBus | null = null;

/** Get the singleton bus, creating it on first use. */
export function getShardsBus(): ShardsBus {
  if (bus === null) bus = createShardsBus();
  return bus;
}

/**
 * Reset the singleton. Tests call this in `beforeEach` so each case
 * starts with a clean listener set.
 */
export function resetShardsBus(): void {
  if (bus !== null) {
    bus.removeAllListeners();
  }
  bus = null;
}
