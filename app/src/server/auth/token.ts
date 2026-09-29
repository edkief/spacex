import { createHmac, timingSafeEqual } from 'node:crypto';

/** Compact session payload carried (unsigned) inside the token body. */
export interface SessionPayload {
  playerId: string;
  systemId?: string;
  /** Unix seconds after which the token is invalid. */
  exp: number;
}

export type TokenVerifyResult =
  | { ok: true; payload: SessionPayload }
  | { ok: false; reason: 'malformed-token' | 'invalid-signature' | 'expired-token' };

export interface TokenCodec {
  /** Produce base64url(JSON payload) + "." + base64url(HMAC-SHA256 mac). */
  sign(payload: SessionPayload): string;
  /**
   * Constant-time MAC check, then exp with a 30 s clock-skew tolerance.
   * Never throws; the raw secret is never returned or logged.
   */
  verify(token: string): TokenVerifyResult;
}

/** exp is honoured up to this much server clock skew (spec: 30 s). */
export const TOKEN_SKEW_TOLERANCE_MS = 30_000;

const B64URL_CHARS = /^[A-Za-z0-9_-]+$/;

/**
 * Strict base64url decode (TASK-66): rejects invalid characters and
 * non-canonical encodings — e.g. a last char with trailing padding bits set,
 * which Node's decoder would silently drop. Guarantees any single-character
 * mutation of a segment changes (or invalidates) the decoded bytes, so it can
 * never verify as an identical token.
 */
function decodeB64url(segment: string): Buffer | undefined {
  if (!B64URL_CHARS.test(segment)) return undefined;
  const buf = Buffer.from(segment, 'base64url');
  return buf.toString('base64url') === segment ? buf : undefined;
}

/**
 * HMAC-SHA256 session token codec (TASK-10). The payload is public data —
 * only the MAC binds it, so the token can travel in a Bearer header without
 * extra transport security. Tokens are opaque to everything else: callers
 * must only ever store the sha256 hash (see session.ts), never the token.
 */
export function createTokenCodec(secret: string, opts: { now?: () => number } = {}): TokenCodec {
  const now = opts.now ?? Date.now;

  function macOf(body: string): Buffer {
    return createHmac('sha256', secret).update(body).digest();
  }

  return {
    sign(payload) {
      const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
      return `${body}.${macOf(body).toString('base64url')}`;
    },
    verify(token) {
      const dot = token.lastIndexOf('.');
      if (dot <= 0 || dot === token.length - 1) {
        return { ok: false, reason: 'malformed-token' };
      }
      const body = token.slice(0, dot);
      const bodyBuf = decodeB64url(body);
      if (!bodyBuf) return { ok: false, reason: 'malformed-token' };
      const given = decodeB64url(token.slice(dot + 1));
      if (!given) return { ok: false, reason: 'invalid-signature' };
      let raw: unknown;
      try {
        raw = JSON.parse(bodyBuf.toString('utf8'));
      } catch {
        return { ok: false, reason: 'malformed-token' };
      }
      const payload = asSessionPayload(raw);
      if (!payload) return { ok: false, reason: 'malformed-token' };
      const expected = macOf(body);
      // A length difference already proves the MAC differs; the timing-safe
      // path only matters for equal-length candidates.
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        return { ok: false, reason: 'invalid-signature' };
      }
      if (payload.exp * 1000 < now() - TOKEN_SKEW_TOLERANCE_MS) {
        return { ok: false, reason: 'expired-token' };
      }
      return { ok: true, payload };
    },
  };
}

/** Narrow an unknown decoded body to SessionPayload (rejects garbage). */
function asSessionPayload(raw: unknown): SessionPayload | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const p = raw as Record<string, unknown>;
  if (typeof p.playerId !== 'string' || p.playerId.length === 0) return undefined;
  if (typeof p.exp !== 'number' || !Number.isFinite(p.exp)) return undefined;
  const payload: SessionPayload = { playerId: p.playerId, exp: p.exp };
  if (p.systemId !== undefined) {
    if (typeof p.systemId !== 'string') return undefined;
    payload.systemId = p.systemId;
  }
  return payload;
}
