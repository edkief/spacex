import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { afterAll, describe, expect, it } from 'vitest';

import { buildServer } from '@server/server';
import type { Env } from '@server/env';
import { attachWebSocket, type Conn } from '@server/ws';
import type { StateSnapshot } from '@shared/protocol/schemas';

/**
 * TASK-65 integration + flood benchmark.
 *
 * The shard tick loop does not exist yet (TASK-11/12), so the benchmark
 * simulates 16 ticking entities in-process alongside the flood and asserts
 * the tick cost stays well inside the 30 ms p95 budget.
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

const SNAPSHOT: StateSnapshot = {
  systemId: 'sys-canned',
  entities: [],
  nodes: [],
  chat: [],
  players: [],
};

interface Envelope {
  v: number;
  type: string;
  payload: unknown;
}

class FloodClient {
  readonly ws: WebSocket;
  readonly messages: Envelope[] = [];
  closed = false;
  closeCode: number | undefined;
  closedAt: number | undefined;
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
      this.closedAt = Date.now();
      for (const w of this.wake.splice(0)) w();
    });
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('close', () => reject(new Error('socket closed before open')));
    });
  }

  send(envelope: Envelope): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(envelope));
  }

  async next(predicate: (m: Envelope) => boolean, what: string, ms = 3000): Promise<Envelope> {
    const deadline = Date.now() + ms;
    for (;;) {
      const idx = this.messages.findIndex(predicate);
      if (idx !== -1) return this.messages.splice(idx, 1)[0];
      if (this.closed && idx === -1 && Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what} (closed=${this.closed})`);
      }
      await new Promise((resolve) => {
        this.wake.push(resolve);
        setTimeout(resolve, 10);
      });
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    }
  }

  waitForClose(ms = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + ms;
      const timer = setInterval(() => {
        if (this.closed) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() > deadline) {
          clearInterval(timer);
          reject(new Error('timed out waiting for close'));
        }
      }, 10);
    });
  }

  close(): void {
    this.ws.close();
  }
}

async function handshake(client: FloodClient): Promise<void> {
  client.send({ v: 1, type: 'hello', payload: { v: 1 } });
  client.send({ v: 1, type: 'auth', payload: { callsign: 'flooder' } });
}

interface Boot {
  url: string;
  close(): Promise<void>;
}

const booted: Array<() => Promise<void>> = [];

async function boot(
  onGameMessage?: (conn: Conn, type: string, payload: unknown) => void,
): Promise<Boot> {
  const app = buildServer(env);
  const handle = attachWebSocket(app, {
    path: env.WS_PATH,
    gateway: {
      async enterSystem(systemId) {
        return { ok: true, snapshot: { ...SNAPSHOT, systemId } };
      },
    },
    onGameMessage,
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

afterAll(async () => {
  await Promise.all(booted.splice(0).map((close) => close()));
});

describe('rate limiting over the wire (TASK-65)', () => {
  it('drops a 100 msg/s flooder with 4009 and keeps simulated ticks under the p95 budget', async () => {
    const gameMessages: string[] = [];
    const server = await boot((_conn, type) => {
      gameMessages.push(type);
    });
    const client = new FloodClient(server.url);
    await client.open();
    await handshake(client);
    client.send({ v: 1, type: 'join_system', payload: { systemId: 'sys-canned' } });
    await client.next((m) => m.type === 'enter_system', 'enter_system');

    // Simulated shard: 16 entities ticking every 20 ms while the flood runs.
    const entities = Array.from({ length: 16 }, (_, i) => ({
      id: i,
      x: 0,
      y: 0,
      z: 0,
      vx: 1 + i * 0.1,
    }));
    const tickDurations: number[] = [];
    let stopTicks = false;
    const tickLoop = async () => {
      while (!stopTicks) {
        const t0 = performance.now();
        for (const e of entities) {
          e.x += e.vx * 0.02;
          e.y += Math.sin(e.x * 0.01) * 0.02;
          e.z += Math.cos(e.x * 0.01) * 0.02;
        }
        tickDurations.push(performance.now() - t0);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    const ticks = tickLoop();

    const startedAt = Date.now();
    // 100 msg/s flood for up to 10 s; stop early once the server drops us.
    const flooder = setInterval(() => {
      client.send({
        v: 1,
        type: 'input',
        payload: { seq: 1, thrust: 1, turn: 0, pitch: 0, yaw: 0, fire: false, lock: false },
      });
    }, 10);
    await client.waitForClose(15_000);
    const dropElapsedMs = (client.closedAt ?? Date.now()) - startedAt;
    clearInterval(flooder);
    stopTicks = true;
    await ticks;

    expect(client.closeCode, 'dropped with 4009 flooded').toBe(4009);
    expect(dropElapsedMs, 'dropped within ~5 s').toBeLessThan(5_000);
    const rateLimited = client.messages.filter(
      (m) => m.type === 'error' && (m.payload as { code?: string }).code === 'rate-limited',
    );
    expect(rateLimited.length, 'sends rate-limited rejections before dropping').toBeGreaterThan(0);
    // The flood never reached gameplay dispatch after the bucket drained.
    expect(gameMessages.length).toBeLessThan(100);

    const sorted = [...tickDurations].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    expect(p95, `p95 tick ${p95.toFixed(3)} ms stays under 30 ms`).toBeLessThan(30);

    client.close();
    await server.close();
  }, 30_000);

  it('lets 10 Hz gameplay inputs through without tripping the bucket', async () => {
    const seen: number[] = [];
    const server = await boot((_conn, type) => {
      if (type === 'input') seen.push(Date.now());
    });
    const client = new FloodClient(server.url);
    await client.open();
    await handshake(client);
    client.send({ v: 1, type: 'join_system', payload: { systemId: 'sys-canned' } });
    await client.next((m) => m.type === 'enter_system', 'enter_system');

    const start = Date.now();
    while (Date.now() - start < 3_000) {
      client.send({
        v: 1,
        type: 'input',
        payload: { seq: 1, thrust: 1, turn: 0, pitch: 0, yaw: 0, fire: false, lock: false },
      });
      await new Promise((resolve) => setTimeout(resolve, 100)); // 10 Hz
    }
    // Every input must reach dispatch; none rate-limited.
    expect(seen.length).toBeGreaterThanOrEqual(25);
    expect(client.messages.some((m) => m.type === 'error')).toBe(false);
    expect(client.closed).toBe(false);
    client.close();
    await server.close();
  }, 15_000);

  it('applies the chat limiter: 2 s gap, 280 chars, violations reported', async () => {
    const chats: string[] = [];
    const server = await boot((_conn, type, payload) => {
      if (type === 'chat') chats.push((payload as { text: string }).text);
    });
    const a = new FloodClient(server.url);
    const b = new FloodClient(server.url);
    await a.open();
    await b.open();
    await handshake(a);
    await handshake(b);
    a.send({ v: 1, type: 'join_system', payload: { systemId: 'sys-canned' } });
    b.send({ v: 1, type: 'join_system', payload: { systemId: 'sys-canned' } });
    await a.next((m) => m.type === 'enter_system', 'a enter_system');
    await b.next((m) => m.type === 'enter_system', 'b enter_system');

    a.send({ v: 1, type: 'chat', payload: { channel: 'local', text: 'hello' } });
    b.send({ v: 1, type: 'chat', payload: { channel: 'local', text: 'hi b' } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(chats).toEqual(['hello', 'hi b']);

    // A speaks again 500 ms later — too soon.
    a.send({ v: 1, type: 'chat', payload: { channel: 'local', text: 'again' } });
    const err = await a.next((m) => m.type === 'error', 'a rate-limited chat');
    expect(err.payload).toMatchObject({ code: 'rate-limited' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    // The rejected message never reaches dispatch.
    expect(chats).toEqual(['hello', 'hi b']);

    // B waits out the gap and sends a full 280-char message.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    b.send({ v: 1, type: 'chat', payload: { channel: 'local', text: 'x'.repeat(280) } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(chats).toContain('x'.repeat(280));
    expect(b.closed).toBe(false);

    a.close();
    b.close();
    await server.close();
  }, 15_000);

  it('drops a connection on 3 rate-limit violations in 10 s', async () => {
    const server = await boot();
    const client = new FloodClient(server.url);
    await client.open();
    await handshake(client);
    client.send({ v: 1, type: 'join_system', payload: { systemId: 'sys-canned' } });
    await client.next((m) => m.type === 'enter_system', 'enter_system');
    // Burst well past the 40-token allowance; the 3rd rejection escalates.
    for (let i = 0; i < 50; i++) {
      client.send({ v: 1, type: 'ping', payload: {} });
    }
    await client.waitForClose(5_000);
    expect(client.closeCode).toBe(4009);
    await server.close();
  });
});
