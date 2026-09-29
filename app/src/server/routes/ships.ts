import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { homeDockPosition } from '@shared/galaxy/dock';
import { shipStats, type ShipClass } from '@shared/ships';
import { InsufficientCreditsError } from '@server/db/errors';
import type { ShipRow } from '@server/db/schema';
import { requireAuth } from './auth';
import type { RouteDeps } from './callsigns';

const buyBody = z.object({ classId: z.string().min(1).max(32) }).strict();

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
}
