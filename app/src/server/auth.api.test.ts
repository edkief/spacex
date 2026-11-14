import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { listSpawnSystems, pickSpawnSystem } from '@shared/galaxy/spawn.ts';
import { generateStars } from '@shared/galaxy/stars.ts';
import { generateSystemForStar } from '@shared/galaxy/system.ts';
import { signToken, hashToken, TOKEN_TTL_MS } from './auth/token.ts';
import { DEV_SEED, TEST_SECRET, startTestServer, type TestServer } from './testing/testServer.ts';

const spawns = listSpawnSystems(DEV_SEED);
const UNAUTHENTICATED = { code: 'unauthenticated', message: 'authentication required' };

describe('callsign claim, session and profile REST API', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer({ fakeTimers: true });
  });
  afterAll(async () => {
    await server.close();
  });
  afterEach(() => {
    // Claims are limited to 5/min per IP; each test starts with a fresh minute.
    server.timers.advance(61_000);
  });

  const claim = (payload: unknown) =>
    server.app.inject({ method: 'POST', url: '/api/callsigns', payload: payload as object });
  const get = (url: string, headers: Record<string, string> = {}) =>
    server.app.inject({ method: 'GET', url, headers });
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  describe('POST /api/callsigns', () => {
    it('claims a callsign, creating the player, a docked starter scout and a hashed session', async () => {
      const response = await claim({ callsign: 'Test-Alpha' });
      expect(response.statusCode).toBe(201);
      const body = response.json<Record<string, unknown>>();
      expect(Object.keys(body).sort()).toEqual(
        ['callsign', 'expiresAt', 'homeSystemId', 'playerId', 'shipId', 'token'].sort(),
      );
      expect(body['callsign']).toBe('TEST-ALPHA'); // canonicalised to UPPERCASE
      const playerId = body['playerId'] as string;

      const player = await server.repo.getPlayer(playerId);
      expect(player).toMatchObject({ callsign: 'TEST-ALPHA', credits: 500 });
      expect(player?.homeSystemId).toBe(pickSpawnSystem(spawns, playerId).systemId);

      const ship = await server.repo.getShip(body['shipId'] as string);
      expect(ship).toMatchObject({ ownerId: playerId, classId: 'scout', state: 'docked' });
      expect(ship?.position).toMatchObject({ systemId: body['homeSystemId'], frame: 'system' });

      const token = body['token'] as string;
      const row = await server.repo.getSession(hashToken(token));
      expect(row).toMatchObject({ playerId });
      expect(row?.expiresAt.getTime()).toBe(server.timers.now() + TOKEN_TTL_MS);
      expect(body['expiresAt']).toBe(server.timers.now() + TOKEN_TTL_MS);
      expect(await server.repo.getSession(token)).toBeUndefined(); // the raw token is never stored
    });

    it('picks a home system with a landable, docked planet (never star #0 of the dev seed)', async () => {
      const star0 = generateSystemForStar(DEV_SEED, generateStars(DEV_SEED)[0]!).systemId;
      for (const name of ['HOME-ONE', 'HOME-TWO', 'HOME-THREE']) {
        const body = (await claim({ callsign: name })).json<{ homeSystemId: string }>();
        expect(spawns.map((s) => s.systemId)).toContain(body.homeSystemId);
        expect(body.homeSystemId).not.toBe(star0);
      }
    });

    it('lets the e2e callsigns TEST-ALPHA and TEST-BRAVO be claimed on a fresh database', async () => {
      const fresh = await startTestServer({ fakeTimers: true });
      try {
        for (const callsign of ['TEST-ALPHA', 'TEST-BRAVO']) {
          const response = await fresh.app.inject({
            method: 'POST',
            url: '/api/callsigns',
            payload: { callsign },
          });
          expect(response.statusCode, callsign).toBe(201);
        }
      } finally {
        await fresh.close();
      }
    });

    it('treats callsigns case-insensitively and answers 409 callsign-taken', async () => {
      expect((await claim({ callsign: 'Zulu-One' })).statusCode).toBe(201);
      for (const again of ['ZULU-ONE', 'zulu-one', 'zUlU-oNe']) {
        const response = await claim({ callsign: again });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({
          code: 'callsign-taken',
          message: 'callsign already taken',
        });
        server.timers.advance(20_000);
      }
      expect(await server.repo.findPlayerByCallsign('ZULU-ONE')).toBeDefined();
      expect(await server.repo.findPlayerByCallsign('zulu-one')).toBeUndefined();
    });

    it.each([
      ['too short', { callsign: 'ab' }],
      ['too long', { callsign: 'a'.repeat(17) }],
      ['leading dash', { callsign: '-abc' }],
      ['trailing dash', { callsign: 'abc-' }],
      ['space', { callsign: 'a b c' }],
      ['unicode', { callsign: 'pïlot' }],
      ['underscore', { callsign: 'pilot_one' }],
      ['empty', { callsign: '' }],
      ['number', { callsign: 123 }],
      ['missing', {}],
      ['null body', null],
      ['extra field', { callsign: 'GOOD-ONE', admin: true }],
    ])('rejects an invalid claim (%s) with 400 invalid-request', async (_label, payload) => {
      const response = await claim(payload);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ code: 'invalid-request', message: 'invalid request' });
      server.timers.advance(20_000);
    });

    it('accepts boundary lengths and inner dashes', async () => {
      for (const callsign of ['ABC', 'A'.repeat(16), 'A--B', 'a1-2b']) {
        expect((await claim({ callsign })).statusCode, callsign).toBe(201);
        server.timers.advance(20_000);
      }
    });

    it('lets exactly one of many concurrent claims for the same callsign win', async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => claim({ callsign: 'RACE-DAY' })),
      );
      expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
      expect(results.filter((r) => r.statusCode === 409)).toHaveLength(4);
    });

    it('rate limits claims per IP: 5 per minute, then 429 with Retry-After', async () => {
      const limited = await startTestServer({ fakeTimers: true });
      try {
        const post = (callsign: string) =>
          limited.app.inject({ method: 'POST', url: '/api/callsigns', payload: { callsign } });
        for (let i = 0; i < 5; i++) expect((await post(`LIM-${i}A`)).statusCode).toBe(201);
        const blocked = await post('LIM-6A');
        expect(blocked.statusCode).toBe(429);
        expect(blocked.json()).toMatchObject({ code: 'rate-limited' });
        expect(blocked.headers['retry-after']).toBe('60');
        // Invalid and duplicate attempts count too, so squatting probes get no free tries.
        limited.timers.advance(60_000);
        expect((await post('LIM-7A')).statusCode).toBe(201);
      } finally {
        await limited.close();
      }
    });
  });

  describe('GET /api/session and GET /api/players/me', () => {
    it('returns the caller’s profile for a valid token (and nothing about other players)', async () => {
      const me = await server.claim('PROFILE-ME');
      const other = await server.claim('PROFILE-OTHER');
      const session = await get('/api/session', bearer(me.token));
      expect(session.statusCode).toBe(200);
      expect(session.json()).toEqual({
        playerId: me.playerId,
        callsign: 'PROFILE-ME',
        credits: 500,
        homeSystemId: me.homeSystemId,
        shipId: me.shipId,
      });
      const profile = await get('/api/players/me', bearer(me.token));
      expect(profile.json()).toEqual({
        callsign: 'PROFILE-ME',
        credits: 500,
        homeSystemId: me.homeSystemId,
        shipId: me.shipId,
      });
      expect(JSON.stringify(profile.json())).not.toContain(other.playerId);
    });

    it('reflects credit changes, and exposes no endpoint for other players’ balances', async () => {
      const me = await server.claim('RICH-ONE');
      await server.repo.addCredits(me.playerId, 250);
      expect((await get('/api/players/me', bearer(me.token))).json()).toMatchObject({
        credits: 750,
      });
      await server.repo.withdrawCredits(me.playerId, 700);
      expect((await get('/api/players/me', bearer(me.token))).json()).toMatchObject({
        credits: 50,
      });
      for (const url of [
        `/api/players/${me.playerId}`,
        '/api/players',
        `/api/players/RICH-ONE`,
        '/api/credits',
      ]) {
        const response = await get(url, bearer(me.token));
        expect(response.statusCode, url).toBe(404);
      }
    });

    it('accepts the Bearer scheme case-insensitively', async () => {
      const me = await server.claim('SCHEME-OK');
      const response = await get('/api/session', { authorization: `bearer ${me.token}` });
      expect(response.statusCode).toBe(200);
    });

    describe('answers 401 {code, message} for', () => {
      let valid: Awaited<ReturnType<TestServer['claim']>>;
      beforeAll(async () => {
        valid = await server.claim('AUTH-CASES');
      });

      const flipLast = (token: string) =>
        token.slice(0, -2) + (token.at(-2) === 'A' ? 'B' : 'A') + token.slice(-1);

      it.each([
        ['a missing header', () => ({})],
        ['an empty bearer', () => ({ authorization: 'Bearer ' })],
        ['the wrong scheme', () => ({ authorization: `Basic ${valid.token}` })],
        ['a bare token', () => ({ authorization: valid.token })],
        ['a garbage token', () => ({ authorization: 'Bearer not.a.token' })],
        ['a tampered token', () => ({ authorization: `Bearer ${flipLast(valid.token)}` })],
        [
          'a token signed with another secret',
          () => ({
            authorization: `Bearer ${signToken({ playerId: valid.playerId, exp: server.timers.now() + 1e9, jti: 'A'.repeat(22) }, 'x'.repeat(40))}`,
          }),
        ],
        [
          'a validly signed token with no session row',
          () => ({
            authorization: `Bearer ${signToken({ playerId: valid.playerId, exp: server.timers.now() + 1e9, jti: 'B'.repeat(22) }, TEST_SECRET)}`,
          }),
        ],
      ])('%s', async (_label, headers) => {
        for (const url of ['/api/session', '/api/players/me']) {
          const response = await get(url, headers());
          expect(response.statusCode).toBe(401);
          expect(response.json()).toEqual(UNAUTHENTICATED);
          expect(response.headers['www-authenticate']).toBe('Bearer');
        }
      });

      it('a token passed only in the query string (never read from URLs)', async () => {
        const response = await get(`/api/session?token=${valid.token}&access_token=${valid.token}`);
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual(UNAUTHENTICATED);
      });

      it('an expired session (fake clock past 7 days + skew)', async () => {
        const mine = await server.claim('EXPIRE-ME');
        server.timers.advance(TOKEN_TTL_MS);
        expect((await get('/api/session', bearer(mine.token))).statusCode).toBe(200); // inside skew
        server.timers.advance(31_000);
        const response = await get('/api/session', bearer(mine.token));
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual(UNAUTHENTICATED);
      });

      it('a revoked session (row deleted)', async () => {
        const mine = await server.claim('REVOKED-ONE');
        expect((await get('/api/session', bearer(mine.token))).statusCode).toBe(200);
        await server.repo.deleteSession(hashToken(mine.token));
        expect((await get('/api/session', bearer(mine.token))).statusCode).toBe(401);
      });
    });
  });
});
