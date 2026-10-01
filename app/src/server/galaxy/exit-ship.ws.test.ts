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
import { characterSpawnPos } from '@shared/physics/character';
import { PROTOCOL_VERSION } from '@shared/protocol';
import { createGalaxyRouter } from './router';
import { createRouterGateway } from './gateway';

/**
 * TASK-31 step 4: disembark over LIVE ws (real server wiring, the
 * warp.ws.test.ts pattern). The seed is the canonical DRIFT-SEED-0001 (the
 * e2e-proven galaxy that hosts a landable atmospheric pad).
 *
 * Contracts under test (server-authoritative, wire level):
 * - exit_ship on a PAD-docked ship → a 'character' entity appears at
 *   ship.pos + 2.5 m side offset on the pad plane (± 0.5 m per the AC),
 *   the ship STAYS docked in the same snapshot, and NO error is sent;
 * - TWO clients in the system see the EXACT same character position (the
 *   10 Hz snapshot is one shared buffer);
 * - denial: a non-docked ship → {code:'not-docked'} and no character entity.
 */

const GALAXY_SEED = 'DRIFT-SEED-0001';

/** The deterministic pad target (first star-order system with a landable atmo planet). */
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
  SESSION_SECRET: 'exit-ship-ws-secret',
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-exit-'));
  const { db } = createDb({ driver: 'sqlite', dbPath: path.join(dir, 'exit.db') });
  repo = createRepo(db, sqliteTables);
  const sessions = createSessionService({ repo, codec: createTokenCodec('exit-ship-ws-secret') });
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
  // The production dispatch surface (index.ts uses the SAME helper): this
  // is what routes 'exit_ship' to the shard.
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
  rot?: { x: number; y: number; z: number; w: number };
  regime: string;
  padId?: string;
  callsign?: string;
  playerId?: string;
  onFoot?: boolean;
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
    const arrived = await client.next(
      (m) => m.type === 'warp_arrived',
      'warp_arrived (pad system)',
      10_000,
    );
    expect((arrived.payload as { systemId: string }).systemId).toBe(PAD.systemId);
  }
}

/** Dock the player's ship on the pad (dev teleport + the real pad machine). */
async function dockShip(client: WsTestClient, player: Claimed): Promise<WireEntity> {
  const shard = router.active(PAD.systemId)?.shard;
  expect(shard, `shard for ${PAD.systemId} must be active`).toBeDefined();
  expect(
    shard!.teleportForTesting(player.playerId, {
      x: PAD.pad.pos.x,
      y: PAD.pad.pos.y + 5,
      z: PAD.pad.pos.z,
    }),
  ).toBe(true);
  const docked = await client.next(
    (m) => {
      if (m.type !== 'entity_update') return false;
      return ((m.payload as { entities: WireEntity[] }).entities ?? []).some(
        (e) => e.callsign === player.callsign && e.regime === 'docked' && e.padId === PAD.pad.padId,
      );
    },
    `docked entity_update for ${player.callsign}`,
    15_000,
  );
  const entities = (docked.payload as { entities: WireEntity[] }).entities;
  return entities.find((e) => e.callsign === player.callsign)!;
}

const errorsFor = (client: WsTestClient): { code: string; message: string }[] =>
  client.messages
    .filter((m) => m.type === 'error')
    .map((m) => m.payload as { code: string; message: string });

describe('TASK-31: disembark over live ws', () => {
  it('docked: character at ship pos + side offset (± 0.5 m), ship stays docked, two clients agree', async () => {
    const a = await claim('ws-exit-a');
    const b = await claim('ws-exit-b');
    const ca = mkClient();
    const cb = mkClient();
    await arriveAtPad(ca, a);
    await arriveAtPad(cb, b);

    const ship = await dockShip(ca, a);
    // Expected spawn from the SHARED math on the last wire state.
    const expected = characterSpawnPos(
      ship.pos,
      ship.rot ?? { x: 0, y: 0, z: 0, w: 1 },
      PAD.pad.pos.y,
    );

    ca.send({ v: PROTOCOL_VERSION, type: 'exit_ship', payload: { shipId: a.shipId } });

    // BOTH clients see the character appear (the snapshot is one shared buffer).
    const charPred = (m: WsEnvelope) =>
      m.type === 'entity_update' &&
      ((m.payload as { entities: WireEntity[] }).entities ?? []).some(
        (e) => e.kind === 'character' && e.callsign === a.callsign,
      );
    const updA = await ca.next(charPred, 'character entity_update (A)', 10_000);
    const updB = await cb.next(charPred, 'character entity_update (B)', 10_000);
    const entA = (updA.payload as { entities: WireEntity[] }).entities;
    const entB = (updB.payload as { entities: WireEntity[] }).entities;
    const charA = entA.find((e) => e.kind === 'character' && e.callsign === a.callsign)!;
    const charB = entB.find((e) => e.kind === 'character' && e.callsign === a.callsign)!;

    // The spawn: within 0.5 m of the shared-math position (per the AC).
    expect(Math.abs(charA.pos.x - expected.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(charA.pos.y - expected.y)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(charA.pos.z - expected.z)).toBeLessThanOrEqual(0.5);
    // Standing on the pad plane.
    expect(charA.pos.y).toBeCloseTo(PAD.pad.pos.y, 3);
    // Character wire shape: owner + on foot.
    expect(charA.playerId).toBe(a.playerId);
    expect(charA.onFoot).toBe(true);

    // The SHIP stays docked in the SAME snapshot batch.
    const shipA = entA.find((e) => e.kind === 'ship' && e.callsign === a.callsign)!;
    expect(shipA.regime).toBe('docked');
    expect(shipA.padId).toBe(PAD.pad.padId);

    // Multi-client agreement: the two clients see the SAME character position.
    expect(charB.pos).toEqual(charA.pos);
    expect(charB.id).toBe(charA.id);

    // No denials on the success path.
    expect(errorsFor(ca)).toHaveLength(0);
    expect(errorsFor(cb)).toHaveLength(0);
  });

  it('denied when not docked: {code: not-docked}, no character entity ever appears', async () => {
    const a = await claim('ws-exit-c');
    const ca = mkClient();
    await arriveAtPad(ca, a);
    // The ship is at the spawn gate: in flight, never docked.
    await ca.next(
      (m) =>
        m.type === 'entity_update' &&
        ((m.payload as { entities: WireEntity[] }).entities ?? []).some(
          (e) => e.callsign === a.callsign && e.regime !== 'docked',
        ),
      'self entity_update (in flight)',
      10_000,
    );

    ca.send({ v: PROTOCOL_VERSION, type: 'exit_ship', payload: { shipId: a.shipId } });
    const err = await ca.next((m) => m.type === 'error', 'not-docked error', 5000);
    expect((err.payload as { code: string }).code).toBe('not-docked');

    // A few more snapshot batches: still no character for this player.
    await ca.next((m) => m.type === 'entity_update', 'follow-up entity_update', 5000);
    await ca.next((m) => m.type === 'entity_update', 'follow-up entity_update 2', 5000);
    for (const m of ca.messages) {
      if (m.type !== 'entity_update') continue;
      const entities = (m.payload as { entities: WireEntity[] }).entities ?? [];
      expect(entities.some((e) => e.kind === 'character' && e.callsign === a.callsign)).toBe(false);
    }
  });
});
