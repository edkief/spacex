import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/** Tokens stay valid this long after `exp` to tolerate clock skew. */
export const CLOCK_SKEW_MS = 30_000;
/** Session lifetime. */
export const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const payloadSchema = z.strictObject({
  playerId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  exp: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  jti: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
});

export type TokenPayload = z.infer<typeof payloadSchema>;
export type TokenFailure = 'malformed' | 'bad-signature' | 'expired';
export type TokenResult = { ok: true; payload: TokenPayload } | { ok: false; reason: TokenFailure };

const B64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Decodes base64url strictly: only the URL alphabet, and the text must be the canonical encoding
 * of the bytes (otherwise the unused trailing bits of the last character could be altered
 * without changing the decoded value, giving two valid spellings of one token).
 */
function decodeCanonical(text: string): Buffer | undefined {
  if (!B64URL.test(text)) return undefined;
  const bytes = Buffer.from(text, 'base64url');
  return bytes.toString('base64url') === text ? bytes : undefined;
}

/** HMAC-SHA256 of the encoded payload under the secret. */
function mac(encodedPayload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(encodedPayload, 'utf8').digest();
}

/**
 * Signs a payload into `base64url(payload JSON).base64url(HMAC-SHA256)`. The secret is the
 * server's SESSION_SECRET and never leaves this module.
 */
export function signToken(payload: TokenPayload, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payloadSchema.parse(payload)), 'utf8').toString(
    'base64url',
  );
  return `${encoded}.${mac(encoded, secret).toString('base64url')}`;
}

/**
 * Verifies structure, signature (constant time) and expiry, in that order. The payload is parsed
 * only after the MAC checks out. Expiry tolerates 30 s of clock skew.
 */
export function verifyToken(token: string, secret: string, nowMs: number): TokenResult {
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [encodedPayload, encodedMac] = parts as [string, string];
  const given = decodeCanonical(encodedMac);
  if (!given || !decodeCanonical(encodedPayload)) return { ok: false, reason: 'malformed' };

  const expected = mac(encodedPayload, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'bad-signature' };
  }

  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const parsed = payloadSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: 'malformed' };
  if (nowMs > parsed.data.exp + CLOCK_SKEW_MS) return { ok: false, reason: 'expired' };
  return { ok: true, payload: parsed.data };
}

/** sha256 of a token as lowercase hex: the only form that is ever stored. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
