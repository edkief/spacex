import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@shared/protocol/envelope.ts';
import { CLOSE_CODES } from '@shared/protocol/errors.ts';
import { VALID_CLIENT_PAYLOADS } from '@shared/protocol/examples.ts';
import { loadConfig } from '../config.ts';
import { createGalaxyDirectory } from '../directory.ts';
import { denyAllAuthenticator } from '../auth/types.ts';
import { FakeTimers } from '../testing/fakeTimers.ts';
import { Connection, type Socket } from './connection.ts';
import type { WsDeps } from './context.ts';
import { createDispatcher, type HandlerMap } from './dispatch.ts';
import { Hub } from './hub.ts';

/** A socket that records what the server sends and how it is closed. */
class FakeSocket implements Socket {
  sent: { type: string; payload: Record<string, unknown> }[] = [];
  closedWith: number | undefined;
  send(data: string): void {
    this.sent.push(JSON.parse(data) as (typeof this.sent)[number]);
  }
  close(code: number): void {
    this.closedWith = code;
  }
  terminate(): void {
    this.closedWith = -1;
  }
  get errors(): string[] {
    return this.sent.filter((m) => m.type === 'error').map((m) => String(m.payload['code']));
  }
}

function setup(handlers: HandlerMap = {}) {
  const timers = new FakeTimers();
  const config = loadConfig({ SESSION_SECRET: 'x'.repeat(40), NODE_ENV: 'test' });
  const deps: WsDeps = {
    config,
    authenticator: denyAllAuthenticator,
    directory: createGalaxyDirectory({ seed: 'dispatch-test' }),
    clock: timers.now,
    timers,
    log: { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() } as never,
  };
  const socket = new FakeSocket();
  const conn = new Connection(socket, '127.0.0.1', timers.now());
  const hub = new Hub();
  const dispatch = createDispatcher(handlers, deps, hub);
  const send = (type: string, payload: unknown, v = PROTOCOL_VERSION) =>
    dispatch(conn, JSON.stringify({ v, type, payload }));
  return { socket, conn, dispatch, send, timers };
}

describe('dispatcher', () => {
  it('rejects garbage frames with invalid-message and keeps the connection usable', async () => {
    const t = setup({ hello: ({ conn }) => void conn.transition('hello-ok') });
    await t.dispatch(t.conn, '{nope');
    await t.dispatch(t.conn, '[]');
    expect(t.socket.errors).toEqual(['invalid-message', 'invalid-message']);
    await t.send('hello', { v: 1 });
    expect(t.conn.state).toBe('hello-ok');
  });

  it('answers a different protocol version with version-mismatch, closing before hello', async () => {
    const t = setup();
    await t.send('hello', { v: 1 }, 99);
    expect(t.socket.errors).toEqual(['version-mismatch']);
    expect(t.socket.closedWith).toBe(CLOSE_CODES.versionMismatch);
  });

  it('answers unknown types and drops the connection after 10', async () => {
    const t = setup();
    for (let i = 0; i < 9; i++) await t.send('teleport', {});
    expect(t.socket.closedWith).toBeUndefined();
    await t.send('teleport', {});
    expect(t.socket.errors).toEqual(Array(10).fill('unknown-type'));
    expect(t.socket.closedWith).toBe(CLOSE_CODES.tooManyUnknown);
  });

  it('treats server-only types sent by a client as unknown-type', async () => {
    const t = setup();
    await t.send('welcome', { v: 1, tickRate: 20, snapshotRate: 10, serverTime: 1 });
    await t.send('constructor', {});
    expect(t.socket.errors).toEqual(['unknown-type', 'unknown-type']);
  });

  it('gates by state before validating, so unauthenticated probes learn nothing about schemas', async () => {
    const handler = vi.fn();
    const t = setup({ chat: handler });
    await t.send('chat', { totally: 'wrong' });
    await t.send('chat', VALID_CLIENT_PAYLOADS.chat);
    expect(t.socket.errors).toEqual(['unauthenticated', 'unauthenticated']);
    expect(handler).not.toHaveBeenCalled();
  });

  it('never calls a handler for an invalid payload and hands valid ones over parsed', async () => {
    const seen: unknown[] = [];
    const t = setup({ ping: (_ctx, payload) => void seen.push(payload) });
    await t.send('ping', { t: 'now' });
    await t.send('ping', { t: 5, extra: 1 });
    await t.send('ping', { t: 7 });
    expect(t.socket.errors).toEqual(['invalid-message', 'invalid-message']);
    expect(seen).toEqual([{ t: 7 }]);
  });

  it('answers valid but unhandled types with not-implemented', async () => {
    const t = setup();
    t.conn.state = 'in-system';
    await t.send('sell', VALID_CLIENT_PAYLOADS.sell);
    await t.send('warp', VALID_CLIENT_PAYLOADS.warp);
    expect(t.socket.errors).toEqual(['not-implemented', 'not-implemented']);
  });

  it('requires input seq to strictly increase', async () => {
    const seqs: number[] = [];
    const t = setup({ input: (_ctx, payload) => void seqs.push(payload.seq) });
    t.conn.state = 'in-system';
    const input = (seq: number) => ({ ...(VALID_CLIENT_PAYLOADS.input as object), seq });
    await t.send('input', input(5));
    await t.send('input', input(5));
    await t.send('input', input(4));
    await t.send('input', input(6));
    expect(seqs).toEqual([5, 6]);
    expect(t.socket.errors).toEqual(['invalid-message', 'invalid-message']);
  });

  it('turns handler exceptions into an internal error and keeps going', async () => {
    const t = setup({
      ping: () => {
        throw new Error('boom');
      },
      pong: () => undefined,
    });
    await t.send('ping', { t: 1 });
    await t.send('pong', { t: 1 });
    expect(t.socket.errors).toEqual(['internal']);
  });

  it('refreshes lastSeenAt on every frame, even invalid ones', async () => {
    const t = setup();
    t.timers.advance(12_345);
    await t.dispatch(t.conn, 'garbage');
    expect(t.conn.lastSeenAt).toBe(t.timers.now());
  });
});
