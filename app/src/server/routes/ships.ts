/**
 * REST routes for the player's owned ship (TASK-20).
 *
 *   GET  /api/ships
 *     header: Authorization: Bearer <token>
 *     200:   { ship, class } — full ship row + catalog stats merged.
 *     401:   { code: "unauthenticated", message }
 *
 *   POST /api/ships/buy
 *     header: Authorization: Bearer <token>
 *     body:  { classId: "scout" | "freighter" | "interceptor" }
 *     200:   { ship, class } — the newly-purchased ship.
 *     400:   { code: "unknown-class", message }    — bad classId.
 *     409:   { code: "not-docked", message }       — player is mid-flight.
 *     409:   { code: "already-owned", message }    — owning the same class.
 *     422:   { code: "insufficient-credits", message } — credits < price.
 *     401:   { code: "unauthenticated", message }  — bad / missing token.
 *
 * Both routes share the same response shape: the full ship row +
 * the catalog entry (`@shared/ships`) for client-side rendering.
 * The `class` payload exposes every stat the dock UI / ship HUD might
 * need in one round-trip — keeps the client from re-fetching the
 * static catalog separately.
 *
 * The buy endpoint delegates persistence to `repo.purchaseShip` which
 * wraps validation + credit withdraw + ship replacement in a single
 * transaction. On success it publishes a `ship-swapped` event on the
 * in-process shards bus so an active system shard (future TASK-11)
 * can replace the live entity and broadcast `entity_update`.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

import {
  AlreadyOwnedShipError,
  InsufficientCreditsError,
  NotDockedError,
  type Repository,
} from "../db/repo.js";
import type { ShipLivery, ShipPosition, ShipRow, ShipState, ShipVelocity } from "../db/types.js";
import { loadSessionProfile } from "../auth/resolver.js";
import {
  ShipClassIdSchema,
  type ShipClass,
  type ShipClassId,
  SHIP_CLASSES,
  shipPrice,
  shipStats,
} from "@shared/ships.js";
import { getShardsBus } from "../shards/event-bus.js";

/** Public deps shared by tests and the live server. */
export interface ShipsRouteDeps {
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

/** Wire payload for `GET /api/ships` and `POST /api/ships/buy` responses. */
export interface ShipWirePayload {
  /** Full persisted ship row (TASK-62 type). */
  ship: ReturnType<typeof serializeShipForWire>;
  /** Catalog entry merged from `@shared/ships.js` (TASK-19). */
  class: ShipClass;
}

/**
 * Wire-friendly ship payload. Mirrors the repo `ShipRow` with `updatedAt`
 * projected to an ISO string so the JSON response is trivially
 * serialisable across the WS + REST boundary.
 */
interface ShipWireRow {
  id: string;
  ownerId: string;
  classId: ShipClassId;
  livery: ShipLivery;
  hull: number;
  shields: number;
  position: ShipPosition;
  velocity: ShipVelocity;
  state: ShipState;
  updatedAt: string;
}

/**
 * Convert the repo `ShipRow` into a JSON-friendly payload.
 */
function serializeShipForWire(ship: ShipRow): ShipWireRow {
  return {
    id: ship.id,
    ownerId: ship.ownerId,
    classId: ship.classId,
    livery: ship.livery,
    hull: ship.hull,
    shields: ship.shields,
    position: ship.position,
    velocity: ship.velocity,
    state: ship.state,
    updatedAt: ship.updatedAt.toISOString(),
  };
}

/**
 * Look up the catalog entry for a classId. Pulled into one place so
 * the GET and POST handlers agree on the merge order and the
 * unknown-class error path.
 */
function classFor(classId: ShipClassId): ShipClass {
  return shipStats(classId);
}

/**
 * Register the player-ship REST routes on the given Fastify instance.
 *
 * `buildApp()` is the only intended caller; tests wrap their own
 * Fastify + deps and call this directly so they can supply an
 * in-memory repo.
 */
export function registerShipsRoutes(app: FastifyInstance, deps: ShipsRouteDeps): void {
  app.get("/api/ships", async (req: FastifyRequest, reply: FastifyReply) => {
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
    // Re-load the live ship row + merge with the catalog.
    const owned = await deps.repo.listShipsByOwner(profile.playerId);
    const ship = owned[0];
    if (!ship) {
      return reply
        .code(500)
        .send(errBody("no-ship", "Player has no ship (callsign claim was incomplete)"));
    }
    return reply.code(200).send({
      ship: serializeShipForWire(ship),
      class: classFor(ship.classId),
    });
  });

  app.post("/api/ships/buy", async (req: FastifyRequest, reply: FastifyReply) => {
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

    // Parse the body. `ShipClassIdSchema` only accepts the three v1
    // classes — unknown ids surface as `unknown-class` (400).
    const body = (req.body ?? {}) as { classId?: unknown };
    const parsed = ShipClassIdSchema.safeParse(body.classId);
    if (!parsed.success) {
      return reply.code(400).send(errBody("unknown-class", "Unknown ship class id"));
    }
    const classId: ShipClassId = parsed.data;
    const klass = SHIP_CLASSES[classId];
    const price = shipPrice(classId);

    // Look up the *current* ship to capture its classId for the
    // event-bus payload — we know it exists because the
    // `loadSessionProfile` helper just confirmed one.
    const previous = await deps.repo.listShipsByOwner(profile.playerId);
    const currentShip = previous[0];
    if (!currentShip) {
      return reply
        .code(500)
        .send(errBody("no-ship", "Player has no ship (callsign claim was incomplete)"));
    }

    // Repository-level atomic purchase. The repo throws typed errors
    // we map back to HTTP codes here.
    let newShip;
    try {
      newShip = await deps.repo.purchaseShip({
        playerId: profile.playerId,
        classId,
        price,
        hull: klass.hull,
        shields: klass.shieldCapacity,
        // Livery starts at DEFAULT — TASK-21 will let players customise
        // through a dedicated endpoint after TASK-20 ships.
        livery: currentShip.livery,
      });
    } catch (err) {
      if (err instanceof NotDockedError) {
        return reply.code(409).send(errBody("not-docked", "Must be docked to buy a ship"));
      }
      if (err instanceof AlreadyOwnedShipError) {
        return reply.code(409).send(errBody("already-owned", "You already own this ship class"));
      }
      if (err instanceof InsufficientCreditsError) {
        return reply
          .code(422)
          .send(errBody("insufficient-credits", "Not enough credits to buy this ship"));
      }
      throw err;
    }

    // Publish the ship-swap event on the in-process bus so an active
    // system shard (future TASK-11) can replace the live entity and
    // broadcast `entity_update`. We deliberately publish AFTER the
    // transaction commits so listeners never see a "swapped" entity
    // backed by a row that the transaction later rolls back.
    try {
      getShardsBus().publishShipSwap({
        playerId: profile.playerId,
        newShip,
        previousClassId: currentShip.classId,
      });
    } catch {
      // Bus failures must not break the buy response — the DB write
      // already committed. A subscriber that died is its own problem.
    }

    return reply.code(200).send({
      ship: serializeShipForWire(newShip),
      class: klass,
    });
  });
}
