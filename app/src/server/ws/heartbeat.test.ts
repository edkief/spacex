import { describe, expect, it } from 'vitest';
import { CLOSE_CODES } from '@shared/protocol/errors.ts';
import { loadConfig } from '../config.ts';
import { denyAllAuthenticator } from '../auth/types.ts';
import { createGalaxyDirectory } from '../directory.ts';
import { FakeTimers } from '../testing/fakeTimers.ts';
import { Connection, type Socket } from './connection.ts';
import type { WsDeps } from './context.ts';
import {
  HANDSHAKE_TIMEOUT_MS,
  PING_INTERVAL_MS,
  SILENCE_LIMIT_MS,
  armHandshakeTimeout,
  startHeartbeat,
} from './heartbeat.ts';
import { Hub } from './hub.ts';

class RecordingSocket implements Socket {
  sent: string[] = [];
  closedWith: number | undefined;
  terminated = false;
  send(data: string): void {
    this.sent.push(data);
  }
  close(code: number): void {
    this.closedWith = code;
  }
  terminate(): void {
    this.terminated = true;
  }
}

function setup() {
  const timers = new FakeTimers();
  const deps: WsDeps = {
    config: loadConfig({ SESSION_SECRET: 'x'.repeat(40), NODE_ENV: 'test' }),
    authenticator: denyAllAuthenticator,
    directory: createGalaxyDirectory({ seed: 's' }),
    clock: timers.now,
    timers,
    log: {} as never,
  };
  const hub = new Hub();
  const socket = new RecordingSocket();
  const conn = new Connection(socket, '127.0.0.1', timers.now());
  hub.add(conn);
  return { timers, deps, hub, socket, conn };
}

describe('heartbeat', () => {
  it('pings every connection each 15 s', () => {
    const { timers, deps, hub, socket } = setup();
    startHeartbeat(deps, hub);
    timers.advance(PING_INTERVAL_MS - 1);
    expect(socket.sent).toHaveLength(0);
    timers.advance(1);
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      type: 'ping',
      payload: { t: timers.now() },
    });
    timers.advance(PING_INTERVAL_MS);
    expect(socket.sent).toHaveLength(2);
  });

  it('keeps a connection that answers (any inbound frame counts) and drops one silent over 45 s', () => {
    const { timers, deps, hub, socket, conn } = setup();
    startHeartbeat(deps, hub);
    for (let i = 0; i < 4; i++) {
      timers.advance(PING_INTERVAL_MS);
      conn.lastSeenAt = timers.now();
    }
    expect(socket.terminated).toBe(false);

    const silent = setup();
    startHeartbeat(silent.deps, silent.hub);
    silent.timers.advance(SILENCE_LIMIT_MS);
    expect(silent.socket.terminated).toBe(false); // exactly 45 s of silence is still allowed
    silent.timers.advance(PING_INTERVAL_MS);
    expect(silent.socket.terminated).toBe(true);
    expect(silent.socket.closedWith).toBe(CLOSE_CODES.heartbeatTimeout);
  });

  it('stops pinging once stopped', () => {
    const { timers, deps, hub, socket } = setup();
    const stop = startHeartbeat(deps, hub);
    stop();
    timers.advance(PING_INTERVAL_MS * 3);
    expect(socket.sent).toHaveLength(0);
    expect(timers.pending).toBe(0);
  });
});

describe('handshake timeout', () => {
  it('closes a connection that has not authenticated within 10 s', () => {
    const { timers, deps, socket, conn } = setup();
    armHandshakeTimeout(conn, deps);
    timers.advance(HANDSHAKE_TIMEOUT_MS - 1);
    expect(socket.closedWith).toBeUndefined();
    timers.advance(1);
    expect(socket.closedWith).toBe(CLOSE_CODES.handshakeTimeout);
  });

  it('also closes one that said hello but never authenticated', () => {
    const { timers, deps, socket, conn } = setup();
    armHandshakeTimeout(conn, deps);
    conn.transition('hello-ok');
    timers.advance(HANDSHAKE_TIMEOUT_MS);
    expect(socket.closedWith).toBe(CLOSE_CODES.handshakeTimeout);
  });

  it('leaves authenticated connections alone and cancels its timer on close', () => {
    const { timers, deps, socket, conn } = setup();
    armHandshakeTimeout(conn, deps);
    conn.transition('hello-ok');
    conn.transition('authenticated');
    timers.advance(HANDSHAKE_TIMEOUT_MS * 2);
    expect(socket.closedWith).toBeUndefined();

    const other = setup();
    armHandshakeTimeout(other.conn, other.deps);
    other.conn.markClosed();
    expect(other.timers.pending).toBe(0);
  });
});
