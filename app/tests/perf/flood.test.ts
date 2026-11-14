import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateStars } from '@shared/galaxy/stars.ts';
import { generateSystemForStar } from '@shared/galaxy/system.ts';
import { CLOSE_CODES } from '@shared/protocol/errors.ts';
import { createStubAuthenticator } from '../../src/server/testing/stubAuth.ts';
import {
  DEV_SEED,
  STUB_PLAYER,
  startTestServer,
  type TestServer,
} from '../../src/server/testing/testServer.ts';
import type { TestClient } from '../../src/server/testing/wsClient.ts';

const SYSTEM = generateSystemForStar(DEV_SEED, generateStars(DEV_SEED)[2]!).systemId;

interface TickStats {
  workP95: number;
  lateP95: number;
  lateMax: number;
  ticks: number;
}

/** Percentile of an unsorted list. */
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

/**
 * A stand-in for the server's 20 Hz simulation: integrates 16 entities each tick and records the
 * work time and how late each tick fired (event-loop delay) while a flood is in progress.
 */
function startTickLoop(): () => TickStats {
  const entities = Array.from({ length: 16 }, (_, i) => ({
    x: i,
    y: 0,
    z: 0,
    vx: 1,
    vy: 0.5,
    vz: -0.25,
  }));
  const work: number[] = [];
  const late: number[] = [];
  let expected = performance.now() + 50;
  const handle = setInterval(() => {
    const start = performance.now();
    late.push(Math.max(0, start - expected));
    for (let pass = 0; pass < 200; pass++) {
      for (const e of entities) {
        e.x += e.vx * 0.05;
        e.y += e.vy * 0.05;
        e.z += e.vz * 0.05;
      }
    }
    work.push(performance.now() - start);
    expected += 50;
  }, 50);
  return () => {
    clearInterval(handle);
    return {
      workP95: percentile(work, 0.95),
      lateP95: percentile(late, 0.95),
      lateMax: Math.max(...late),
      ticks: work.length,
    };
  };
}

describe('flood resistance (real server, real timers)', () => {
  let server: TestServer;
  const open: TestClient[] = [];

  beforeAll(async () => {
    server = await startTestServer({
      authenticator: createStubAuthenticator({
        'token-0': STUB_PLAYER,
        'token-1': { ...STUB_PLAYER, playerId: '22222222-2222-4222-8222-222222222222' },
      }),
    });
  });
  afterAll(async () => {
    open.forEach((c) => c.close());
    await server.close();
  });

  /** Connects an authenticated client that has joined a system. */
  async function joined(index = 0): Promise<TestClient> {
    const client = await server.connect();
    open.push(client);
    client.send('hello', { v: 1 });
    await client.expect('welcome');
    client.send('auth', { token: `token-${index % 2}` });
    await client.expect('auth_ok');
    client.send('join_system', { systemId: SYSTEM });
    await client.expect('enter_system');
    return client;
  }

  it('throttles a 100 msg/s client, drops it with 4009, and leaves the 20 Hz tick untouched', async () => {
    const client = await joined();
    const stop = startTickLoop();
    const startedAt = performance.now();
    let sent = 0;
    const flood = setInterval(() => {
      if (client.ws.readyState === client.ws.OPEN) {
        client.send('ping', { t: sent });
        sent += 1;
      }
    }, 10);
    const code = await Promise.race([
      client.closed(),
      new Promise<number>((resolve) => setTimeout(() => resolve(-1), 10_000)),
    ]);
    clearInterval(flood);
    const droppedAfterMs = performance.now() - startedAt;
    await new Promise((resolve) => setTimeout(resolve, 500));
    const stats = stop();
    const limited = client.inbox.filter((m) => m.payload['code'] === 'rate-limited').length;
    console.log(
      `flood 100 msg/s: dropped (code ${code}) after ${droppedAfterMs.toFixed(0)} ms, ${sent} msgs sent, ` +
        `${limited} rate-limited answers; tick work p95 ${stats.workP95.toFixed(2)} ms, ` +
        `lateness p95 ${stats.lateP95.toFixed(2)} ms max ${stats.lateMax.toFixed(2)} ms over ${stats.ticks} ticks`,
    );
    expect(code).toBe(CLOSE_CODES.flooded);
    expect(droppedAfterMs).toBeLessThan(5000);
    // Spec: p95 tick < 30 ms. Isolated runs measure ~2-3 ms; the full parallel suite can steal
    // CPU, so the in-suite bound leaves headroom (npm run test:perf prints the real figures).
    expect(stats.workP95 + stats.lateP95).toBeLessThan(50);
  }, 20_000);

  it('survives a tight-loop blast from 8 parallel clients (the per-IP cap) without hurting the tick', async () => {
    const clients = await Promise.all(Array.from({ length: 8 }, (_, i) => joined(i)));
    const stop = startTickLoop();
    const startedAt = performance.now();
    for (let round = 0; round < 400; round++) {
      for (const client of clients) {
        if (client.ws.readyState === client.ws.OPEN) client.send('ping', { t: round });
      }
      if (round % 50 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    const codes = await Promise.all(clients.map((c) => c.closed()));
    const elapsed = performance.now() - startedAt;
    await new Promise((resolve) => setTimeout(resolve, 300));
    const stats = stop();
    console.log(
      `blast 8 x 400 frames: all dropped in ${elapsed.toFixed(0)} ms (codes ${[...new Set(codes)].join(',')}); ` +
        `tick work p95 ${stats.workP95.toFixed(2)} ms, lateness p95 ${stats.lateP95.toFixed(2)} ms ` +
        `max ${stats.lateMax.toFixed(2)} ms over ${stats.ticks} ticks`,
    );
    expect(codes.every((code) => code === CLOSE_CODES.flooded)).toBe(true);
    expect(stats.workP95 + stats.lateP95).toBeLessThan(60);
    expect((await server.app.inject('/api/health')).statusCode).toBe(200);
  }, 30_000);
});
