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
import { createShipSwapBus, routeGameMessage } from '@server/shards';
import { attachWebSocket } from '@server/ws';
import { WsTestClient, type WsEnvelope } from '@server/ws-test-client';
import { generateStars } from '@shared/galaxy/stars';
import { generateSystem } from '@shared/galaxy/system';
import { padsForSystem } from '@shared/world/pads';
import { PROTOCOL_VERSION } from '@shared/protocol';
import { createGalaxyRouter } from './router';
import { createRouterGateway } from './gateway';

/**
 * TASK-33 step 4: the interaction over LIVE ws (the warp.ws.test.ts pattern,
 * real server wiring). The AC: "two clients, one picks up, both see the
 * update" — a pickup is an entity mutation on the SHARD, so the 10 Hz shared
 * snapshot carries it to every peer within one snapshot: quantity −1, then
 * the removal at zero.
 */

const GALAXY_SEED = 'DRIFT-SEED-0001';

function findPadTarget(): {
  systemId: string;
  pad: { padId: string; pos: { x: number; y: number; z: number } };
} {
  for (const star of generateStars(GALAXY_SEED)) {
    const system = generateSystem(GALAXY_SEED, star.id);
    const planet = system.planets.find((p) => p.landable && p.hasAtmosphere);
    if (!planet) continue;
    const pad = padsForSystem(GALAXY_SEED, system).find((p) => p.planetId === planet.id);
    if (pad) return { systemId: system.systemId, pad: { padId: pad.padId, pos: pad.pos } };
  }
  throw new Error('no landable atmospheric pad in the seeded galaxy');
}
const PAD = findPadTarget();

