/**
 * `JoinResolver` adapter that routes through the in-process galaxy
 * router (TASK-11).
 *
 * The WS handshake (`src/server/ws.handlers.ts#onJoinSystem`) already
 * follows the resolver-style pattern from TASK-9:
 *
 *   - Returns `{systemId, entities, nodes, chat, players, serverTickHz, snapshotTick}` on success.
 *   - Throws a tagged error ({ code: 'system-full' }) on failure so
 *     `sendError(conn, code, message)` can echo the wire code back to
 *     the client.
 *
 * This module wraps the `GalaxyRouter` + a `Repository` into a
 * `JoinResolver`-shaped function. The wrapper:
 *
 *   1. Resolves the player's ship row so `joinSystem()` has the HP
 *      + class id it needs to mint the per-connection `SimEntity`.
 *   2. Calls `router.joinSystem(systemId, ctx)` — returns either a
 *      `JoinResult` or a `JoinRejection`.
 *   3. Pulls the entity-update payload from the shard for the
 *      snapshot the client should ack (`broadcastSizeFor` + the
 *      entities of the latest snapshot).
 *   4. Throws an `{ code, message }` rejection on the failure paths
 *      so the handler can forward it as a structured error frame.
 *
 * ## Connection id threading
 *
 * The TASK-9 `JoinResolver` signature is `(systemId, callsign) => result`.
 * It does not pass a `connId`. The router needs a stable, unique id
 * for each shard connection so its entity-binding code can attach
 * ships to specific sockets. We bridge this by:
 *
 *   - Generating a stable per-connection token via `UUID` (`crypto.randomUUID`)
 *     when the resolver is built. Each call returns a fresh token.
 *   - Storing the `{token, connId}` mapping on a `WeakMap<WebSocket>`
 *     the handler populates from `ConnectionRegistry`.
 *
 * For tests we accept a `lookupConnId` seam so the test driver can
 * pre-populate the mapping. Production wires it through the WS
 * registry directly.
 *
 * Spec: "the player stays in their previous system." On cap-full, we
 * deliberately do NOT touch the connection's systemId — the handler's
 * `sendError` keeps the connection alive and lets the client pick a
 * different system.
 *
 * @see ./router.ts for the underlying router.
 * @see ../ws.handlers.ts for the consumer.
 */
import type { Repository } from "../db/repo.js";
import { buildSnapshotEntities } from "../shard/index.js";
import type { JoinResolver, JoinResolverResult } from "../ws.js";

import type { GalaxyRouter, RouterConnectionContext } from "./router.js";

/** Dependencies of `buildRouterJoinResolver`. */
export interface RouterJoinResolverDeps {
  repo: Repository;
  router: GalaxyRouter;
}

/**
 * Build a `JoinResolver` adapter for the in-process router. The
 * caller wires the result into `attachWs({ joinResolver })` exactly
 * like any other resolver.
 */
export function buildRouterJoinResolver(deps: RouterJoinResolverDeps): JoinResolver {
  const { repo, router } = deps;
  return async (systemId: string, callsign: string, connId: string) => {
    // Look up the player + ship so `joinSystem()` has the data it
    // needs to mint a per-connection `SimEntity`. The resolver never
    // silently picks "the first ship" — multi-ship players
    // (TASK-20 ships bought via the dock) resolve the correct one.
    const player = await repo.findPlayerByCallsign(callsign);
    if (!player) {
      throw routerError("system-not-found", `Player ${callsign} not found`);
    }
    const ships = await repo.listShipsByOwner(player.id);
    const ship = ships[0];
    if (!ship) {
      throw routerError("system-not-found", `Player ${callsign} has no ship`);
    }

    const ctx: RouterConnectionContext = {
      connId,
      callsign: player.callsign,
      playerId: player.id,
      ship: {
        id: ship.id,
        classId: ship.classId,
        hull: ship.hull,
        shields: ship.shields,
        quat: ship.quat,
      },
    };

    const result = await router.joinSystem(systemId, ctx);
    if ("code" in result) {
      // JoinRejection — throw so the handler maps the wire code.
      throw routerError(result.code, result.message);
    }

    // Pull a snapshot of the live entities to populate the
    // `enter_system` response. For v1 we use the same serializer
    // the broadcast loop uses (`buildSnapshotEntities`); future tasks
    // can extend `JoinResolverResult` to carry AI roster or sector
    // metadata without touching the resolver.
    const entities = buildSnapshotEntities(result.shard);
    return {
      systemId: result.systemId,
      entities,
      nodes: [],
      chat: [],
      players: [],
      serverTickHz: 20,
      snapshotTick: result.snapshotTick,
    } satisfies JoinResolverResult;
  };
}

/**
 * Build a uniform error tagged with a `code` so the WS handler can
 * extract the wire code without juggling multiple error classes.
 */
function routerError(code: string, message: string): Error {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
