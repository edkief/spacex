/**
 * Router shard-spawn helper (TASK-11 + TASK-12).
 *
 * Encapsulates the "create a new shard for `systemId`" sequence:
 *   1. Build the deterministic system context (cheap, ~ms).
 *   2. Hydrate ships from the DB via `loadShipsForShard(...)`
 *      (GC's expired wrecks first, returns `SimEntitySpec[]`).
 *   3. Build the shard with noop send/broadcast hooks (the WS
 *      layer swaps them in via `WsHandle`).
 *   4. Bump the per-system generation counter (TASK-12: tracks
 *      reloads from DB; reconnect-storm test relies on the
 *      counter staying at 1 across rapid join/leave cycles).
 *   5. Hydrate entities from the loaded specs via
 *      `hydrateShardEntities` so the entity registry is ready by
 *      the time `enter_system` is sent.
 *   6. Register the shard in the router's maps.
 *
 * The router owns the maps + the seed/starCount config; this
 * helper is the imperative sequence that mutates them. Errors
 * propagate so the caller can map `GalaxySystemNotFoundError`
 * to a structured wire code.
 *
 * @see ./router.ts for the consumer.
 */
import type { EventEmitter } from "node:events";

import type { Repository } from "../db/repo.js";
import type { ConnSender, Shard } from "../shard/types.js";
import { createShard } from "../shard/index.js";
import { loadShipsForShard } from "../shard/load.js";

import { buildShardContext, GalaxySystemNotFoundError } from "./system-data.js";
import { hydrateShardEntities } from "./hydrate.js";
import { hydrateShardDeposits } from "./deposit-hydrate.js";

/** Maps the router exposes for shard bookkeeping. */
export interface RouterShardMaps {
  /** Active shard map (systemId → Shard). */
  shards: Map<string, Shard>;
  /** When each shard was first registered (for uptimeMs). */
  shardStartedAt: Map<string, number>;
  /** Per-system generation counter (TASK-12). */
  shardGeneration: Map<string, number>;
}

/** Configuration + dependencies for `loadAndRegister`. */
export interface LoadAndRegisterDeps {
  repo: Repository;
  galaxySeed: string;
  galaxyStarCount: number;
  events: EventEmitter;
  logger: Pick<Console, "info" | "warn" | "error" | "debug">;
  now: () => number;
  maps: RouterShardMaps;
  /**
   * TASK-16: per-connection frame sender. Threaded into the shard
   * via `createShard({ send })` so `broadcastChat()` can push
   * `{type:'chat', payload: ChatEntry}` frames to the matching
   * socket. When omitted, the shard gets the existing noop stub
   * (preserves the behavior the router has had since TASK-11 / 13).
   */
  connSender?: ConnSender;
}

/**
 * Spawn the shard for `systemId` and register it on the router's
 * maps. Idempotent on the router side (caller checks `shards` +
 * `pendingSpawns` first); the helper itself is the slow path.
 */
export async function loadAndRegister(systemId: string, deps: LoadAndRegisterDeps): Promise<Shard> {
  let context;
  try {
    context = buildShardContext({
      seed: deps.galaxySeed,
      starCount: deps.galaxyStarCount,
      systemId,
    });
  } catch (err) {
    if (err instanceof GalaxySystemNotFoundError) {
      throw err; // re-thrown unchanged; handler maps to `system-not-found`
    }
    throw err;
  }
  // Hydrate ships from DB. `loadShipsForShard` GC's expired wrecks
  // FIRST so a row that should be gone never reappears in the next
  // hydrate. We pass `includeDocked: true` so a player who owns a
  // docked starter ship still re-hydrates it with the persisted
  // position — otherwise the entity is missing from the broadcast
  // loop until the player warps out of dock (TASK-29). The v1
  // router doesn't need to special-case docked ships because
  // docking data lives in TASK-29; until then, every persisted row
  // represents a live ship entity.
  const { specs } = await loadShipsForShard(systemId, deps.repo, {
    nowMs: deps.now(),
    includeDocked: true,
  });
  // Build the shard with a noop broadcaster; the WS layer wires the
  // real one when it calls `joinSystem`. Using noop here keeps the
  // router free of any transport reference — same shape as the
  // existing `createShard` test helpers.
  // TASK-12: generation bumps on every respawn so the
  // reconnect-storm test can assert the shard wasn't reloaded
  // mid-flight.
  const generation = (deps.maps.shardGeneration.get(systemId) ?? 0) + 1;
  deps.maps.shardGeneration.set(systemId, generation);
  const shard: Shard = createShard({
    systemId,
    context,
    // TASK-16: the WS layer wires a real per-connection frame
    // sender via `RouterOptions.connSender`. When omitted, the
    // shard gets a noop stub so unit tests don't have to wire the
    // WS layer. The same hook is responsible for entity_update +
    // chat + combat_event frames — `ConnSender` accepts all three
    // types via the union shape.
    send: deps.connSender ?? (() => undefined),
    broadcast: () => undefined,
    events: deps.events,
    logger: deps.logger,
    generation,
    // TASK-38: thread the live repository so the mining state
    // machine can persist inventory + deposit deltas on every
    // 1.5 s cadence tick. Tests that don't exercise mining can
    // leave it unset — the loop fast-paths the mining advance
    // when no rows are active.
    repo: deps.repo,
  });
  // Hydrate entities from the loaded specs. The hydrate step
  // fetches callsigns for the owner ids on the ship rows so the
  // resulting entities broadcast the right metadata on
  // `entity_update`. Idempotent on entityId (`spawnShip` returns
  // the existing entry); no double-registration.
  await hydrateShardEntities(shard, specs, { repo: deps.repo });
  // TASK-37: seed-derived deposit placement + persisted state
  // merge. Fire-and-forget so the hydrate path stays cheap; the
  // deposit entities land on the next broadcast cycle.
  hydrateShardDeposits(shard, deps.galaxySeed, { repo: deps.repo });
  deps.maps.shards.set(systemId, shard);
  deps.maps.shardStartedAt.set(systemId, deps.now());
  return shard;
}
