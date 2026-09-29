import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { afterAll, describe, expect, it } from 'vitest';

import { buildServer } from '@server/server';
import type { Env } from '@server/env';
import { attachWebSocket, type Authenticate, type SystemGateway } from '@server/ws';
import type { StateSnapshot } from '@shared/protocol/schemas';

const env: Env = {
  PORT: 3001,
  SESSION_SECRET: 'test-secret',
  GALAXY_SEED: 'DRIFT-SEED-0001',
  DB_DRIVER: 'sqlite',
  DB_PATH: './data/drift.db',
  DATABASE_URL: '',
  SYSTEM_INSTANCE_COUNT: 3,
  WS_PATH: '/ws',
};

const CANNED: StateSnapshot = {
  systemId: 'sys-canned',
  entities: [
    {
      id: 'ai-1',
      kind: 'ai-ship',
      pos: { x: 10, y: 0, z: -4 },
      vel: { x: 0, y: 0, z: 1 },
      regime: 'cruise',
      hull: 1,
      shields: 1,
      targetId: null,
      classId: 'scout',
    },
  ],
  nodes: [],
  chat: [],
  players: [],
};

function stubGateway(overrides?: Partial<SystemGateway>): SystemGateway {
  const base: SystemGateway = {
    async enterSystem(systemId) {
      if (systemId === 'sys-full')
        return { ok: false, code: 'system-full', message: 'system is full' };
      if (systemId !== 'sys-canned') {
        return { ok: false, code: 'system-not-found', message: `system ${systemId} not found` };
      }
      return { ok: true, snapshot: CANNED };
    },
  };
  return { ...base, ...overrides };
}

const rejectsAuth: Authenticate = async () => ({ ok: false, message: 'token rejected' });

interface Boot {
  url: string;
  close(): Promise<void>;
}

const booted: Array<() => Promise<void>> = [];

