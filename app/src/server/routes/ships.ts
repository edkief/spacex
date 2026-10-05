import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { homeDockPosition } from '@shared/galaxy/dock';
import { repairCost } from '@shared/physics/damage';
import { shipStats, type ShipClass } from '@shared/ships';
import { isResourceId } from '@shared/inventory';
import { TERMINAL_RANGE_M } from '@shared/world/terminals';
import { InsufficientCreditsError } from '@server/db/errors';
import type { ShipRow } from '@server/db/schema';
import { requireAuth } from './auth';
import type { RouteDeps } from './callsigns';

const buyBody = z.object({ classId: z.string().min(1).max(32) }).strict();

/** TASK-40: the sell body — the WS 'sell' payload, one shape for both. */
const sellBody = z
  .object({
    resourceId: z.string().min(1).max(32),
    amount: z.number().int().finite().positive(),
    source: z.enum(['hold', 'inv']),
  })
  .strict();

/** TASK-21: exactly the three named paint slots, hex colors, no extras. */
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const liveryBody = z
  .object({
    colors: z.object({ hull: hexColor, accent: hexColor, trim: hexColor }).strict(),
  })
  .strict();

/** Ship row with its catalog class merged in (class: null if the id is unknown). */
function shipPayload(ship: ShipRow): { ship: ShipRow; class: ShipClass | null } {
  let cls: ShipClass | null;
  try {
    cls = shipStats(ship.classId);
  } catch {
    cls = null;
  }
  return { ship, class: cls };
}

/**
 * Ship acquisition (TASK-20). One ship per player in v1: a purchase deducts
 * the price, scrubs the old ship + cargo, and inserts the new ship docked at
 * the system dock — all in one transaction. After commit the in-process
 * bus notifies the player's system shard, which swaps the entity in place.
 */
