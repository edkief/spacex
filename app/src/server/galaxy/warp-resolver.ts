/**
 * Warp resolver (TASK-8) — inter-system travel.
 *
 * Wraps the in-process `GalaxyRouter` so the WS layer can resolve
 * an inbound `warp { targetSystemId }` frame into the canonical
 * target-system snapshot the client should hydrate.
 *
 * The happy path mirrors `buildRouterJoinResolver` (TASK-12) but
 * with two extra steps:
 *
 *   1. **Flush + remove from source shard.** The caller's
 *      `Connection.systemId` is the source; the source shard's
 *      ship entity is flushed via `flushShips()` so the ship
 *      state survives the warp even if the player disconnects
 *      mid-jump. The connection is then removed from the source
 *      shard via `router.leaveSystem(fromSystemId, connId)` so
 *      the presence roster reflects the departure before the
 *      join is broadcast on the target shard.
 *
 *   2. **Reposition at the target spawn gate.** The player's
 *      persisted ship row is updated (via `repo.saveShipState`)
 *      to the target system's spawn-gate position (100 u along
 *      +X from the target star, facing the star along -X) so
 *      the target shard's hydrate step (TASK-12) sees the new
 *      position when the entity is spawned. Without this, the
 *      ship would resurrect at the source system's coordinates
 *      inside the target shard.
 *
 * Failure paths:
 *   - **Same system**: rejected with `same-system` so a buggy
 *     client (or a stale chart selection) gets a clear error.
 *   - **Player / ship missing**: rejected with `system-not-found`.
 *   - **Target system missing** (not in the seeded galaxy):
 *     rejected with `system-not-found`. The connection's source
 *     shard is left intact so the player can pick a different
 *     target.
 *   - **Target shard full**: rejected with `system-full`. The
 *     player stays in the source shard (the persisted position
 *     is rolled back best-effort).
 *
 * Because the resolver mutates the persisted ship row, it
 * requires `repo` (the database handle) in addition to the
 * router — pure/test resolvers can swap in an in-memory repo.
 *
 * @see ./router.ts for the underlying router.
 * @see ./join-resolver.ts for the initial-join sibling.
 * @see ../ws.handlers.ts#onWarp for the WS consumer.
 */
import { quatFromAxisAngle } from "@shared/physics/vec.js";

import type { Repository } from "../db/repo.js";
import { buildSnapshotEntities } from "../shard/index.js";
import { flushShips } from "../shard/persist.js";
import type { JoinResolverResult } from "../ws.js";

import { findStar } from "./system-data.js";
import type { GalaxyRouter, RouterConnectionContext } from "./router.js";

/**
 * Result returned to a successful warp. Same wire shape as a
 * fresh `join_system` (the client uses the exact same hydration
 * path) plus the `targetSystemId` echo so the warp state machine
 * can correlate the frame with the in-flight target.
 */
export type WarpResolverResult = JoinResolverResult & { targetSystemId: string };

/** Deps of `buildRouterWarpResolver`. */
export interface RouterWarpResolverDeps {
  repo: Repository;
  router: GalaxyRouter;
  galaxySeed: string;
  galaxyStarCount: number;
}

/**
 * Spawn-gate offset (game units) from the star along +X. Spec:
 * "100 u from the star along the +X axis, facing the star".
 * Kept as a named constant so the unit tests pin it explicitly.
 */
export const SPAWN_GATE_OFFSET_U = 100;

/**
 * The warp resolver contract. Called by the WS handler with the
 * decoded `warp` payload + the connection metadata it already
 * has on hand (callsign, connId, source systemId).
 */
export type WarpResolver = (
  toSystemId: string,
  callsign: string,
  connId: string,
  fromSystemId: string,
) => Promise<WarpResolverResult>;

/**
 * Build a `WarpResolver` adapter for the in-process router. The
 * caller wires the result into `attachWs({ warpResolver })`
 * exactly like any other resolver.
 *
 * The resolver is the single place that mutates the player's
 * persisted position/quat for a warp; the WS handler is
 * responsible for the wire encode + presence-broadcast
 * side-effects.
 */
