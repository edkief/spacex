/**
 * REST route for dock repair (TASK-23).
 *
 *   POST /api/ships/repair
 *     header: Authorization: Bearer <token>
 *     body:   { shipId?: string } — optional; defaults to the
 *             player's owned ship (one per player in v1, see
 *             TASK-20). Accepting an explicit shipId makes the route
 *             forward-compatible with future multi-ship ownership.
 *
 *     200:    { ship, class, cost, newBalance } — the post-repair
 *             ship row + catalog stats + the deducted credit cost +
 *             the player's new balance.
 *     401:    { code: "unauthenticated", message } — bad / missing token.
 *     409:    { code: "not-docked", message } — ship is mid-flight.
 *     422:    { code: "insufficient-credits", message } — cost > balance.
 *
 * The repair transaction (`repo.repairShip`) is atomic: it withdraws
 * the cost AND restores hull/shields inside one BEGIN ... COMMIT,
 * so a half-applied repair is impossible. The cost formula lives in
 * `@shared/physics/damage.repairCost` so the client and the server
 * agree on the same number (and so the unit tests can pin the
 * arithmetic).
 *
 * No broadcast on the WS shards bus for v1 — the live shard will
 * pick up the new HP on the next entity_update tick (10 Hz). A
 * future TASK-25 may push an immediate `combat_event`-style
 * notification when the player docks + repairs, but that's
 * decorative; the entity_update carries the truth.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

import { repairCost } from "@shared/physics/damage.js";
import { shipStats } from "@shared/ships.js";

import { InsufficientCreditsError, NotDockedError, type Repository } from "../db/repo.js";
import { loadSessionProfile } from "../auth/resolver.js";
import { getShardsBus } from "../shards/event-bus.js";

/** Public deps shared by tests and the live server. */
export interface RepairRouteDeps {
  repo: Repository;
  sessionSecret: string;
  /** Wall-clock override used by tests. */
  nowMs?: number;
}

/** Bearer-token extractor (case-insensitive, per RFC 7235). */
function readBearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization ?? req.headers.Authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^Bearer\s+/iu.test(trimmed)) return null;
  return trimmed.slice("Bearer ".length).trim();
}

/** Structured error body used for every failure response. */
function errBody(code: string, message: string): { code: string; message: string } {
  return { code, message };
}

/**
 * Register the repair route on the given Fastify instance.
 *
 * `buildApp()` is the only intended caller; tests wrap their own
 * Fastify + deps and call this directly so they can supply an
 * in-memory repo.
 */
export function registerRepairRoute(app: FastifyInstance, deps: RepairRouteDeps): void {
  app.post("/api/ships/repair", async (req: FastifyRequest, reply: FastifyReply) => {
    const token = readBearer(req);
    if (token === null) {
      return reply.code(401).send(errBody("unauthenticated", "Missing bearer token"));
    }
    const profile = await loadSessionProfile(deps.repo, deps.sessionSecret, token, {
      nowMs: deps.nowMs,
    });
    if (profile === null) {
      return reply.code(401).send(errBody("unauthenticated", "Token invalid or expired"));
    }

    // Body is optional and may include a `{ shipId }` override. v1 has
    // only one ship per player so we default to the profile's shipId.
    // Validate that if a `shipId` is provided it's a non-empty string.
    const body = (req.body ?? {}) as { shipId?: unknown };
    const shipId =
      typeof body.shipId === "string" && body.shipId.length > 0 ? body.shipId : profile.shipId;

    // Load the live ship row to read class + current HP for the cost
    // calc. A different `shipId` than the profile's is fine; we just
    // enforce ownership below.
    const owned = await deps.repo.listShipsByOwner(profile.playerId);
    const ship = owned.find((s) => s.id === shipId);
    if (!ship) {
      return reply.code(404).send(errBody("ship-not-found", "Player does not own that ship"));
    }

    // Compute the cost from the current HP. If the ship is already
    // fully repaired, the cost is 0 and we still call `repairShip`
    // (it is a no-op withdrawal + a redundant full-restore; either
    // way the response shape is the same).
    const klass = shipStats(ship.classId);
    const cost = repairCost({ hull: ship.hull, shields: ship.shields }, ship.classId);

    // Atomic credit-withdraw + hull/shield restore. Any of the
    // typed errors surface as their HTTP code; everything else
    // propagates as a 500.
    let repaired;
    try {
      repaired = await deps.repo.repairShip({
        playerId: profile.playerId,
        shipId: ship.id,
        cost,
        maxHull: klass.hull,
        maxShields: klass.shieldCapacity,
      });
    } catch (err) {
      if (err instanceof NotDockedError) {
        return reply.code(409).send(errBody("not-docked", "Must be docked to repair"));
      }
      if (err instanceof InsufficientCreditsError) {
        return reply
          .code(422)
          .send(errBody("insufficient-credits", "Not enough credits to repair"));
      }
      throw err;
    }

    // Refresh balance for the response. After `repairShip` succeeds
    // we know the withdraw succeeded, so a re-read cannot throw
    // `InsufficientCreditsError` here.
    const newBalance = await deps.repo.getBalance(profile.playerId);

    // Publish on the shards bus so an active system shard (future
    // TASK-11) can broadcast `entity_update` with the post-repair
    // HP. Same defensive pattern as `ships.ts`: never fail the
    // response on a bus glitch because the DB write already
    // committed.
    try {
      getShardsBus().publishLiveryChanged({
        playerId: profile.playerId,
        shipId: repaired.id,
        livery: repaired.livery,
        systemId: repaired.position.systemId,
      });
    } catch {
      // Bus failures must not break the response — the DB write
      // already committed. A subscriber that died is its own problem.
    }

    return reply.code(200).send({
      ship: {
        id: repaired.id,
        ownerId: repaired.ownerId,
        classId: repaired.classId,
        livery: repaired.livery,
        hull: repaired.hull,
        shields: repaired.shields,
        position: repaired.position,
        velocity: repaired.velocity,
        state: repaired.state,
        updatedAt: repaired.updatedAt.toISOString(),
      },
      class: klass,
      cost,
      newBalance,
    });
  });
}
