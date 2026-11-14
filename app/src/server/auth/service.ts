import { randomBytes } from 'node:crypto';
import type { Repository } from '../db/types.ts';
import { CLOCK_SKEW_MS, TOKEN_TTL_MS, hashToken, signToken, verifyToken } from './token.ts';
import type { AuthResult, Authenticator } from './types.ts';

export interface IssuedToken {
  token: string;
  tokenHash: string;
  expiresAt: number;
}

/** Issues and validates session tokens; the Authenticator the WebSocket layer uses. */
export interface AuthService extends Authenticator {
  /**
   * Signs a new 7-day token for the player and stores only its sha256 as a session row.
   * Pass `tx` to join an open repository transaction.
   */
  issue(playerId: string, tx?: Repository): Promise<IssuedToken>;
}

export interface AuthServiceOptions {
  /** SESSION_SECRET. Never logged. */
  secret: string;
  repo: Repository;
  /** Epoch milliseconds. */
  clock: () => number;
  ttlMs?: number;
}

/**
 * A token is valid only if its signature, its expiry AND a live sessions row all check out;
 * deleting the row (logout, revocation) therefore kills the token immediately.
 */
export function createAuthService(options: AuthServiceOptions): AuthService {
  const { secret, repo, clock } = options;
  const ttl = options.ttlMs ?? TOKEN_TTL_MS;

  return {
    async issue(playerId, tx = repo) {
      const expiresAt = clock() + ttl;
      const token = signToken(
        { playerId, exp: expiresAt, jti: randomBytes(16).toString('base64url') },
        secret,
      );
      const tokenHash = hashToken(token);
      await tx.createSession({ tokenHash, playerId, expiresAt: new Date(expiresAt) });
      return { token, tokenHash, expiresAt };
    },

    async authenticate(token): Promise<AuthResult> {
      const verified = verifyToken(token, secret, clock());
      if (!verified.ok) return { ok: false, reason: verified.reason };
      const tokenHash = hashToken(token);
      const row = await repo.getSession(tokenHash);
      if (!row || row.playerId !== verified.payload.playerId)
        return { ok: false, reason: 'revoked' };
      if (clock() > row.expiresAt.getTime() + CLOCK_SKEW_MS)
        return { ok: false, reason: 'expired' };

      const player = await repo.getPlayer(row.playerId);
      if (!player) return { ok: false, reason: 'unknown-player' };
      const ships = await repo.listShipsByOwner(player.id);
      const ship =
        ships.find((s) => s.state !== 'destroyed') ??
        (await repo.getOrCreateStarterShip(player.id));
      return {
        ok: true,
        session: {
          playerId: player.id,
          callsign: player.callsign,
          shipId: ship.id,
          homeSystemId: player.homeSystemId,
          tokenHash,
        },
      };
    },

    revoke: (tokenHash) => repo.deleteSession(tokenHash),
  };
}