export function buildRouterWarpResolver(deps: RouterWarpResolverDeps): WarpResolver {
  const { repo, router, galaxySeed, galaxyStarCount } = deps;
  return async (toSystemId, callsign, connId, fromSystemId) => {
    if (toSystemId === fromSystemId) {
      throw warpError(
        "same-system",
        `Already in system ${fromSystemId}; cannot warp to the same system`,
        toSystemId,
      );
    }
    // Look up the player + ship so we can mint the per-connection
    // `SimEntity` in the target shard. Same pattern as
    // `buildRouterJoinResolver` (TASK-12).
    const player = await repo.findPlayerByCallsign(callsign);
    if (!player) {
      throw warpError("system-not-found", `Player ${callsign} not found`, toSystemId);
    }
    const ships = await repo.listShipsByOwner(player.id);
    const ship = ships[0];
    if (!ship) {
      throw warpError("system-not-found", `Player ${callsign} has no ship`, toSystemId);
    }

    // ---- 1. Flush the source shard so the ship's current state
    //         (pos, vel, hull, shields) survives the warp. Skip
    //         silently when the source shard has already been
    //         reaped — at that point the ship row is the source
    //         of truth and an old flush would just rewrite the
    //         same data.
    const sourceShard = router.get(fromSystemId);
    if (sourceShard) {
      try {
        await flushShips(sourceShard, repo);
      } catch {
        // Don't block the warp on a transient flush error — the
        // DB row is still authoritative from the last successful
        // flush.
      }
    }

    // ---- 2. Compute the target spawn gate. We resolve the
    //         target's star position through `findStar` so the
    //         gate is identical for every peer (deterministic
    //         coordinate system). For v1 the star coordinates
    //         matter only as a seed offset; the gate is 100 u
    //         along +X.
    const targetStar = findStar(galaxySeed, galaxyStarCount, toSystemId);
    if (!targetStar) {
      throw warpError("system-not-found", `System ${toSystemId} not found`, toSystemId);
    }
    const gatePos = {
      x: targetStar.x + SPAWN_GATE_OFFSET_U,
      y: targetStar.y,
      z: targetStar.z,
    };
    // Ship's forward (+Z body axis) should point at the star
    // from the gate — i.e. world vector (-1, 0, 0). That's a
    // -π/2 (90°) rotation around world +Y (right-hand rule: a
    // positive +Y rotation takes +Z to +X, so we need the
    // opposite sign to take +Z to -X).
    // `quatFromAxisAngle` returns a unit quaternion so the
    // integrator doesn't need to re-normalise.
    const gateQuat = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, -Math.PI / 2);

    // ---- 3. Persist the new position BEFORE spawning the
    //         target shard entity so the hydrate step (which
    //         reads the DB) sees the spawn-gate coords.
    await repo.saveShipState(ship.id, {
      position: { systemId: toSystemId, ...gatePos },
      quat: [gateQuat.x, gateQuat.y, gateQuat.z, gateQuat.w],
      state: "flying",
      velocity: { x: 0, y: 0, z: 0 },
      // Keep hull + shields untouched so the warping player
      // doesn't get healed by the transfer.
    });

    // ---- 4. Drop the connection from the source shard. If the
    //         source shard has been reaped between the flush and
    //         here, `leaveSystem` returns `false` and we quietly
    //         proceed.
    router.leaveSystem(fromSystemId, connId);

    // ---- 5. Spawn the target shard (if needed) and add the
    //         connection. `router.joinSystem` re-checks the cap
    //         so a target that became full between the previous
    //         step and this one is rejected with `system-full`.
    const ctx: RouterConnectionContext = {
      connId,
      callsign: player.callsign,
      playerId: player.id,
      ship: {
        id: ship.id,
        classId: ship.classId,
        hull: ship.hull,
        shields: ship.shields,
        quat: [gateQuat.x, gateQuat.y, gateQuat.z, gateQuat.w],
      },
    };
    const result = await router.joinSystem(toSystemId, ctx);
    if ("code" in result) {
      // Target full or unreachable. Roll the persisted row back
      // to the source coords (best-effort) so a reconnecting
      // player doesn't respawn inside the target system.
      await repo
        .saveShipState(ship.id, {
          position: { systemId: fromSystemId, x: 0, y: 0, z: 0 },
          state: "flying",
        })
        .catch(() => undefined);
      throw warpError(result.code as Parameters<typeof warpError>[0], result.message, toSystemId);
    }

    const entities = buildSnapshotEntities(result.shard);
    const chat = result.shard.chatLog.snapshot();
    // Players list is intentionally empty here — the broadcast
    // loop fills it for every snapshot, and the initial `enter_system`
    // / `warp_arrived` payload is consumed by the client's
    // presence/chat stores which already track the roster via
    // dedicated `presence` frames.
    const players: unknown[] = [];
    return {
      targetSystemId: toSystemId,
      systemId: result.systemId,
      entities,
      nodes: [],
      chat,
      players,
      serverTickHz: 20,
      snapshotTick: result.snapshotTick,
    } satisfies WarpResolverResult;
  };
}

/**
 * Build a uniform error tagged with a `code` so the WS handler
 * can extract the wire code without juggling multiple error
 * classes. Mirrors the join-resolver helper.
 */
function warpError(
  code: string,
  message: string,
  targetSystemId: string,
): Error & { code: string; targetSystemId: string } {
  const err = new Error(message) as Error & { code: string; targetSystemId: string };
  err.code = code;
  err.targetSystemId = targetSystemId;
  return err;
}
