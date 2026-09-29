import type { FastifyRequest } from 'fastify';
import type { SessionService, SessionVerifyResult } from '@server/auth/session';
import type { PlayerRow } from '@server/db/schema';

const BEARER_PREFIX = 'Bearer ';

/** Extract the bearer token from an Authorization header, if present. */
export function bearerToken(header: unknown): string | null {
  if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX)) return null;
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

type VerifyFailure = Exclude<SessionVerifyResult, { ok: true }>;
export type AuthOutcome =
  | { ok: true; player: PlayerRow }
  | { ok: false; reason: 'missing bearer token' | VerifyFailure['reason'] };

/**
 * Shared REST auth (TASK-10 session service): resolve the bearer token to a
 * verified player. Failures carry the session-service reason verbatim so the
 * structured 401 {code, reason} shape stays identical across endpoints.
 */
export async function requireAuth(
  req: FastifyRequest,
  sessions: SessionService,
): Promise<AuthOutcome> {
  const token = bearerToken(req.headers.authorization);
  if (!token) return { ok: false, reason: 'missing bearer token' };
  const result = await sessions.verify(token);
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, player: result.player };
}
