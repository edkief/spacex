import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateStars } from '@shared/galaxy/stars.ts';
import { generateSystemForStar } from '@shared/galaxy/system.ts';
import { CLOSE_CODES } from '@shared/protocol/errors.ts';
import { hashToken } from './auth/token.ts';
import {
  DEV_SEED,
  TEST_SECRET,
  startTestServer,
  type ClaimedPlayer,
  type TestServer,
} from './testing/testServer.ts';
import type { TestClient } from './testing/wsClient.ts';

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const SYSTEM = generateSystemForStar(DEV_SEED, generateStars(DEV_SEED)[2]!).systemId;

describe('session token integrity: logout, revocation, tampering', () => {
  let server: TestServer;
  const open: TestClient[] = [];

  beforeAll(async () => {
    server = await startTestServer({ fakeTimers: true });
  });
  afterAll(async () => {
    open.forEach((c) => c.close());
    await server.close();
  });
  afterEach(() => {
    // Claims are limited to 5/min per IP; give every test a fresh minute (also retires old sockets).
    server.timers.advance(61_000);
  });

  const get = (url: string, token: string) =>
    server.app.inject({ method: 'GET', url, headers: bearer(token) });
  const logout = (token?: string, payload?: unknown) =>
    server.app.inject({
      method: 'POST',
      url: '/api/session/logout',
      headers: token ? bearer(token) : {},
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  /** Connects, authenticates and joins a system as the given player. */
  async function online(player: ClaimedPlayer): Promise<TestClient> {
    const client = await server.connect();
    open.push(client);
    client.send('hello', { v: 1 });
    await client.expect('welcome');
    client.send('auth', { token: player.token });
    await client.expect('auth_ok');
    client.send('join_system', { systemId: SYSTEM });
    await client.expect('enter_system');
    return client;
  }

  describe('POST /api/session/logout', () => {
    it('revokes the presenting token: the session row is deleted and a second use is 401', async () => {
      const me = await server.claim('LOGOUT-ONE');
      expect(await server.repo.getSession(hashToken(me.token))).toBeDefined();
      expect((await get('/api/session', me.token)).statusCode).toBe(200);

      const response = await logout(me.token);
      expect(response.statusCode).toBe(204);
      expect(response.body).toBe('');
      expect(await server.repo.getSession(hashToken(me.token))).toBeUndefined();

      for (const url of ['/api/session', '/api/players/me']) {
        expect((await get(url, me.token)).statusCode, url).toBe(401);
      }
      expect((await logout(me.token)).statusCode).toBe(401);
    });

    it('only revokes the presented token, not the player’s other sessions or other players', async () => {
      const a = await server.claim('LOGOUT-A');
      const b = await server.claim('LOGOUT-B');
      const second = await server.app.inject({
        method: 'POST',
        url: '/api/callsigns',
        payload: { callsign: 'LOGOUT-C' },
      });
      expect(second.statusCode).toBe(201);
      await logout(a.token);
      expect((await get('/api/session', b.token)).statusCode).toBe(200);
    });

    it('requires a valid token and accepts only an empty body', async () => {
      const me = await server.claim('LOGOUT-BODY');
      expect((await logout()).statusCode).toBe(401);
      expect((await logout('garbage')).statusCode).toBe(401);
      expect((await logout(me.token, { everyone: true })).statusCode).toBe(400);
      expect((await get('/api/session', me.token)).statusCode).toBe(200); // rejected body revoked nothing
      expect((await logout(me.token, {})).statusCode).toBe(204);
    });

    it('rejects WebSocket authentication with a revoked token', async () => {
      const me = await server.claim('LOGOUT-WS-AUTH');
      await logout(me.token);
      const client = await server.connect();
      open.push(client);
      client.send('hello', { v: 1 });
      await client.expect('welcome');
      client.send('auth', { token: me.token });
      expect(await client.expect('error')).toMatchObject({ code: 'unauthenticated' });
    });
  });

  describe('shared account model: one token, several connections', () => {
    it('lets two connections use the same token until it is revoked, then closes both (1000)', async () => {
      const me = await server.claim('SHARED-ONE');
      const first = await online(me);
      const second = await online(me);
      first.send('chat', { text: 'from first' });
      await first.expect('chat');
      await second.expect('chat'); // same account, same system: both sockets are live
      second.send('ping', { t: 1 });
      expect(await second.expect('pong')).toEqual({ t: 1 });

      expect((await logout(me.token)).statusCode).toBe(204);
      expect(await first.closed()).toBe(CLOSE_CODES.loggedOut);
      expect(await second.closed()).toBe(CLOSE_CODES.loggedOut);
      expect((await get('/api/session', me.token)).statusCode).toBe(401);
    });

    it('the WS logout message revokes the token and closes with code 1000', async () => {
      const me = await server.claim('SHARED-WS-LOGOUT');
      const first = await online(me);
      const second = await online(me);
      first.send('logout', {});
      expect(await first.closed()).toBe(CLOSE_CODES.loggedOut);
      expect(await second.closed()).toBe(CLOSE_CODES.loggedOut);
      expect(await server.repo.getSession(hashToken(me.token))).toBeUndefined();
      expect((await get('/api/players/me', me.token)).statusCode).toBe(401);
    });

    it('requires authentication to log out over WebSocket', async () => {
      const client = await server.connect();
      open.push(client);
      client.send('hello', { v: 1 });
      await client.expect('welcome');
      client.send('logout', {});
      expect(await client.expect('error')).toMatchObject({ code: 'unauthenticated' });
    });
  });

  it('rejects every single-character mutation of a real issued token at the API', async () => {
    const me = await server.claim('TAMPER-API');
    const alphabet = 'AZaz09-_';
    let tried = 0;
    for (let i = 0; i < me.token.length; i++) {
      if (me.token[i] === '.') continue;
      for (const c of alphabet) {
        if (c === me.token[i]) continue;
        const forged = me.token.slice(0, i) + c + me.token.slice(i + 1);
        const response = await get('/api/session', forged);
        expect(response.statusCode, `index ${i} -> ${c}`).toBe(401);
        tried++;
      }
    }
    expect(tried).toBeGreaterThan(1000);
    expect((await get('/api/session', me.token)).statusCode).toBe(200); // the real one still works
  });

  describe('log-leak guard (permanent regression test)', () => {
    it('never writes the secret, tokens, token hashes or query strings to the logs', async () => {
      const leaky = await startTestServer({ fakeTimers: true, captureLogs: true });
      const sockets: TestClient[] = [];
      try {
        const me = await leaky.claim('LEAK-CHECK');
        const hash = hashToken(me.token);
        const [payloadPart, macPart] = me.token.split('.') as [string, string];
        const forgedRest = 'FORGED-REST-SENTINEL-TOKEN-ZZZ';
        const forgedWs = 'FORGED-WS-SENTINEL-TOKEN-ZZZ';

        // REST: success, failures, a token in the query string, a token echoed in a bad body.
        await leaky.app.inject({ method: 'GET', url: '/api/session', headers: bearer(me.token) });
        await leaky.app.inject({
          method: 'GET',
          url: '/api/players/me',
          headers: bearer(me.token),
        });
        await leaky.app.inject({
          method: 'GET',
          url: `/api/session?token=${me.token}&access_token=${forgedRest}`,
        });
        await leaky.app.inject({ method: 'GET', url: '/api/session', headers: bearer(forgedRest) });
        await leaky.app.inject({
          method: 'POST',
          url: '/api/callsigns',
          payload: { callsign: 'x', token: me.token },
        });
        await leaky.app.inject({
          method: 'POST',
          url: '/api/callsigns',
          payload: { callsign: 'LEAK-CHECK' },
        });

        // WebSocket: bad token, good token, chat, logout.
        const client = await leaky.connect();
        sockets.push(client);
        client.send('hello', { v: 1 });
        await client.expect('welcome');
        client.send('auth', { token: forgedWs });
        await client.expect('error');
        client.send('auth', { token: me.token });
        await client.expect('auth_ok');
        client.send('join_system', { systemId: SYSTEM });
        await client.expect('enter_system');
        client.send('auth', { token: me.token }); // out of order: logged at debug, must not echo
        await client.expect('error');
        client.send('logout', {});
        await client.closed();
        await leaky.app.inject({
          method: 'POST',
          url: '/api/session/logout',
          headers: bearer(me.token),
        });

        const logs = leaky.logs();
        // Not vacuous: the requests really were logged (at trace level).
        expect(logs).toContain('/api/session');
        expect(logs).toContain('/api/callsigns');
        expect(logs.split('\n').filter(Boolean).length).toBeGreaterThan(10);

        for (const [label, secret] of [
          ['SESSION_SECRET', TEST_SECRET],
          ['token', me.token],
          ['token hash', hash],
          ['token payload part', payloadPart],
          ['token MAC part', macPart],
          ['forged REST token', forgedRest],
          ['forged WS token', forgedWs],
        ] as const) {
          expect(logs.includes(secret), `${label} leaked into the logs`).toBe(false);
        }
        expect(logs).not.toMatch(/token=/);
        expect(logs).not.toMatch(/Bearer /i);
        expect(logs).not.toMatch(/authorization/i);
      } finally {
        sockets.forEach((c) => c.close());
        await leaky.close();
      }
    });
  });
});
