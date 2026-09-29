import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { afterAll, describe, expect, it } from 'vitest';

import { buildServer } from '@server/server';
import type { Env } from '@server/env';
import { attachWebSocket, type SystemGateway } from '@server/ws';
import { INVALID_MESSAGE_DROP_LIMIT, MAX_MESSAGE_BYTES, parseMessage } from '@shared/protocol';
import type { StateSnapshot } from '@shared/protocol/schemas';

/**
 * TASK-64 fuzz suite (node, not playwright): 20 crafted malformed payloads
 * against a live in-process server — every one must come back as a structured
 * invalid-message while the connection survives and /api/health stays 200.
 */

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
  entities: [],
  nodes: [],
  chat: [],
  players: [],
};

const gateway: SystemGateway = {
  async enterSystem(systemId) {
    if (systemId !== 'sys-canned') {
      return { ok: false, code: 'system-not-found', message: `system ${systemId} not found` };
    }
    return { ok: true, snapshot: CANNED };
  },
};

/** Depth-30 nested object — must be rejected by the strict payload schemas. */
function nested(depth: number): Record<string, unknown> {
  let obj: Record<string, unknown> = {};
  for (let i = 0; i < depth; i++) obj = { deep: obj };
  return obj;
}

/** 20 payloads: wrong types, Infinity, depth-30 nesting, 1 MB string, negative
 *  seq, unknown fields, bad enums, out-of-range numbers. All must be rejected
 *  with invalid-message (no unknown-type, so the connection must survive). */
