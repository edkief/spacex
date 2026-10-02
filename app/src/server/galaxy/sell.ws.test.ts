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
import { WsTestClient } from '@server/ws-test-client';
import { generateStars } from '@shared/galaxy/stars';
import { generateSystem } from '@shared/galaxy/system';
import { padsForSystem } from '@shared/world/pads';
import { PROTOCOL_VERSION } from '@shared/protocol';
import { createGalaxyRouter } from './router';
import { createRouterGateway } from './gateway';

/**
 * TASK-40 step 4: the dock sell over LIVE ws + REST (the cargo.ws.test.ts
 * pattern, real server wiring). THE money test for the core economy:
 * - the FULL LOOP: mine 10 iron (fake) → load into the hold → sell at the
 *   dock → credits 500 + 10×5 = 550, through BOTH surfaces (the WS 'sell'
 *   frame and POST /api/ships/sell — the SAME handler);
 * - the 'sell' result frame carries the NEW stacks + balance (the dock panel
 *   re-renders, the counter updates within one frame);
 * - error codes over the wire + over REST: not-docked (the ship is moving),
 *   not-at-station (on-foot 'inv' sell far from a terminal), insufficient,
 *   unknown resource (REST 400).
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
  SESSION_SECRET: 'sell-ws-secret',
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-sell-'));
  const { db } = createDb({ driver: 'sqlite', dbPath: path.join(dir, 'sell.db') });
  repo = createRepo(db, sqliteTables);
  const sessions = createSessionService({ repo, codec: createTokenCodec('sell-ws-secret') });
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

/** The player's persisted credit balance (the DB row, post-flush). */
async function creditsOf(callsign: string): Promise<number> {
  const p = await repo.findPlayerByCallsign(callsign);
  return p?.credits ?? -1;
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

/** Dock + disembark → on foot at the pad (the ship stays docked on the pad). */
async function onFoot(client: WsTestClient, player: Claimed): Promise<void> {
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
    (m) =>
      m.type === 'entity_update' &&
      ((m.payload as { entities: WireEntity[] }).entities ?? []).some(
        (e) => e.callsign === player.callsign && e.regime === 'docked',
      ),
    `docked entity_update for ${player.callsign}`,
    15_000,
  );
  client.send({ v: PROTOCOL_VERSION, type: 'exit_ship', payload: { shipId: player.shipId } });
  await client.next(
    (m) =>
      m.type === 'entity_update' &&
      ((m.payload as { entities: WireEntity[] }).entities ?? []).some(
        (e) => e.kind === 'character' && e.callsign === player.callsign,
      ),
    `character entity_update for ${player.callsign}`,
    10_000,
  );
}

const send = (c: WsTestClient, type: string, payload: unknown): void =>
  c.send({ v: PROTOCOL_VERSION, type, payload });

interface SellFrame {
  resourceId: string;
  sold: number;
  earned: number;
  balance: number;
  hold: { stacks: Record<string, number>; weightUsed: number; capacity: number };
  inventory: { stacks: Record<string, number>; weightUsed: number };
}

async function sellFrame(c: WsTestClient, what: string): Promise<SellFrame> {
  const m = await c.next((x) => x.type === 'sell' && (x.payload as SellFrame).sold !== undefined, what, 10_000);
  return m.payload as SellFrame;
}

async function errorOf(c: WsTestClient, what: string): Promise<string> {
  const m = await c.next((x) => x.type === 'error', what, 10_000);
  return (m.payload as { code: string }).code;
}

