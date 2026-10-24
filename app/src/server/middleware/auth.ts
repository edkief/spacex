import { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken, hashToken } from '../auth/token';
import { repo } from '../db/repo';

export async function authMiddleware(request: FastifyRequest, reply: FastifyReply) {
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

  // Attach session to request for use in routes
  (request as any).session = session;
}
