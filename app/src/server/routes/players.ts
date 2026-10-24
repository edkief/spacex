import { FastifyInstance } from 'fastify';
import { repo } from '../db/repo';
import { authMiddleware } from '../middleware/auth';

export async function playersRoutes(fastify: FastifyInstance) {
  fastify.get('/api/players/me', { preHandler: [authMiddleware] }, async (request, reply) => {
    const session = (request as any).session;
    const player = await repo.findPlayerById(session.player_id);
    if (!player) {
      return reply.status(404).send({
        code: 'not-found',
        message: 'Player not found',
      });
    }

    // Find the player's ship
    const ship = await repo.getOrCreateStarterShip(player.id, player.home_system_id || 'sol');

    return reply.send({
      callsign: player.callsign,
      credits: player.credits,
      homeSystemId: player.home_system_id,
      shipId: ship.id,
    });
  });
}
