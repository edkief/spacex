import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from './callsigns';

const BEARER_PREFIX = 'Bearer ';

/**
 * GET /api/session — resolves the bearer token to the player profile
 * (TASK-10). Every failure path is a structured 401 {code, reason}; the raw
 * token is never echoed back in responses or error messages.
 */
export function registerSessionRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/api/session', async (req, reply) => {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX)) {
      return reply.code(401).send({ code: 'unauthenticated', reason: 'missing bearer token' });
    }
    const token = header.slice(BEARER_PREFIX.length).trim();
    if (token.length === 0) {
      return reply.code(401).send({ code: 'unauthenticated', reason: 'missing bearer token' });
    }
    const result = await deps.sessions.verify(token);
    if (!result.ok) {
      return reply.code(401).send({ code: 'unauthenticated', reason: result.reason });
    }
    const player = result.player;
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
