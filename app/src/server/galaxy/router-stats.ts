/**
 * Router stats surface (TASK-11 + TASK-12).
 *
 * Centralises the snapshot building used by `GalaxyRouter.stats()`
 * and the read-only accessors (`listSystemIds`, `generationFor`).
 * Extracted from the router module so the AGENTS.md file-size cap
 * is respected by every galaxy/* module.
 *
 * The router passes in its private maps + now() clock; the helper
 * returns a fresh `RouterStats` snapshot. Pure functions keep the
 * stats logic testable in isolation.
 *
 * @see ./router.ts for the consumer.
 * @see ./router-types.ts for the `RouterStats` shape.
 */
import type { Shard } from "../shard/types.js";
import type { RouterShardStats, RouterStats } from "./router-types.js";

/** Build the stats snapshot from the router's live shard map. */
export function buildRouterStats(args: {
  shards: Map<string, Shard>;
  shardStartedAt: Map<string, number>;
  routerStartedAt: number;
  now: () => number;
}): RouterStats {
  const shards: RouterShardStats[] = [];
  let totalPlayers = 0;
  const now = args.now();
  for (const [systemId, shard] of args.shards.entries()) {
    const startedMs = args.shardStartedAt.get(systemId) ?? args.routerStartedAt;
    const players = shard.connections.size;
    totalPlayers += players;
    shards.push({
      systemId,
      name: shard.context.system.name,
      players,
      uptimeMs: Math.max(0, now - startedMs),
    });
  }
  return {
    shardCount: args.shards.size,
    totalPlayers,
    routerStartedAt: args.routerStartedAt,
    shards,
  };
}

/** Read the current generation counter for a system. */
export function readGeneration(args: {
  shardGeneration: Map<string, number>;
  systemId: string;
}): number {
  return args.shardGeneration.get(args.systemId) ?? 0;
}
