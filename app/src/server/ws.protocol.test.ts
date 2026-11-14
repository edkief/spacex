import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateStars } from '@shared/galaxy/stars.ts';
import { generateSystemForStar } from '@shared/galaxy/system.ts';
import { CLOSE_CODES } from '@shared/protocol/errors.ts';
import { VALID_CLIENT_PAYLOADS } from '@shared/protocol/examples.ts';
import { createGalaxyDirectory } from './directory.ts';
import {
  DEV_SEED,
  STUB_PLAYER,
  goodTokenAuth,
  startTestServer,
  type TestServer,
} from './testing/testServer.ts';
import type { TestClient } from './testing/wsClient.ts';

const SYSTEM = generateSystemForStar(DEV_SEED, generateStars(DEV_SEED)[2]!).systemId;

describe('WebSocket handshake over a real server', () => {
  let server: TestServer;
  const open: TestClient[] = [];

  beforeAll(async () => {
    server = await startTestServer({
      authenticator: goodTokenAuth(),
      directory: createGalaxyDirectory({ seed: DEV_SEED, capacity: 2 }),
    });
  });
  afterAll(async () => {
    for (const client of open) client.close();
    await server.close();
  });

  /** Connects a client and tracks it for cleanup. */
  async function connect(): Promise<TestClient> {
    const client = await server.connect();
    open.push(client);
    return client;
  }

  /** Runs hello and auth, returning the connected client. */
  async function authenticated(token = 'good-token'): Promise<TestClient> {
    const client = await connect();
    client.send('hello', { v: 1 });
    await client.expect('welcome');
    client.send('auth', { token });
    await client.expect('auth_ok');
    return client;
  }

  it('runs hello -> welcome, auth -> auth_ok, join_system -> enter_system', async () => {
    const client = await connect();
    client.send('hello', { v: 1 });
    const welcome = await client.expect('welcome');
    expect(welcome).toMatchObject({ v: 1, tickRate: 20, snapshotRate: 10 });
    expect(typeof welcome['serverTime']).toBe('number');
    client.send('auth', { token: 'good-token' });
    expect(await client.expect('auth_ok')).toEqual({
      playerId: STUB_PLAYER.playerId,
      callsign: 'TEST-ALPHA',
      shipId: STUB_PLAYER.shipId,
      homeSystemId: STUB_PLAYER.homeSystemId,
    });
    client.send('join_system', { systemId: SYSTEM });
    const entered = await client.expect('enter_system');
    expect(entered).toMatchObject({ systemId: SYSTEM, tick: 0, lastInputSeq: 0 });
    expect(entered['snapshot']).toMatchObject({ systemId: SYSTEM, entities: [], players: [] });
  });

  it('answers a hello with the wrong version with version-mismatch and closes', async () => {
    const client = await connect();
    client.send('hello', { v: 99 });
    expect(await client.expect('error')).toMatchObject({ code: 'version-mismatch' });
    expect(await client.closed()).toBe(CLOSE_CODES.versionMismatch);
  });

  it('rejects out-of-order handshake messages', async () => {
    const client = await connect();
    client.send('auth', { token: 'good-token' });
    expect(await client.expect('error')).toMatchObject({ code: 'out-of-order' });
    client.send('hello', { v: 1 });
    await client.expect('welcome');
    client.send('hello', { v: 1 });
    expect(await client.expect('error')).toMatchObject({ code: 'out-of-order' });
    client.send('join_system', { systemId: SYSTEM });
    expect(await client.expect('error')).toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects a bad token with unauthenticated and allows a retry', async () => {
    const client = await connect();
    client.send('hello', { v: 1 });
    await client.expect('welcome');
    client.send('auth', { token: 'forged' });
    const denied = await client.expect('error');
    expect(denied['code']).toBe('unauthenticated');
    expect(JSON.stringify(denied)).not.toContain('forged');
    client.send('auth', { token: 'good-token' });
    await client.expect('auth_ok');
  });

  it('rejects gameplay messages before login with unauthenticated', async () => {
    const client = await connect();
    client.send('chat', VALID_CLIENT_PAYLOADS.chat);
    expect(await client.expect('error')).toMatchObject({ code: 'unauthenticated' });
    client.send('hello', { v: 1 });
    await client.expect('welcome');
    client.send('sell', VALID_CLIENT_PAYLOADS.sell);
    expect(await client.expect('error')).toMatchObject({ code: 'unauthenticated' });
  });

  it('answers join_system errors: unknown system, and full systems', async () => {
    const client = await authenticated();
    client.send('join_system', { systemId: '0000000000000000' });
    expect(await client.expect('error')).toMatchObject({ code: 'system-not-found' });
    client.send('join_system', { systemId: 'nonsense' });
    expect(await client.expect('error')).toMatchObject({ code: 'invalid-message' });
  });

  it('answers valid gameplay messages with not-implemented once in a system', async () => {
    const client = await authenticated();
    client.send('join_system', { systemId: SYSTEM });
    await client.expect('enter_system');
    client.send('sell', VALID_CLIENT_PAYLOADS.sell);
    expect(await client.expect('error')).toMatchObject({ code: 'not-implemented' });
    client.send('join_system', { systemId: SYSTEM });
    expect(await client.expect('error')).toMatchObject({ code: 'out-of-order' });
  });

  it('answers unknown types and closes after 10 without crashing the server', async () => {
    const client = await connect();
    for (let i = 0; i < 10; i++) client.send('teleport', {});
    for (let i = 0; i < 10; i++)
      expect(await client.expect('error')).toMatchObject({ code: 'unknown-type' });
    expect(await client.closed()).toBe(CLOSE_CODES.tooManyUnknown);
    expect((await server.app.inject('/api/health')).statusCode).toBe(200);
  });

  it('answers client ping with pong and tolerates pong', async () => {
    const client = await connect();
    client.send('ping', { t: 42 });
    expect(await client.expect('pong')).toEqual({ t: 42 });
    client.send('pong', { t: 1 });
    client.send('ping', { t: 43 });
    expect(await client.expect('pong')).toEqual({ t: 43 });
  });

  it('refuses frames over 64 KB at the library level (close 1009) and survives', async () => {
    const client = await connect();
    client.sendRaw(
      JSON.stringify({ v: 1, type: 'ping', payload: { t: 1, pad: 'x'.repeat(70_000) } }),
    );
    expect(await client.closed()).toBe(1009);
    expect((await server.app.inject('/api/health')).statusCode).toBe(200);
  });

  it('rejects binary frames', async () => {
    const client = await connect();
    client.sendRaw(Buffer.from([1, 2, 3]), true);
    expect(await client.expect('error')).toMatchObject({ code: 'invalid-message' });
  });
});

