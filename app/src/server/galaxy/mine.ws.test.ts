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
import { MINING_UNIT_MS } from '@shared/mining';
import { PROTOCOL_VERSION } from '@shared/protocol';
import { createGalaxyRouter } from './router';
import { createRouterGateway } from './gateway';

/**
 * TASK-38 step 4: the mining channel over LIVE ws (real time — the server's
 * 1.5 s cadence is wall-clock here). The anti-spam AC, the weight-cap pause,
 * and two-miner atomicity, each through the real server wiring:
 * - spamming 20 'mine-tick' messages gains nothing — the unit lands on the
 *   server's own tick, exactly one per 1.5 s of channel;
 * - at the 40 u weight cap the channel pauses ('status: full' echo) until
 *   space frees (a drop), then the held award lands;
 * - two miners on ONE unit: the deposit despawns and EXACTLY ONE award
 *   exists across both channels (atomic decrement, no negative remaining).
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
  PORT: 3003,
  SESSION_SECRET: 'mine-ws-secret',
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-mine-'));
  const { db } = createDb({ driver: 'sqlite', dbPath: path.join(dir, 'mine.db') });
  repo = createRepo(db, sqliteTables);
  const sessions = createSessionService({ repo, codec: createTokenCodec('mine-ws-secret') });
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

function interact(client: WsTestClient, targetId: string, action: string): void {
  client.send({ v: PROTOCOL_VERSION, type: 'interact', payload: { targetId, action } });
}

interface MiningFrame {
  phase: 'active' | 'ended';
  depositId: string;
  units: number;
  status?: string;
  reason?: string;
}

const isMiningActive = (m: WsEnvelope): boolean =>
  m.type === 'mining' && (m.payload as MiningFrame).phase === 'active';
const isMiningEnded = (m: WsEnvelope): boolean =>
  m.type === 'mining' && (m.payload as MiningFrame).phase === 'ended';
const quantityOf = (m: WsEnvelope, id: string): number | undefined =>
  m.type === 'entity_update'
    ? ((m.payload as { entities: WireEntity[] }).entities ?? []).find((e) => e.id === id)?.quantity
    : undefined;

/** Wait for the shared snapshot reporting `depositId` at exactly `quantity`. */
async function atQuantity(c: WsTestClient, id: string, quantity: number): Promise<void> {
  await c.next((m) => quantityOf(m, id) === quantity, `quantity ${quantity}`, 10_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('TASK-38: mining channel over live ws', () => {
  it('full channel awards 1 unit on the server tick; cancel (mine-stop) awards nothing further', async () => {
    // Real time: dock + 1.5 s cadence + a further full cadence after the
    // stop — longer than the 5 s default test timeout, hence 30 s.
    const a = await claim('ws-mine-a');
    const ca = mkClient();
    await arriveAtPad(ca, a);
    const charA = await onFoot(ca, a);
    const shard = router.active(PAD.systemId)!.shard;
    const depositId = shard.addDepositForTesting(
      { x: charA.pos.x, y: charA.pos.y, z: charA.pos.z + 1 },
      3,
    );

    interact(ca, depositId, 'mine-start');
    const start = await ca.next(isMiningActive, 'mining active (A)', 10_000);
    expect(start.payload).toEqual(
      expect.objectContaining({ phase: 'active', depositId, units: 0, status: 'mining' }),
    );

    // The unit lands on the server's own 1.5 s tick (real time here).
    await atQuantity(ca, depositId, 2);

    interact(ca, depositId, 'mine-stop');
    const stop = await ca.next(isMiningEnded, 'mining ended (A)', 10_000);
    expect(stop.payload).toEqual(
      expect.objectContaining({ phase: 'ended', depositId, reason: 'stopped', units: 1 }),
    );

    // A FULL further cadence after the stop: the dead channel awards nothing.
    await sleep(MINING_UNIT_MS + 600);
    expect(shard.entities.get(depositId)?.quantity).toBe(2);
    expect(ca.messages.filter((m) => m.type === 'error')).toHaveLength(0);
  }, 30_000);

  it("spam: 20 'mine-tick' messages in ~1 s gain nothing — exactly 1 unit per full channel", async () => {
    const a = await claim('ws-mine-spam');
    const ca = mkClient();
    await arriveAtPad(ca, a);
    const charA = await onFoot(ca, a);
    const shard = router.active(PAD.systemId)!.shard;
    const depositId = shard.addDepositForTesting(
      { x: charA.pos.x, y: charA.pos.y, z: charA.pos.z + 1 },
      5,
    );

    interact(ca, depositId, 'mine-start');
    await ca.next(isMiningActive, 'mining active (A)', 10_000);
    // The spam burst: 20 re-assertions in well under 1 s of wall clock.
    for (let i = 0; i < 20; i++) interact(ca, depositId, 'mine-tick');

    // The first unit still lands exactly on the server's 1.5 s tick…
    await atQuantity(ca, depositId, 4);
    // …and a SECOND burst cannot pull the next one forward: +0.8 s later
    // (well under the next 1.5 s cadence) the quantity is unchanged.
    for (let i = 0; i < 20; i++) interact(ca, depositId, 'mine-tick');
    await sleep(800);
    expect(shard.entities.get(depositId)?.quantity).toBe(4);

    interact(ca, depositId, 'mine-stop');
    const stop = await ca.next(isMiningEnded, 'mining ended (A)', 10_000);
    expect(stop.payload).toEqual(
      expect.objectContaining({ phase: 'ended', depositId, reason: 'stopped', units: 1 }),
    );
  }, 30_000);

  it('weight cap: the channel pauses (status full) until space frees, then the award lands', async () => {
    const a = await claim('ws-mine-full');
    const ca = mkClient();
    await arriveAtPad(ca, a);
    const charA = await onFoot(ca, a);
    const shard = router.active(PAD.systemId)!.shard;
    const depositId = shard.addDepositForTesting(
      { x: charA.pos.x, y: charA.pos.y, z: charA.pos.z + 1 },
      5,
    );
    // 40/40 u: iron at 1 u each — the backpack is exactly full.
    shard.giveInventoryForTesting(a.playerId, { iron: 40 });

    interact(ca, depositId, 'mine-start');
    await ca.next(isMiningActive, 'mining active (A)', 10_000);
    // At the cadence the award is HELD: the 10 Hz echo flips to 'full'.
    await ca.next(
      (m) =>
        m.type === 'mining' &&
        (m.payload as MiningFrame).phase === 'active' &&
        (m.payload as MiningFrame).status === 'full',
      "status 'full' echo",
      10_000,
    );
    expect(shard.entities.get(depositId)?.quantity).toBe(5); // nothing awarded

    // Free 1 u: drop one iron at the character → the held award lands.
    ca.send({ v: PROTOCOL_VERSION, type: 'drop', payload: { resourceId: 'iron', amount: 1 } });
    await atQuantity(ca, depositId, 4);

    interact(ca, depositId, 'mine-stop');
    const stop = await ca.next(isMiningEnded, 'mining ended (A)', 10_000);
    expect(stop.payload).toEqual(
      expect.objectContaining({ phase: 'ended', depositId, reason: 'stopped', units: 1 }),
    );
  }, 30_000);

  it('two miners, one unit: the deposit despawns and exactly ONE award exists across both', async () => {
    const a = await claim('ws-mine-2a');
    const b = await claim('ws-mine-2b');
    const ca = mkClient();
    const cb = mkClient();
    await arriveAtPad(ca, a);
    await arriveAtPad(cb, b);
    const charA = await onFoot(ca, a);
    const charB = await onFoot(cb, b);
    const shard = router.active(PAD.systemId)!.shard;

    // The single-unit deposit sits in front of A; B disembarked on the same
    // pad, so both characters are inside the 3 m reach of it.
    const depositId = shard.addDepositForTesting(
      { x: charA.pos.x, y: charA.pos.y, z: charA.pos.z + 1 },
      1,
    );
    const dist = Math.hypot(
      charB.pos.x - charA.pos.x,
      charB.pos.y - charA.pos.y,
      charB.pos.z - (charA.pos.z + 1),
    );
    expect(dist, 'B must be within the 3 m reach of the deposit').toBeLessThanOrEqual(3);

    // Both clients must first see the deposit exist…
    const hasDep = (m: WsEnvelope): boolean =>
      m.type === 'entity_update' &&
      ((m.payload as { entities: WireEntity[] }).entities ?? []).some((e) => e.id === depositId);
    await ca.next(hasDep, 'deposit visible (A)', 10_000);
    await cb.next(hasDep, 'deposit visible (B)', 10_000);
    // …then drain: next() scans the WHOLE buffer, so stale pre-deposit
    // snapshots would otherwise satisfy the "gone" predicate below.
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

    interact(ca, depositId, 'mine-start');
    interact(cb, depositId, 'mine-start');
    await ca.next(isMiningActive, 'mining active (A)', 10_000);
    await cb.next(isMiningActive, 'mining active (B)', 10_000);

    // The unit lands once; the deposit despawns for BOTH (shared snapshot)…
    const gone = (m: WsEnvelope): boolean =>
      m.type === 'entity_update' &&
      !((m.payload as { entities: WireEntity[] }).entities ?? []).some((e) => e.id === depositId);
    await ca.next(gone, 'deposit removed (A)', 10_000);
    await cb.next(gone, 'deposit removed (B)', 10_000);

    // …and across both channels EXACTLY one unit was awarded, both ending
    // 'depleted' (the loser's channel dies on the despawn with 0 units).
    const endA = (await ca.next(isMiningEnded, 'mining ended (A)', 10_000)).payload as MiningFrame;
    const endB = (await cb.next(isMiningEnded, 'mining ended (B)', 10_000)).payload as MiningFrame;
    expect(endA.reason).toBe('depleted');
    expect(endB.reason).toBe('depleted');
    expect(endA.units + endB.units).toBe(1);
    expect(shard.entities.has(depositId)).toBe(false);
  }, 30_000);
});
