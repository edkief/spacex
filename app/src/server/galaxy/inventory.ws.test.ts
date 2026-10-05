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
 * TASK-34 step 4: the inventory over LIVE ws (the interact.ws.test.ts
 * pattern, real server wiring). The AC: "two players, one drops, the other
 * sees the ground item" — a drop spawns a shard entity, so the 10 Hz shared
 * snapshot carries it to every peer within one snapshot; the second player
 * then picks it up PARTIALLY (37 iron → 3 u room = one 3 u crystal), and the
 * quantity change + both players' inventories ride the same snapshots.
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
  SESSION_SECRET: 'inventory-ws-secret',
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-inventory-'));
  const { db } = createDb({ driver: 'sqlite', dbPath: path.join(dir, 'inventory.db') });
  repo = createRepo(db, sqliteTables);
  const sessions = createSessionService({ repo, codec: createTokenCodec('inventory-ws-secret') });
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
  // what routes 'drop' + 'interact' to the shard.
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
  resourceId?: string;
  inventory?: { stacks: Record<string, number>; weightUsed: number };
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

/**
 * Dock + disembark → the player's character entity, as seen on the wire.
 * BOTH players dock at the SAME pad position, so their characters spawn at
 * the same spot (0 m apart — the 3 m reach is trivially satisfied).
 */
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
    (m) =>
      m.type === 'entity_update' &&
      ((m.payload as { entities: WireEntity[] }).entities ?? []).some(
        (e) => e.callsign === player.callsign && e.regime === 'docked',
      ),
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

describe('TASK-34: drop + partial pickup over live ws — two clients see it all', () => {
  it('A drops, BOTH see the ground item; B picks up PARTIALLY (37 u of iron leaves room for one crystal)', async () => {
    const a = await claim('ws-inv-a');
    const b = await claim('ws-inv-b');
    const ca = mkClient();
    const cb = mkClient();
    await arriveAtPad(ca, a);
    await arriveAtPad(cb, b);
    const charA = await onFoot(ca, a);
    const charB = await onFoot(cb, b);
    expect(charB.pos).toEqual(charA.pos); // same pad spot → same character spot

    const shard = router.active(PAD.systemId)!.shard;
    shard.giveInventoryForTesting(a.playerId, { crystal: 2 });
    shard.giveInventoryForTesting(b.playerId, { iron: 37 });

    // A drops 2 crystal (6 u) at their character's position — the client's
    // Q key sends exactly this frame.
    ca.send({ v: PROTOCOL_VERSION, type: 'drop', payload: { resourceId: 'crystal', amount: 2 } });

    // BOTH clients see the ground item appear in the same snapshot stream,
    // with its resource + quantity.
    const seesItem =
      (q: number): ((m: WsEnvelope) => boolean) =>
      (m) =>
        m.type === 'entity_update' &&
        ((m.payload as { entities: WireEntity[] }).entities ?? []).some(
          (e) => e.kind === 'groundItem' && e.resourceId === 'crystal' && e.quantity === q,
        );
    const dropA = await ca.next(seesItem(2), 'groundItem visible (A)', 10_000);
    const dropB = await cb.next(seesItem(2), 'groundItem visible (B)', 10_000);
    const itemA = (dropA.payload as { entities: WireEntity[] }).entities.find(
      (e) => e.kind === 'groundItem',
    )!;
    const itemB = (dropB.payload as { entities: WireEntity[] }).entities.find(
      (e) => e.kind === 'groundItem',
    )!;
    expect(itemA.id).toBe(itemB.id);
    expect(itemA.pos).toEqual(expect.objectContaining(charA.pos)); // at A's feet
    // A's own entity shows the emptied inventory (both ship and character).
    const selfA = (dropA.payload as { entities: WireEntity[] }).entities.find(
      (e) => e.callsign === a.callsign && e.kind === 'character',
    )!;
    // TASK-18: an EMPTY inventory is omitted on the wire (its default is absence).
    expect(selfA.inventory ?? { stacks: {}, weightUsed: 0 }).toEqual({ stacks: {}, weightUsed: 0 });
    expect(ca.messages.filter((m) => m.type === 'error')).toHaveLength(0);

    // B picks up: 37 u of iron leaves 3 u of room = exactly ONE crystal
    // (3 u). The server takes what fits; the remainder stays on the ground.
    cb.send({
      v: PROTOCOL_VERSION,
      type: 'interact',
      payload: { targetId: itemA.id, action: 'pickup' },
    });

    // BOTH clients see the quantity change (2 → 1)…
    const partA = await ca.next(seesItem(1), 'quantity 1 (A)', 10_000);
    await cb.next(seesItem(1), 'quantity 1 (B)', 10_000);
    // …and B's character entity carries the now-full inventory (40/40).
    const selfB = (partA.payload as { entities: WireEntity[] }).entities.find(
      (e) => e.callsign === b.callsign && e.kind === 'character',
    )!;
    expect(selfB.inventory).toEqual({ stacks: { iron: 37, crystal: 1 }, weightUsed: 40 });
    expect(cb.messages.filter((m) => m.type === 'error')).toHaveLength(0);

    // The shard agrees: 1 crystal left on the ground, B at the cap.
    expect(shard.entities.get(itemA.id)?.quantity).toBe(1);
    expect(shard.getInventory(b.playerId)).toEqual({ iron: 37, crystal: 1 });
  });

  it('drop denials over the wire: still in the ship → wrong-regime, nothing spawns', async () => {
    const a = await claim('ws-inv-c');
    const ca = mkClient();
    await arriveAtPad(ca, a);
    const shard = router.active(PAD.systemId)!.shard;
    shard.giveInventoryForTesting(a.playerId, { iron: 1 });
    // The earlier test's leftover item (300 s ttl) may still be in the shard
    // — count-based assertions only.
    const before = [...shard.entities.values()].filter((e) => e.kind === 'groundItem').length;

    // No disembark: the drop is denied with a structured error…
    ca.send({ v: PROTOCOL_VERSION, type: 'drop', payload: { resourceId: 'iron', amount: 1 } });
    const err = await ca.next((m) => m.type === 'error', 'wrong-regime error', 10_000);
    expect(err.payload).toEqual(expect.objectContaining({ code: 'wrong-regime' }));
    // …and no NEW ground item was spawned.
    const after = [...shard.entities.values()].filter((e) => e.kind === 'groundItem').length;
    expect(after).toBe(before);
    // The inventory itself is untouched.
    expect(shard.getInventory(a.playerId)).toEqual({ iron: 1 });
  });
});
