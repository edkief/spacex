import fs from 'fs';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '@server/server';
import type { Env } from '@server/env';
import { createDb } from '@server/db/client';
import { createRepo, type Repository } from '@server/db/repo';
import { sqliteTables } from '@server/db/schema';
import { createTokenCodec } from '@server/auth/token';
import { createSessionService, createTokenAuthenticate } from '@server/auth/session';
import { registerApiRoutes } from '@server/routes';
import { createShipSwapBus } from '@server/shards';
import type { SystemShard, SimEntity } from '@server/shard';
import { attachWebSocket } from '@server/ws';
import { createGalaxyRouter, REAP_GRACE_MS } from './router';
import { createRouterGateway } from './gateway';
import { WsTestClient } from '@server/ws-test-client';
import { generateStars } from '@shared/galaxy/stars';
import { generateSystem } from '@shared/galaxy/system';
import { homeDockPosition } from '@shared/galaxy/dock';
import { PROTOCOL_VERSION } from '@shared/protocol';
import type { InputPayload, StateSnapshot } from '@shared/protocol/schemas';

/**
 * TASK-17 reconnect and full state resync over live ws (real server wiring,
 * including the onGameMessage input routing from index.ts):
 * - a mid-flight drop leaves the ship IDLE but SIMULATED in the shard
 *   (coasts on zero input); presence leave goes to the peer;
 * - a reconnect with the same token re-enters the SAME shard: exactly one
 *   entity for the player (no duplicate), position continuous (< 1 u from
 *   where the ship was extrapolated to, tick quantization included);
 * - a superseded (zombie) socket of the same player can neither steer nor
 *   tear down the reconnected player's connection;
 * - after the 60 s reap grace (fake clock) the shard is flushed and reaped;
 *   rejoining spawns a fresh generation and finds the ship where the last
 *   flush put it — not the dock.
 */

const GALAXY_SEED = 'reconnect-ws-seed-001';
const stars = generateStars(GALAXY_SEED);
const sysId = (i: number): string => generateSystem(GALAXY_SEED, stars[i].id).systemId;
const SYS_A = sysId(0);
const SYS_B = sysId(1);
const SYS_C = sysId(2);

const env: Env = {
  PORT: 3001,
  SESSION_SECRET: 'reconnect-ws-secret',
  GALAXY_SEED,
  DB_DRIVER: 'sqlite',
  DB_PATH: './data/drift.db',
  DATABASE_URL: '',
  SYSTEM_INSTANCE_COUNT: 3,
  WS_PATH: '/ws',
  SHARD_FLUSH_INTERVAL_MS: 30_000,
};

let dir: string;
let app: FastifyInstance;
let repo: Repository;
let router: ReturnType<typeof createGalaxyRouter>;
let httpUrl: string;
let wsUrl: string;
let closeServer: () => Promise<void>;
const clients: WsTestClient[] = [];
/** Fake clock shared with the router (reap grace, TASK-12). */
let fakeNow = 1_700_000_000_000;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-reconnect-'));
  const { db } = createDb({ driver: 'sqlite', dbPath: path.join(dir, 'reconnect.db') });
  repo = createRepo(db, sqliteTables);
  const sessions = createSessionService({ repo, codec: createTokenCodec('reconnect-ws-secret') });
  const bus = createShipSwapBus();
  router = createGalaxyRouter({
    repo,
    galaxySeed: GALAXY_SEED,
    shipSwapBus: bus,
    now: () => fakeNow, // fake clock: the reap grace is testable without sleeping 60 s
  });

  app = buildServer(env);
  registerApiRoutes(app, {
    repo,
    sessions,
    galaxySeed: GALAXY_SEED,
    shipSwapBus: bus,
    galaxyRouter: router,
  });
  attachWebSocket(app, {
    path: env.WS_PATH,
    gateway: createRouterGateway(router),
    authenticate: createTokenAuthenticate(sessions),
    // Same gameplay routing as src/server/index.ts: input frames go to the
    // shard with the Conn identity (the TASK-17 stale-conn guard needs it).
    onGameMessage: (conn, type, payload) => {
      if (!conn.systemId || !conn.playerId) return;
      const shard = router.active(conn.systemId)?.shard;
      if (!shard) return;
      if (type === 'input') shard.enqueueInput(conn.playerId, payload as InputPayload, conn);
    },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  httpUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}${env.WS_PATH}`;
  closeServer = async () => {
    for (const c of clients.splice(0)) c.close();
    await router.stopAll();
    await app.close();
  };
});

afterAll(async () => {
  await closeServer();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function claim(
  callsign: string,
): Promise<{ token: string; playerId: string; shipId: string; callsign: string }> {
  const res = await fetch(`${httpUrl}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as {
    token: string;
    playerId: string;
    shipId: string;
    callsign: string;
  };
}