export function registerShipRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/api/ships', async (req, reply) => {
    const auth = await requireAuth(req, deps.sessions);
    if (!auth.ok) {
      return reply.code(401).send({ code: 'unauthenticated', reason: auth.reason });
    }
    const ship = await deps.repo.getShipByOwner(auth.player.id);
    if (!ship) {
      return reply.code(404).send({ code: 'no-ship', message: 'player has no ship' });
    }
    return shipPayload(ship);
  });

  app.post('/api/ships/buy', async (req, reply) => {
    const auth = await requireAuth(req, deps.sessions);
    if (!auth.ok) {
      return reply.code(401).send({ code: 'unauthenticated', reason: auth.reason });
    }
    const player = auth.player;

    const parsed = buyBody.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return reply.code(400).send({
        code: 'invalid-body',
        message: issue?.message ?? 'classId is required',
      });
    }
    let cls: ShipClass;
    try {
      cls = shipStats(parsed.data.classId);
    } catch {
      return reply
        .code(400)
        .send({ code: 'unknown-class', message: `unknown ship class: ${parsed.data.classId}` });
    }

    const ship = await deps.repo.getShipByOwner(player.id);
    if (!ship) {
      return reply.code(404).send({ code: 'no-ship', message: 'player has no ship' });
    }
    if (ship.classId === cls.id) {
      return reply.code(409).send({ code: 'already-owned', message: `already owns the ${cls.id}` });
    }
    if (ship.state !== 'docked') {
      return reply
        .code(409)
        .send({ code: 'not-docked', message: 'dock the current ship before buying' });
    }

    const price = cls.price;
    let balance = await deps.repo.getBalance(player.id);
    if (balance < price) {
      return reply.code(422).send({
        code: 'insufficient-credits',
        message: `need ${price} credits, have ${balance}`,
        balance,
        price,
      });
    }

    let swap: { ship: ShipRow; oldId: string };
    try {
      // One transaction: withdraw → scrub old ship + cargo → insert new ship
      // (docked at the system dock, class-full hull/shields, default livery).
      swap = await deps.repo.withTransaction(async (tx) => {
        if (price > 0) {
          const paid = await tx.withdrawCredits(player.id, price);
          balance = paid.credits;
        }
        const old = (await tx.getShipByOwner(player.id)) ?? ship;
        await tx.deleteShipWithCargo(old.id);
        const created = await tx.createShip({
          ownerId: player.id,
          classId: cls.id,
          hull: cls.hull,
          shields: cls.shieldCapacity,
          position: {
            systemId: old.position.systemId,
            ...homeDockPosition(deps.galaxySeed, old.position.systemId),
          },
          state: 'docked',
        });
        return { ship: created, oldId: old.id };
      });
    } catch (err) {
      // A concurrent spend can drive the conditional withdraw to zero rows.
      if (err instanceof InsufficientCreditsError) {
        return reply.code(422).send({
          code: 'insufficient-credits',
          message: err.message,
          balance: err.balance,
          price,
        });
      }
      throw err;
    }
    const newShip = swap.ship;
    const oldShipId = swap.oldId;

    // Notify the system shard (no-op when no shard is active for the system).
    deps.shipSwapBus?.emitSwap({ playerId: player.id, ship: newShip, oldShipId });

    return reply.code(201).send({ ...shipPayload(newShip), balance });
  });

  /**
   * POST /api/ships/livery (TASK-21) — dock customization. Replaces all
   * three paint slots in one atomic write; any peer in the ship's system
   * gets an `entity_update` with the new colors.
   */
  app.post('/api/ships/livery', async (req, reply) => {
    const auth = await requireAuth(req, deps.sessions);
    if (!auth.ok) {
      return reply.code(401).send({ code: 'unauthenticated', reason: auth.reason });
    }
    const player = auth.player;

    const parsed = liveryBody.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return reply.code(400).send({
        code: 'invalid-livery',
        message: issue?.message ?? 'expected {colors: {hull, accent, trim}} hex colors',
      });
    }

    const ship = await deps.repo.getShipByOwner(player.id);
    if (!ship) {
      return reply.code(404).send({ code: 'no-ship', message: 'player has no ship' });
    }

    const updated = await deps.repo.saveShipState(ship.id, {
      hull: ship.hull,
      shields: ship.shields,
      position: ship.position,
      velocity: ship.velocity,
      state: ship.state,
      livery: parsed.data.colors,
    });

    // Notify the system shard (no-op when no shard is active for the system).
    deps.shipSwapBus?.emitLivery({ playerId: player.id, livery: parsed.data.colors });

    return shipPayload(updated);
  });

  /**
   * POST /api/ships/repair (TASK-23) — dock repair. Full hull + shield restore
   * for a credit cost computed from the class maxes:
   * `ceil((1 - hull/maxHull) * 10) + ceil((1 - shields/maxShields) * 5)`.
   * Requires a DOCKED ship. The cost is withdrawn via TASK-41 in the SAME
   * transaction as the hull/shield reset (one atomic write: a failed reset
   * rolls the spend back, a failed spend never resets the ship). A 0-cost
   * call on a full ship is a no-op success. After commit the in-process bus
   * notifies the system shard, which revives / updates the in-shard entity
   * and its next 10 Hz snapshot carries the restored hull/shields.
   */
  app.post('/api/ships/repair', async (req, reply) => {
    const auth = await requireAuth(req, deps.sessions);
    if (!auth.ok) {
      return reply.code(401).send({ code: 'unauthenticated', reason: auth.reason });
    }
    const player = auth.player;

    const ship = await deps.repo.getShipByOwner(player.id);
    if (!ship) {
      return reply.code(404).send({ code: 'no-ship', message: 'player has no ship' });
    }
    if (ship.state !== 'docked') {
      return reply.code(409).send({ code: 'not-docked', message: 'repair requires a docked ship' });
    }

    const cls = shipStats(ship.classId);
    const cost = repairCost(ship.classId, ship.hull, ship.shields);
    let balance = await deps.repo.getBalance(player.id);
    if (balance < cost) {
      return reply.code(422).send({
        code: 'insufficient-credits',
        message: `need ${cost} credits, have ${balance}`,
        balance,
        cost,
      });
    }

    let repaired: ShipRow;
    try {
      // One transaction: withdraw the cost, then restore to class caps.
      // A cost of 0 (full ship) skips the withdraw but still commits the
      // (no-op) restore so the response reflects canonical full values.
      repaired = await deps.repo.withTransaction(async (tx) => {
        if (cost > 0) {
          const paid = await tx.withdrawCredits(player.id, cost);
          balance = paid.credits;
        }
        return await tx.saveShipState(ship.id, {
          hull: cls.hull,
          shields: cls.shieldCapacity,
          position: ship.position,
          velocity: ship.velocity,
          state: ship.state,
        });
      });
    } catch (err) {
      // A concurrent spend can drive the conditional withdraw to zero rows.
      if (err instanceof InsufficientCreditsError) {
        return reply.code(422).send({
          code: 'insufficient-credits',
          message: err.message,
          balance: err.balance,
          cost,
        });
      }
      throw err;
    }

    // Notify the system shard (no-op when no shard is active for the system).
    // Reuses the swap event: the in-shard handler resets hull/shields in place
    // and, if the entity was destroyed, revives it.
    deps.shipSwapBus?.emitSwap({ playerId: player.id, ship: repaired, oldShipId: ship.id });

    return { ...shipPayload(repaired), balance, cost };
  });

  /**
   * POST /api/ships/sell (TASK-40) — sell cargo to the dock. The WS 'sell'
   * frame is an alias of this endpoint: BOTH delegate to the SAME handler
   * (shard.handleSell), so the two surfaces can never diverge. The live
   * system shard is the position authority (the docked state + the on-foot
   * terminal proximity are shard state, never row state), so the ship's
   * system must have an active shard — a player who is not in the station
   * cannot sell here (409 not-in-system, the dev-route precedent).
   *
   * Success: {sold, earned, newBalance} — the credits were granted in the
   * SAME transaction as the stack decrement (atomicity: one commit).
   * Errors map the handler's codes: not-at-station / not-docked /
   * insufficient → 409/409/422, unknown resource / bad amount → 400.
   */
  app.post('/api/ships/sell', async (req, reply) => {
    const auth = await requireAuth(req, deps.sessions);
    if (!auth.ok) {
      return reply.code(401).send({ code: 'unauthenticated', reason: auth.reason });
    }
    const player = auth.player;

    const parsed = sellBody.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return reply.code(400).send({
        code: 'invalid-body',
        message: issue?.message ?? 'expected {resourceId, amount, source: hold|inv}',
      });
    }
    if (!isResourceId(parsed.data.resourceId)) {
      return reply
        .code(400)
        .send({ code: 'unknown-resource', message: `unknown resource: ${parsed.data.resourceId}` });
    }

    const ship = await deps.repo.getShipByOwner(player.id);
    if (!ship) {
      return reply.code(404).send({ code: 'no-ship', message: 'player has no ship' });
    }
    const active = deps.galaxyRouter?.active(ship.position.systemId);
    if (!active) {
      return reply.code(409).send({
        code: 'not-in-system',
        message: 'ship system has no active shard — sell from in-system',
      });
    }

    const result = await active.shard.handleSell(player.id, parsed.data);
    if (result.ok) {
      return { sold: result.sold, earned: result.earned, newBalance: result.balance };
    }
    switch (result.code) {
      case 'invalid-resource':
        return reply.code(400).send({
          code: 'invalid-resource',
          message: `unknown resource ${parsed.data.resourceId}`,
        });
      case 'invalid-amount':
        return reply
          .code(400)
          .send({ code: 'invalid-amount', message: 'amount must be a positive integer' });
      case 'not-docked':
        return reply
          .code(409)
          .send({ code: 'not-docked', message: 'the ship must be docked at the station to sell' });
      case 'not-at-station':
        return reply.code(409).send({
          code: 'not-at-station',
          message: `sell from your inventory requires standing within ${TERMINAL_RANGE_M} m of a station terminal`,
        });
      case 'insufficient':
        return reply.code(422).send({
          code: 'insufficient',
          message: 'not enough of that resource in the selected source',
        });
      case 'unknown-ship':
        return reply.code(404).send({ code: 'no-ship', message: 'player has no ship in-system' });
      default:
        return reply
          .code(500)
          .send({ code: 'sell-failed', message: 'the sale could not be completed' });
    }
  });
}
