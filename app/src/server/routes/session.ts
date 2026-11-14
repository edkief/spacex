import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Authenticator } from '../auth/types.ts';
import type { Repository } from '../db/types.ts';
import { parseOr400, sendError } from '../rest.ts';
import { requireSession } from './bearer.ts';

export interface SessionRouteDeps {
  repo: Repository;
  authenticator: Authenticator;
  /** Called after a token is revoked so live sockets using it can be closed. */
  onRevoked?: (tokenHash: string) => void;
}

const emptyBody = z.strictObject({}).optional();

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

  /** POST /api/session/logout: revokes the presenting token (its session row is deleted). */
  app.post('/api/session/logout', async (request, reply) => {
    const session = await requireSession(request, reply, deps.authenticator);
    if (!session) return reply;
    if (request.body !== undefined && request.body !== null) {
      if (parseOr400(emptyBody, request.body, request, reply) === undefined) return reply;
    }
    await deps.authenticator.revoke(session.tokenHash);
    deps.onRevoked?.(session.tokenHash);
    return reply.code(204).send();
  });

  app.get('/api/players/me', async (request, reply) => {
    const found = await profile(request, reply);
    return found ? found.body : reply;
  });
}