function mkClient(): WsTestClient {
  const c = new WsTestClient(wsUrl);
  clients.push(c);
  return c;
}

async function join(client: WsTestClient, token: string, systemId: string): Promise<StateSnapshot> {
  await client.open();
  client.send({ v: PROTOCOL_VERSION, type: 'hello', payload: { v: PROTOCOL_VERSION } });
  client.send({ v: PROTOCOL_VERSION, type: 'auth', payload: { token } });
  client.send({ v: PROTOCOL_VERSION, type: 'join_system', payload: { systemId } });
  const enter = await client.next((m) => m.type === 'enter_system', 'enter_system', 8000);
  return (enter.payload as { snapshot: StateSnapshot }).snapshot;
}

function sendInput(client: WsTestClient, seq: number, thrust: number): void {
  client.send({
    v: PROTOCOL_VERSION,
    type: 'input',
    payload: { seq, thrust, turn: 0, pitch: 0, yaw: 0, fire: false, lock: false },
  });
}

function ackAtLeast(minSeq: number) {
  return (m: { type: string; payload: unknown }): boolean =>
    m.type === 'ack' && (m.payload as { seq: number }).seq >= minSeq;
}

function entityOf(shard: SystemShard, playerId: string): SimEntity {
  const entity = [...shard.entities.values()].find((e) => e.playerId === playerId);
  expect(entity, `entity for ${playerId}`).toBeDefined();
  return entity!;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, what: string, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const speed = (v: Vec3): number => Math.hypot(v.x, v.y, v.z);

describe('reconnect and full state resync over live ws (TASK-17)', () => {
  it('mid-flight drop: ship coasts idle; reconnect resyncs at the moved position, no duplicate', async () => {
    const a = await claim('Recon-A');
    const b = await claim('Recon-B');
    const ca = mkClient();
    await join(ca, a.token, SYS_A);
    const cb = mkClient();
    const snapB = await join(cb, b.token, SYS_A);
    const total = snapB.entities.length; // A + B, captured BEFORE the drop

    // A accelerates for ~5 ticks (scout: 40 u/s² → ~10 u/s, well under the
    // 120 cap) then cuts the engines; wait until the zero-input frame is
    // APPLIED (ack) so the ship coasts on a known constant velocity.
    for (let seq = 1; seq <= 5; seq++) {
      sendInput(ca, seq, 1);
      await sleep(60);
    }
    sendInput(ca, 6, 0);
    await ca.next(ackAtLeast(6), 'ack seq 6', 8000);

    // Abrupt mid-flight drop (the socket just closes).
    ca.close();
    const pleave = await cb.next(
      (m) => m.type === 'presence' && (m.payload as { event: string }).event === 'leave',
      'presence leave',
      8000,
    );
    expect(pleave.payload).toMatchObject({ event: 'leave', player: { callsign: a.callsign } });

    const shard = router.active(SYS_A)!.shard;
    // B is still in-system, so the shard never empties — wait for A's
    // connection to be released and the ship to go IDLE (kept simulating).
    const entity = entityOf(shard, a.playerId);
    await waitFor(() => entity.idle === true, 'A ship to go idle');
    const pStop = { ...entity.ship.pos };
    const vStop = { ...entity.ship.vel };
    const tStop = Date.now();
    expect(speed(vStop)).toBeGreaterThan(0.5);

    // The ship KEEPS LIVING: 2 s later it has coasted well past 1 u and is
    // idle (no inputs accepted, TASK-12 grace/reap rules unchanged).
    await sleep(2000);
    expect(entity.idle).toBe(true);
    expect(dist(entity.ship.pos, pStop)).toBeGreaterThan(1);

    // Reconnect with the SAME token → full resync snapshot: exactly ONE
    // entity for A (no duplicate), total count unchanged, and the position
    // is continuous with the idle coast (< 1 u of extrapolation error,
    // tick quantization included).
    const ca2 = mkClient();
    const snapA2 = await join(ca2, a.token, SYS_A);
    const dt = (Date.now() - tStop) / 1000;
    const own = snapA2.entities.filter((e) => e.id === a.shipId);
    expect(own).toHaveLength(1);
    expect(snapA2.entities).toHaveLength(total);
    const expected = {
      x: pStop.x + vStop.x * dt,
      y: pStop.y + vStop.y * dt,
      z: pStop.z + vStop.z * dt,
    };
    expect(dist(own[0].pos, expected)).toBeLessThan(1);

    // The existing peer was told about the rejoin…
    const pjoin = await cb.next(
      (m) => m.type === 'presence' && (m.payload as { event: string }).event === 'join',
      'presence join',
      8000,
    );
    expect(pjoin.payload).toMatchObject({ event: 'join', player: { callsign: a.callsign } });
    // …and the new connection pilots again (entity un-idled, acks flow).
    expect(shard.connections.size).toBe(2);
    expect(entity.idle).toBe(false);
    sendInput(ca2, 1, 0);
    await ca2.next(ackAtLeast(1), 'ack on the new connection', 8000);

    ca2.close();
    cb.close();
  }, 30000);

  it('zombie socket: a superseded conn cannot steer or tear down the reconnect', async () => {
    const p = await claim('Recon-Zombie');
    const c1 = mkClient();
    await join(c1, p.token, SYS_B);
    // c2 opens with the SAME token/system while c1 is still LIVE: the shard
    // supersedes c1 (one slot, one entity — no duplicate on the sim side).
    const c2 = mkClient();
    const snap2 = await join(c2, p.token, SYS_B);
    expect(snap2.entities.filter((e) => e.id === p.shipId)).toHaveLength(1);
    const shard = router.active(SYS_B)!.shard;
    expect(shard.connections.size).toBe(1);

    // c2 acks a zero-input frame so its conn has a lastSeq…
    sendInput(c2, 1, 0);
    await c2.next(ackAtLeast(1), 'ack on c2', 8000);
    // …and c1 (still open) fires a THRUST with a fresh seq: the source
    // guard must DROP it (if it applied, the ship would accelerate).
    sendInput(c1, 9, 1);
    await sleep(1500);
    const entity = entityOf(shard, p.playerId);
    expect(speed(entity.ship.vel)).toBeLessThan(0.5);

    // Late close of the zombie: its leave is IGNORED — the live conn and
    // the (un-idled) entity survive.
    c1.close();
    await sleep(300);
    expect(shard.connections.size).toBe(1);
    expect(entity.idle).toBe(false);

    // The real close (c2) empties the shard and idles the ship.
    c2.close();
    await waitFor(() => shard.connections.size === 0, 'shard to empty');
    expect(entity.idle).toBe(true);
  }, 30000);

  it('reap-and-rejoin: after the grace the ship loads where the last flush put it', async () => {
    const a = await claim('Recon-Reap');
    const ca = mkClient();
    await join(ca, a.token, SYS_C);

    // Fly ~1 s (held input integrates every tick: v ≈ 40 u/s, ~20 u from
    // the dock), then drop.
    sendInput(ca, 1, 1);
    await sleep(1000);
    ca.close();
    const shard = router.active(SYS_C)!.shard;
    await waitFor(() => shard.connections.size === 0, 'shard to empty');

    // Advance the FAKE clock past the 60 s reap grace and reap on demand
    // (no reaper interval running). Other systems emptied by earlier tests
    // may be reaped by the same pass — assert >= 1, not === 1.
    fakeNow += REAP_GRACE_MS + 1_000;
    const reaped = await router.reapEmpty();
    expect(reaped).toBeGreaterThanOrEqual(1);
    expect(router.active(SYS_C)).toBeUndefined();

    // The reap flushed the ship to the DB in FLYING state, away from the
    // dock (no dock reset on the flush).
    const row = await repo.getShipByOwner(a.playerId);
    expect(row?.position.systemId).toBe(SYS_C);
    expect(row?.state).toBe('flying');

    // Rejoin: a FRESH shard (generation bumped) with the ship at the
    // flushed position — within one flush-period of flight of the row,
    // still far from the dock, and exactly one entity for A.
    const ca2 = mkClient();
    const snap = await join(ca2, a.token, SYS_C);
    const own = snap.entities.filter((e) => e.id === a.shipId);
    expect(own).toHaveLength(1);
    const rowPos = row!.position;
    const rowVel = row!.velocity;
    const budget = speed(rowVel) * 1.5 + 1;
    expect(dist(own[0].pos, { x: rowPos.x, y: rowPos.y, z: rowPos.z })).toBeLessThan(budget);
    const dock = homeDockPosition(GALAXY_SEED, SYS_C);
    expect(dist(own[0].pos, dock)).toBeGreaterThan(10);
    expect(router.active(SYS_C)!.generation).toBe(2);

    ca2.close();
  }, 30000);
});
