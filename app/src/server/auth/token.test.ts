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

/**
 * Exhaustive codec table (TASK-66): valid, tampered-payload, tampered-mac,
 * truncated, expired, skew-window and garbage input — all through the same
 * verify() the server uses.
 */
describe('token codec — exhaustive table (TASK-66)', () => {
  const SECRET = 'table-secret';
  const codec = createTokenCodec(SECRET, { now: () => T0 });
  const expSec = (offsetMs: number) => Math.floor((T0 + offsetMs) / 1000);
  const validToken = codec.sign({
    playerId: 'player-66',
    systemId: 'sys-66',
    exp: expSec(3_600_000),
  });
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
  const b64json = (v: unknown) => b64(JSON.stringify(v));

  it('accepts the valid table entries', () => {
    expect(codec.verify(validToken).ok).toBe(true);
    // systemId is optional: a token without it also verifies.
    const noSystem = codec.sign({ playerId: 'player-66', exp: expSec(3_600_000) });
    const result = codec.verify(noSystem);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.systemId).toBeUndefined();
  });

  it('rejects every single-character mutation (payload or MAC) of a valid token', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let mutated = 0;
    for (let i = 0; i < validToken.length; i++) {
      for (const ch of alphabet) {
        if (ch === validToken[i]) continue;
        const forged = validToken.slice(0, i) + ch + validToken.slice(i + 1);
        expect(codec.verify(forged).ok, `mutation at ${i} was accepted`).toBe(false);
        mutated += 1;
      }
    }
    expect(mutated).toBeGreaterThan(2000);
  });

  it('rejects every proper truncation of a valid token', () => {
    for (let len = 1; len < validToken.length; len++) {
      expect(codec.verify(validToken.slice(0, len)).ok, `prefix of ${len} accepted`).toBe(false);
    }
  });

  it('rejects a non-canonical MAC whose trailing padding bits differ', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const mac = validToken.slice(validToken.lastIndexOf('.') + 1);
    const lastIdx = alphabet.indexOf(mac[mac.length - 1]);
    // Flipping one trailing padding bit changes the char but not the 32 MAC
    // bytes — a lax decoder would read the identical signature.
    const forged = validToken.slice(0, -1) + alphabet[lastIdx ^ 1];
    expect(forged).not.toBe(validToken);
    expect(
      Buffer.from(forged.slice(forged.lastIndexOf('.') + 1), 'base64url').equals(
        Buffer.from(mac, 'base64url'),
      ),
    ).toBe(true);
    expect(codec.verify(forged)).toEqual({ ok: false, reason: 'invalid-signature' });
  });

  it('expiry table: past exp rejected, ≤30 s skew accepted, far future accepted', () => {
    const cases: Array<[label: string, offsetMs: number, expected: 'ok' | 'expired-token']> = [
      ['exp 1 h in the past', -3_600_000, 'expired-token'],
      ['exp 29 s in the past (skew window)', -29_000, 'ok'],
      ['exp exactly 30 s in the past (skew boundary)', -30_000, 'ok'],
      ['exp 31 s in the past (beyond skew)', -31_000, 'expired-token'],
      ['exp exactly now', 0, 'ok'],
      ['exp 1 h in the future', 3_600_000, 'ok'],
      ['exp 10 years in the future', 10 * 365 * 24 * 3_600_000, 'ok'],
    ];
    for (const [label, offset, expected] of cases) {
      const token = codec.sign({ playerId: 'p', exp: expSec(offset) });
      const result = codec.verify(token);
      if (expected === 'ok') {
        expect(result.ok, `${label} should be accepted`).toBe(true);
      } else {
        expect(result, `${label} should be rejected`).toEqual({
          ok: false,
          reason: 'expired-token',
        });
      }
    }
  });

  it('garbage input table: structured rejection, never throws', () => {
    const cases: Array<
      [label: string, token: string, reason: 'malformed-token' | 'invalid-signature']
    > = [
      ['empty string', '', 'malformed-token'],
      ['bare dot', '.', 'malformed-token'],
      ['empty mac', 'a.', 'malformed-token'],
      ['empty body', '.a', 'malformed-token'],
      ['non-base64 body', '!!!.###', 'malformed-token'],
      ['body is not JSON', `${b64('not json{')}.sig`, 'malformed-token'],
      ['body is a JSON array', `${b64json([1, 2])}.sig`, 'malformed-token'],
      ['body is a JSON string', `${b64json('str')}.sig`, 'malformed-token'],
      ['body is null', `${b64json(null)}.sig`, 'malformed-token'],
      ['missing playerId', `${b64json({ exp: 1 })}.sig`, 'malformed-token'],
      ['empty playerId', `${b64json({ playerId: '', exp: 1 })}.sig`, 'malformed-token'],
      ['numeric playerId', `${b64json({ playerId: 42, exp: 1 })}.sig`, 'malformed-token'],
      ['missing exp', `${b64json({ playerId: 'p' })}.sig`, 'malformed-token'],
      ['null exp', `${b64json({ playerId: 'p', exp: null })}.sig`, 'malformed-token'],
      ['string exp', `${b64json({ playerId: 'p', exp: 'soon' })}.sig`, 'malformed-token'],
      [
        'non-string systemId',
        `${b64json({ playerId: 'p', systemId: 7, exp: 1 })}.sig`,
        'malformed-token',
      ],
      // Well-formed body + payload, but a wrong-length MAC → signature path.
      ['wrong-length mac', `${b64json({ playerId: 'p', exp: 1 })}.abc`, 'invalid-signature'],
    ];
    for (const [label, token, reason] of cases) {
      expect(codec.verify(token), label).toEqual({ ok: false, reason });
    }
  });
});