async function boot(
  opts: {
    gateway?: SystemGateway;
    authenticate?: Authenticate;
    keepalive?: { pingIntervalMs?: number; dropAfterMs?: number };
  } = {},
): Promise<Boot> {
  const app = buildServer(env);
  const handle = attachWebSocket(app, {
    path: env.WS_PATH,
    gateway: opts.gateway ?? stubGateway(),
    authenticate: opts.authenticate,
    keepalive: opts.keepalive,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  const close = async () => {
    await handle.close();
    await app.close();
  };
  booted.push(close);
  return { url: `ws://127.0.0.1:${port}/ws`, close };
}

interface Envelope {
  v: number;
  type: string;
  payload: unknown;
}

class TestClient {
  readonly ws: WebSocket;
  readonly messages: Envelope[] = [];
  closed = false;
  closeCode: number | undefined;
  private wake: Array<(value?: unknown) => void> = [];

  constructor(url: string, onPing?: () => void) {
    this.ws = new WebSocket(url);
    this.ws.on('error', () => {
      // Tolerated: teardown terminates sockets the client no longer uses.
    });
    this.ws.on('message', (data) => {
      this.messages.push(JSON.parse(String(data)) as Envelope);
      const msg = this.messages[this.messages.length - 1];
      if (msg.type === 'ping' && onPing) onPing();
      for (const w of this.wake.splice(0)) w();
    });
    this.ws.on('close', (code) => {
      this.closed = true;
      this.closeCode = code;
      for (const w of this.wake.splice(0)) w();
    });
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.once('open', () => resolve());
      this.ws.once('close', () => reject(new Error('socket closed before open')));
    });
  }

  send(envelope: Envelope | string): void {
    this.ws.send(typeof envelope === 'string' ? envelope : JSON.stringify(envelope));
  }

  /** Consume the first unmatched message matching the predicate. */
  async next(predicate: (m: Envelope) => boolean, what: string, ms = 2000): Promise<Envelope> {
    const deadline = Date.now() + ms;
    for (;;) {
      const idx = this.messages.findIndex(predicate);
      if (idx !== -1) return this.messages.splice(idx, 1)[0];
      if (this.closed || Date.now() > deadline) {
        throw new Error(
          `timed out waiting for ${what} (closed=${this.closed}, got: ${this.messages
            .map((m) => m.type)
            .join(',')})`,
        );
      }
      await new Promise((resolve) => {
        this.wake.push(resolve);
        setTimeout(resolve, 10);
      });
    }
  }

  async waitForClose(ms = 2000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!this.closed) {
      if (Date.now() > deadline) throw new Error('timed out waiting for close');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  close(): void {
    this.ws.close();
  }
}

async function handshake(client: TestClient): Promise<void> {
  await client.open();
  client.send({ v: 1, type: 'hello', payload: { v: 1 } });
  client.send({ v: 1, type: 'auth', payload: { callsign: 'drifter' } });
}

afterAll(async () => {
  await Promise.all(booted.splice(0).map((close) => close()));
});

describe('WS handshake and protocol (in-process)', () => {
  it('hello → auth → join_system yields enter_system with the stubbed snapshot', async () => {
    const server = await boot();
    const client = new TestClient(server.url);
    await handshake(client);
    client.send({ v: 1, type: 'join_system', payload: { systemId: 'sys-canned' } });
    const enter = await client.next((m) => m.type === 'enter_system', 'enter_system');
    expect(enter.payload).toEqual({ snapshot: CANNED });
    client.close();
    await server.close();
  });

  it('rejects a wrong protocol version with version-mismatch and closes', async () => {
    const server = await boot();
    const client = new TestClient(server.url);
    await client.open();
    client.send({ v: 999, type: 'hello', payload: { v: 999 } });
    const err = await client.next((m) => m.type === 'error', 'error');
    expect(err.payload).toMatchObject({ code: 'version-mismatch' });
    await client.waitForClose();
    expect(client.closeCode).toBe(1002);
    await server.close();
  });

  it('rejects out-of-order handshake messages with unauthenticated', async () => {
    const server = await boot();
    const client = new TestClient(server.url);
    await client.open();
    client.send({ v: 1, type: 'auth', payload: { callsign: 'drifter' } });
    expect(
      (await client.next((m) => m.type === 'error', 'error after early auth')).payload,
    ).toMatchObject({ code: 'unauthenticated' });
    client.send({ v: 1, type: 'join_system', payload: { systemId: 'sys-canned' } });
    expect(
      (await client.next((m) => m.type === 'error', 'error after early join')).payload,
    ).toMatchObject({ code: 'unauthenticated' });
    client.close();
    await server.close();
  });

  it('responds to join_system with system-not-found for unknown systems', async () => {
    const server = await boot();
    const client = new TestClient(server.url);
    await handshake(client);
    client.send({ v: 1, type: 'join_system', payload: { systemId: 'sys-nowhere' } });
    expect((await client.next((m) => m.type === 'error', 'error')).payload).toMatchObject({
      code: 'system-not-found',
    });
    client.close();
    await server.close();
  });

  it('responds to join_system with system-full when the gateway says full', async () => {
    const server = await boot();
    const client = new TestClient(server.url);
    await handshake(client);
    client.send({ v: 1, type: 'join_system', payload: { systemId: 'sys-full' } });
    expect((await client.next((m) => m.type === 'error', 'error')).payload).toMatchObject({
      code: 'system-full',
    });
    client.close();
    await server.close();
  });

  it('reports unauthenticated when authentication is rejected', async () => {
    const server = await boot({ authenticate: rejectsAuth });
    const client = new TestClient(server.url);
    await client.open();
    client.send({ v: 1, type: 'hello', payload: { v: 1 } });
    client.send({ v: 1, type: 'auth', payload: { token: 'bad' } });
    expect((await client.next((m) => m.type === 'error', 'error')).payload).toMatchObject({
      code: 'unauthenticated',
      message: 'token rejected',
    });
    client.close();
    await server.close();
  });

  it('rejects malformed payloads with invalid-message and never crashes', async () => {
    const server = await boot();
    const client = new TestClient(server.url);
    await client.open();
    client.send('this is not json');
    expect(
      (await client.next((m) => m.type === 'error', 'error for non-JSON')).payload,
    ).toMatchObject({ code: 'invalid-message' });
    client.send({ v: 1, type: 'hello', payload: { v: 'nope' } });
    expect(
      (await client.next((m) => m.type === 'error', 'error for bad hello')).payload,
    ).toMatchObject({ code: 'invalid-message' });
    client.close();
    await server.close();
  });

  it('rejects system-scoped gameplay before joining a system', async () => {
    const server = await boot();
    const client = new TestClient(server.url);
    await handshake(client);
    client.send({
      v: 1,
      type: 'input',
      payload: { seq: 0, thrust: 0, turn: 0, pitch: 0, yaw: 0, fire: false, lock: false },
    });
    expect(
      (await client.next((m) => m.type === 'error', 'error for early input')).payload,
    ).toMatchObject({ code: 'unauthenticated' });
    client.close();
    await server.close();
  });

  it('answers unknown types with unknown-type and drops the connection after 10', async () => {
    const server = await boot();
    const client = new TestClient(server.url);
    await handshake(client);
    for (let i = 1; i <= 9; i++) {
      client.send({ v: 1, type: `bogus-${i}`, payload: {} });
      expect(
        (await client.next((m) => m.type === 'error', `unknown-type ${i}`)).payload,
      ).toMatchObject({ code: 'unknown-type' });
      expect(client.closed).toBe(false);
    }
    client.send({ v: 1, type: 'bogus-10', payload: {} });
    await client.next(
      (m) =>
        m.type === 'error' &&
        (m.payload as { message?: string }).message?.includes('bogus-10') === true,
      'final unknown-type',
    );
    await client.waitForClose();
    await server.close();
  });

  it('broadcasts presence join/leave to the other peers in a system', async () => {
    const server = await boot();
    const a = new TestClient(server.url);
    const b = new TestClient(server.url);
    await handshake(a);
    await handshake(b);
    a.send({ v: 1, type: 'join_system', payload: { systemId: 'sys-canned' } });
    b.send({ v: 1, type: 'join_system', payload: { systemId: 'sys-canned' } });
    await a.next((m) => m.type === 'enter_system', 'a enter_system');
    const join = await b.next((m) => m.type === 'presence', 'b sees a join');
    expect(join.payload).toMatchObject({ event: 'join', player: { callsign: 'drifter' } });
    a.close();
    const leave = await b.next((m) => m.type === 'presence', 'b sees a leave');
    expect(leave.payload).toMatchObject({ event: 'leave', player: { callsign: 'drifter' } });
    b.close();
    await server.close();
  });
});

describe('WS keepalive', () => {
  it('drops a silent connection after the drop window', async () => {
    const server = await boot({ keepalive: { pingIntervalMs: 30, dropAfterMs: 90 } });
    const client = new TestClient(server.url);
    await handshake(client);
    // No pong replies: last activity is the handshake, so the drop window elapses.
    await client.waitForClose(3000);
    await server.close();
  });

  it('keeps a connection alive while the client answers pings with pongs', async () => {
    const server = await boot({ keepalive: { pingIntervalMs: 30, dropAfterMs: 90 } });
    const client = new TestClient(server.url, () => {
      client.send({ v: 1, type: 'pong', payload: {} });
    });
    await handshake(client);
    // Survive at least 4 ping cycles (120 ms >> 90 ms drop window).
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(client.closed).toBe(false);
    client.close();
    await server.close();
  });
});
