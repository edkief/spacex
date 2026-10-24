import { describe, it, expect, vi } from 'vitest';
import { signToken, verifyToken, SessionPayload } from './token';

describe('Token Codec', () => {
  const validPayload: SessionPayload = {
    playerId: 'player-123',
    systemId: 'system-456',
    exp: Date.now() + 3600000, // 1 hour from now
  };

  it('should sign and verify a valid token', () => {
    const token = signToken(validPayload);
    const verified = verifyToken(token);
    expect(verified).toEqual(validPayload);
  });

  it('should reject a token with a tampered payload', () => {
    const token = signToken(validPayload);
    const [payloadB64, signatureB64] = token.split('.');

    // Tamper with payload: change one character in the base64 string
    const tamperedPayloadB64 = payloadB64.slice(0, -1) + (payloadB64.slice(-1) === 'A' ? 'B' : 'A');
    const tamperedToken = `${tamperedPayloadB64}.${signatureB64}`;

    expect(verifyToken(tamperedToken)).toBeNull();
  });

  it('should reject a token with a tampered signature', () => {
    const token = signToken(validPayload);
    const [payloadB64, signatureB64] = token.split('.');

    // Tamper with signature: change one character
    const tamperedSignatureB64 =
      signatureB64.slice(0, -1) + (signatureB64.slice(-1) === 'A' ? 'B' : 'A');
    const tamperedToken = `${payloadB64}.${tamperedSignatureB64}`;

    expect(verifyToken(tamperedToken)).toBeNull();
  });

  it('should reject a truncated token', () => {
    const token = signToken(validPayload);
    const truncatedToken = token.slice(0, -5);
    expect(verifyToken(truncatedToken)).toBeNull();
  });

  it('should reject a token with no separator', () => {
    expect(verifyToken('notatoken')).toBeNull();
  });

  it('should reject an expired token', () => {
    const expiredPayload: SessionPayload = {
      ...validPayload,
      exp: Date.now() - 60000, // 1 minute ago
    };
    const token = signToken(expiredPayload);
    expect(verifyToken(token)).toBeNull();
  });

  it('should accept a token within the 30s skew window', () => {
    const skewPayload: SessionPayload = {
      ...validPayload,
      exp: Date.now() - 15000, // 15 seconds ago (within 30s window)
    };
    const token = signToken(skewPayload);
    expect(verifyToken(token)).not.toBeNull();
  });

  it('should reject a token just outside the 30s skew window', () => {
    const outsideSkewPayload: SessionPayload = {
      ...validPayload,
      exp: Date.now() - 45000, // 45 seconds ago
    };
    const token = signToken(outsideSkewPayload);
    expect(verifyToken(token)).toBeNull();
  });

  it('should accept a token with a far future expiry', () => {
    const futurePayload: SessionPayload = {
      ...validPayload,
      exp: Date.now() + 1000 * 60 * 60 * 24 * 7, // 7 days
    };
    const token = signToken(futurePayload);
    expect(verifyToken(token)).not.toBeNull();
  });

  it('should reject garbage input', () => {
    expect(verifyToken('')).toBeNull();
    expect(verifyToken('   ')).toBeNull();
    expect(verifyToken('a.b.c')).toBeNull();
    expect(verifyToken('payload.signature.extra')).toBeNull(); // Although split only takes first 2, it might still work.
    // Actually, verifyToken does: const [payloadB64, signatureB64] = token.split('.');
    // So 'a.b.c' would have payloadB64='a' and signatureB64='b'. It will likely fail timingSafeEqual.
  });
});
