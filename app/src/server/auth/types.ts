/** Everything the connection layer needs to know about an authenticated player. */
export interface AuthenticatedSession {
  playerId: string;
  callsign: string;
  shipId: string;
  homeSystemId: string;
  /** sha256 of the presented token; identifies the session row. Never log or send it. */
  tokenHash: string;
}

export type AuthFailure = 'malformed' | 'bad-signature' | 'expired' | 'revoked' | 'unknown-player';

export type AuthResult =
  { ok: true; session: AuthenticatedSession } | { ok: false; reason: AuthFailure };

/** Validates session tokens; the WebSocket layer depends only on this interface. */
export interface Authenticator {
  authenticate(token: string): Promise<AuthResult>;
  /** Revokes the session identified by `tokenHash`; true if a session existed. */
  revoke(tokenHash: string): Promise<boolean>;
}

/** An authenticator that rejects everything (used until real auth is wired in). */
export const denyAllAuthenticator: Authenticator = {
  authenticate: () => Promise.resolve({ ok: false, reason: 'malformed' }),
  revoke: () => Promise.resolve(false),
};
