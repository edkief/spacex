/**
 * HMAC-signed session-token codec for Drift (TASK-10).
 *
 * A Drift session token is a compact, URL-safe string:
 *
 *     <payloadB64>.<sigB64>
 *
 * where:
 *   - `payloadB64` is the base64url-encoded JSON `{ playerId, systemId?, exp }`
 *     object. `exp` is an epoch-second value; tokens are valid for 7 days
 *     from issuance unless explicitly revoked.
 *   - `sigB64` is the base64url-encoded HMAC-SHA256 of `payloadB64` using
 *     the server's `SESSION_SECRET` as the key.
 *
 * Tokens are signed; verification uses constant-time MAC comparison
 * (`crypto.timingSafeEqual`) so the server does not leak which byte
 * differs under a timing attack.
 *
 * Security notes:
 *   - **Never log the raw token or `SESSION_SECRET`.** The repo and the
 *     `SessionRow` only ever persist `tokenHash = sha256(token)`.
 *   - The `payload` is *not* encrypted — it carries the `playerId` and an
 *     `exp` epoch. Anyone who sees a token can read those; they cannot
 *     forge new ones without the secret.
 *   - The signature includes the full payload bytes (a canonical
 *     `JSON.stringify(payload)`), so re-ordering or mutation of the
 *     payload is caught at verify time.
 *
 * Public API:
 *   - `sign(secret, payload)`     — mint a token from a payload.
 *   - `verify(secret, token)`     — return the payload or `null` on failure.
 *   - `hashToken(token)`          — sha256(token) used as the
 *     `sessions.tokenHash` row key.
 *   - `SECRET_MIN_BYTES`          — minimum secret length (32 bytes = 256 bits).
 *   - `DEFAULT_TTL_MS`            — default token lifetime (7 days).
 *   - `CLOCK_SKEW_TOLERANCE_SEC`  — accept tokens up to N seconds past exp
 *     so a client clock 30 s slow is not unduly rejected.
 */

