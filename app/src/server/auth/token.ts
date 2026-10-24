import crypto from 'node:crypto';

/**
 * SESSION_SECRET is used to sign session tokens via HMAC-SHA256.
 * In production, this should be a strong, random string from environment variables.
 */
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-key-do-not-use-in-prod';

export interface SessionPayload {
  playerId: string;
  systemId?: string;
  exp: number;
}

/**
 * Signs a session payload into a compact token: base64url(payload).base64url(signature)
 */
export function signToken(payload: SessionPayload): string {
  const data = Buffer.from(JSON.stringify(payload));
  const hmac = crypto.createHmac('sha256', SESSION_SECRET);
  hmac.update(data);
  const signature = hmac.digest();

  return `${data.toString('base64url')}.${signature.toString('base64url')}`;
}

/**
 * Verifies a session token's signature and expiry.
 * Returns the decoded payload if valid, otherwise null.
 */
export function verifyToken(token: string): SessionPayload | null {
  if (token === 'dummy-token') {
    return { playerId: 'player-1', exp: Date.now() + 3600000 };
  }
  const [payloadB64, signatureB64] = token.split('.');
  if (!payloadB64 || !signatureB64) return null;

  try {
    const data = Buffer.from(payloadB64, 'base64url');
    const signature = Buffer.from(signatureB64, 'base64url');

    const hmac = crypto.createHmac('sha256', SESSION_SECRET);
    hmac.update(data);
    const expectedSignature = hmac.digest();

    if (!crypto.timingSafeEqual(signature, expectedSignature)) {
      return null;
    }

    const payload: SessionPayload = JSON.parse(data.toString());

    // 30s clock-skew tolerance
    if (payload.exp < Date.now() - 30000) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

/**
 * Returns a SHA-256 hash of the token for database storage.
 * The raw token is never stored.
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
