import type { FastifyInstance } from 'fastify';
import { requireAuth } from './auth';
import type { RouteDeps } from './callsigns';

/**
 * /api/players routes (TASK-41). v1 exposes only the caller's own record —
 * GET /api/players/me (auth) returns the player profile including the credit
 * balance. No endpoint addresses other players by id, so one player's
 * balance is never visible to another.
 */
export function registerPlayerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/api/players/me', async (req, reply) => {
    const auth = await requireAuth(req, deps.sessions);
    if (!auth.ok) {
      return reply.code(401).send({ code: 'unauthenticated', reason: auth.reason });
    }
    const player = auth.player;
    // Idempotent: returns the existing ship when the player has one.
    const ship = await deps.repo.getOrCreateStarterShip(player.id, { classId: 'scout' });
    return {
      callsign: player.callsign,
      credits: player.credits,
      homeSystemId: player.homeSystemId,
      shipId: ship.id,
    };
  });
}
