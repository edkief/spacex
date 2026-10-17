/**
 * Public types for the galaxy router (TASK-11 + TASK-12).
 *
 * Split out of `router.ts` to keep the router module under the
 * AGENTS.md file-size cap. The types here are part of the
 * `GalaxyRouter` public API — re-exported from the router module
 * for backward compatibility and surfaced directly when callers
 * only need the wire shape.
 */
import type { EventEmitter } from "node:events";

import type { ShipClassId } from "@shared/ships.js";

import type { Repository } from "../db/repo.js";
import type { Shard } from "../shard/types.js";
import type { ShardFlushService } from "../shard/persist.js";

import type { PresenceBroadcaster } from "./presence.js";

/**
 * One connection's view of the world as the router sees it. The
 * `JoinResolver` uses this to know who is joining, while the
 * `LeaveResolver` uses the symmetric `LeaveArgs` to know who left.
 */
export interface RouterConnectionContext {
  /** Stable WS connection id (matches `Connection.connId`). */
  connId: string;
  /** Callsign asserted by the auth resolver. */
  callsign: string;
  /** Player id from the `players` table. */
  playerId: string;
  /**
   * The ship the player controls. Resolved by the route layer by
   * joining the player's `shipId` (from `GET /api/players/me`). The
   * router doesn't touch `repo.listShipsByOwner`; the caller hands in
   * the row.
   */
  ship: {
    id: string;
    classId: ShipClassId;
    hull: number;
    shields: number;
    /** Quat tuple — the router flattens into the entity on spawn. */
    quat: readonly [number, number, number, number];
  };
}

/**
 * Outcome of a successful `joinSystem` call. The caller emits an
 * `enter_system` wire frame with `snapshotTick` and `players` list.
 */
export interface JoinResult {
  /** The shard the connection now belongs to. */
  shard: Shard;
  /** Connection id (echoed for the WS handler). */
  connId: string;
  /** The system the player just joined. */
  systemId: string;
  /** Number of players now in the system (1..MAX_PLAYERS_PER_SYSTEM). */
  players: number;
  /** Current sim tick of the snapshot the client should ack. */
  snapshotTick: number;
}

/** Outcome of a `joinSystem` failure — wire code is `system-full` or `system-not-found`. */
export interface JoinRejection {
  /** Wire code ("system-full" | "system-not-found"). */
  code: "system-full" | "system-not-found";
  /** Human-readable message. */
  message: string;
  /** The system id that was requested (echoed for debug). */
  systemId: string;
}

/** Per-shard stats exposed by `router.stats()`. */
export interface RouterShardStats {
  systemId: string;
  /** Display name pulled from the deterministic SystemGen. */
  name: string;
  /** Number of active player connections in the shard. */
  players: number;
  /** Milliseconds since the shard was first registered. */
  uptimeMs: number;
}

/** Top-level router stats (shape used by `/api/galaxy/health`). */
export interface RouterStats {
  shardCount: number;
  totalPlayers: number;
  /** Wall-clock ms when the router was instantiated. */
  routerStartedAt: number;
  shards: RouterShardStats[];
}

/** Options bag for `GalaxyRouter`. */
export interface RouterOptions {
  repo: Repository;
  /** Galaxy seed used to derive system data. */
  galaxySeed: string;
  /** Galaxy size (number of stars in `generateStars`). */
  galaxyStarCount: number;
  /** Override the per-shard reap grace (ms). Defaults to `DEFAULT_SHARD_REAP_GRACE_MS`. */
  reapGraceMs?: number;
  /** Override the reap sweep interval (ms). Defaults to `DEFAULT_ROUTER_REAP_INTERVAL_MS`. */
  reapIntervalMs?: number;
  /** Override the flush service (TASK-24). Tests may inject a recording variant. */
  flusher?: ShardFlushService;
  /** Custom event bus; defaults to a per-router `EventEmitter`. */
  events?: EventEmitter;
  /** Logger — defaults to a silent info logger so the tests don't spam console. */
  logger?: Pick<Console, "info" | "warn" | "error" | "debug">;
  /** Wall-clock override for tests. */
  now?: () => number;
  /**
   * TASK-12: presence broadcaster — invoked by the router whenever a
   * player joins or leaves a system so the WS layer can echo the
   * event to every other connection in the shard. The hook receives
   * the systemId and the canonical presence payload the router wants
   * delivered (presence_join / presence_leave are the same shape;
   * the WS layer is responsible for deciding whether to suppress
   * the broadcast back to the originating connection).
   *
   * When omitted, presence events are silently dropped — the router
   * remains functional for unit tests + force-reap code paths that
   * don't need to surface presence to the wire.
   *
   * The presence payload shape lives in `./presence.ts` so future
   * protocol bumps (TASK-15) extend the roster fields in one place.
   */
  presenceBroadcaster?: PresenceBroadcaster;
}
