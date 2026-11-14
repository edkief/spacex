import { afterEach, describe, expect, it } from 'vitest';
import { generateStars } from '@shared/galaxy/stars.ts';
import { generateSystemForStar } from '@shared/galaxy/system.ts';
import { CLOSE_CODES } from '@shared/protocol/errors.ts';
import { VALID_CLIENT_PAYLOADS } from '@shared/protocol/examples.ts';
import { LIMITS } from './limits.ts';
import { createStubAuthenticator } from './testing/stubAuth.ts';
import { DEV_SEED, STUB_PLAYER, startTestServer, type TestServer } from './testing/testServer.ts';
import type { TestClient } from './testing/wsClient.ts';

const stars = generateStars(DEV_SEED);
const SYSTEM_A = generateSystemForStar(DEV_SEED, stars[2]!).systemId;
const SYSTEM_B = generateSystemForStar(DEV_SEED, stars[5]!).systemId;
const tick = () => new Promise((resolve) => setTimeout(resolve, 40));

describe('WebSocket rate limits', () => {
  let server: TestServer | undefined;
  const open: TestClient[] = [];

  afterEach(async () => {
    open.splice(0).forEach((c) => c.close());
    await server?.close();
    server = undefined;
  });

  /** Starts a server with fake time and two distinct players (token a, token b). */
  async function start(): Promise<TestServer> {
    server = await startTestServer({
      fakeTimers: true,
      authenticator: createStubAuthenticator({
        a: {
          ...STUB_PLAYER,
          callsign: 'PILOT-A',
          playerId: '11111111-1111-4111-8111-111111111111',
        },
        b: {
          ...STUB_PLAYER,
          callsign: 'PILOT-B',
          playerId: '22222222-2222-4222-8222-222222222222',
        },
      }),
    });
    return server;
  }

  /** Connects and joins `systemId` as the player behind `token`. */
  async function join(s: TestServer, token: string, systemId: string): Promise<TestClient> {
    const client = await s.connect();
    open.push(client);
    client.send('hello', { v: 1 });
    await client.expect('welcome');
    client.send('auth', { token });
    await client.expect('auth_ok');
    client.send('join_system', { systemId });
    await client.expect('enter_system');
    return client;
  }

  describe('general message rate', () => {
    it('answers rate-limited and drops the excess, then escalates to close 4009 on the 3rd violation', async () => {
      const s = await start();
      const client = await join(s, 'a', SYSTEM_A);
      // 3 frames used so far; the bucket holds 40. Send 60 more instantly with frozen time.
      for (let i = 0; i < 60; i++) client.send('ping', { t: i });
      expect(await client.closed()).toBe(CLOSE_CODES.flooded);
      const answers = client.inbox.map((m) => m.type);
      // Excess frames get rate-limited answers until the 3rd violation drops the connection;
      // work already queued for a dropped connection is skipped, so pongs are at most the budget.
      expect(answers.filter((t) => t === 'error').length).toBe(LIMITS.violationLimit - 1);
      expect(answers.filter((t) => t === 'pong').length).toBeLessThanOrEqual(
        LIMITS.messageBurst - 3,
      );
    });

    it('lets normal play through: 10 Hz of input for 30 s never trips the limiter', async () => {
      const s = await start();
      const client = await join(s, 'a', SYSTEM_A);
      for (let i = 1; i <= 300; i++) {
        s.timers.advance(100);
        client.send('input', { ...(VALID_CLIENT_PAYLOADS.input as object), seq: i });
        if (i % 20 === 0) await tick();
      }
      await tick();
      const errors = client.inbox.filter(
        (m) => m.payload['code'] !== 'not-implemented' && m.type === 'error',
      );
      expect(errors).toEqual([]);
      expect(client.closeCode).toBeUndefined();
    });

    it('forgives bursts that are spread out: violations expire after 10 s', async () => {
      const s = await start();
      const client = await join(s, 'a', SYSTEM_A);
      for (let round = 0; round < 3; round++) {
        s.timers.advance(11_000); // refills the bucket and expires earlier violations
        for (let i = 0; i < LIMITS.messageBurst + 1; i++) client.send('pong', { t: i }); // 1 over
        await tick();
      }
      expect(client.closeCode).toBeUndefined();
      expect(client.inbox.filter((m) => m.payload['code'] === 'rate-limited')).toHaveLength(3);
    });
  });

  describe('chat', () => {
    it('broadcasts to everyone in the same system only, echoing to the sender', async () => {
      const s = await start();
      const a = await join(s, 'a', SYSTEM_A);
      const b = await join(s, 'b', SYSTEM_A);
      const c = await join(s, 'b', SYSTEM_B);
      a.send('chat', { text: '  hello pilots  ' });
      for (const client of [a, b]) {
        expect(await client.expect('chat')).toEqual({
          from: 'PILOT-A',
          text: 'hello pilots',
          at: s.timers.now(),
        });
      }
      await tick();
      expect(c.inbox).toEqual([]);
    });

    it('allows one message per 2 s and answers rate-limited without broadcasting', async () => {
      const s = await start();
      const a = await join(s, 'a', SYSTEM_A);
      const b = await join(s, 'b', SYSTEM_A);
      a.send('chat', { text: 'one' });
      await b.expect('chat');
      s.timers.advance(1999);
      a.send('chat', { text: 'two' });
      expect(await a.expect('chat')).toMatchObject({ text: 'one' });
      expect(await a.expect('error')).toMatchObject({ code: 'rate-limited' });
      await tick();
      expect(b.inbox).toEqual([]);
      s.timers.advance(1);
      a.send('chat', { text: 'three' });
      expect(await b.expect('chat')).toMatchObject({ text: 'three' });
    });

    it('caps 10 messages per 30 s window', async () => {
      const s = await start();
      const a = await join(s, 'a', SYSTEM_A);
      for (let i = 0; i < 10; i++) {
        a.send('chat', { text: `m${i}` });
        await a.expect('chat');
        s.timers.advance(2000);
      }
      a.send('chat', { text: 'overflow' });
      expect(await a.expect('error')).toMatchObject({ code: 'rate-limited' });
      s.timers.advance(10_000);
      a.send('chat', { text: 'later' });
      expect(await a.expect('chat')).toMatchObject({ text: 'later' });
    });

    it('rejects over-long chat as invalid-message (280 max)', async () => {
      const s = await start();
      const a = await join(s, 'a', SYSTEM_A);
      a.send('chat', { text: 'x'.repeat(281) });
      expect(await a.expect('error')).toMatchObject({ code: 'invalid-message' });
      a.send('chat', { text: 'x'.repeat(280) });
      expect((await a.expect('chat'))['text']).toHaveLength(280);
    });

    it('counts chat spam toward escalation: 3 violations in 10 s closes with 4009', async () => {
      const s = await start();
      const a = await join(s, 'a', SYSTEM_A);
      a.send('chat', { text: 'first' });
      await a.expect('chat');
      for (let i = 0; i < 3; i++) a.send('chat', { text: `spam ${i}` });
      expect(await a.closed()).toBe(CLOSE_CODES.flooded);
    });
  });

  describe('concurrent socket caps', () => {
    it('refuses the 9th socket from one IP with HTTP 429 and frees the slot when one closes', async () => {
      const s = await start();
      const clients: TestClient[] = [];
      for (let i = 0; i < LIMITS.socketsPerIp; i++) clients.push(await s.connect());
      open.push(...clients);
      await expect(s.connect()).rejects.toThrow('HTTP 429');
      clients[0]!.close();
      await clients[0]!.closed();
      await tick();
      open.push(await s.connect());
    });

    it('allows 4 sockets per session token and refuses the 5th with too-many-connections', async () => {
      const s = await start();
      for (let i = 0; i < LIMITS.socketsPerToken; i++) await join(s, 'a', SYSTEM_A);
      const fifth = await s.connect();
      open.push(fifth);
      fifth.send('hello', { v: 1 });
      await fifth.expect('welcome');
      fifth.send('auth', { token: 'a' });
      expect(await fifth.expect('error')).toMatchObject({ code: 'too-many-connections' });
      expect(await fifth.closed()).toBe(CLOSE_CODES.connectionLimit);
      const other = await join(s, 'b', SYSTEM_A);
      expect(other.closeCode).toBeUndefined();
    });
  });
});
