import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from './callsigns';

const BEARER_PREFIX = 'Bearer ';

/** Extract the bearer token from an Authorization header, if present. */
function bearerToken(header: unknown): string | null {
  if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX)) return null;
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * /api/session routes (TASK-10 + TASK-66). GET resolves the bearer token to
 * the player profile; POST /logout verifies it and revokes it by deleting the
 * sessions row, so any second use of the same token is a 401. Every failure
 * path is a structured 401 {code, reason}; the raw token is never echoed back
 * in responses or error messages.
 */
export function registerSessionRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/api/session', async (req, reply) => {
    const token = bearerToken(req.headers.authorization);
    if (!token) {
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

  app.post('/api/session/logout', async (req, reply) => {
    const token = bearerToken(req.headers.authorization);
    if (!token) {
      return reply.code(401).send({ code: 'unauthenticated', reason: 'missing bearer token' });
    }
    // Verify first so a revoked/forged token gets the same structured 401
    // (and a valid-but-already-revoked one reports unknown-session).
    const result = await deps.sessions.verify(token);
    if (!result.ok) {
      return reply.code(401).send({ code: 'unauthenticated', reason: result.reason });
    }
    await deps.sessions.revoke(token);
    return reply.code(200).send({ code: 'logged-out' });
  });
}
