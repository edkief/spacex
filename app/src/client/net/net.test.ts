import { describe, expect, it } from 'vitest';
import { encodeMessage } from '@shared/protocol/envelope.ts';
import { VALID_SERVER_PAYLOADS } from '@shared/protocol/examples.ts';
import { formatSpeed } from '../ui/Hud.tsx';
import {
  ApiError,
  claimCallsign,
  clearToken,
  fetchClientConfig,
  loadToken,
  resumeSession,
  storeToken,
} from './session.ts';
import { GameSocket, socketUrl, type SocketLike, type SocketStatus } from './socket.ts';

/** A fake WebSocket recording what the client sends. */
class FakeSocket implements SocketLike {
  sent: { type: string; payload: Record<string, unknown> }[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string): void {
    this.sent.push(JSON.parse(data) as FakeSocket['sent'][number]);
  }
  close(): void {
    this.closed = true;
    this.onclose?.({ code: 1000 });
  }
  deliver(type: string, payload: unknown): void {
    this.onmessage?.({ data: encodeMessage(type, payload) });
  }
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('GameSocket', () => {
  const SYSTEM = '0123456789abcdef';
  function open() {
    const fake = new FakeSocket();
    const statuses: SocketStatus[] = [];
    const messages: string[] = [];
    const socket = new GameSocket({
      url: 'ws://test/ws',
      token: 'the-token',
      systemId: SYSTEM,
      onMessage: (message) => messages.push(message.type),
      onStatus: (status) => statuses.push(status),
      createSocket: () => fake,
    });
    return { fake, statuses, messages, socket };
  }

  it('walks hello -> auth -> join_system and goes online on enter_system', () => {
    const { fake, statuses, messages, socket } = open();
    socket.send('ping', { t: 1 }); // not open yet: dropped
    expect(fake.sent).toEqual([]);
    fake.onopen?.();
    expect(fake.sent.at(-1)).toEqual({ v: 1, type: 'hello', payload: { v: 1 } });
    fake.deliver('welcome', VALID_SERVER_PAYLOADS.welcome);
    expect(fake.sent.at(-1)).toMatchObject({ type: 'auth', payload: { token: 'the-token' } });
    expect(socket.rates?.tickRate).toBe(20);
    fake.deliver('auth_ok', VALID_SERVER_PAYLOADS.auth_ok);
    expect(fake.sent.at(-1)).toMatchObject({ type: 'join_system', payload: { systemId: SYSTEM } });
    fake.deliver('enter_system', VALID_SERVER_PAYLOADS.enter_system);
    expect(statuses).toEqual(['handshaking', 'online']);
    expect(messages).toEqual(['enter_system']);
  });

  it('answers pings, ignores malformed frames and reports errors before it is online', () => {
    const { fake, statuses, messages } = open();
    fake.onopen?.();
    fake.deliver('ping', { t: 42 });
    expect(fake.sent.at(-1)).toEqual({ v: 1, type: 'pong', payload: { t: 42 } });
    fake.onmessage?.({ data: 'not json' });
    fake.onmessage?.({ data: new ArrayBuffer(4) });
    fake.deliver('welcome', { nonsense: true });
    fake.deliver('hello', { v: 1 }); // a client-only type from the server is rejected
    expect(messages).toEqual([]);
    fake.deliver('error', { code: 'unauthenticated', message: 'no' });
    expect(statuses.at(-1)).toBe('error');
  });

  it('reports closure once and stops sending', () => {
    const { fake, statuses, socket } = open();
    fake.onopen?.();
    socket.close();
    expect(statuses.at(-1)).toBe('closed');
    const count = fake.sent.length;
    socket.send('ping', { t: 1 });
    expect(fake.sent).toHaveLength(count);
  });

  it('builds same-origin socket URLs', () => {
    expect(socketUrl('/ws', { protocol: 'http:', host: 'localhost:3000' })).toBe(
      'ws://localhost:3000/ws',
    );
    expect(socketUrl('/ws', { protocol: 'https:', host: 'drift.example' })).toBe(
      'wss://drift.example/ws',
    );
  });
});

describe('session REST helpers', () => {
  const info = { playerId: 'p', callsign: 'ACE', shipId: 's', homeSystemId: 'h' };

  it('claims a callsign and surfaces the server error code on refusal', async () => {
    const ok = await claimCallsign('ace', () =>
      Promise.resolve(json(201, { ...info, token: 't' })),
    );
    expect(ok.token).toBe('t');
    const refused = claimCallsign('ace', () =>
      Promise.resolve(json(409, { code: 'callsign-taken', message: 'taken' })),
    );
    await expect(refused).rejects.toMatchObject({ code: 'callsign-taken', status: 409 });
    await expect(refused).rejects.toBeInstanceOf(ApiError);
  });

  it('resumes a session with the bearer token, or returns undefined on 401', async () => {
    let header: string | undefined;
    const session = await resumeSession('tok', (_url, init) => {
      header = new Headers(init?.headers).get('authorization') ?? undefined;
      return Promise.resolve(json(200, info));
    });
    expect(header).toBe('Bearer tok');
    expect(session).toEqual({ ...info, token: 'tok' });
    expect(
      await resumeSession('old', () => Promise.resolve(json(401, { code: 'unauthenticated' }))),
    ).toBeUndefined();
  });

  it('reads the client config and rejects a malformed one', async () => {
    const config = { galaxySeed: 'seed', wsPath: '/ws', protocolVersion: 1 };
    expect(await fetchClientConfig(() => Promise.resolve(json(200, config)))).toEqual(config);
    await expect(
      fetchClientConfig(() => Promise.resolve(json(200, { ok: true }))),
    ).rejects.toThrow();
  });

  it('stores, loads and clears the token, tolerating unavailable storage', () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    };
    expect(loadToken(storage)).toBeUndefined();
    storeToken('abc', storage);
    expect(loadToken(storage)).toBe('abc');
    clearToken(storage);
    expect(loadToken(storage)).toBeUndefined();
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadToken(broken)).toBeUndefined();
    expect(() => storeToken('x', broken)).not.toThrow();
    expect(() => clearToken(broken)).not.toThrow();
  });
});

describe('formatSpeed', () => {
  it('switches from m/s to km/s at 10 km/s', () => {
    expect(formatSpeed(0)).toBe('0 m/s');
    expect(formatSpeed(299.6)).toBe('300 m/s');
    expect(formatSpeed(1_241_000)).toBe('1241.0 km/s');
  });
});
