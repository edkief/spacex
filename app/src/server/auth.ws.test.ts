import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from './auth/token.ts';
import { TestClient } from './testing/wsClient.ts';
import { startTestServer, type TestServer } from './testing/testServer.ts';

describe('WebSocket authentication with real session tokens', () => {
  let server: TestServer;
  const open: TestClient[] = [];

  beforeAll(async () => {
    server = await startTestServer({ fakeTimers: true });
  });
  afterAll(async () => {
    open.forEach((c) => c.close());
    await server.close();
  });

  /** Connects (optionally with headers) and completes hello. */
  async function hello(headers?: Record<string, string>): Promise<TestClient> {
    const client = await server.connect(headers);
    open.push(client);
    client.send('hello', { v: 1 });
    await client.expect('welcome');
    return client;
  }

  it('claims over REST, then hello -> auth -> join_system at the home system', async () => {
    const me = await server.claim('WS-PILOT');
    const client = await hello();
    client.send('auth', { token: me.token });
    expect(await client.expect('auth_ok')).toEqual({
      playerId: me.playerId,
      callsign: 'WS-PILOT',
      shipId: me.shipId,
      homeSystemId: me.homeSystemId,
    });
    client.send('join_system', { systemId: me.homeSystemId });
    expect(await client.expect('enter_system')).toMatchObject({ systemId: me.homeSystemId });
  });

  it('rejects forged, expired and revoked tokens with unauthenticated, revealing nothing', async () => {
    const me = await server.claim('WS-BAD-TOKENS');
    const revoked = await server.claim('WS-REVOKED');
    await server.repo.deleteSession(hashToken(revoked.token));
    const client = await hello();
    for (const token of [me.token.slice(0, -3) + 'AAA', 'garbage', revoked.token, '']) {
      if (token === '') continue; // empty tokens fail schema validation instead
      client.send('auth', { token });
      const error = await client.expect('error');
      expect(error).toEqual({
        code: 'unauthenticated',
        message: 'invalid or expired session token',
      });
    }
  });

  it('rejects an expired token (a fresh connection after the 7 days + skew have passed)', async () => {
    const me = await server.claim('WS-EXPIRED');
    server.timers.advance(7 * 24 * 60 * 60 * 1000 + 31_000); // also closes idle older sockets
    const client = await hello();
    client.send('auth', { token: me.token });
    expect(await client.expect('error')).toMatchObject({ code: 'unauthenticated' });
  });

  it('keeps gameplay locked until authenticated', async () => {
    const client = await hello();
    client.send('chat', { text: 'let me in' });
    expect(await client.expect('error')).toMatchObject({ code: 'unauthenticated' });
  });

  describe('origin check', () => {
    const origin = () => `http://127.0.0.1:${server.port}`;

    it('allows a same-origin browser and a client without an Origin header (non-production)', async () => {
      open.push(await server.connect({ origin: origin() }));
      open.push(await server.connect({ origin: origin().toUpperCase().replace('HTTP', 'http') }));
      open.push(await server.connect());
    });

    it('refuses cross-origin, null and malformed origins with 403 forbidden-origin', async () => {
      for (const bad of [
        'http://evil.example',
        'http://127.0.0.1:1',
        'null',
        'not a url',
        `https://127.0.0.1.evil.example:${server.port}`,
      ]) {
        await expect(server.connect({ origin: bad }), bad).rejects.toThrow(
          /HTTP 403 .*forbidden-origin/,
        );
      }
    });

    it('refuses any query string (tokens must never travel in a URL)', async () => {
      await expect(TestClient.connect(`${server.wsUrl}?token=abc`)).rejects.toThrow(
        /HTTP 400 .*invalid-request/,
      );
      await expect(TestClient.connect(`${server.wsUrl}?x=1`)).rejects.toThrow(/HTTP 400/);
    });

    it('ignores X-Forwarded-Host unless TRUST_PROXY is on', async () => {
      const forwarded = { origin: 'http://game.example', 'x-forwarded-host': 'game.example' };
      await expect(server.connect(forwarded)).rejects.toThrow(/HTTP 403/);
      const proxied = await startTestServer({ env: { TRUST_PROXY: 'true' } });
      try {
        open.push(await proxied.connect(forwarded));
        await expect(
          proxied.connect({ origin: 'http://other.example', 'x-forwarded-host': 'game.example' }),
        ).rejects.toThrow(/HTTP 403/);
      } finally {
        await proxied.close();
      }
    });

    it('in production requires an Origin header, and still enforces same-origin', async () => {
      const prod = await startTestServer({ env: { NODE_ENV: 'production' } });
      try {
        await expect(prod.connect()).rejects.toThrow(/HTTP 403 .*forbidden-origin/);
        await expect(prod.connect({ origin: 'http://evil.example' })).rejects.toThrow(/HTTP 403/);
        open.push(await prod.connect({ origin: `http://127.0.0.1:${prod.port}` }));
      } finally {
        await prod.close();
      }
    });
  });
});
