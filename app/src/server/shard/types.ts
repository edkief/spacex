import type { EventEmitter } from 'node:events';

import type { EntityState, InputPayload } from '@shared/protocol/schemas';
import type { ShipState } from '@shared/physics/flight';
import type { SimLoop } from './sim';

/**
 * Shard record types (TASK-13). A shard is the authoritative simulation for
 * one star system: a fixed 20 Hz SimLoop, one entity per player, per-connection
 * input queues, and a 10 Hz snapshot broadcast.
 *
 * Invariant (PRD determinism): ALL entity mutation happens inside the sim
 * tick (single writer). Message handlers only ENQUEUE; they never touch
 * entities directly.
 */

/** One WS connection's sim-side state. */
export interface ConnState {
  /** Stable id assigned when the connection joins the shard. */
  connId: string;
  playerId: string;
  callsign: string;
  /** Last accepted input seq; inputs with seq <= lastSeq are stale (dropped). */
  lastSeq: number;
  /**
   * TASK-14: last input seq actually INTEGRATED in a tick (≤ lastSeq). The
   * client predictor reconciles against this, not lastSeq — enqueued inputs
   * are not yet applied.
   */
  appliedSeq: number;
  /** Last seq already sent to the client via an 'ack' message. */
  ackSentSeq: number;
  /** Latest accepted input awaiting the next tick (latest-wins). */
  input?: InputPayload;
  /**
   * Deliver a serialized protocol frame (the 10 Hz snapshot buffer, encoded
   * ONCE per broadcast and shared by every in-system connection).
   */
  send(buffer: string): void;
}

/** A simulated entity in the shard (player ship; AI ships arrive in TASK-46). */
export interface SimEntity {
  /** Wire-stable entity id (the ship id clients hold; survives ship swaps). */
  id: string;
  /** 'wreck': static wreck of a destroyed ship (TASK-23), removed after its ttl. */
  kind: 'ship' | 'ai-ship' | 'wreck';
  /** Owner (null for AI ships and wrecks). One entity per player. */
  playerId: string | null;
  callsign?: string;
  classId: string;
  /** Kinematic state — mutated only inside the tick (wrecks are static). */
  ship: ShipState;
  /** Normalized hull / shields (0..1), combat state (TASK-23). */
  hull: number;
  shields: number;
  targetId: string | null;
  livery?: Record<string, string>;
  /**
   * TASK-23: the ship is destroyed (hull at zero). A destroyed entity stops
   * integrating, ignores inputs, and is non-targetable; it stays in the world
   * (frozen, hull 0 on the wire) until the dock respawn (TASK-49).
   */
  destroyed?: boolean;
  /** TASK-23: ticks left until the entity is removed (wrecks only: 600 s). */
  ttl?: number;
  /**
   * Persisted 'docked' ships stay in the 'docked' wire regime until their
   * first input (which takes them off the dock plane).
   */
  docked: boolean;
  /** Planet whose surface this ship flies above (atmosphere regime only). */
  planetId?: string;
  /**
   * TASK-14: the newest input frame, HELD and re-integrated every tick until
   * a newer frame replaces it (latest-wins persistence). This mirrors the
   * client predictor, which keeps integrating its last input between frames
   * — consume-once semantics would make the authority drift from the
   * prediction (a 10 Hz echo would integrate at ⅓ speed server-side).
   * Cleared when the owner leaves, so an abandoned ship coasts, not thrusters.
   */
  heldInput?: InputPayload;
}

/** The shard the router (TASK-11) will instantiate per system. */
export interface Shard {
  systemId: string;
  sim: SimLoop;
  connections: Map<string, ConnState>;
  entities: Map<string, SimEntity>;
  /** Lifecycle notifications: 'tick', 'player-joined', 'player-left'. */
  events: EventEmitter;
  /**
   * Save hook (TASK-63 wires the real persistence service). Called on stop()
   * with the final snapshot; no-op by default.
   */
  persist: (entities: EntityState[]) => void;
}

/** Structured log surface the shard writes to (defaults to console). */
export interface ShardLogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
}

export const defaultLogger: ShardLogger = {
  debug: (msg, meta) => console.debug(`[shard:debug] ${msg}`, meta ?? ''),
  warn: (msg, meta) => console.warn(`[shard:warn] ${msg}`, meta ?? ''),
  info: (msg, meta) => console.info(`[shard:info] ${msg}`, meta ?? ''),
};
