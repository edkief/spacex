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
   * TASK-43: queued fire INTENTS (the tick resolves them — single writer).
   * Bounded (cap 4): overflow is dropped + logged (the weapon-lock spam
   * guard below is the real anti-abuse layer).
   */
  fireQueue?: { weapon: 'laser' | 'missile'; targetId?: string }[];
  /** TASK-43: epoch ms until which ALL of this conn's weapons are locked (30 fires/s). */
  weaponLockedUntilMs?: number;
  /** TASK-43: fire-message counter in the current 1 s window (anti-spam). */
  fireSpamCount?: number;
  /** TASK-43: epoch ms the current fire-spam window started. */
  fireSpamWindowStartMs?: number;
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
   * ttl. 'character': the on-foot player entity (TASK-31/32), lives in
   * `entities` (NOT playerEntities: it never owns a ship-input lane).
   * 'deposit' / 'terminal' (TASK-33): static interactable world objects
   * (deposits carry a `quantity` — the v1 pickup decrements it and despawns
   * the entity at zero; seeded placement lands in TASK-37, terminals in
   * TASK-40/53). 'groundItem' (TASK-34): dropped inventory — a static
   * interactable at the dropper's position with a `quantity` + `resourceId`
   * and a 300 s ttl (the generic tick ttl sweep despawns it).
   */
  kind:
    | 'ship'
    | 'ai-ship'
    | 'wreck'
    | 'character'
    | 'deposit'
    | 'terminal'
    | 'groundItem'
    /** TASK-43: a missile in flight (a visible tracer entity, 5 s ttl). */
    | 'projectile';
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
   * TASK-42: the id of the source that destroyed the ship (set on 'wreck'
   * entities when they spawn). TASK-49 renders it as the skull marker until
   * the wreck despawns; the 10 Hz snapshot carries it as `killerId`.
   */
  killerId?: string;
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
  /**
   * TASK-33: remaining units (deposit entities only). The v1 pickup
   * decrements it by one per interaction; at zero the deposit despawns.
   * TASK-38's channel flow replaces the per-tap decrement (same field).
   * TASK-34: groundItem entities also carry it (units dropped by a player).
   */
  quantity?: number;
  /**
   * TASK-34: the resource a 'groundItem' entity holds (dropped inventory).
   * Ground items only — the wire carries it as `resourceId`. TASK-37:
   * seeded deposit entities carry it too (their resource from the catalog).
   */
  resourceId?: string;
  /**
   * TASK-37: the SEED-derived identity of a deposit entity (the shard's dev
   * hook deposits have none). `${systemId}:${depositSeq}` — the DB delta
   * row's key, so mining can persist remaining/discovered.
   */
  depositSeq?: number;
  /**
   * TASK-37: a seeded deposit's discovered flag — flips true server-side
   * when any player (ship OR on-foot character) comes within
   * DEPOSIT_DISCOVERY_RADIUS_M (50 m). v1: kept for the future (gates the
   * star-chart summary); the test asserts the server-side flip.
   */
  depositDiscovered?: boolean;
  /**
   * TASK-34: the player's on-foot inventory — stacks of resource units,
   * weight-capped (40 units, @shared/inventory). One inventory per player,
   * kept on the PLAYER's ship entity (shared across ship and on-foot; the
   * ship's cargo hold is separate, TASK-39). Persisted in players.inventory.
   */
  inventory?: import('@shared/inventory').InventoryStacks;
  /**
   * TASK-43: the ship's energy (ABSOLUTE 0..100). Undefined on pre-43
   * entities and non-ship kinds — always treated as FULL (ENERGY_MAX) so
   * test entities need no migration; the tick regenerates player ships.
   */
  energy?: number;
  /**
   * TASK-43: per-weapon fire cooldowns (weapon id → sim TICK the ship may
   * next fire). Checked in the tick (single writer); denied fires (still
   * in cooldown) spend no energy and emit no event.
   */
  fireCooldownUntil?: Record<string, number>;
  /**
   * TASK-43: missile flight state (kind 'projectile' entities only).
   * `targetId` is the intended target (the homing reference); `sourceId`
   * is the firing ship (attribution + splash friendly-fire); `spawnTick`
   * orders the 16-projectile cap (oldest expires first).
   */
  projectile?: {
    targetId: string;
    sourceId: string;
    weaponId: 'missile';
    spawnTick: number;
  };
  /**
   * TASK-39: the ship's cargo hold (ships.cargo JSON). Lives ON THE SHIP
   * entity — it persists with the ship (TASK-24 flush/load), survives
   * restarts, and travels with the ship across warp. Undefined on
   * pre-39 test entities (treated as an empty hold, never persisted —
   * the flush COALESCEs it).
   */
  cargo?: import('@shared/cargo').CargoHold;
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
