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
 * TASK-35 step 3: re-entry over LIVE ws (the interact.ws.test.ts pattern —
 * real server wiring, the production dispatch surface).
 *
 * AC under test:
 * - disembark → re-enter round trip: the character entity LEAVES the shared
 *   entity_update for EVERY peer (no orphan character), the ship comes back
 *   at the SAME position (the frozen ship never drifted), docked state
 *   kept, and no error reaches the requester;
 * - idempotency: a double enter_ship answers {code:'already-in-ship'};
 * - ownership: player B near player A's ship gets {code:'not-owner'};
 * - moving ship: a ship thrusting > 1 u/s answers {code:'ship-moving'}.
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
  SESSION_SECRET: 'enter-ship-ws-secret',
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-enter-'));
  const { db } = createDb({ driver: 'sqlite', dbPath: path.join(dir, 'enter.db') });
  repo = createRepo(db, sqliteTables);
  const sessions = createSessionService({ repo, codec: createTokenCodec('enter-ship-ws-secret') });
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
  // what routes 'enter_ship' to the shard.
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
 * Dock + disembark → the player's character entity as seen on the wire, and
 * the ship's (frozen, docked) wire position at that moment.
 */
async function onFoot(
  client: WsTestClient,
  player: Claimed,
): Promise<{ char: WireEntity; shipPos: { x: number; y: number; z: number } }> {
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
        (e) => e.callsign === player.callsign && e.regime === 'docked',
      );
    },
    `docked entity_update for ${player.callsign}`,
    15_000,
  );
  const shipPos = (
    (docked.payload as { entities: WireEntity[] }).entities.find(
      (e) => e.callsign === player.callsign && e.kind === 'ship',
    ) ??
    (docked.payload as { entities: WireEntity[] }).entities.find(
      (e) => e.callsign === player.callsign,
    )!
  ).pos;
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
  const char = (upd.payload as { entities: WireEntity[] }).entities.find(
    (e) => e.kind === 'character' && e.callsign === player.callsign,
  )!;
  return { char, shipPos };
}

describe('TASK-35: re-enter the ship over live ws', () => {
  it('disembark → re-enter round trip: no orphan character, ship position consistent, both peers see it', async () => {
    const a = await claim('ws-enter-a');
    const b = await claim('ws-enter-b');
    const ca = mkClient();
    const cb = mkClient();
    await arriveAtPad(ca, a);
    await arriveAtPad(cb, b);

    const { char, shipPos } = await onFoot(ca, a);
    expect(char.onFoot).toBe(true);

    // A re-enters (the client's registry sends exactly this frame).
    ca.send({ v: PROTOCOL_VERSION, type: 'enter_ship', payload: { shipId: a.shipId } });

    // The character LEAVES the shared snapshot for EVERY peer — the removal
    // rides the next 10 Hz entity_update (the broadcast is the shard's job).
    const gone = (m: WsEnvelope, callsign: string): boolean => {
      if (m.type !== 'entity_update') return false;
      return !(m.payload as { entities: WireEntity[] }).entities.some(
        (e) => e.kind === 'character' && e.callsign === callsign,
      );
    };
    // Drain first: next() scans the whole buffer, so stale pre-enter
    // snapshots would otherwise satisfy the "gone" predicate.
    for (const c of [ca, cb]) {
      for (;;) {
        try {
          await c.next(() => true, 'drain', 40);
        } catch {
          break; // quiet: the buffer is caught up
        }
      }
    }
    const upda = await ca.next((m) => gone(m, a.callsign), 'character gone (A)', 10_000);
    await cb.next((m) => gone(m, a.callsign), 'character gone (B)', 10_000);

    // Entity counts are correct: exactly ONE A entity remains (the ship),
    // its position is UNCHANGED (the frozen ship never drifted), docked
    // state kept — and the shard agrees (no orphan character server-side).
    const entities = (upda.payload as { entities: WireEntity[] }).entities;
    const aEntities = entities.filter((e) => e.callsign === a.callsign);
    expect(aEntities).toHaveLength(1);
    expect(aEntities[0].kind).toBe('ship');
    expect(aEntities[0].pos).toEqual(shipPos);
    expect(aEntities[0].regime).toBe('docked');
    const shard = router.active(PAD.systemId)!.shard;
    // Server-side truth: no orphan character for A, exactly one A entity.
    expect(
      [...shard.entities.values()].some((e) => e.kind === 'character' && e.callsign === a.callsign),
    ).toBe(false);
    expect([...shard.entities.values()].filter((e) => e.callsign === a.callsign)).toHaveLength(1);

    // The successful re-entry sends NO error to the requester…
    expect(ca.messages.filter((m) => m.type === 'error')).toHaveLength(0);
    // …and a DOUBLE enter is the idempotent denial: no duplicate state.
    ca.send({ v: PROTOCOL_VERSION, type: 'enter_ship', payload: { shipId: a.shipId } });
    const err = await ca.next((m) => m.type === 'error', 'already-in-ship error', 10_000);
    expect(err.payload).toEqual(expect.objectContaining({ code: 'already-in-ship' }));
    expect([...shard.entities.values()].filter((e) => e.callsign === a.callsign)).toHaveLength(1);
  });

  it("not-owner: player B near player A's ship gets {code: not-owner}", async () => {
    const a = await claim('ws-enter-c');
    const b = await claim('ws-enter-d');
    const ca = mkClient();
    const cb = mkClient();
    await arriveAtPad(ca, a);
    await arriveAtPad(cb, b);

    // BOTH dock at the same pad and BOTH disembark: B's character stands
    // ~2.5 m from A's hull (well inside the 5 m radius) — range is fine,
    // ownership is not.
    await onFoot(ca, a);
    await onFoot(cb, b);

    cb.send({ v: PROTOCOL_VERSION, type: 'enter_ship', payload: { shipId: a.shipId } });
    const err = await cb.next((m) => m.type === 'error', 'not-owner error', 10_000);
    expect(err.payload).toEqual(expect.objectContaining({ code: 'not-owner' }));
    // Nothing moved: A's character still exists, B is still on foot.
    const shard = router.active(PAD.systemId)!.shard;
    const chars = [...shard.entities.values()].filter((e) => e.kind === 'character');
    expect(chars).toHaveLength(2);
    expect(chars.map((c) => c.callsign).sort()).toEqual([a.callsign, b.callsign].sort());
  });

  it('moving ship: thrusting > 1 u/s answers {code: ship-moving}, the character survives', async () => {
    const a = await claim('ws-enter-e');
    const ca = mkClient();
    await arriveAtPad(ca, a);
    const { char } = await onFoot(ca, a);

    // The disembarked ship is normally frozen (velocity 0); force a
    // > 1 u/s drift (the dev teleport sets position + velocity directly) —
    // the "moving ship cannot be boarded" case.
    const shard = router.active(PAD.systemId)!.shard;
    expect(shard.teleportForTesting(a.playerId, char.pos, { x: 0, y: 0, z: 2 })).toBe(true);

    ca.send({ v: PROTOCOL_VERSION, type: 'enter_ship', payload: { shipId: a.shipId } });
    const err = await ca.next((m) => m.type === 'error', 'ship-moving error', 10_000);
    expect(err.payload).toEqual(expect.objectContaining({ code: 'ship-moving' }));
    // Denied: the player is still on foot, the character is still in the sim.
    expect(
      [...shard.entities.values()].some((e) => e.kind === 'character' && e.callsign === a.callsign),
    ).toBe(true);
    expect(shard.entities.get(a.shipId)?.disembarked).toBe(true);
  });
});
