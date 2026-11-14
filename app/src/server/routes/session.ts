import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Authenticator } from '../auth/types.ts';
import type { Repository } from '../db/types.ts';
import { sendError } from '../rest.ts';
import { requireSession } from './bearer.ts';

export interface SessionRouteDeps {
  repo: Repository;
  authenticator: Authenticator;
}

/**
 * GET /api/session and GET /api/players/me: the caller's own profile (callsign, credits, home
 * system, ship). There is deliberately no endpoint that exposes another player's balance.
 */
export function registerSessionRoutes(app: FastifyInstance, deps: SessionRouteDeps): void {
  /** Loads the caller's profile fields, or replies 401/404 and returns undefined. */
  async function profile(request: FastifyRequest, reply: FastifyReply) {
    const session = await requireSession(request, reply, deps.authenticator);
    if (!session) return undefined;
    const player = await deps.repo.getPlayer(session.playerId);
    if (!player) {
      sendError(reply, 404, 'not-found', 'player not found');
      return undefined;
    }
    return {
      session,
      body: {
        callsign: player.callsign,
        credits: player.credits,
        homeSystemId: player.homeSystemId,
        shipId: session.shipId,
      },
    };
  }

  app.get('/api/session', async (request, reply) => {
    const found = await profile(request, reply);
    return found ? { playerId: found.session.playerId, ...found.body } : reply;
  });

  app.get('/api/players/me', async (request, reply) => {
    const found = await profile(request, reply);
    return found ? found.body : reply;
  });
}