describe('TASK-40: dock sell — the full resource loop', () => {
  it('WS: mine 10 iron → load the hold → sell → credits 500 + 10×5 = 550 (result frame carries the new stacks + balance)', async () => {
    const a = await claim('ws-sell-a');
    const ca = mkClient();
    await arriveAtPad(ca, a);
    await onFoot(ca, a);
    const shard = router.active(PAD.systemId)!.shard;
    // Start at the default 500 credits.
    expect(await creditsOf(a.callsign)).toBe(500);

    // 1. Mine 10 iron (fake) → the on-foot inventory.
    shard.giveInventoryForTesting(a.playerId, { iron: 10 });
    // 2. Load it ALL into the cargo hold (the haul leg).
    send(ca, 'cargo_transfer', { resourceId: 'iron', amount: 10, from: 'inv' });
    await ca.next((x) => x.type === 'cargo', 'cargo frame (after load)', 10_000);
    expect(shard.getCargo(a.playerId)?.stacks).toEqual({ iron: 10 });

    // 3. SELL the full hold at the dock (the ship is docked on the pad).
    send(ca, 'sell', { resourceId: 'iron', amount: 10, source: 'hold' });
    const frame = await sellFrame(ca, 'sell result frame');
    expect(frame.resourceId).toBe('iron');
    expect(frame.sold).toBe(10);
    expect(frame.earned).toBe(50); // 10 × 5
    expect(frame.balance).toBe(550); // 500 + 50 — the money
    expect(frame.hold).toEqual({ stacks: {}, weightUsed: 0, capacity: 40 }); // drained
    // The shard + the DB agree.
    expect(shard.getCargo(a.playerId)?.stacks).toEqual({});
    expect(await creditsOf(a.callsign)).toBe(550);
  });

  it('REST: the SAME full loop through POST /api/ships/sell → {sold, earned, newBalance}', async () => {
    const b = await claim('ws-sell-b');
    const cb = mkClient();
    await arriveAtPad(cb, b);
    await onFoot(cb, b);
    const shard = router.active(PAD.systemId)!.shard;
    shard.giveInventoryForTesting(b.playerId, { iron: 10 });
    send(cb, 'cargo_transfer', { resourceId: 'iron', amount: 10, from: 'inv' });
    await cb.next((x) => x.type === 'cargo', 'cargo frame (after load)', 10_000);
    expect(shard.getCargo(b.playerId)?.stacks).toEqual({ iron: 10 });

    const res = await fetch(`${httpUrl}/api/ships/sell`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${b.token}` },
      body: JSON.stringify({ resourceId: 'iron', amount: 10, source: 'hold' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sold: number; earned: number; newBalance: number };
    expect(body).toEqual({ sold: 10, earned: 50, newBalance: 550 });
    expect(shard.getCargo(b.playerId)?.stacks).toEqual({});
    expect(await creditsOf(b.callsign)).toBe(550);
  });

  it('WS errors: not-docked (ship moving) → not-at-station (inv, far from terminal) → insufficient', async () => {
    const c = await claim('ws-sell-c');
    const cc = mkClient();
    await arriveAtPad(cc, c);
    // Do NOT dock: the ship is still moving (undocked) in the pad system.
    const shard = router.active(PAD.systemId)!.shard;
    shard.giveInventoryForTesting(c.playerId, { iron: 10 });

    // Not docked → the sell is denied before anything else (either source).
    send(cc, 'sell', { resourceId: 'iron', amount: 1, source: 'hold' });
    expect(await errorOf(cc, 'not-docked (moving ship)')).toBe('not-docked');
  });

  it('on foot far from a terminal: an "inv" sell is not-at-station (10 m reach)', async () => {
    const d = await claim('ws-sell-d');
    const cd = mkClient();
    await arriveAtPad(cd, d);
    await onFoot(cd, d);
    const shard = router.active(PAD.systemId)!.shard;
    shard.giveInventoryForTesting(d.playerId, { iron: 10 });
    // The disembark spawn is ~2.5 m from the pad center, the terminal is 18 m
    // out — the on-foot character is far beyond the 10 m sell range.
    send(cd, 'sell', { resourceId: 'iron', amount: 1, source: 'inv' });
    expect(await errorOf(cd, 'not-at-station (far from terminal)')).toBe('not-at-station');
    expect(shard.getInventory(d.playerId)).toEqual({ iron: 10 }); // untouched
  });

  it('insufficient: selling more than the source holds is denied (WS + REST)', async () => {
    const e = await claim('ws-sell-e');
    const ce = mkClient();
    await arriveAtPad(ce, e);
    await onFoot(ce, e);
    const shard = router.active(PAD.systemId)!.shard;
    shard.giveInventoryForTesting(e.playerId, { iron: 2 });
    send(ce, 'cargo_transfer', { resourceId: 'iron', amount: 2, from: 'inv' });
    await ce.next((x) => x.type === 'cargo', 'cargo frame (after load)', 10_000);

    // WS: ask for 10 but only 2 are in the hold.
    send(ce, 'sell', { resourceId: 'iron', amount: 10, source: 'hold' });
    expect(await errorOf(ce, 'insufficient (WS)')).toBe('insufficient');
    // REST: the same denial maps to a 422.
    const res = await fetch(`${httpUrl}/api/ships/sell`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${e.token}` },
      body: JSON.stringify({ resourceId: 'iron', amount: 10, source: 'hold' }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('insufficient');
    expect(shard.getCargo(e.playerId)?.stacks).toEqual({ iron: 2 }); // untouched
  });

  it('REST: unknown resource → 400; invalid body → 400', async () => {
    const f = await claim('ws-sell-f');
    const cf = mkClient();
    await arriveAtPad(cf, f);
    await onFoot(cf, f);
    router.active(PAD.systemId)!.shard.giveInventoryForTesting(f.playerId, { iron: 10 });
    send(cf, 'cargo_transfer', { resourceId: 'iron', amount: 10, from: 'inv' });
    await cf.next((x) => x.type === 'cargo', 'cargo frame (after load)', 10_000);

    const bad = await fetch(`${httpUrl}/api/ships/sell`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${f.token}` },
      body: JSON.stringify({ resourceId: 'plutonium', amount: 1, source: 'hold' }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe('unknown-resource');

    const invalid = await fetch(`${httpUrl}/api/ships/sell`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${f.token}` },
      body: JSON.stringify({ resourceId: 'iron', amount: 0, source: 'hold' }),
    });
    expect(invalid.status).toBe(400);
  });
});