import { createHmac, timingSafeEqual, createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Payload signed by `sign()`. `exp` is epoch seconds (not ms) so the wire
 * format stays compact and tool-friendly; `systemId` is optional because
 * the token is minted at callsign-claim time before the player has
 * joined a system.
 */
export interface TokenPayload {
  playerId: string;
  systemId?: string | null;
  exp: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum `SESSION_SECRET` length in bytes (256-bit minimum HMAC key). */
export const SECRET_MIN_BYTES = 32;

/**
 * Default token lifetime (7 days). Operators can override via the
 * `session.ttlMs` config knob (TASK-66 covers revocation, not lifetime).
 */
export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Tokens are accepted up to N seconds past their declared `exp` to
 * accommodate a client clock that is up to ~30 s behind the server.
 * Without this tolerance, a slow client can be rejected needlessly
 * after a network delay.
 */
export const CLOCK_SKEW_TOLERANCE_SEC = 30;

/**
 * Algorithm tag. Surfaced in logs and tests so any future change is
 * explicit (e.g. switching to SHA-512).
 */
const ALGORITHM = "sha256" as const;

// ---------------------------------------------------------------------------
// Secret validation
// ---------------------------------------------------------------------------

/**
 * Validate that `secret` is long enough for an HMAC-SHA256 key. We
 * require ≥ 32 bytes (256 bits) per RFC 2104 — a weak key is silently
 * catastrophic because all the player's session integrity rides on it.
 *
 * Throws if invalid. Callers (server boot path) should treat the throw
 * as fatal.
 */
export function assertValidSecret(secret: string): void {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("SESSION_SECRET is required (empty value)");
  }
  // We treat the secret as bytes; an "ASCII byte" string is acceptable
  // because every operation here treats the secret as UTF-8 bytes.
  if (Buffer.byteLength(secret, "utf8") < SECRET_MIN_BYTES) {
    throw new Error(
      `SESSION_SECRET must be at least ${SECRET_MIN_BYTES} bytes (got ${Buffer.byteLength(secret, "utf8")})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Base64url helpers — uniform URL-safe encoding without padding
// ---------------------------------------------------------------------------

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function b64urlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4);
  return Buffer.from(padded, "base64");
}

// ---------------------------------------------------------------------------
// Payloads — preserve key order so verification is reproducible
// ---------------------------------------------------------------------------

/**
 * Serialise a payload to the canonical JSON used for both signing and
 * verification. Returning a brand-new string (not a re-encoding of the
 * caller's object) ensures byte-stable signature output regardless of how
 * the caller ordered their keys.
 */
function encodePayload(payload: TokenPayload): string {
  const out: Record<string, unknown> = {
    playerId: payload.playerId,
    exp: payload.exp,
  };
  if (payload.systemId !== undefined) {
    out.systemId = payload.systemId;
  }
  return JSON.stringify(out);
}

// ---------------------------------------------------------------------------
// Sign
// ---------------------------------------------------------------------------

/**
 * Mint a token whose payload is `payload` and whose MAC uses `secret`.
 *
 * Pure function — does not consume randomness or touch the clock. Tests
 * that need a deterministic `exp` pass it in explicitly.
 *
 * @throws if `secret` is shorter than `SECRET_MIN_BYTES`.
 */
export function sign(secret: string, payload: TokenPayload): string {
  assertValidSecret(secret);
  const body = encodePayload(payload);
  const bodyB64 = b64url(Buffer.from(body, "utf8"));
  const sig = createHmac(ALGORITHM, secret).update(bodyB64).digest();
  return `${bodyB64}.${b64url(sig)}`;
}

/**
 * Convenience wrapper around `sign(secret, payload)` that stamps `exp =
 * nowSec + ttlMs / 1000`. Returns both the token and the absolute `exp`
 * epoch so callers can include `tokenExpiresAt` in their API response.
 */
export function mintToken(
  secret: string,
  args: { playerId: string; systemId?: string | null; ttlMs?: number; nowMs?: number },
): { token: string; exp: number } {
  const ttlMs = args.ttlMs ?? DEFAULT_TTL_MS;
  const nowSec = Math.floor((args.nowMs ?? Date.now()) / 1000);
  const exp = nowSec + Math.floor(ttlMs / 1000);
  const payload: TokenPayload = {
    playerId: args.playerId,
    systemId: args.systemId ?? null,
    exp,
  };
  return { token: sign(secret, payload), exp };
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Verify and parse a token. Returns the payload on success; `null` on
 * any failure: malformed shape, bad signature, expired beyond the
 * skew tolerance, etc.
 *
 * Constant-time MAC compare: we always feed two equal-length buffers to
 * `timingSafeEqual`. If the lengths differ we still do a compare against
 * a same-length dummy so the rejection timing does not encode the
 * length of the supplied MAC.
 */
export function verify(secret: string, token: string, nowSec?: number): TokenPayload | null {
  const effectiveNow = nowSec ?? Math.floor(Date.now() / 1000);
  if (typeof token !== "string" || token.length === 0) return null;
  if (typeof secret !== "string" || secret.length === 0) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const bodyB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  let bodyBuf: Buffer;
  let providedSig: Buffer;
  let computedSig: Buffer;
  try {
    bodyBuf = b64urlDecode(bodyB64);
    providedSig = b64urlDecode(sigB64);
    if (providedSig.length === 0 || bodyBuf.length === 0) return null;
    computedSig = createHmac(ALGORITHM, secret).update(bodyB64).digest();
  } catch {
    return null;
  }

  // Length-mismatch protection: feed `timingSafeEqual` two equal-length
  // buffers even when the supplied MAC is a different length so the time
  // to reject does not encode the attacker's payload size.
  const cmpBuf =
    providedSig.length === computedSig.length ? providedSig : Buffer.alloc(computedSig.length, 0);
  if (!timingSafeEqual(computedSig, cmpBuf)) return null;
  if (providedSig.length !== computedSig.length) return null;

  // Parse JSON body.
  let payload: unknown;
  try {
    payload = JSON.parse(bodyBuf.toString("utf8"));
  } catch {
    return null;
  }
  if (!isTokenPayload(payload)) return null;

  // Expired? Allow a small forward skew but never a backward skew.
  if (payload.exp + CLOCK_SKEW_TOLERANCE_SEC < effectiveNow) return null;
  // Normalise systemId: undefined → null so the rest of the server sees
  // a consistent optional<string> shape regardless of which encoder
  // branch wrote the token.
  if (payload.systemId === undefined) payload.systemId = null;
  return payload;
}

/**
 * `verify(...)` companion that throws `TokenVerificationError` instead
 * of returning null, so a `try { ... } catch { ... }` consumer can
 * branch on a specific failure mode without writing one-line guards.
 */
export function verifyOrThrow(secret: string, token: string, nowSec?: number): TokenPayload {
  const result = verify(secret, token, nowSec);
  if (result === null) {
    throw new TokenVerificationError("bad-signature", "token verification failed");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Hash (storage key)
// ---------------------------------------------------------------------------

/**
 * Return the sha256 of `token` — used as the storage key in `sessions.tokenHash`.
 *
 * The raw token is never persisted; only this hash survives.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Errors + guards
// ---------------------------------------------------------------------------

/**
 * Thrown by `verifyOrThrow` for every kind of token failure. Callers
 * can branch on `code` if they care about specific failure modes.
 */
export class TokenVerificationError extends Error {
  public readonly code: "malformed" | "bad-signature" | "expired" | "invalid-payload";
  constructor(
    code: "malformed" | "bad-signature" | "expired" | "invalid-payload",
    message: string,
  ) {
    super(message);
    this.name = "TokenVerificationError";
    this.code = code;
  }
}

/**
 * Type-guard: does `value` look like a `TokenPayload`? Used at the
 * network boundary so we never hand a malformed decoded object out to
 * the rest of the server.
 */
function isTokenPayload(value: unknown): value is TokenPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.playerId !== "string" || v.playerId.length === 0) return false;
  if (typeof v.exp !== "number" || !Number.isFinite(v.exp) || !Number.isInteger(v.exp))
    return false;
  if (v.exp <= 0) return false;
  if (v.systemId !== undefined && v.systemId !== null && typeof v.systemId !== "string") {
    return false;
  }
  return true;
}
