import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthenticatedSession, Authenticator } from '../auth/types.ts';
import { sendError } from '../rest.ts';

const BEARER = /^Bearer ([A-Za-z0-9_.-]{1,512})$/i;

/**
 * Extracts and validates the session from the `Authorization: Bearer <token>` header. Tokens are
 * never read from the URL or query string. On failure replies 401 `unauthenticated` (one generic
 * message, whatever the reason) and returns undefined.
 */
export async function requireSession(
  request: FastifyRequest,
  reply: FastifyReply,
  authenticator: Authenticator,
): Promise<AuthenticatedSession | undefined> {
  const header = request.headers.authorization;
  const match = header ? BEARER.exec(header) : null;
  if (match?.[1]) {
    const result = await authenticator.authenticate(match[1]);
    if (result.ok) return result.session;
  }
  void reply.header('www-authenticate', 'Bearer');
  sendError(reply, 401, 'unauthenticated', 'authentication required');
  return undefined;
}
