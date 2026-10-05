import type { FastifyInstance } from 'fastify';
import { bearerToken, requireAuth } from './auth';
import type { RouteDeps } from './callsigns';

/**
 * /api/session routes (TASK-10 + TASK-66). GET resolves the bearer token to
 * the player profile; POST /logout verifies it and revokes it by deleting the
 * sessions row, so any second use of the same token is a 401. Every failure
 * path is a structured 401 {code, reason}; the raw token is never echoed back
 * in responses or error messages.
 */
export function registerSessionRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/api/session', async (req, reply) => {
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
      // TASK-55: the player's persisted settings — a fresh machine / first
      // join gets the factory defaults (the repo normalizes the empty row).
      settings: await deps.repo.getPlayerSettings(player.id),
    };
  });

  app.post('/api/session/logout', async (req, reply) => {
    // Verify first so a revoked/forged token gets the same structured 401
    // (and a valid-but-already-revoked one reports unknown-session).
    const auth = await requireAuth(req, deps.sessions);
    if (!auth.ok) {
      return reply.code(401).send({ code: 'unauthenticated', reason: auth.reason });
    }
    await deps.sessions.revoke(bearerToken(req.headers.authorization)!);
    return reply.code(200).send({ code: 'logged-out' });
  });
}
