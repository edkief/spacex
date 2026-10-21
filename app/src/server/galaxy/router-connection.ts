/**
 * Router per-connection bookkeeping (TASK-11 + TASK-12).
 *
 * Encapsulates the "register a player connection on a shard" step
 * so the router's `joinSystem` doesn't carry the entity-spawn
 * boilerplate inline. Pure functions: each helper takes the
 * inputs it needs and mutates the shard / connection directly.
 *
 * @see ./router.ts for the consumer.
 */
import type { Shard, ShardConnection } from "../shard/types.js";
import { spawnShip } from "../shard/index.js";
import { AI_GHOST_CONN_PREFIX } from "../shard/ai.js";
import type { RouterConnectionContext } from "./router-types.js";

/**
 * True for a `ShardConnection` that represents an AI ghost
 * (TASK-45 / `src/server/shard/ai.ts#ensureAiGhostConnection`).
 * Ghosts share `shard.connections` with real players so the AI
 * state machine can route `handleFire` through the same
 * `connId` dispatch path, but the 16-player cap and the
 * presence roster only count real players — otherwise a
 * 16-real-player shard with one AI firing would read 17 and
 * the cap probe would always fail.
 */
export function isAiGhostConnection(conn: ShardConnection): boolean {
  return conn.connId.startsWith(AI_GHOST_CONN_PREFIX);
}

/**
 * Count the real (non-AI-ghost) connections on a shard. The
 * 16-player cap is enforced against this count, not against
 * `shard.connections.size`, which would otherwise include
 * every AI that has fired at least once.
 */
export function countRealPlayerConnections(shard: Shard): number {
  let n = 0;
  for (const conn of shard.connections.values()) {
    if (isAiGhostConnection(conn)) continue;
    n += 1;
  }
  return n;
}

/**
 * Mint a `ShardConnection` from the router-side context. The
 * caller adds it to `shard.connections` after the cap check so a
 * rejected join never appears in the registry.
 */
export function makeShardConnection(ctx: RouterConnectionContext): ShardConnection {
  return {
    connId: ctx.connId,
    callsign: ctx.callsign,
    playerId: ctx.playerId,
    shipId: ctx.ship.id,
    entityId: null,
    lastSeq: 0,
    pendingInput: null,
    staleDrops: 0,
  };
}

/**
 * Bind the connection to a player-owned entity on the shard. If
 * the hydrate step already minted the entity (reconnect path) we
 * just point the connection at it; otherwise we spawn a fresh
 * entity with the persisted `ShipRow` fields.
 *
 * Returns the entity id the connection is bound to (used for
 * later input dispatch).
 */
export function bindConnectionToEntity(
  shard: Shard,
  conn: ShardConnection,
  ctx: RouterConnectionContext,
): string {
  const existingEntity = shard.entities.get(`entity:${ctx.ship.id}`);
  if (existingEntity !== undefined) {
    // Reconnect: bind the connection to the entity that already
    // holds the right ownership metadata.
    conn.entityId = existingEntity.id;
    return existingEntity.id;
  }
  spawnShip(shard, {
    shipId: ctx.ship.id,
    playerId: ctx.playerId,
    callsign: ctx.callsign,
    classId: ctx.ship.classId,
    hull: ctx.ship.hull,
    shields: ctx.ship.shields,
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    quat: {
      x: ctx.ship.quat[0],
      y: ctx.ship.quat[1],
      z: ctx.ship.quat[2],
      w: ctx.ship.quat[3],
    },
    regime: "space",
    originPlanetId: null,
    onPad: null,
    bindConnId: conn.connId,
  });
  // spawnShip binds the connection too; return the entity id the
  // caller wants for any downstream wiring.
  return `entity:${ctx.ship.id}`;
}
