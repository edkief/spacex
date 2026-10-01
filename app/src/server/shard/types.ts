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
  /**
   * TASK-17: opaque identity of the owning WS connection (the WS layer
   * passes its Conn object). Used to reject frames — inputs or leaves —
   * arriving from a SUPERSEDED (zombie) socket of the same player after a
   * reconnect. Absent for callers that do not care (headless/tests).
   */
  source?: unknown;
}

/** A simulated entity in the shard (player ship; AI ships arrive in TASK-46). */
export interface SimEntity {
  /** Wire-stable entity id (the ship id clients hold; survives ship swaps). */
  id: string;
  /**
   * 'wreck': static wreck of a destroyed ship (TASK-23), removed after its
   * ttl. 'character': the on-foot player entity (TASK-31) — static in v1
   * (walking is TASK-32), lives in `entities` (NOT playerEntities: it never
   * owns a ship-input lane).
   */
  kind: 'ship' | 'ai-ship' | 'wreck' | 'character';
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
  /**
   * TASK-24: epoch ms of the killing hit. The shard flush persists it as
   * ships.destroyed_at, so a restarted shard can rebuild the wreck with its
   * remaining ttl (and clean up expired wrecks).
   */
  destroyedAtMs?: number;
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
   * TASK-29: the landing pad this ship is docked on (server-authoritative,
   * set/cleared by the pad state machine in the tick). One pad per ship —
   * a single id, never two. Undefined when not docked on a pad.
   */
  padId?: string;
  /**
   * TASK-14: the newest input frame, HELD and re-integrated every tick until
   * a newer frame replaces it (latest-wins persistence). This mirrors the
   * client predictor, which keeps integrating its last input between frames
   * — consume-once semantics would make the authority drift from the
   * prediction (a 10 Hz echo would integrate at ⅓ speed server-side).
   * Cleared when the owner leaves, so an abandoned ship coasts, not thrusters.
   */
  heldInput?: InputPayload;
  /**
   * TASK-17: the owner currently has NO live connection. The ship keeps
   * being simulated (coasting on zero input — the held frame is cleared)
   * for as long as the shard lives; inputs are only accepted when the
   * player's connection is re-registered (idle back to false).
   */
  idle?: boolean;
  /**
   * TASK-31: the owner disembarked — their character entity (id
   * `char:<playerId>`) is the player's active entity. The ship is FROZEN
   * where it docked: the tick skips it entirely (no drift, no re-dock
   * churn) and the owner's input frames route to the character (TASK-32).
   * Cleared by re-entry (TASK-35).
   */
  disembarked?: boolean;
  /**
   * TASK-32: the character's ground flag (integrateCharacter's onGround).
   * Character entities only — ships have no ground state (the flight model
   * clamps to terrain inline). Persisted implicitly: a character always
   * resumes grounded (disembark spawns it standing on the pad plane).
   */
  charOnGround?: boolean;
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
