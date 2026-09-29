import { describe, expect, it } from 'vitest';

import { createTokenCodec, TOKEN_SKEW_TOLERANCE_MS, type SessionPayload } from '@server/auth/token';

/** Deterministic fake clock for expiry/skew tests. */
function withClock(startMs: number) {
  let now = startMs;
  return {
    get now() {
      return now;
    },
    advance(ms: number) {
      now += ms;
    },
    codec: createTokenCodec('unit-test-secret', { now: () => now }),
  };
}

const T0 = Date.UTC(2026, 8, 29, 12, 0, 0);
const PAYLOAD: SessionPayload = { playerId: 'player-1', systemId: 'sys-abc', exp: 1_900_000_000 };

describe('token codec (HMAC-SHA256)', () => {
  it('sign → verify round-trips the payload', () => {
    const codec = createTokenCodec('s3cret');
    const token = codec.sign(PAYLOAD);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const result = codec.verify(token);
    expect(result).toEqual({ ok: true, payload: PAYLOAD });
  });

  it('rejects a token tampered in the payload body', () => {
    const codec = createTokenCodec('s3cret');
    const token = codec.sign(PAYLOAD);
    const [body, mac] = token.split('.');
    const bodyBytes = Buffer.from(body, 'base64url');
    // Flip one bit inside the body (playerId region) without re-signing.
    bodyBytes[0] ^= 0x01;
    const forged = `${bodyBytes.toString('base64url')}.${mac}`;
    expect(codec.verify(forged).ok).toBe(false);
  });

  it('rejects a token with a tampered signature', () => {
    const codec = createTokenCodec('s3cret');
    const token = codec.sign(PAYLOAD);
    const [body, mac] = token.split('.');
    const macBytes = Buffer.from(mac, 'base64url');
    macBytes[macBytes.length - 1] ^= 0x01;
    const forged = `${body}.${macBytes.toString('base64url')}`;
    expect(codec.verify(forged)).toEqual({ ok: false, reason: 'invalid-signature' });
  });

  it('a token signed with a different secret fails the MAC', () => {
    const token = createTokenCodec('secret-a').sign(PAYLOAD);
    expect(createTokenCodec('secret-b').verify(token)).toEqual({
      ok: false,
      reason: 'invalid-signature',
    });
  });

  it('rejects malformed tokens without throwing', () => {
    const codec = createTokenCodec('s3cret');
    expect(codec.verify('')).toEqual({ ok: false, reason: 'malformed-token' });
    expect(codec.verify('nodot')).toEqual({ ok: false, reason: 'malformed-token' });
    expect(codec.verify('a.')).toEqual({ ok: false, reason: 'malformed-token' });
    expect(codec.verify('!!!.###')).toEqual({ ok: false, reason: 'malformed-token' });
    const badBody = Buffer.from(JSON.stringify({ playerId: 42, exp: 1 })).toString('base64url');
    expect(codec.verify(`${badBody}.sig`)).toEqual({ ok: false, reason: 'malformed-token' });
    const noExp = Buffer.from(JSON.stringify({ playerId: 'p' })).toString('base64url');
    expect(codec.verify(`${noExp}.sig`)).toEqual({ ok: false, reason: 'malformed-token' });
  });

  it('expires tokens after exp elapses (fake clock)', () => {
    const clock = withClock(T0);
    const exp = Math.floor((clock.now + 1000) / 1000);
    const token = clock.codec.sign({ playerId: 'p', exp });
    expect(clock.codec.verify(token).ok).toBe(true);
    clock.advance(1000); // now === exp exactly: still valid (inclusive boundary)
    expect(clock.codec.verify(token).ok).toBe(true);
    clock.advance(31_000); // past exp + 30 s skew
    expect(clock.codec.verify(token)).toEqual({ ok: false, reason: 'expired-token' });
  });

  it('tolerates up to 30 s of clock skew past exp, rejects beyond it', () => {
    const clock = withClock(T0);
    const exp = Math.floor(clock.now / 1000);
    const token = clock.codec.sign({ playerId: 'p', exp });
    clock.advance(TOKEN_SKEW_TOLERANCE_MS - 1_000);
    expect(clock.codec.verify(token).ok).toBe(true);
    clock.advance(1_001); // now past exp + 30 s
    expect(clock.codec.verify(token)).toEqual({ ok: false, reason: 'expired-token' });
  });

  it('signs distinct payloads with distinct tokens even for tiny diffs', () => {
    const codec = createTokenCodec('s3cret');
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const a = codec.sign({ playerId: 'p1', exp });
    const b = codec.sign({ playerId: 'p2', exp });
    expect(a).not.toBe(b);
    expect(codec.verify(a).ok).toBe(true);
    expect(codec.verify(b).ok).toBe(true);
  });
});
