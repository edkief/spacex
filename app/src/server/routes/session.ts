import { FastifyInstance } from 'fastify';
import { repo } from '../db/repo';
import { verifyToken, hashToken } from '../auth/token';

export async function sessionRoutes(fastify: FastifyInstance) {
  fastify.get('/api/session', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({
        code: 'unauthenticated',
        message: 'Missing or invalid Authorization header',
      });
    }

    const token = authHeader.slice(7);
    const payload = verifyToken(token);
    if (!payload) {
      return reply.status(401).send({
        code: 'unauthenticated',
        message: 'Invalid or expired session token',
      });
    }

    const tokenHash = hashToken(token);
    const session = await repo.findSession(tokenHash);
    if (!session) {
      return reply.status(401).send({
        code: 'unauthenticated',
        message: 'Session not found or revoked',
      });
    }

    const player = await repo.findPlayerById(session.player_id);
    if (!player) {
      return reply.status(404).send({
        code: 'not-found',
        message: 'Player not found',
      });
    }

    return reply.send({
      callsign: player.callsign,
      credits: player.credits,
      homeSystemId: player.home_system_id,
    });
  });

  fastify.post('/api/session/logout', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({
        code: 'unauthenticated',
        message: 'Missing or invalid Authorization header',
      });
    }

    const token = authHeader.slice(7);
    const payload = verifyToken(token);
    if (!payload) {
      return reply.status(401).send({
        code: 'unauthenticated',
        message: 'Invalid or expired session token',
      });
    }

    const tokenHash = hashToken(token);
    await repo.deleteSession(tokenHash);

    return reply.status(204).send();
  });
}
