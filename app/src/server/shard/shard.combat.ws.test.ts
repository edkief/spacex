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
import { WsTestClient, joinSystem, type WsEnvelope } from '@server/ws-test-client';
import type { WeaponSpec } from '@shared/weapons';
import { generateStars } from '@shared/galaxy/stars';
import { generateSystem } from '@shared/galaxy/system';

/**
 * Combat core integration (TASK-42 step 4): THREE real ws clients in a live
 * shard. Two ships trade hits through the sim's contact-callback path
 * (handleWeaponContact — the same call TASK-43's projectiles make on
 * contact); the THIRD client, which fires nothing, must observe the exact
 * 'hit' payloads, the 'destroyed' event, and the 'kill' event (a player
 * source destroyed a player).
 */

const env: Env = {
  PORT: 3001,
  SESSION_SECRET: 'combat-test-secret',
  GALAXY_SEED: 'combat-ws-seed-001',
  DB_DRIVER: 'sqlite',
  DB_PATH: './data/drift.db',
  DATABASE_URL: '',
  SYSTEM_INSTANCE_COUNT: 3,
  WS_PATH: '/ws',
  SHARD_FLUSH_INTERVAL_MS: 30000,
};

const LASER: WeaponSpec = { id: 'laser', damage: 30, range: 2000 };

