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
import { attachWebSocket, createRegistryGateway } from '@server/ws';
import { SystemShard } from '@server/shard';
import { WsTestClient, joinSystem } from '@server/ws-test-client';
import type { EntityState, InputPayload } from '@shared/protocol/schemas';
import { generateStars } from '@shared/galaxy/stars';
import { generateSystem } from '@shared/galaxy/system';
import { PROTOCOL_VERSION } from '@shared/protocol';

/**
 * TASK-13 ws integration: a live server with the test-only shard (the wiring
 * index.ts uses) — a player joins the shard's system, sends seq'd inputs, and
 * receives 10 Hz entity_update snapshots reflecting the integrated physics.
 * (The full multi-client comparison suite arrives with TASK-70.)
 */

const env: Env = {
  PORT: 3001,
  SESSION_SECRET: 'shard-test-secret',
  GALAXY_SEED: 'shard-ws-seed-001',
  DB_DRIVER: 'sqlite',
  DB_PATH: './data/drift.db',
  DATABASE_URL: '',
  SYSTEM_INSTANCE_COUNT: 3,
  WS_PATH: '/ws',
};

let dir: string;
let app: FastifyInstance;
let repo: Repository;
let shard: SystemShard;
let wsUrl: string;
let httpUrl: string;
let closeServer: () => Promise<void>;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-shard-'));
  const { db } = createDb({ driver: 'sqlite', dbPath: path.join(dir, 'shard.db') });
  repo = createRepo(db, sqliteTables);
  const sessions = createSessionService({
    repo,
    codec: createTokenCodec('shard-test-secret'),
  });
  const bus = createShipSwapBus();

  // Same wiring as src/server/index.ts: first star's system, registered,
  // one test-only shard.
  const star = generateStars(env.GALAXY_SEED, 4)[0];
  const system = generateSystem(env.GALAXY_SEED, star.id);
  await repo.upsertSystem(system.systemId, system.name, true);
  shard = new SystemShard({
    systemId: system.systemId,
    galaxySeed: env.GALAXY_SEED,
    system,
    repo,
    shipSwapBus: bus,
  });
  shard.start();

  app = buildServer(env);
  registerApiRoutes(app, { repo, sessions, galaxySeed: env.GALAXY_SEED, shipSwapBus: bus });
  const handle = attachWebSocket(app, {
    path: env.WS_PATH,
    gateway: createRegistryGateway(repo),
    authenticate: createTokenAuthenticate(sessions),
    onGameMessage: (conn, type, payload) => {
      if (type === 'input' && conn.systemId === system.systemId && conn.playerId) {
        shard.enqueueInput(conn.playerId, payload as InputPayload);
      }
    },
    onJoinSystem: async (conn, systemId) => {
      if (systemId === system.systemId) await shard.join(conn);
    },
    onLeaveSystem: (conn, systemId) => {
      if (systemId === system.systemId) shard.leave(conn);
    },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  httpUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}${env.WS_PATH}`;
  closeServer = async () => {
    shard.stop();
    await handle.close();
    await app.close();
  };
});

afterAll(async () => {
  await closeServer();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function claim(
  callsign: string,
): Promise<{ token: string; playerId: string; shipId: string }> {
  const res = await fetch(`${httpUrl}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { token: string; playerId: string; shipId: string };
}

function sendInput(client: WsTestClient, payload: InputPayload): void {
  client.send({ v: PROTOCOL_VERSION, type: 'input', payload });
}

describe('shard sim over live ws (TASK-13)', () => {
  it('joins the shard system, inputs integrate, and 10 Hz snapshots arrive', async () => {
    const p = await claim('Shard-Pilot');
    const client = new WsTestClient(wsUrl);
    await joinSystem(client, p.token, shard.systemId);

    // onJoinSystem spawns the entity asynchronously — wait for it.
    for (let i = 0; i < 50 && shard.entities.size === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    // The joined player's ship is now a shard entity at the dock position.
    expect(shard.entities.size).toBe(1);
    const entity = [...shard.entities.values()][0];
    expect(entity.playerId).toBe(p.playerId);
    expect(entity.docked).toBe(true);

    // Thrust for a moment; snapshots (10 Hz) must show the ship moving.
    for (let i = 1; i <= 10; i++) {
      sendInput(client, {
        seq: i,
        thrust: 1,
        turn: 0,
        pitch: 0,
        yaw: 0,
        fire: false,
        lock: false,
      });
      await new Promise((r) => setTimeout(r, 30));
    }
    // Wait for snapshots: first one after ~200 ms; collect a few.
    const updates: EntityState[][] = [];
    const deadline = Date.now() + 3000;
    while (updates.length < 5 && Date.now() < deadline) {
      const msg = await client.next((m) => m.type === 'entity_update', 'entity_update', 2500);
      updates.push((msg.payload as { entities: EntityState[] }).entities);
    }
    expect(updates.length).toBe(5);

    // The player's own entity is in every snapshot, under their ship id.
    for (const list of updates) {
      const me = list.find((e) => e.id === p.shipId);
      expect(me).toBeDefined();
      expect(me!.callsign).toBe('shard-pilot');
      expect(me!.classId).toBe('scout');
    }
    // First snapshot: just took off (no longer docked). Later: moving +Z.
    const first = updates[0].find((e) => e.id === p.shipId)!;
    const last = updates[4].find((e) => e.id === p.shipId)!;
    expect(last.pos.z).toBeGreaterThan(first.pos.z);
    expect(last.vel.z).toBeGreaterThan(0);
    // The entity left the dock regime after the first input.
    expect(last.regime).toBe('sublight');

    // TASK-14: the owning client is acked the last APPLIED seq. Acks are
    // sent at snapshot cadence as appliedSeq advances; latest-wins means a
    // frame replaced before its tick is never APPLIED, so acked seqs may
    // skip — collect until the applied seq reaches 10.
    const ackSeqs: number[] = [];
    for (let i = 0; i < 30 && ackSeqs[ackSeqs.length - 1] !== 10; i++) {
      const ack = await client.next((m) => m.type === 'ack', 'ack', 2500);
      ackSeqs.push((ack.payload as { seq: number }).seq);
    }
    expect(ackSeqs[ackSeqs.length - 1]).toBe(10); // final ack: all inputs applied
    expect(ackSeqs.every((s, i) => i === 0 || s > ackSeqs[i - 1])).toBe(true); // monotonic
    expect(ackSeqs[0]).toBeGreaterThanOrEqual(1);

    // Stale seq from the wire is ignored: state keeps advancing from seq 10.
    const before = last.pos.z;
    sendInput(client, {
      seq: 2, // stale (lastSeq = 10)
      thrust: -1,
      turn: 0,
      pitch: 0,
      yaw: 0,
      fire: false,
      lock: false,
    });
    const msg = await client.next((m) => m.type === 'entity_update', 'entity_update', 2500);
    const after = (msg.payload as { entities: EntityState[] }).entities.find(
      (e) => e.id === p.shipId,
    )!;
    expect(after.pos.z).toBeGreaterThanOrEqual(before - 1e-9); // no reverse thrust applied

    client.close();
    // Leaving the system releases the connection (entity stays in-world).
    await new Promise((r) => setTimeout(r, 200));
    expect(shard.connections.size).toBe(0);
    expect(shard.entities.size).toBe(1);
  }, 15000);
});
