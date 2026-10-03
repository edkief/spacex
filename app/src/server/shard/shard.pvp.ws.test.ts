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
import { attachWebSocket, createRegistryGateway } from '@server/ws';
import { SystemShard } from '@server/shard';
import { WsTestClient, joinSystem, type WsEnvelope } from '@server/ws-test-client';
import { PROTOCOL_VERSION } from '@shared/protocol';
import { quatFromEuler } from '@shared/physics/vec';
import { generateStars } from '@shared/galaxy/stars';
import { generateSystem } from '@shared/galaxy/system';

/**
 * TASK-47 step 2: the PvP kill scenario over REAL websocket clients.
 *
 * A (interceptor) and B (scout) in the same system, scripted positions via
 * the shard test hooks: A locks B, A's lasers drain B's shields → hull, and
 * A's missile delivers the killing blow. The kill event
 * {killer: A, victim: B, weapon: 'missile'} must broadcast to everyone —
 * the observer C (and the victim B) see the whole exchange, the wreck
 * carries A as the killer (in shard state AND on the 10 Hz snapshot wire),
 * A can then damage C too (friendly fire: no team immunity in v1), and a
 * self-directed fire lands on nothing (TASK-42's self-target denial).
 *
 * The fire + lock intents travel over the wire and are routed through
 * onGameMessage → routeGameMessage — the PRODUCTION dispatcher verbatim
 * (the single 'fire' branch the code-path audit asserts on).
 *
 * Damage math (scout 50 shields / 100 hull, laser 8, missile 25): 7 lasers
 * drop the shields 50→0 (the 7th opens the hull for 6) and 4 missiles drop
 * the hull 94→69→44→19, the fourth detonating (the killing hit has no 'hit'
 * event — only 'destroyed' + 'kill').
 */

const env: Env = {
  PORT: 3001,
  SESSION_SECRET: 'pvp-test-secret',
  GALAXY_SEED: 'pvp-ws-seed-001',
  DB_DRIVER: 'sqlite',
  DB_PATH: './data/drift.db',
  DATABASE_URL: '',
  SYSTEM_INSTANCE_COUNT: 3,
  WS_PATH: '/ws',
  SHARD_FLUSH_INTERVAL_MS: 30000,
};