let dir: string;
let app: FastifyInstance;
let repo: Repository;
let shard: SystemShard;
let wsUrl: string;
let httpUrl: string;
let closeServer: () => Promise<void>;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-combat-'));
  const { db } = createDb({ driver: 'sqlite', dbPath: path.join(dir, 'combat.db') });
  repo = createRepo(db, sqliteTables);
  const sessions = createSessionService({
    repo,
    codec: createTokenCodec('combat-test-secret'),
  });
  const bus = createShipSwapBus();

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
    onGameMessage: () => {
      /* combat has no inbound traffic: fire intents (TASK-43) only */
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

async function join(callsign: string): Promise<{
  client: WsTestClient;
  playerId: string;
  shipId: string;
}> {
  const p = await claim(callsign);
  const client = new WsTestClient(wsUrl);
  await joinSystem(client, p.token, shard.systemId);
  for (
    let i = 0;
    i < 100 && ![...shard.entities.values()].some((e) => e.playerId === p.playerId);
    i++
  ) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const entity = [...shard.entities.values()].find((e) => e.playerId === p.playerId);
  expect(entity).toBeDefined();
  return { client, playerId: p.playerId, shipId: p.shipId };
}

function isCombat(m: WsEnvelope): m is WsEnvelope & { payload: Record<string, unknown> } {
  return m.type === 'combat_event' && typeof m.payload === 'object' && m.payload !== null;
}

/** Deep-space anchor points (60 km from the system: no terrain, no pads). */
const POS_A = { x: 60000, y: 60000, z: 0 };
const POS_B = { x: 60060, y: 60000, z: 0 };

describe('combat over live ws (TASK-42 step 4)', () => {
  it('two ships trade hits via the sim; a third client observes the hits, the destroyed, and the kill', async () => {
    const a = await join('Combat-Alpha');
    const b = await join('Combat-Bravo');
    const c = await join('Combat-Charlie'); // the observer: fires nothing

    // Park both fighters in open space, 60 m apart, and let the regime
    // machine re-resolve (docked surface → space) on the next ticks.
    expect(shard.teleportForTesting(a.playerId, POS_A)).toBe(true);
    expect(shard.teleportForTesting(b.playerId, POS_B)).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    const eA = shard.entities.get(a.shipId)!;
    const eB = shard.entities.get(b.shipId)!;
    expect(eA.ship.regime).toBe('space');
    expect(eB.ship.regime).toBe('space');

    // The sim's contact-callback path (TASK-43's projectiles call exactly
    // this): A and B trade 30-point laser hits…
    const fire = (src: string, tgt: string, point: { x: number; y: number; z: number }) =>
      shard.handleWeaponContact(LASER, src, tgt, point);
    expect(fire(a.shipId, b.shipId, POS_B)).toMatchObject({ ok: true, shieldHit: 30 });
    expect(fire(b.shipId, a.shipId, POS_A)).toMatchObject({ ok: true, shieldHit: 30 });
    expect(fire(a.shipId, b.shipId, POS_B)).toMatchObject({ ok: true, shieldHit: 20, hullHit: 10 });
    expect(fire(b.shipId, a.shipId, POS_A)).toMatchObject({ ok: true, shieldHit: 20, hullHit: 10 });
    // …and A finishes B: shields 0, hull 60 → 30 → 0 (the killing hit).
    expect(fire(a.shipId, b.shipId, POS_B)).toMatchObject({ ok: true, shieldHit: 0, hullHit: 30 });
    expect(fire(a.shipId, b.shipId, POS_B)).toMatchObject({ ok: true, shieldHit: 0, hullHit: 30 });
    expect(fire(a.shipId, b.shipId, POS_B)).toMatchObject({
      ok: true,
      shieldHit: 0,
      hullHit: 30,
      destroyed: true,
    });

    // The THIRD client saw the whole exchange in order (same socket). The
    // 'kill' frame is last — everything before it is already buffered.
    const kill = await c.client.next(
      (m) => isCombat(m) && m.payload.kind === 'kill',
      'kill event',
      5000,
    );
    expect(kill.payload).toEqual({
      kind: 'kill',
      killer: a.playerId,
      victim: b.shipId,
      weapon: 'laser',
    });
    const cEvents = c.client.messages.filter(isCombat).map((m) => m.payload);
    // 4 'hit' events on B (the 5th shot was the killing one → 'destroyed').
    const hitsOnB = cEvents.filter((e) => e.kind === 'hit' && e.target === b.shipId);
    const hitsOnA = cEvents.filter((e) => e.kind === 'hit' && e.target === a.shipId);
    expect(hitsOnB).toHaveLength(4);
    expect(hitsOnB[0]).toEqual({
      kind: 'hit',
      target: b.shipId,
      source: { kind: 'player', id: a.playerId },
      weapon: 'laser',
      damage: 30,
      shieldHit: 30,
      hullHit: 0,
    });
    expect(hitsOnB[1]).toMatchObject({ shieldHit: 20, hullHit: 10 });
    expect(hitsOnB[2]).toMatchObject({ shieldHit: 0, hullHit: 30 });
    expect(hitsOnB[3]).toMatchObject({ shieldHit: 0, hullHit: 30 });
    expect(hitsOnA).toHaveLength(2);
    expect(hitsOnA[0]).toEqual({
      kind: 'hit',
      target: a.shipId,
      source: { kind: 'player', id: b.playerId },
      weapon: 'laser',
      damage: 30,
      shieldHit: 30,
      hullHit: 0,
    });
    // The killing hit has NO 'hit' event — only 'destroyed' (+ the 'kill').
    const cDestroyed = cEvents.filter((e) => e.kind === 'destroyed');
    expect(cDestroyed).toEqual([
      {
        kind: 'destroyed',
        target: b.shipId,
        source: { kind: 'player', id: a.playerId },
        weapon: 'laser',
      },
    ]);

    // The victim's own connection got the destroyed event too…
    const bDestroyed = await b.client.next(
      (m) => isCombat(m) && m.payload.kind === 'destroyed',
      'destroyed event',
      5000,
    );
    expect(bDestroyed.payload).toEqual(cDestroyed[0]);

    // …the sim state matches (frozen dead ship + wreck with its killer),
    // and the wreck's killer rides the 10 Hz snapshot wire (skull marker
    // for TASK-49).
    expect(eB.destroyed).toBe(true);
    expect(eB.hull).toBe(0);
    const wreck = shard.entities.get(`wreck:${b.shipId}`)!;
    expect(wreck.killerId).toBe(a.playerId);
    // 10 Hz snapshots: skip any still buffered from before the wreck
    // existed, then the wreck + its killer must ride the wire.
    let wireWreck: { id: string; killerId?: string } | undefined;
    const deadline = Date.now() + 5000;
    while (!wireWreck && Date.now() < deadline) {
      const snap = await c.client.next(
        (m) => m.type === 'entity_update',
        'entity_update with wreck',
        2500,
      );
      const entities = (snap.payload as { entities: Array<{ id: string; killerId?: string }> })
        .entities;
      wireWreck = entities.find((e) => e.id === `wreck:${b.shipId}`);
    }
    expect(wireWreck).toBeDefined();
    expect(wireWreck!.killerId).toBe(a.playerId);

    // A hit on the now-dead ship is refused (dead targets are not targetable).
    expect(fire(a.shipId, b.shipId, POS_B)).toEqual({ ok: false, code: 'dead-target' });

    a.client.close();
    b.client.close();
    c.client.close();
  }, 20000);
});
