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
import { createGalaxyRouter } from './router';
import { createRouterGateway } from './gateway';
import { WsTestClient } from '@server/ws-test-client';
import { generateStars } from '@shared/galaxy/stars';
import { generateSystem } from '@shared/galaxy/system';
import { SPAWN_GATE_POS, SPAWN_GATE_QUAT } from '@shared/galaxy/spawn';
import { PROTOCOL_VERSION } from '@shared/protocol';
import type { StateSnapshot } from '@shared/protocol/schemas';

/**
 * TASK-8 inter-system warp over live ws (real server wiring):
 * - warp A→B: the player's entity leaves shard A entirely (no idle ghost),
 *   appears in shard B at the spawn gate (100 u +X, facing the star), the
 *   ship row follows the ship (position.systemId = B, state 'flying'),
 *   warp_arrived carries a complete B snapshot, and presence leave/join go
 *   to the source/target peers;
 * - warp to a full system (16 players) is rejected with 'system-full' and
 *   the player stays in the source;
 * - warp to an unknown system is rejected with 'system-not-found';
 * - a mid-warp disconnect leaves exactly ONE entity for the player across
 *   both shards, and a reconnect into the row's system re-adopts it.
 */

const GALAXY_SEED = 'warp-ws-seed-001';
const stars = generateStars(GALAXY_SEED);
const SYS_A = generateSystem(GALAXY_SEED, stars[0].id).systemId;
const SYS_B = generateSystem(GALAXY_SEED, stars[1].id).systemId;

const env: Env = {
  PORT: 3002,
  SESSION_SECRET: 'warp-ws-secret',
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

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-warp-'));
  const { db } = createDb({ driver: 'sqlite', dbPath: path.join(dir, 'warp.db') });
  repo = createRepo(db, sqliteTables);
  const sessions = createSessionService({ repo, codec: createTokenCodec('warp-ws-secret') });
  const bus = createShipSwapBus();
  router = createGalaxyRouter({ repo, galaxySeed: GALAXY_SEED, shipSwapBus: bus });

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
): Promise<{ token: string; playerId: string; shipId: string; homeSystemId: string }> {
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
    homeSystemId: string;
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
  const enter = await client.next(
    (m) => m.type === 'enter_system',
    `enter_system for ${systemId} (got: ${client.messages
      .map((m) => (m.type === 'error' ? `error:${JSON.stringify(m.payload)}` : m.type))
      .join(',')})`,
    8000,
  );
  return (enter.payload as { snapshot: StateSnapshot }).snapshot;
}

function sendWarp(client: WsTestClient, destinationSystemId: string): void {
  client.send({
    v: PROTOCOL_VERSION,
    type: 'warp',
    payload: { destinationSystemId },
  });
}

function entityIn(
  loaded: { shard: SystemShard } | undefined,
  playerId: string,
): SimEntity | undefined {
  const shard = loaded?.shard;
  if (!shard) return undefined;
  return [...shard.entities.values()].find((e) => e.playerId === playerId);
}

const near = (
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): boolean => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 1e-6;

