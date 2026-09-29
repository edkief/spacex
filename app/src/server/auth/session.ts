import { createHash } from 'node:crypto';
import type { Repository } from '@server/db/repo';
import type { PlayerRow } from '@server/db/schema';
import type { AuthPayload } from '@shared/protocol/schemas';
import type { Authenticate } from '@server/ws';
import { TOKEN_SKEW_TOLERANCE_MS, type TokenCodec } from './token';

/** Sessions live 7 days; the token exp and sessions.expires_at match. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type SessionVerifyResult =
  | { ok: true; player: PlayerRow }
  | {
      ok: false;
      reason: 'malformed-token' | 'invalid-signature' | 'expired-token' | 'unknown-session';
    };

export interface SessionService {
  /** Issue a token for a player and record its sha256 in sessions. */
  issue(playerId: string, systemId?: string): Promise<string>;
  /** Signature + exp + sessions-row lookup. The raw token never hits the db. */
  verify(token: string): Promise<SessionVerifyResult>;
  /**
   * Revoke the presenting token by deleting its sessions row (TASK-66).
   * Returns true when a row was actually deleted; false when the token was
   * never issued or already revoked (revocation is idempotent).
   */
  revoke(token: string): Promise<boolean>;
  /** sha256 hex of the raw token — the only form ever persisted. */
  tokenHash(token: string): string;
}

export interface SessionDeps {
  repo: Repository;
  codec: TokenCodec;
  /** Injectable clock for fake-time tests; defaults to Date.now. */
  now?: () => number;
  ttlMs?: number;
}

/**
 * Session verification over HMAC tokens (TASK-10): the raw token is never
 * stored or logged — only its sha256 lives in the sessions table, and every
 * verification re-checks the MAC, the exp (30 s skew) and the row's
 * expires_at, so a leaked hash is worthless and revocation is a delete.
 *
 * Shared account model (TASK-66): verify is stateless over the sessions row,
 * so the same token may legitimately back several simultaneous connections
 * (e.g. two tabs) — both keep working until the token is revoked via
 * revoke() (logout), after which every further use is rejected. Already-open
 * WS connections are not force-closed on revocation; the token is only
 * re-checked at handshake.
 */
export function createSessionService(deps: SessionDeps): SessionService {
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? SESSION_TTL_MS;

  function tokenHash(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  return {
    tokenHash,
    async issue(playerId, systemId) {
      const token = deps.codec.sign({
        playerId,
        ...(systemId ? { systemId } : {}),
        exp: Math.floor((now() + ttlMs) / 1000),
      });
      await deps.repo.createSession({
        tokenHash: tokenHash(token),
        playerId,
        systemId: systemId ?? null,
        expiresAt: new Date(now() + ttlMs).toISOString(),
      });
      return token;
    },
    async revoke(token) {
      const hash = tokenHash(token);
      const row = await deps.repo.findSession(hash);
      if (!row) return false;
      await deps.repo.deleteSession(hash);
      return true;
    },
    async verify(token) {
      const checked = deps.codec.verify(token);
      if (!checked.ok) return checked;
      const row = await deps.repo.findSession(tokenHash(token));
      if (!row) return { ok: false, reason: 'unknown-session' };
      if (new Date(row.expiresAt).getTime() < now() - TOKEN_SKEW_TOLERANCE_MS) {
        return { ok: false, reason: 'expired-token' };
      }
      const [player] = await deps.repo.getPlayersByIds([row.playerId]);
      if (!player) return { ok: false, reason: 'unknown-session' };
      return { ok: true, player };
    },
  };
}

/**
 * WS handshake authenticator backed by the same session service as the REST
 * API: only a valid issued token admits a connection (callsign claims are a
 * REST-only operation, TASK-10 step 4).
 */
export function createTokenAuthenticate(sessions: SessionService): Authenticate {
  return async (payload: AuthPayload) => {
    if (!payload.token) {
      return { ok: false, message: 'auth requires a session token (POST /api/callsigns)' };
    }
    const result = await sessions.verify(payload.token);
    if (!result.ok) return { ok: false, message: result.reason };
    return { ok: true, playerId: result.player.id, callsign: result.player.callsign };
  };
}
