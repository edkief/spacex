import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateStars } from '@shared/galaxy/stars.ts';
import { generateSystemForStar } from '@shared/galaxy/system.ts';
import { VALID_CLIENT_PAYLOADS } from '@shared/protocol/examples.ts';
import {
  DEV_SEED,
  goodTokenAuth,
  startTestServer,
  type TestServer,
} from '../src/server/testing/testServer.ts';
import type { TestClient } from '../src/server/testing/wsClient.ts';

const SYSTEM = generateSystemForStar(DEV_SEED, generateStars(DEV_SEED)[2]!).systemId;
const frame = (type: unknown, payload: unknown): string => JSON.stringify({ v: 1, type, payload });
const nested = (depth: number): unknown => (depth === 0 ? 1 : { a: nested(depth - 1) });
const goodInput = { ...(VALID_CLIENT_PAYLOADS.input as object) };

/** Raw frames sent on a fresh (unauthenticated) connection. */
const FRESH: [string, string][] = [
  ['hello with string version', frame('hello', { v: '1' })],
  ['hello with extra field', frame('hello', { v: 1, admin: true })],
  ['hello with missing payload', '{"v":1,"type":"hello"}'],
  ['non-string type', '{"v":1,"type":5,"payload":{}}'],
  ['extra envelope field', '{"v":1,"type":"hello","payload":{"v":1},"x":1}'],
  ['bare null', 'null'],
  ['bare array', '[]'],
];

/** Raw frames sent after hello (state hello-ok). */
const AFTER_HELLO: [string, string][] = [
  ['auth with 600-char token', frame('auth', { token: 'x'.repeat(600) })],
  ['auth with object token', frame('auth', { token: { $ne: null } })],
  ['auth with callsign instead of token', frame('auth', { callsign: 'EVIL' })],
  ['auth with empty token', frame('auth', { token: '' })],
];

/** Raw frames sent while in a system. */
const IN_SYSTEM: [string, string][] = [
  ['negative seq', frame('input', { ...goodInput, seq: -1 })],
  ['fractional seq', frame('input', { ...goodInput, seq: 1.5 })],
  ['string thrust', frame('input', { ...goodInput, thrust: '1' })],
  [
    'Infinity thrust (1e999)',
    JSON.stringify({ v: 1, type: 'input', payload: goodInput }).replace(
      '"thrust":1',
      '"thrust":1e999',
    ),
  ],
  [
    'NaN literal',
    JSON.stringify({ v: 1, type: 'input', payload: goodInput }).replace(
      '"thrust":1',
      '"thrust":NaN',
    ),
  ],
  ['unknown field', frame('input', { ...goodInput, godMode: true })],
  [
    '__proto__ pollution attempt',
    '{"v":1,"type":"chat","payload":{"__proto__":{"admin":true},"text":"hi"}}',
  ],
  ['depth-30 nesting', frame('input', nested(30))],
  ['array payload', frame('input', [])],
  ['missing payload', '{"v":1,"type":"input"}'],
  ['281-char chat', frame('chat', { text: 'x'.repeat(281) })],
  ['control characters in chat', frame('chat', { text: 'a\u0000b' })],
  ['numeric chat text', frame('chat', { text: 12345 })],
];

describe('validation fuzz against a live in-process server', () => {
  let server: TestServer;
  const clients: TestClient[] = [];

  beforeAll(async () => {
    server = await startTestServer({ authenticator: goodTokenAuth() });
  });
  afterAll(async () => {
    clients.forEach((c) => c.close());
    await server.close();
  });

  /** Connects, optionally progressing the handshake to a given stage. */
  async function connectTo(stage: 'fresh' | 'hello' | 'system'): Promise<TestClient> {
    const client = await server.connect();
    clients.push(client);
    if (stage === 'fresh') return client;
    client.send('hello', { v: 1 });
    await client.expect('welcome');
    if (stage === 'hello') return client;
    client.send('auth', { token: 'good-token' });
    await client.expect('auth_ok');
    client.send('join_system', { systemId: SYSTEM });
    await client.expect('enter_system');
    return client;
  }

  /** Sends each frame and asserts an invalid-message answer, then that the connection still works. */
  async function fuzz(client: TestClient, cases: [string, string][]): Promise<void> {
    for (const [label, text] of cases) {
      client.sendRaw(text);
      const reply = await client.expect('error');
      expect(reply['code'], label).toBe('invalid-message');
      expect(Object.keys(reply).sort(), label).toEqual(['code', 'message']);
      expect(String(reply['message']).length, label).toBeLessThan(100);
    }
  }

  it('sends 20+ crafted payloads; every one is rejected with invalid-message and nothing mutates', async () => {
    expect(FRESH.length + AFTER_HELLO.length + IN_SYSTEM.length).toBeGreaterThanOrEqual(20);

    const fresh = await connectTo('fresh');
    await fuzz(fresh, FRESH);
    fresh.send('hello', { v: 1 });
    await fresh.expect('welcome'); // still in 'connected' state, still usable

    const hello = await connectTo('hello');
    await fuzz(hello, AFTER_HELLO);
    hello.send('auth', { token: 'good-token' });
    await hello.expect('auth_ok');

    const inSystem = await connectTo('system');
    await fuzz(inSystem, IN_SYSTEM);
    const conn = [...server.app.sockets.hub.connections()].find((c) => c.state === 'in-system');
    expect(conn?.lastInputSeq).toBe(-1); // no rejected input advanced the sequence
    inSystem.send('input', goodInput);
    expect(await inSystem.expect('error')).toMatchObject({ code: 'not-implemented' });

    expect((await server.app.inject('/api/health')).statusCode).toBe(200);
    const again = await connectTo('system');
    again.send('ping', { t: 1 });
    expect(await again.expect('pong')).toEqual({ t: 1 });
  });

  it('refuses a 1 MB string at the library level and keeps serving', async () => {
    const client = await connectTo('system');
    client.sendRaw(frame('chat', { text: 'x'.repeat(1024 * 1024) }));
    expect(await client.closed()).toBe(1009);
    expect((await server.app.inject('/api/health')).statusCode).toBe(200);
    const next = await connectTo('system');
    next.send('ping', { t: 2 });
    expect(await next.expect('pong')).toEqual({ t: 2 });
  });

  it('drops a client that keeps sending invalid messages (50) with close code 4011', async () => {
    // Fake time lets us pace the garbage below the rate limit so the invalid counter is what trips.
    const paced = await startTestServer({ fakeTimers: true });
    try {
      const client = await paced.connect();
      for (let i = 0; i < 50; i++) {
        client.sendRaw('{broken');
        if (i % 10 === 9) {
          await new Promise((resolve) => setTimeout(resolve, 30));
          paced.timers.advance(1000);
        }
      }
      expect(await client.closed()).toBe(4011);
    } finally {
      await paced.close();
    }
  });
});