let dir: string;
let app: FastifyInstance;
let repo: Repository;
let shard: SystemShard;
let wsUrl: string;
let httpUrl: string;
let closeServer: () => Promise<void>;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-pvp-'));
  const { db } = createDb({ driver: 'sqlite', dbPath: path.join(dir, 'pvp.db') });
  repo = createRepo(db, sqliteTables);
  const sessions = createSessionService({
    repo,
    codec: createTokenCodec('pvp-test-secret'),
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
    // PvP test — the rogue AI's own combat traffic would pollute the
    // event-ordering assertions.
    spawnRogues: false,
  });
  shard.start();

  app = buildServer(env);
  registerApiRoutes(app, { repo, sessions, galaxySeed: env.GALAXY_SEED, shipSwapBus: bus });
  const handle = attachWebSocket(app, {
    path: env.WS_PATH,
    gateway: createRegistryGateway(repo),
    authenticate: createTokenAuthenticate(sessions),
    // The PRODUCTION dispatcher (shards.ts routeGameMessage): 'fire' and
    // 'target_lock' intents ride the wire exactly like a browser would send
    // them — no direct shard calls from the test.
    onGameMessage: (conn, type, payload) => routeGameMessage(shard, conn, type, payload),
    onJoinSystem: async (conn, systemId) => {
      if (systemId !== system.systemId || !conn.playerId || !conn.callsign) return;
      // Mirror the router's join order (production path): reserve the slot
      // with the WS conn registered AS the stale-conn source (shard.join
      // alone omits it, and handleFire would drop every frame as stale),
      // then adopt the ship entity.
      shard.registerConnection(
        conn.playerId,
        conn.callsign,
        (buffer) => {
          if (conn.socket.readyState === 1) conn.socket.send(buffer); // WebSocket.OPEN
        },
        conn,
      );
      await shard.adoptEntity(conn.playerId, conn.callsign);
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
  if (res.status !== 201) {
    throw new Error(`claim ${callsign} -> ${res.status}: ${await res.text()}`);
  }
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

type CombatPayload = {
  kind: string;
  target?: string;
  source?: { kind: string; id: string };
  weapon?: string;
  damage?: number;
  shieldHit?: number;
  hullHit?: number;
  killer?: string;
  victim?: string;
};

const combatPayloads = (client: WsTestClient): CombatPayload[] =>
  client.messages.filter(isCombat).map((m) => m.payload as CombatPayload);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll the shard until the predicate holds (20 ms cadence). */
async function waitFor(pred: () => boolean, label: string, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await sleep(20);
  }
}

describe('PvP kill scenario over live ws (TASK-47 step 2)', () => {
  it('A (interceptor) locks B (scout), lasers drain shields→hull, the missile kills B; C observes everything and is damageable in turn', async () => {
    const a = await join('Pvp-Alpha');
    const b = await join('Pvp-Bravo');
    const c = await join('Pvp-Charlie'); // the observer: fires nothing
    c.client.messages.length = 0; // a clean ledger for the exchange

    // Scripted positions (test hooks): A at the anchor, B 60 m ahead on +x,
    // C 60 m off on +y — all deep space (no terrain, no LOS, no pads).
    const POS_A = { x: 60000, y: 60000, z: 0 };
    expect(shard.teleportForTesting(a.playerId, POS_A)).toBe(true);
    expect(shard.teleportForTesting(b.playerId, { x: 60060, y: 60000, z: 0 })).toBe(true);
    expect(shard.teleportForTesting(c.playerId, { x: 60000, y: 60060, z: 0 })).toBe(true);
    await sleep(400); // let the regime machine re-resolve to space
    for (const id of [a.shipId, b.shipId, c.shipId]) {
      expect(shard.entities.get(id)!.ship.regime).toBe('space');
    }
    // A is the INTERCEPTOR (laser + missile): the same test-hook mutation
    // the weapons ws test uses (dock purchases take over via the swap bus;
    // this pins the class directly). B stays the scout starter (50/100).
    const eA = shard.entities.get(a.shipId)!;
    eA.classId = 'interceptor';
    eA.ship.quat = quatFromEuler(Math.PI / 2, 0, 0); // nose +x: B is dead ahead

    // (1) A locks B over the wire ('target_lock' → the server's cone check).
    a.client.send({ v: PROTOCOL_VERSION, type: 'target_lock', payload: { targetId: b.shipId } });
    await waitFor(() => shard.targets.get(a.playerId)?.targetId === b.shipId, 'A lock on B');

    // (2) Seven laser shots (3/s rate respected by 350 ms spacing): shields
    //     50 → 2 after six, the seventh empties them and opens the hull (6).
    for (let i = 0; i < 7; i++) {
      a.client.send({
        v: PROTOCOL_VERSION,
        type: 'fire',
        payload: { weapon: 'laser', targetId: b.shipId },
      });
      await sleep(350);
    }
    await waitFor(
      () =>
        combatPayloads(c.client).filter((e) => e.kind === 'hit' && e.target === b.shipId).length >=
        7,
      '7 laser hits on B at C',
      10_000,
    );
    const eB = shard.entities.get(b.shipId)!;
    expect(eB.shields).toBeCloseTo(0, 9);
    expect(eB.hull).toBeCloseTo(1 - 6 / 100, 9);

    // (3) The missile kills B: 25 per hit (0.5/s cooldown — 2.6 s spacing)
    //     drops the hull 94 → 69 → 44 → 19, the fourth detonating.
    for (let i = 0; i < 4; i++) {
      a.client.send({
        v: PROTOCOL_VERSION,
        type: 'fire',
        payload: { weapon: 'missile', targetId: b.shipId },
      });
      await sleep(2600);
    }
    // Wait WITHOUT consuming (next() splices) — the kill must stay in C's
    // ledger for the full-ordering assertions below.
    await waitFor(
      () => c.client.messages.some((m) => isCombat(m) && m.payload.kind === 'kill'),
      'kill event on C',
      10_000,
    );
    const kill = c.client.messages.find((m) => isCombat(m) && m.payload.kind === 'kill')!;
    expect(kill.payload).toEqual({
      kind: 'kill',
      killer: a.playerId,
      victim: b.shipId,
      weapon: 'missile',
    });

    // (4) C's ledger of the WHOLE exchange: 7 laser hits on B (6 full-
    //     shield + 1 shield-2/hull-6), 3 missile hits, the 'destroyed'
    //     (the killing hit has NO 'hit' event), then the kill. The FX
    //     ledger: 7 laser-fired, 4 missile-fired + 4 missile-impact.
    // (The sim keeps normalized hull/shields, so derived split numbers are
    // compared to 1e-9, never by exact float equality.)
    const events = combatPayloads(c.client);
    const hitsOnB = events.filter((e) => e.kind === 'hit' && e.target === b.shipId);
    expect(hitsOnB).toHaveLength(10);
    for (const hit of hitsOnB.slice(0, 6)) {
      expect(hit).toMatchObject({
        kind: 'hit',
        target: b.shipId,
        source: { kind: 'player', id: a.playerId },
        weapon: 'laser',
        damage: 8,
      });
      expect(hit.shieldHit).toBeCloseTo(8, 9);
      expect(hit.hullHit).toBeCloseTo(0, 9);
    }
    expect(hitsOnB[6]).toMatchObject({
      kind: 'hit',
      target: b.shipId,
      source: { kind: 'player', id: a.playerId },
      weapon: 'laser',
      damage: 8,
    });
    expect(hitsOnB[6].shieldHit).toBeCloseTo(2, 9);
    expect(hitsOnB[6].hullHit).toBeCloseTo(6, 9);
    for (const hit of hitsOnB.slice(7)) {
      expect(hit).toMatchObject({
        kind: 'hit',
        target: b.shipId,
        source: { kind: 'player', id: a.playerId },
        weapon: 'missile',
        damage: 25,
      });
      expect(hit.shieldHit).toBeCloseTo(0, 9);
      expect(hit.hullHit).toBeCloseTo(25, 9);
    }
    expect(events.filter((e) => e.kind === 'destroyed')).toEqual([
      {
        kind: 'destroyed',
        target: b.shipId,
        source: { kind: 'player', id: a.playerId },
        weapon: 'missile',
      },
    ]);
    expect(events.filter((e) => e.kind === 'kill')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'laser-fired')).toHaveLength(7);
    expect(events.filter((e) => e.kind === 'missile-fired')).toHaveLength(4);
    expect(events.filter((e) => e.kind === 'missile-impact')).toHaveLength(4);

    // (5) The victim's OWN connection got the destroyed + the kill.
    const bDestroyed = await b.client.next(
      (m) => isCombat(m) && m.payload.kind === 'destroyed',
      'destroyed event on B',
      5000,
    );
    expect(bDestroyed.payload).toEqual(events.find((e) => e.kind === 'destroyed'));

    // (6) Sim state: B is destroyed (frozen) and the wreck carries A.
    expect(eB.destroyed).toBe(true);
    expect(eB.hull).toBe(0);
    const wreck = shard.entities.get(`wreck:${b.shipId}`)!;
    expect(wreck.killerId).toBe(a.playerId);
    // The wreck + its killer ride the 10 Hz snapshot wire (skull marker,
    // TASK-49 renders it).
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

    // (7) Self-fire is denied (TASK-42): with B dead, a self-directed laser
    //     resolves on NOTHING (no hit, no destroyed — the FX beam alone).
    const selfBefore = combatPayloads(c.client).filter((e) => e.kind === 'hit').length;
    a.client.send({
      v: PROTOCOL_VERSION,
      type: 'fire',
      payload: { weapon: 'laser', targetId: a.shipId },
    });
    await sleep(400);
    expect(combatPayloads(c.client).filter((e) => e.kind === 'hit')).toHaveLength(selfBefore);
    expect(combatPayloads(c.client).filter((e) => e.kind === 'destroyed')).toHaveLength(1);

    // (8) Friendly fire: A can damage C (the third player) too — no team
    //     immunity in v1. One laser at C: 8 shield points, same pipeline.
    a.client.send({
      v: PROTOCOL_VERSION,
      type: 'fire',
      payload: { weapon: 'laser', targetId: c.shipId },
    });
    const cHit = await c.client.next(
      (m) =>
        isCombat(m) &&
        m.payload.kind === 'hit' &&
        (m.payload as { target: string }).target === c.shipId,
      'hit event on C',
      5000,
    );
    expect(cHit.payload).toEqual({
      kind: 'hit',
      target: c.shipId,
      source: { kind: 'player', id: a.playerId },
      weapon: 'laser',
      damage: 8,
      shieldHit: 8,
      hullHit: 0,
    });

    a.client.close();
    b.client.close();
    c.client.close();
  }, 90_000);
});
