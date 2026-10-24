import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../middleware/auth';
import { repo } from '../db/repo';
import { SHIP_CLASSES, shipStats, ShipClassId } from '../../shared/ships';
import { gameEvents, GameEventType } from '../events';
import { InsufficientCreditsError, NotFoundError } from '../db/types';
import { db } from '../db/client';
import crypto from 'crypto';
import { z } from 'zod';

const LiverySchema = z.object({
  hull: z.string().regex(/^#([A-Fa-f0-9]{6})$/),
  accent: z.string().regex(/^#([A-Fa-f0-9]{6})$/),
  trim: z.string().regex(/^#([A-Fa-f0-9]{6})$/),
}).strict();

export async function shipsRoutes(fastify: FastifyInstance) {
  // GET /api/ships
  fastify.get('/api/ships', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const session = (request as any).session;
    const ship = await repo.getShipByOwner(session.player_id);

    if (!ship) {
      return reply.status(404).send({
        code: 'no-ship',
        message: 'Player does not own a ship',
      });
    }

    const stats = shipStats(ship.class_id as ShipClassId);

    return {
      ...ship,
      stats,
      livery: typeof ship.livery === 'string' ? JSON.parse(ship.livery) : ship.livery,
      position: typeof ship.position === 'string' ? JSON.parse(ship.position) : ship.position,
      velocity: typeof ship.velocity === 'string' ? JSON.parse(ship.velocity) : ship.velocity,
    };
  });

  // POST /api/ships/livery
  fastify.post('/api/ships/livery', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const session = (request as any).session;
    const playerId = session.player_id;

    const liveryResult = LiverySchema.safeParse(request.body);
    if (!liveryResult.success) {
      return reply.status(400).send({
        code: 'invalid-livery',
        message: 'Invalid livery format. Required: hull, accent, trim as #rrggbb hex strings.',
      });
    }

    const livery = liveryResult.data;
    const ship = await repo.getShipByOwner(playerId);
    if (!ship) {
      return reply.status(404).send({
        code: 'no-ship',
        message: 'Player does not own a ship',
      });
    }

    await repo.saveShipState(ship.id, { livery });

    // Notify shard via event bus
    gameEvents.emit(GameEventType.LIVERY_CHANGED, {
      playerId,
      livery,
    });

    // Return updated ship
    const updatedShip = await repo.getShipByOwner(playerId);
    return {
      ...updatedShip!,
      livery: typeof updatedShip!.livery === 'string' ? JSON.parse(updatedShip!.livery) : updatedShip!.livery,
    };
  });

  // POST /api/ships/buy
  fastify.post('/api/ships/buy', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { classId } = request.body as { classId: string };
    const session = (request as any).session;
    const playerId = session.player_id;

    // 1. Validate classId
    let stats;
    try {
      stats = shipStats(classId as ShipClassId);
    } catch (e) {
      return reply.status(400).send({
        code: 'unknown-class',
        message: `Unknown ship class: ${classId}`,
      });
    }

    // 2. Load current ship
    const oldShip = await repo.getShipByOwner(playerId);
    if (!oldShip) {
      return reply.status(409).send({
        code: 'no-ship-to-replace',
        message: 'Player must own a ship to purchase a new one',
      });
    }

    // 3. Check if docked
    if (oldShip.state !== 'docked') {
      return reply.status(409).send({
        code: 'not-docked',
        message: 'Must be docked to purchase a new ship',
      });
    }

    // 4. Check if already owns this class
    if (oldShip.class_id === classId) {
      return reply.status(409).send({
        code: 'already-owned',
        message: 'You already own a ship of this class',
      });
    }

    // 5. Purchase transaction
    try {
      const newShip = db.transaction((tx) => {
        // Deduct credits (sync)
        const creditResult = repo.withdrawCreditsSync(playerId, stats.price, tx);

        // Scrub old ship (sync)
        repo.deleteShipSync(oldShip.id, tx);

        // Insert new ship (sync)
        return repo.createShipSync({
          owner_id: playerId,
          class_id: classId as ShipClassId,
          system_id: oldShip.system_id,
          state: 'docked',
          hull: stats.hull,
          shields: stats.shieldCapacity,
          livery: {},
          position: oldShip.position,
          velocity: { x: 0, y: 0, z: 0 },
        }, tx);
      });

      // Notify shard via event bus
      gameEvents.emit(GameEventType.SHIP_SWAPPED, {
        playerId,
        newShip,
      });

      return newShip;
    } catch (e: any) {
      if (e instanceof InsufficientCreditsError) {
        return reply.status(422).send({
          code: 'insufficient-credits',
          message: 'Insufficient credits for this ship',
        });
      }
      console.error('Purchase transaction failed:', e);
      return reply.status(500).send({
        code: 'internal-error',
        message: 'An unexpected error occurred during purchase',
      });
    }
  });
}
