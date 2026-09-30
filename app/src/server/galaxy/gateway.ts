import type { SystemGateway } from '@server/ws';
import type { GalaxyRouter } from './router';

/**
 * WS gateway over the galaxy router (TASK-11): join_system spawns/reuses the
 * system shard, enforces the 16-player cap, and hands the player the initial
 * full snapshot; the WS layer then takes over (presence, leave on close).
 */
export function createRouterGateway(router: GalaxyRouter): SystemGateway {
  return {
    enterSystem: (systemId, player) => router.enter(systemId, player),
    // TASK-17: the connection identity rides along so a late close of a
    // superseded (zombie) socket cannot evict the reconnected player's conn.
    leaveSystem: (systemId, player) => router.leave(systemId, player.playerId, player.source),
    // TASK-8: inter-system warp — the router moves the ship row + entity
    // from the source shard to the target's spawn gate.
    warpSystem: (fromSystemId, targetSystemId, player) =>
      router.warp(fromSystemId, targetSystemId, player),
  };
}