const FUZZ_PAYLOADS: string[] = [
  'this is not json {{{',
  '[1, 2, 3]',
  '42',
  JSON.stringify({ v: '1', type: 'hello', payload: { v: 1 } }),
  JSON.stringify({ v: 1, type: '', payload: {} }),
  JSON.stringify({ v: 1, type: 'hello', payload: { v: 'one' } }),
  JSON.stringify({ v: 1, type: 'hello', payload: { v: 1, sneaky: true } }),
  JSON.stringify({
    v: 1,
    type: 'input',
    payload: { seq: -1, thrust: 0, turn: 0, pitch: 0, yaw: 0, fire: false, lock: false },
  }),
  // 1e999 is valid JSON and parses to Infinity — must fail the finite() checks.
  '{"v":1,"type":"input","payload":{"seq":0,"thrust":1e999,"turn":0,"pitch":0,"yaw":0,"fire":false,"lock":false}}',
  JSON.stringify({
    v: 1,
    type: 'input',
    payload: { seq: 0, thrust: 'NaN', turn: 0, pitch: 0, yaw: 0, fire: false, lock: false },
  }),
  JSON.stringify({ v: 1, type: 'ping', payload: nested(30) }),
  JSON.stringify({ v: 1, type: 'chat', payload: { text: 'x'.repeat(1_000_000) } }),
  JSON.stringify({ v: 1, type: 'auth', payload: {} }),
  JSON.stringify({ v: 1, type: 'auth', payload: { token: 'x'.repeat(513) } }),
  JSON.stringify({ v: 1, type: 'join_system', payload: { systemId: '' } }),
  JSON.stringify({ v: 1, type: 'sell', payload: { cargoId: 'c1', quantity: 1.5 } }),
  JSON.stringify({ v: 1, type: 'chat', payload: { channel: 'shout', text: 'hi' } }),
  JSON.stringify({ v: 1, type: 'set_livery', payload: { livery: { hull: 'red' } } }),
  JSON.stringify({ v: 1, type: 'ping', payload: [1, 2] }),
  JSON.stringify({
    v: 1,
    type: 'entity_update',
    payload: {
      entities: [
        {
          id: 's1',
          kind: 'ship',
          pos: { x: 0, y: 0, z: 0 },
          vel: { x: 0, y: 0, z: 0 },
          regime: 'cruise',
          hull: 2,
          shields: 1,
          targetId: null,
          classId: 'scout',
        },
      ],
    },
  }),
];

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

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('error', () => {
      // Tolerated: teardown terminates sockets the client no longer uses.
    });
    this.ws.on('message', (data) => {
      this.messages.push(JSON.parse(String(data)) as Envelope);
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

  send(raw: string): void {
    this.ws.send(raw);
  }

  /** Consume the first unmatched message matching the predicate. */
  async next(predicate: (m: Envelope) => boolean, what: string, ms = 3000): Promise<Envelope> {
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

  close(): void {
    this.ws.close();
  }
}

const booted: Array<() => Promise<void>> = [];

afterAll(async () => {
  await Promise.all(booted.splice(0).map((close) => close()));
});

async function boot(): Promise<{ url: string; httpUrl: string; close(): Promise<void> }> {
  const app = buildServer(env);
  const handle = attachWebSocket(app, { path: env.WS_PATH, gateway });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  const close = async () => {
    await handle.close();
    await app.close();
  };
  booted.push(close);
  return { url: `ws://127.0.0.1:${port}/ws`, httpUrl: `http://127.0.0.1:${port}`, close };
}

describe('validation fuzz (20 malformed payloads, live server)', () => {
  it('rejects every payload with invalid-message and the connection survives', async () => {
    const server = await boot();
    const client = new TestClient(server.url);
    await client.open();
    for (const raw of FUZZ_PAYLOADS) {
      client.send(raw);
      const err = await client.next((m) => m.type === 'error', 'invalid-message');
      expect(err.payload, `payload ${raw.slice(0, 60)}`).toMatchObject({ code: 'invalid-message' });
      // Structured error only: bounded message, no raw payload echo.
      expect((err.payload as { message: string }).message.length).toBeLessThanOrEqual(512);
      expect((err.payload as { message: string }).message).not.toContain('xxxxxxxx');
      expect(client.closed, 'connection must stay alive').toBe(false);
    }
    client.close();
    await server.close();
  });

  it('health endpoint still answers 200 and a valid hello→auth→join still succeeds', async () => {
    const server = await boot();
    const client = new TestClient(server.url);
    await client.open();
    // Blast the same 20 payloads on this fresh connection first.
    for (const raw of FUZZ_PAYLOADS) {
      client.send(raw);
      await client.next((m) => m.type === 'error', 'invalid-message');
    }
    expect(client.closed).toBe(false);

    const health = await fetch(`${server.httpUrl}/api/health`);
    expect(health.status).toBe(200);
    expect((await health.json()).ok).toBe(true);

    // State was never mutated by the fuzz: handshake from scratch works.
    client.send(JSON.stringify({ v: 1, type: 'hello', payload: { v: 1 } }));
    client.send(JSON.stringify({ v: 1, type: 'auth', payload: { callsign: 'drifter' } }));
    client.send(JSON.stringify({ v: 1, type: 'join_system', payload: { systemId: 'sys-canned' } }));
    const enter = await client.next((m) => m.type === 'enter_system', 'enter_system');
    expect(enter.payload).toEqual({ snapshot: CANNED });
    client.close();
    await server.close();
  });

  it('drops a connection after 50 invalid messages', async () => {
    const server = await boot();
    const client = new TestClient(server.url);
    await client.open();
    const bad = JSON.stringify({ v: 1, type: 'hello', payload: { v: 'nope' } });
    const closeSeen = new Promise<void>((resolve) => client.ws.once('close', () => resolve()));
    for (let i = 0; i < INVALID_MESSAGE_DROP_LIMIT; i++) {
      client.send(bad);
      await client.next((m) => m.type === 'error', `invalid-message ${i + 1}`);
    }
    await closeSeen;
    await server.close();
  });
});

describe('validation unit checks (in-process)', () => {
  it('rejects NaN and Infinity values that can only be produced in-process', () => {
    expect(
      parseMessage('input', {
        seq: 0,
        thrust: NaN,
        turn: 0,
        pitch: 0,
        yaw: 0,
        fire: false,
        lock: false,
      }).ok,
    ).toBe(false);
    expect(
      parseMessage('input', {
        seq: 0,
        thrust: Infinity,
        turn: 0,
        pitch: 0,
        yaw: 0,
        fire: false,
        lock: false,
      }).ok,
    ).toBe(false);
  });

  it('rejects unknown fields at top level and rejects depth-30 nesting', () => {
    const withSpray = parseMessage('input', {
      seq: 0,
      thrust: 0,
      turn: 0,
      pitch: 0,
      yaw: 0,
      fire: false,
      lock: false,
      evil: 'probe',
    });
    expect(withSpray.ok).toBe(false);
    expect(parseMessage('ping', nested(30)).ok).toBe(false);
  });

  it('exports the size cap used by the ws layer', () => {
    expect(MAX_MESSAGE_BYTES).toBe(64 * 1024);
  });
});