describe('capacity and keepalive timing', () => {
  it('reports system-full when the stub directory is at capacity', async () => {
    const auth = {
      a: { ...STUB_PLAYER, playerId: '11111111-1111-4111-8111-111111111111' },
      b: { ...STUB_PLAYER, playerId: '22222222-2222-4222-8222-222222222222' },
      c: { ...STUB_PLAYER, playerId: '33333333-3333-4333-8333-333333333333' },
    };
    const { createStubAuthenticator } = await import('./testing/stubAuth.ts');
    const server = await startTestServer({
      authenticator: createStubAuthenticator(auth),
      directory: createGalaxyDirectory({ seed: DEV_SEED, capacity: 2 }),
    });
    const clients: TestClient[] = [];
    try {
      for (const token of ['a', 'b', 'c']) {
        const client = await server.connect();
        clients.push(client);
        client.send('hello', { v: 1 });
        await client.expect('welcome');
        client.send('auth', { token });
        await client.expect('auth_ok');
        client.send('join_system', { systemId: SYSTEM });
        if (token === 'c')
          expect(await client.expect('error')).toMatchObject({ code: 'system-full' });
        else await client.expect('enter_system');
      }
    } finally {
      clients.forEach((c) => c.close());
      await server.close();
    }
  });

  it('pings on the 15 s interval, accepts pongs, and drops a silent client after 45 s', async () => {
    const server = await startTestServer({ fakeTimers: true, authenticator: goodTokenAuth() });
    try {
      const login = async () => {
        const client = await server.connect();
        client.send('hello', { v: 1 });
        await client.expect('welcome');
        client.send('auth', { token: 'good-token' });
        await client.expect('auth_ok');
        return client;
      };
      const chatty = await login();
      const silent = await login();
      for (let round = 0; round < 4; round++) {
        server.timers.advance(15_000);
        const ping = await chatty.expect('ping');
        expect(ping).toEqual({ t: server.timers.now() });
        chatty.send('pong', { t: ping['t'] });
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      expect(await silent.closed()).toBe(CLOSE_CODES.heartbeatTimeout);
      expect(chatty.closeCode).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('closes a socket that has not authenticated within 10 s', async () => {
    const server = await startTestServer({ fakeTimers: true, authenticator: goodTokenAuth() });
    try {
      const client = await server.connect();
      server.timers.advance(10_000);
      expect(await client.closed()).toBe(CLOSE_CODES.handshakeTimeout);
    } finally {
      await server.close();
    }
  });
});
