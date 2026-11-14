import type { AuthenticatedSession, Authenticator } from '../auth/types.ts';

/** A lookup-table authenticator for protocol tests: token string -> session. */
export function createStubAuthenticator(
  table: Record<string, Omit<AuthenticatedSession, 'tokenHash'>>,
): Authenticator & { revoked: string[] } {
  const revoked: string[] = [];
  return {
    revoked,
    authenticate(token) {
      const found = Object.prototype.hasOwnProperty.call(table, token) ? table[token] : undefined;
      if (!found) return Promise.resolve({ ok: false, reason: 'bad-signature' });
      return Promise.resolve({ ok: true, session: { ...found, tokenHash: `hash-of-${token}` } });
    },
    revoke(tokenHash) {
      revoked.push(tokenHash);
      return Promise.resolve(true);
    },
  };
}
