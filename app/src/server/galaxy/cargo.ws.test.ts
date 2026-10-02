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
 * TASK-39 step 4: the cargo hold over LIVE ws (the inventory.ws.test.ts
 * pattern, real server wiring).
 *
 * ACs under test:
 * - transfer round trip: the 'cargo' frame answers 'cargo_open' and every
 *   'cargo_transfer' (the panel re-renders from it); the atomic load moves
 *   inventory → hold and both the frame and the shard agree;
 * - invalid transfers over the wire: insufficient (nothing owned),
 *   not-docked, wrong-regime (still in the ship);
 * - two players can't touch each other's holds: interact 'open-cargo' on
 *   ANOTHER player's ship → {code:'not-owner'}, no 'cargo' frame; each
 *   player's 'cargo_open' carries their OWN (empty) hold;
 * - the warp round trip: load 10 iron, warp A→B, the hold STILL has 10
 *   (the source shard's in-memory hold rides the warp into the target).
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

/** A warp destination: the first seeded system that is NOT the pad's. */
const WARP_DEST = (() => {
  for (const star of generateStars(GALAXY_SEED)) {
    const system = generateSystem(GALAXY_SEED, star.id);
    if (system.systemId !== PAD.systemId) return system.systemId;
  }
  throw new Error('no second system in the seeded galaxy');
})();

const env: Env = {
  PORT: 3002,
  SESSION_SECRET: 'cargo-ws-secret',
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-cargo-'));
  const { db } = createDb({ driver: 'sqlite', dbPath: path.join(dir, 'cargo.db') });
  repo = createRepo(db, sqliteTables);
  const sessions = createSessionService({ repo, codec: createTokenCodec('cargo-ws-secret') });
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

/** Dock + disembark → on foot at the pad (both players share the pad spot). */
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

interface CargoPayload {
  hold: { stacks: Record<string, number>; weightUsed: number; capacity: number };
  inventory?: { stacks: Record<string, number>; weightUsed: number };
}

const send = (c: WsTestClient, type: string, payload: unknown): void =>
  c.send({ v: PROTOCOL_VERSION, type, payload });

async function cargoFrame(c: WsTestClient, what: string): Promise<CargoPayload> {
  const m = await c.next((x) => x.type === 'cargo', what, 10_000);
  return m.payload as CargoPayload;
}

async function errorOf(c: WsTestClient, what: string): Promise<string> {
  const m = await c.next((x) => x.type === 'error', what, 10_000);
  return (m.payload as { code: string }).code;
}

describe('TASK-39: cargo hold over live ws', () => {
  it("transfer round trip + invalid transfers; two players cannot touch each other's holds", async () => {
    const a = await claim('ws-cargo-a');
    const b = await claim('ws-cargo-b');
    const ca = mkClient();
    const cb = mkClient();
    await arriveAtPad(ca, a);
    await arriveAtPad(cb, b);
    await onFoot(ca, a);
    await onFoot(cb, b);
    const shard = router.active(PAD.systemId)!.shard;

    // 1. Open on foot: the 'cargo' frame carries the hold AND the inventory.
    send(ca, 'cargo_open', {});
    let frame = await cargoFrame(ca, 'cargo frame (open, empty)');
    expect(frame.hold).toEqual({ stacks: {}, weightUsed: 0, capacity: 40 });
    expect(frame.inventory).toEqual({ stacks: {}, weightUsed: 0 });

    // 2. Grant ore, open again — the inventory side rides the frame.
    shard.giveInventoryForTesting(a.playerId, { iron: 10 });
    send(ca, 'cargo_open', {});
    frame = await cargoFrame(ca, 'cargo frame (after give)');
    expect(frame.inventory).toEqual({ stacks: { iron: 10 }, weightUsed: 10 });

    // 3. LOAD: 10 iron into the hold — the 'cargo' frame re-renders the
    // panel and the shard state agrees (one atomic move).
    send(ca, 'cargo_transfer', { resourceId: 'iron', amount: 10, from: 'inv' });
    frame = await cargoFrame(ca, 'cargo frame (after load)');
    expect(frame.hold).toEqual({ stacks: { iron: 10 }, weightUsed: 10, capacity: 40 });
    expect(frame.inventory).toEqual({ stacks: {}, weightUsed: 0 });
    expect(shard.entities.get(a.shipId)?.cargo?.stacks).toEqual({ iron: 10 });
    expect(shard.getInventory(a.playerId)).toEqual({});

    // 4. Insufficient: A owns no crystal — nothing moves, structured error.
    send(ca, 'cargo_transfer', { resourceId: 'crystal', amount: 1, from: 'inv' });
    expect(await errorOf(ca, 'insufficient (no crystal owned)')).toBe('insufficient');
    expect(shard.entities.get(a.shipId)?.cargo?.stacks).toEqual({ iron: 10 });

    // 5. Not-docked rung (server-side, like the interact ladder): lift the
    // pad anchor and the transfer is denied before anything is validated.
    const shipA = shard.entities.get(a.shipId)!;
    shipA.padId = undefined;
    send(ca, 'cargo_transfer', { resourceId: 'iron', amount: 1, from: 'hold' });
    expect(await errorOf(ca, 'not-docked denial')).toBe('not-docked');
    shipA.padId = PAD.pad.padId;

    // 6. B tries to open A's hold (B stands at the SAME pad spot — in
    // range): not-owner, and NO 'cargo' frame reaches either connection.
    send(cb, 'interact', { targetId: a.shipId, action: 'open-cargo' });
    expect(await errorOf(cb, 'not-owner denial')).toBe('not-owner');
    send(cb, 'cargo_open', {});
    const bFrame = await cargoFrame(cb, "B opens B's own hold");
    expect(bFrame.hold).toEqual({ stacks: {}, weightUsed: 0, capacity: 40 }); // B's EMPTY hold
    // No 'cargo' frame leaked to A from B's request (frames are per-conn).
    await new Promise((r) => setTimeout(r, 400));
    expect(ca.messages.filter((m) => m.type === 'cargo')).toHaveLength(0);
    expect(shard.entities.get(a.shipId)?.cargo?.stacks).toEqual({ iron: 10 }); // untouched

    // 7. Wrong-regime rung: A re-enters the ship — transfers need the dock.
    send(ca, 'enter_ship', { shipId: a.shipId });
    send(ca, 'cargo_transfer', { resourceId: 'iron', amount: 1, from: 'hold' });
    expect(await errorOf(ca, 'wrong-regime denial')).toBe('wrong-regime');
    expect(shard.entities.get(a.shipId)?.cargo?.stacks).toEqual({ iron: 10 });
  });

  it('warp round trip: load 10 iron, warp A→B, the hold still has 10', async () => {
    const c = await claim('ws-cargo-c');
    const cc = mkClient();
    await arriveAtPad(cc, c);
    await onFoot(cc, c);
    const shard = router.active(PAD.systemId)!.shard;
    shard.giveInventoryForTesting(c.playerId, { iron: 10 });

    // Load it all in, then back into the ship…
    send(cc, 'cargo_transfer', { resourceId: 'iron', amount: 10, from: 'inv' });
    await cargoFrame(cc, 'cargo frame (loaded)');
    send(cc, 'enter_ship', { shipId: c.shipId });

    // …and WARP to the other system. The source shard's in-memory hold must
    // ride the warp (the row may be a flush period stale).
    send(cc, 'warp', { destinationSystemId: WARP_DEST });
    await cc.next((m) => m.type === 'warp_arrived', 'warp_arrived (destination)', 10_000);

    // In the ship (no character): 'cargo_open' answers the hold ONLY…
    send(cc, 'cargo_open', {});
    const frame = await cargoFrame(cc, 'cargo frame (after warp)');
    expect(frame.hold).toEqual({ stacks: { iron: 10 }, weightUsed: 10, capacity: 40 });
    expect(frame.inventory).toBeUndefined();
    // …and the TARGET shard's entity carries it too.
    expect(router.active(WARP_DEST)?.shard.getCargo(c.playerId)?.stacks).toEqual({ iron: 10 });
  });
});
