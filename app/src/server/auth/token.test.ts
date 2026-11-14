import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CLOCK_SKEW_MS,
  TOKEN_TTL_MS,
  hashToken,
  signToken,
  verifyToken,
  type TokenPayload,
} from './token.ts';

const SECRET = 'a-perfectly-valid-test-secret-of-32+chars';
const NOW = Date.UTC(2031, 0, 1);
const payload: TokenPayload = {
  playerId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  exp: NOW + TOKEN_TTL_MS,
  jti: 'AAAAAAAAAAAAAAAAAAAAAA',
};
const token = signToken(payload, SECRET);

/** Replaces the character at `index` with a different base64url character. */
function mutate(text: string, index: number, replacement: string): string {
  return text.slice(0, index) + replacement + text.slice(index + 1);
}

describe('token codec', () => {
  it('has the shape base64url(payload).base64url(mac) and round-trips', () => {
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(verifyToken(token, SECRET, NOW)).toEqual({ ok: true, payload });
  });

  it('is deterministic for a payload and secret, and different under another secret', () => {
    expect(signToken(payload, SECRET)).toBe(token);
    expect(signToken(payload, SECRET + 'x')).not.toBe(token);
    expect(verifyToken(token, SECRET + 'x', NOW)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects a single-character mutation at EVERY position (payload and MAC)', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let checked = 0;
    for (let i = 0; i < token.length; i++) {
      if (token[i] === '.') continue;
      for (const candidate of alphabet) {
        if (candidate === token[i]) continue;
        const result = verifyToken(mutate(token, i, candidate), SECRET, NOW);
        expect(result.ok, `position ${i} -> ${candidate}`).toBe(false);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10_000);
  });

  it('rejects non-canonical base64url spellings (trailing bits) of the MAC and payload', () => {
    const [body, signature] = token.split('.') as [string, string];
    // The last MAC character carries 4 data bits + 2 unused bits; flipping only unused bits
    // would decode identically, so a lenient decoder would accept a second spelling.
    expect(verifyToken(`${body}.${mutate(signature, 42, 'B')}`, SECRET, NOW).ok).toBe(false);
    for (const last of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_') {
      if (last === signature[42]) continue;
      expect(verifyToken(`${body}.${mutate(signature, 42, last)}`, SECRET, NOW).ok).toBe(false);
    }
  });

  it.each([
    ['empty string', ''],
    ['no dot', 'abcdef'],
    ['three parts', `${token}.extra`],
    ['empty parts', '.'],
    ['empty mac', `${token.split('.')[0]}.`],
    ['empty payload', `.${token.split('.')[1]}`],
    ['truncated', token.slice(0, token.length - 5)],
    ['standard base64 alphabet', token.replace(/-/g, '+').replace(/_/g, '/') + '=='],
    ['whitespace padded', ` ${token} `],
    ['newline', `${token}\n`],
    ['unicode', `${token}é`],
    ['garbage', '!!!.@@@'],
  ])('rejects %s', (_label, input) => {
    expect(verifyToken(input, SECRET, NOW).ok).toBe(false);
  });

  it('rejects a correctly signed payload that is not a valid payload', () => {
    const forge = (obj: unknown): string => {
      const body = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
      return `${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`;
    };
    for (const bad of [
      { ...payload, extra: 1 },
      { ...payload, playerId: 'not-a-uuid' },
      { ...payload, exp: 'soon' },
      { ...payload, exp: 1.5 },
      { ...payload, jti: 'x' },
      { playerId: payload.playerId },
      [],
      'text',
    ]) {
      expect(verifyToken(forge(bad), SECRET, NOW)).toEqual({ ok: false, reason: 'malformed' });
    }
    expect(verifyToken(forge(payload), SECRET, NOW).ok).toBe(true);
  });

  describe('expiry', () => {
    const at = (exp: number) => signToken({ ...payload, exp }, SECRET);

    it.each([
      ['far future', NOW + 10 * TOKEN_TTL_MS, true],
      ['just before expiry', NOW + 1, true],
      ['exactly at expiry', NOW, true],
      ['expired 1 s ago (inside skew)', NOW - 1000, true],
      ['expired 29.999 s ago', NOW - (CLOCK_SKEW_MS - 1), true],
      ['expired exactly 30 s ago', NOW - CLOCK_SKEW_MS, true],
      ['expired 30.001 s ago', NOW - CLOCK_SKEW_MS - 1, false],
      ['expired an hour ago', NOW - 3_600_000, false],
      ['expired in 1970', 1, false],
    ])('%s', (_label, exp, valid) => {
      const result = verifyToken(at(exp), SECRET, NOW);
      expect(result.ok).toBe(valid);
      if (!valid) expect(result).toEqual({ ok: false, reason: 'expired' });
    });
  });

  it('refuses to sign an invalid payload', () => {
    expect(() => signToken({ ...payload, playerId: 'nope' }, SECRET)).toThrow();
  });
});

describe('hashToken', () => {
  it('is sha256 hex, deterministic, and not the token', () => {
    const hash = hashToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).toBe(hash);
    expect(hash).not.toContain(token);
    expect(hashToken(token + 'x')).not.toBe(hash);
  });
});