const env: Env = {
  PORT: 3002,
  SESSION_SECRET: 'interact-ws-secret',
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-interact-'));
  const { db } = createDb({ driver: 'sqlite', dbPath: path.join(dir, 'interact.db') });
  repo = createRepo(db, sqliteTables);
  const sessions = createSessionService({ repo, codec: createTokenCodec('interact-ws-secret') });
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
  // The production dispatch surface (index.ts uses the SAME helper): this is
  // what routes 'interact' to the shard.
  attachWebSocket(app, {
    path: env.WS_PATH,
    gateway: createRouterGateway(router),
    authenticate: createTokenAuthenticate(sessions),
    onGameMessage: (conn, type, payload) => {
      if (!conn.systemId || !conn.playerId) return;
      const shard = router.active(conn.systemId)?.shard;
      if (!shard) return;
      routeGameMessage(shard, conn, type, payload);
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

interface Claimed {
  token: string;
  playerId: string;
  shipId: string;
  homeSystemId: string;
  callsign: string;
}

async function claim(callsign: string): Promise<Claimed> {
  const res = await fetch(`${httpUrl}/api/callsigns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Claimed;
}

function mkClient(): WsTestClient {
  const c = new WsTestClient(wsUrl);
  clients.push(c);
  return c;
}

interface WireEntity {
  id: string;
  kind: string;
  pos: { x: number; y: number; z: number };
  regime: string;
  callsign?: string;
  onFoot?: boolean;
  quantity?: number;
}

/** Join home, warp to the pad system when needed (the ship row must live there). */
async function arriveAtPad(client: WsTestClient, player: Claimed): Promise<void> {
  await client.open();
  const send = (type: string, payload: unknown): void =>
    client.send({ v: PROTOCOL_VERSION, type, payload });
  send('hello', { v: PROTOCOL_VERSION });
  send('auth', { token: player.token });
  send('join_system', { systemId: player.homeSystemId });
  await client.next((m) => m.type === 'enter_system', 'enter_system (home)');
  if (player.homeSystemId !== PAD.systemId) {
    send('warp', { destinationSystemId: PAD.systemId });
    await client.next((m) => m.type === 'warp_arrived', 'warp_arrived (pad system)', 10_000);
  }
}

/** Dock + disembark → the player's character entity, as seen on the wire. */
async function onFoot(client: WsTestClient, player: Claimed): Promise<WireEntity> {
  const shard = router.active(PAD.systemId)?.shard;
  expect(shard, `shard for ${PAD.systemId} must be active`).toBeDefined();
  expect(
    shard!.teleportForTesting(player.playerId, {
      x: PAD.pad.pos.x,
      y: PAD.pad.pos.y + 5,
      z: PAD.pad.pos.z,
    }),
  ).toBe(true);
  await client.next(
    (m) => {
      if (m.type !== 'entity_update') return false;
      return ((m.payload as { entities: WireEntity[] }).entities ?? []).some(
        (e) => e.callsign === player.callsign && e.regime === 'docked',
      );
    },
    `docked entity_update for ${player.callsign}`,
    15_000,
  );
  client.send({ v: PROTOCOL_VERSION, type: 'exit_ship', payload: { shipId: player.shipId } });
  const upd = await client.next(
    (m) =>
      m.type === 'entity_update' &&
      ((m.payload as { entities: WireEntity[] }).entities ?? []).some(
        (e) => e.kind === 'character' && e.callsign === player.callsign,
      ),
    `character entity_update for ${player.callsign}`,
    10_000,
  );
  return (upd.payload as { entities: WireEntity[] }).entities.find(
    (e) => e.kind === 'character' && e.callsign === player.callsign,
  )!;
}

describe('TASK-33: pickup over live ws — two clients, both see the update', () => {
  it('one tap: quantity −1 for BOTH clients; a second tap removes the deposit for both', async () => {
    const a = await claim('ws-interact-a');
    const b = await claim('ws-interact-b');
    const ca = mkClient();
    const cb = mkClient();
    await arriveAtPad(ca, a);
    await arriveAtPad(cb, b);

    const charA = await onFoot(ca, a);

    // The deposit sits 1 m in front of A's character (identity facing = +Z):
    // comfortably inside the 3 m, 30° cone BOTH clients would raycast.
    const shard = router.active(PAD.systemId)!.shard;
    const depositId = shard.addDepositForTesting(
      { x: charA.pos.x, y: charA.pos.y, z: charA.pos.z + 1 },
      2,
    );

    // Both clients must first see the deposit exist (the prompt's source of
    // truth — the snapshot batch).
    const hasDep = (m: WsEnvelope, id: string): boolean =>
      m.type === 'entity_update' &&
      ((m.payload as { entities: WireEntity[] }).entities ?? []).some((e) => e.id === id);
    await ca.next((m) => hasDep(m, depositId), 'deposit visible (A)', 10_000);
    await cb.next((m) => hasDep(m, depositId), 'deposit visible (B)', 10_000);

    // A picks up (the client's registry sends exactly this frame).
    ca.send({
      v: PROTOCOL_VERSION,
      type: 'interact',
      payload: { targetId: depositId, action: 'pickup' },
    });

    const q1 = (m: WsEnvelope): boolean => {
      if (m.type !== 'entity_update') return false;
      const d = ((m.payload as { entities: WireEntity[] }).entities ?? []).find(
        (e) => e.id === depositId,
      );
      return d !== undefined && d.quantity === 1;
    };
    const updA = await ca.next(q1, 'quantity 1 (A)', 10_000);
    const updB = await cb.next(q1, 'quantity 1 (B)', 10_000);
    // BOTH clients saw the SAME quantity change…
    const entA = (updA.payload as { entities: WireEntity[] }).entities;
    const entB = (updB.payload as { entities: WireEntity[] }).entities;
    expect(entA.find((e) => e.id === depositId)?.quantity).toBe(1);
    expect(entB.find((e) => e.id === depositId)?.quantity).toBe(1);
    // …and the entity id the wire reports is the shard's deposit.
    expect(entA.find((e) => e.id === depositId)?.kind).toBe('deposit');
    expect(entA.find((e) => e.id === depositId)?.pos).toEqual(
      expect.objectContaining({ z: charA.pos.z + 1 }),
    );

    // The successful interact sends NO error to the requester.
    expect(ca.messages.filter((m) => m.type === 'error')).toHaveLength(0);

    // Drain the queues (next() scans the WHOLE buffer, so stale pre-deposit
    // snapshots would otherwise satisfy the "gone" predicate below).
    const drainQuiet = async (c: WsTestClient): Promise<void> => {
      for (;;) {
        try {
          await c.next(() => true, 'drain', 40);
        } catch {
          return; // quiet: the buffer is caught up
        }
      }
    };
    await drainQuiet(ca);
    await drainQuiet(cb);

    // Second tap: 1 → 0 → the deposit is REMOVED. The removal rides the next
    // snapshot: both clients get an entity_update that no longer contains it
    // (the client prompt hides with it).
    ca.send({ v: PROTOCOL_VERSION, type: 'interact', payload: { targetId: depositId } });
    const gone = (m: WsEnvelope): boolean => {
      if (m.type !== 'entity_update') return false;
      return !(m.payload as { entities: WireEntity[] }).entities.some((e) => e.id === depositId);
    };
    await ca.next(gone, 'deposit removed (A)', 10_000);
    await cb.next(gone, 'deposit removed (B)', 10_000);
    expect(shard.entities.has(depositId)).toBe(false);
  });

  it('an out-of-range interact is denied with {code: out-of-range} and nothing changes', async () => {
    const a = await claim('ws-interact-c');
    const ca = mkClient();
    await arriveAtPad(ca, a);
    const charA = await onFoot(ca, a);
    const shard = router.active(PAD.systemId)!.shard;

    // 10 m away: inside the shard, outside the 3 m reach.
    const far = shard.addDepositForTesting(
      { x: charA.pos.x + 10, y: charA.pos.y, z: charA.pos.z },
      5,
    );
    ca.send({
      v: PROTOCOL_VERSION,
      type: 'interact',
      payload: { targetId: far, action: 'pickup' },
    });
    const err = await ca.next((m) => m.type === 'error', 'out-of-range error', 10_000);
    expect(err.payload).toEqual(expect.objectContaining({ code: 'out-of-range' }));
    // The deposit is untouched (the denial is a validation, not an effect).
    expect(shard.entities.get(far)?.quantity).toBe(5);
  });
});