describe('inter-system warp over live ws (TASK-8)', () => {
  it('warp A→B: entity moves to the gate, row follows, presence to both peer sets', async () => {
    const a = await claim('Warp-A');
    const bPeer = await claim('Warp-Apeer');
    const bSide = await claim('Warp-Bside');
    const ca = mkClient();
    await join(ca, a.token, SYS_A);
    const cb = mkClient();
    await join(cb, bPeer.token, SYS_A); // peer in the SOURCE
    const cc = mkClient();
    await join(cc, bSide.token, SYS_B); // peer in the TARGET

    sendWarp(ca, SYS_B);
    const arrived = await ca.next((m) => m.type === 'warp_arrived', 'warp_arrived', 8000);
    const { systemId, snapshot } = arrived.payload as {
      systemId: string;
      snapshot: StateSnapshot;
    };
    expect(systemId).toBe(SYS_B);
    expect(snapshot.systemId).toBe(SYS_B);
    // The snapshot is complete and shows OUR ship at the spawn gate.
    const own = snapshot.entities.filter((e) => e.id === a.shipId);
    expect(own).toHaveLength(1);
    expect(near(own[0].pos, SPAWN_GATE_POS)).toBe(true);

    // Shard A: no entity for the player at all (warp departure, not idle).
    const shardA = router.active(SYS_A);
    expect(entityIn(shardA, a.playerId)).toBeUndefined();
    // Shard B: the entity exists, at the gate, facing the star (−X).
    const shardB = router.active(SYS_B);
    const entity = entityIn(shardB, a.playerId);
    expect(entity, 'entity in target shard').toBeDefined();
    expect(near(entity!.ship.pos, SPAWN_GATE_POS)).toBe(true);
    expect(near(entity!.ship.vel, { x: 0, y: 0, z: 0 })).toBe(true);
    expect(near(entity!.ship.quat, SPAWN_GATE_QUAT)).toBe(true);
    expect(entity!.idle).toBe(false);

    // The ship row followed the ship to the target system.
    const row = await repo.getShipByOwner(a.playerId);
    expect(row?.position.systemId).toBe(SYS_B);
    expect(near(row!.position, SPAWN_GATE_POS)).toBe(true);
    expect(row?.state).toBe('flying');

    // Presence: leave to the source peer, join to the target peer.
    const pleave = await cb.next(
      (m) => m.type === 'presence' && (m.payload as { event: string }).event === 'leave',
      'presence leave (source peer)',
      8000,
    );
    expect(pleave.payload).toMatchObject({ event: 'leave', player: { callsign: 'warp-a' } });
    const pjoin = await cc.next(
      (m) => m.type === 'presence' && (m.payload as { event: string }).event === 'join',
      'presence join (target peer)',
      8000,
    );
    expect(pjoin.payload).toMatchObject({ event: 'join', player: { callsign: 'warp-a' } });

    ca.close();
    cb.close();
    cc.close();
  }, 30000);

  it('warp to the current system is rejected as an invalid message', async () => {
    const p = await claim('Warp-Same');
    const c = mkClient();
    await join(c, p.token, SYS_A);
    const rowBefore = await repo.getShipByOwner(p.playerId);
    sendWarp(c, SYS_A);
    const err = await c.next((m) => m.type === 'error', 'error', 8000);
    expect(err.payload).toMatchObject({ code: 'invalid-message' });
    // Still in A, untouched (entity present, row unchanged).
    expect(entityIn(router.active(SYS_A), p.playerId)).toBeDefined();
    expect(await repo.getShipByOwner(p.playerId)).toEqual(rowBefore);
    c.close();
  }, 30000);

  it('warp to an unknown system is rejected; the player never moves', async () => {
    const p = await claim('Warp-Unknown');
    const c = mkClient();
    await join(c, p.token, SYS_A);
    const rowBefore = await repo.getShipByOwner(p.playerId);
    sendWarp(c, 'ffffffffffffffff');
    const err = await c.next((m) => m.type === 'error', 'error', 8000);
    expect(err.payload).toMatchObject({ code: 'system-not-found' });
    expect(entityIn(router.active(SYS_A), p.playerId)).toBeDefined();
    expect(entityIn(router.active('ffffffffffffffff'), p.playerId)).toBeUndefined();
    expect(await repo.getShipByOwner(p.playerId)).toEqual(rowBefore);
    c.close();
  }, 30000);

  it('warp into a full system (16 players) is rejected; player stays in source', async () => {
    // Fill SYS_B with 16 connections.
    const fillers: WsTestClient[] = [];
    for (let i = 0; i < 16; i++) {
      const p = await claim(`Warp-Full-${i}`);
      const c = mkClient();
      await join(c, p.token, SYS_B);
      fillers.push(c);
    }
    expect(router.active(SYS_B)!.shard.connections.size).toBe(16);

    const p = await claim('Warp-Full-Warper');
    const c = mkClient();
    await join(c, p.token, SYS_A);
    const rowBefore = await repo.getShipByOwner(p.playerId);
    sendWarp(c, SYS_B);
    const err = await c.next((m) => m.type === 'error', 'error', 8000);
    expect(err.payload).toMatchObject({ code: 'system-full' });

    // The player never left A; the row is untouched.
    expect(entityIn(router.active(SYS_A), p.playerId)).toBeDefined();
    expect(entityIn(router.active(SYS_B), p.playerId)).toBeUndefined();
    expect(await repo.getShipByOwner(p.playerId)).toEqual(rowBefore);

    c.close();
    for (const f of fillers.splice(0)) f.close();
  }, 60000);

  it('mid-warp disconnect: at most one entity before, exactly one after reconnect', async () => {
    const a = await claim('Warp-Drop');
    const ca = mkClient();
    await join(ca, a.token, SYS_A);

    // Fire the warp and drop the socket immediately. Two outcomes are
    // possible (accepted v1 edge): the server completes the move (ship row
    // → target, entity idles in the target shard), or the warp frame is
    // lost in the pipe (ship row stays at the source, entity idles there).
    sendWarp(ca, SYS_B);
    ca.close();
    await new Promise((r) => setTimeout(r, 500));

    // Across the source and target shards: at most one entity for the
    // player (a LOST frame leaves the ship in the source, a COMPLETED warp
    // in the target — never both, never neither).
    const inA = entityIn(router.active(SYS_A), a.playerId);
    const inB = entityIn(router.active(SYS_B), a.playerId);
    expect(Number(Boolean(inA)) + Number(Boolean(inB))).toBe(1);

    // The row tells the truth about where the ship lives now: either the
    // completed target or the pre-warp location (source or home dock).
    const row = await repo.getShipByOwner(a.playerId);
    expect(row?.position.systemId).toBeDefined();
    const home = row!.position.systemId as string;

    // Reconnect into the row's system: exactly one own entity, in the shard
    // the row says — and NOWHERE else (source, target, or the row's home).
    const ca2 = mkClient();
    const snap = await join(ca2, a.token, home);
    const own = snap.entities.filter((e) => e.id === a.shipId);
    expect(own).toHaveLength(1);
    expect(entityIn(router.active(home), a.playerId)).toBeDefined();
    for (const other of [SYS_A, SYS_B, a.homeSystemId]) {
      if (other === home) continue;
      expect(entityIn(router.active(other), a.playerId), `ghost in ${other}`).toBeUndefined();
    }
    ca2.close();
  }, 30000);
});
