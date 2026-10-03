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
import { generateStars } from '@shared/galaxy/stars';
import { generateSystem } from '@shared/galaxy/system';
import type { SystemGen } from '@shared/galaxy/types';
import { padsForSystem } from '@shared/world/pads';
import { terminalsFor } from '@shared/world/terminals';
import { sellUnitPrice } from '@shared/sell';
import { SHIP_CLASSES } from '@shared/ships';
import { PROTOCOL_VERSION } from '@shared/protocol';
import { createGalaxyRouter } from '@server/galaxy/router';
import { createRouterGateway } from '@server/galaxy/gateway';
import { RawClient, nestedPayload } from './rawClient';
import type { Vec3 } from '@shared/physics/vec';

/**
 * TASK-67: the cheat scenarios. A scripted "cheater" (RawClient — raw ws, no
 * game logic) attempts each cheat class against the REAL production wiring
 * (buildServer + registerApiRoutes + createGalaxyRouter + createRouterGateway
 * + routeGameMessage) and must gain nothing: no speed, no free hits, no
 * economy duplication, no protocol escape. Every scenario asserts the FINAL
 * server state matches the honest baseline exactly.
 *
 * Scenarios (per the acceptance):
 *  1. position teleport  2. hit claims       3. fire spam
 *  4. mine spam          5. sell spam        6. warp spam
 *  7. message flood      8. payload abuse
 */

const GALAXY_SEED = 'DRIFT-SEED-0001';

/** The first system hosting a landable atmospheric planet with a pad. */
function findPadTarget(): { system: SystemGen; pad: { padId: string; pos: Vec3 } } {
  for (const star of generateStars(GALAXY_SEED)) {
    const system = generateSystem(GALAXY_SEED, star.id);
    const planet = system.planets.find((p) => p.landable && p.hasAtmosphere);
    if (!planet) continue;
    const pad = padsForSystem(GALAXY_SEED, system).find((p) => p.planetId === planet.id);
    if (pad) return { system, pad: { padId: pad.padId, pos: pad.pos } };
  }
  throw new Error('no landable atmospheric pad in the seeded galaxy');
}
const PAD = findPadTarget();

/** A SECOND system (for the space scenarios), distinct from the pad system. */
function findSpaceSystem(): SystemGen {
  const stars = generateStars(GALAXY_SEED, 8);
  for (const star of stars) {
    const system = generateSystem(GALAXY_SEED, star.id);
    if (system.systemId !== PAD.system.systemId) return system;
  }
  throw new Error('no second system in the seeded galaxy');
}
const SPACE = findSpaceSystem();

const env: Env = {
  PORT: 3003,
  SESSION_SECRET: 'abuse-secret',
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
const clients: RawClient[] = [];

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-abuse-'));
  const { db } = createDb({ driver: 'sqlite', dbPath: path.join(dir, 'abuse.db') });
  repo = createRepo(db, sqliteTables);
  const sessions = createSessionService({ repo, codec: createTokenCodec('abuse-secret') });
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
  // The SAME dispatch surface as production (index.ts).
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

function mkClient(): RawClient {
  const c = new RawClient(wsUrl);
  clients.push(c);
  return c;
}

/** hello → auth → join home → (warp) the target system. */
async function arrive(c: RawClient, player: Claimed, systemId: string): Promise<void> {
  await c.open();
  c.send('hello', { v: PROTOCOL_VERSION });
  c.send('auth', { token: player.token });
  c.send('join_system', { systemId: player.homeSystemId });
  await c.next((m) => m.type === 'enter_system', 'enter_system (home)');
  if (player.homeSystemId !== systemId) {
    c.send('warp', { destinationSystemId: systemId });
    await c.next((m) => m.type === 'warp_arrived', 'warp_arrived', 15_000);
  }
}

/** The player's live ship entity in the shard (server state, not the wire). */
function shipOf(playerId: string, systemId: string) {
  const shard = router.active(systemId)?.shard;
  expect(shard, `shard for ${systemId} must be active`).toBeDefined();
  const entity = [...shard!.entities.values()].find((e) => e.playerId === playerId);
  expect(entity, `ship entity for ${playerId}`).toBeDefined();
  return entity!;
}

const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

describe('TASK-67: cheat scenarios — the scripted cheater gets nothing', () => {
  it('1. position teleport: position claims are rejected; the sim integrates from inputs only', async () => {
    const p = await claim('abuse-teleport');
    const c = mkClient();
    await arrive(c, p, SPACE.systemId);
    // Open space: the ship is undocked and free to move.
    expect(
      router.active(SPACE.systemId)!.shard.teleportForTesting(p.playerId, {
        x: 60_000,
        y: 60_000,
        z: 0,
      }),
    ).toBe(true);
    await new Promise((r) => setTimeout(r, 400)); // regime re-resolve
    const ship = shipOf(p.playerId, SPACE.systemId);
    const start = { ...ship.ship.pos };

    // The cheat: an input frame CLAIMING a position 100 km away.
    c.send('input', {
      seq: 1,
      thrust: 1,
      turn: 0,
      pitch: 0,
      yaw: 0,
      fire: false,
      lock: false,
      pos: { x: 100_000, x_extra: 0, z: 100_000 },
    });
    const err = await c.next((m) => m.type === 'error', 'invalid-message');
    expect(err.payload).toMatchObject({ code: 'invalid-message' });

    // And a fabricated teleport type: it does not exist.
    c.send('teleport', { to: { x: 100_000, y: 60_000, z: 0 } });
    const unknown = await c.next((m) => m.type === 'error', 'unknown-type');
    expect(unknown.payload).toMatchObject({ code: 'unknown-type' });

    // Honest motion: 1.5 s of full-thrust inputs at 10 Hz.
    const vmax = SHIP_CLASSES.scout.maxVelocity;
    const t0 = Date.now();
    let seq = 2;
    let last = { ...start };
    let maxStep = 0;
    while (Date.now() - t0 < 1_500) {
      c.send('input', {
        seq: seq++,
        thrust: 1,
        turn: 0,
        pitch: 0,
        yaw: 0,
        fire: false,
        lock: false,
      });
      await new Promise((r) => setTimeout(r, 100));
      const now = { ...ship.ship.pos };
      maxStep = Math.max(maxStep, dist(last, now));
      last = now;
    }
    // The server integrates the shared flight model from inputs: per 100 ms
    // frame the ship moves at most (max velocity + soft-cap margin), and the
    // whole run stays inside thrust-limited travel — never a 100 km jump.
    expect(maxStep, 'per-frame travel').toBeLessThanOrEqual(vmax * 0.1 * 2.5);
    expect(dist(start, last), 'total travel in 1.5 s').toBeLessThanOrEqual(vmax * 1.5 * 1.5);
    expect(dist(last, { x: 100_000, y: 60_000, z: 100_000 })).toBeGreaterThan(90_000);
    c.close();
  }, 30_000);

  it('2. hit claims: there is no "I hit" message; off-rate claims damage nothing', async () => {
    const a = await claim('abuse-hitclaim-a');
    const b = await claim('abuse-hitclaim-b');
    const ca = mkClient();
    const cb = mkClient();
    await arrive(ca, a, SPACE.systemId);
    await arrive(cb, b, SPACE.systemId);
    const shard = router.active(SPACE.systemId)!.shard;
    expect(shard.teleportForTesting(a.playerId, { x: 60_000, y: 60_000, z: 0 })).toBe(true);
    expect(shard.teleportForTesting(b.playerId, { x: 60_000, y: 60_000, z: 100 })).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    const eb = shipOf(b.playerId, SPACE.systemId);

    // The cheat: raw "I hit you" frames.
    ca.send('hit', { source: a.playerId, target: b.shipId, damage: 1000, weapon: 'laser' });
    const e1 = await ca.next((m) => m.type === 'error', 'unknown hit claim');
    expect(e1.payload).toMatchObject({ code: 'unknown-type' });
    ca.send('damage', { source: a.playerId, target: b.shipId, amount: 500 });
    const e2 = await ca.next((m) => m.type === 'error', 'unknown damage claim');
    expect(e2.payload).toMatchObject({ code: 'unknown-type' });

    // One second of quiet: B is untouched, and no hit event reached anyone.
    await new Promise((r) => setTimeout(r, 1_000));
    expect(eb.shields).toBe(1);
    expect(eb.hull).toBe(1);
    const hits = cb.messages.filter(
      (m) =>
        m.type === 'combat_event' &&
        (m.payload as { kind?: string }).kind === 'hit' &&
        (m.payload as { target?: string }).target === b.shipId,
    );
    expect(hits).toHaveLength(0);
    ca.close();
    cb.close();
  }, 30_000);

  it('3. fire spam: 30 fires/s → weapon lock, damage never exceeds the rate limit', async () => {
    const a = await claim('abuse-firespam-a');
    const b = await claim('abuse-firespam-b');
    const ca = mkClient();
    const cb = mkClient();
    await arrive(ca, a, SPACE.systemId);
    await arrive(cb, b, SPACE.systemId);
    const shard = router.active(SPACE.systemId)!.shard;
    expect(shard.teleportForTesting(a.playerId, { x: 60_000, y: 60_000, z: 0 })).toBe(true);
    expect(shard.teleportForTesting(b.playerId, { x: 60_000, y: 60_000, z: 100 })).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    const ea = shipOf(a.playerId, SPACE.systemId);
    const eb = shipOf(b.playerId, SPACE.systemId);
    expect(ea.energy, 'energy must be materialized before the burst').toBeGreaterThanOrEqual(99);

    // The cheat: 30 fire intents as fast as the wire allows.
    for (let i = 0; i < 30; i++) {
      ca.send('fire', { weapon: 'laser', targetId: b.shipId });
    }
    // The spam lockout answers (30 fires/s → WEAPON_LOCK_MS).
    const locked = await ca.next(
      (m) => m.type === 'error' && (m.payload as { code?: string }).code === 'weapon-locked',
      'weapon-locked',
      5_000,
    );
    expect(locked.payload).toMatchObject({ code: 'weapon-locked' });

    // Exactly ONE laser can land: the 3/s cooldown (7-tick) rejects the other
    // 28 accepted-window frames, and the lock rejects everything after.
    await new Promise((r) => setTimeout(r, 1_200));
    expect(eb.shields, 'exactly one 8-dmg laser hit').toBeCloseTo(1 - 8 / 50, 9);
    expect(eb.hull).toBe(1);
    const hits = cb.messages.filter(
      (m) =>
        m.type === 'combat_event' &&
        (m.payload as { kind?: string }).kind === 'hit' &&
        (m.payload as { target?: string }).target === b.shipId,
    );
    expect(hits, 'exactly one hit event on B').toHaveLength(1);
    const fired = cb.messages.filter(
      (m) => m.type === 'combat_event' && (m.payload as { kind?: string }).kind === 'laser-fired',
    );
    expect(fired, 'exactly one laser actually fired').toHaveLength(1);
    // The lock is still armed after the burst: a further fire is rejected
    // WITHOUT even reaching the cooldown/energy checks.
    ca.send('fire', { weapon: 'laser', targetId: b.shipId });
    await new Promise((r) => setTimeout(r, 300));
    expect(eb.shields).toBeCloseTo(1 - 8 / 50, 9);
    // (The burst's first weapon-locked error was already consumed by
    // ca.next() above — the buffer below holds only the SECOND lockout
    // answer, for the extra fire during the still-armed lock.)
    expect(ca.errors('weapon-locked').length).toBeGreaterThanOrEqual(1);
    ca.close();
    cb.close();
  }, 30_000);

  it('4. mine spam: 20 mine-ticks/s → the server cadence awards nothing extra', async () => {
    const p = await claim('abuse-minespam');
    const c = mkClient();
    await arrive(c, p, PAD.system.systemId);
    const shard = router.active(PAD.system.systemId)!.shard;
    // Dock + disembark → the on-foot character (the real flow, then parked).
    expect(
      shard.teleportForTesting(p.playerId, {
        x: PAD.pad.pos.x,
        y: PAD.pad.pos.y + 5,
        z: PAD.pad.pos.z,
      }),
    ).toBe(true);
    await c.next(
      (m) => {
        if (m.type !== 'entity_update') return false;
        return ((m.payload as { entities: unknown[] }).entities ?? []).some(
          (e) =>
            (e as { callsign?: string }).callsign === p.callsign &&
            (e as { regime?: string }).regime === 'docked',
        );
      },
      'docked',
      15_000,
    );
    c.send('exit_ship', { shipId: p.shipId });
    await c.next(
      (m) =>
        m.type === 'entity_update' &&
        ((m.payload as { entities: { kind?: string }[] }).entities ?? []).some(
          (e) => e.kind === 'character',
        ),
      'on foot',
      10_000,
    );
    const character = shard.entities.get(`char:${p.playerId}`)!;
    const depositId = shard.addDepositForTesting(
      { x: character.ship.pos.x, y: character.ship.pos.y, z: character.ship.pos.z + 1 },
      10,
    );

    // Start the channel, then SPAM 20 mine-ticks/s for 3.2 s (64 ticks —
    // enough for TWO honest 1.5 s awards, none more).
    c.send('interact', { targetId: depositId, action: 'mine-start' });
    await c.next(
      (m) => m.type === 'mining' && (m.payload as { phase?: string }).phase === 'active',
      'mining active',
      10_000,
    );
    const spam = setInterval(() => {
      if (c.ws.readyState === 1) c.send('interact', { targetId: depositId, action: 'mine-tick' });
    }, 50);
    const t0 = Date.now();
    let units = 0;
    while (Date.now() - t0 < 6_000) {
      const frame = c.messages
        .slice()
        .reverse()
        .find(
          (m) =>
            m.type === 'mining' &&
            (m.payload as { phase?: string }).phase === 'active' &&
            (m.payload as { units?: number }).units !== undefined,
        ) as { payload: { units?: number } } | undefined;
      units = frame?.payload.units ?? units;
      if (units >= 2) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    clearInterval(spam);
    c.send('interact', { targetId: depositId, action: 'mine-stop' });
    const ended = await c.next(
      (m) =>
        m.type === 'mining' &&
        (m.payload as { phase?: string }).phase === 'ended' &&
        (m.payload as { reason?: string }).reason === 'stopped',
      'mining ended',
      10_000,
    );
    // Exactly TWO units in ~3 s: the 1.5 s cadence, never the 64 ticks.
    expect((ended.payload as { units: number }).units).toBe(2);
    expect(shard.entities.get(depositId)?.quantity, 'deposit lost exactly 2').toBe(8);
    const ship = shipOf(p.playerId, PAD.system.systemId);
    expect(ship.inventory?.iron, 'inventory holds exactly 2 iron').toBe(2);
    c.close();
  }, 60_000);

  it('5. sell spam: 100 sells/s → rate-limited + idempotent, no credit duplication', async () => {
    const p = await claim('abuse-sellspam');
    const c = mkClient();
    await arrive(c, p, PAD.system.systemId);
    const shard = router.active(PAD.system.systemId)!.shard;
    // Dock, disembark, park the on-foot character AT the station terminal
    // (inside the 10 m sell range), and grant 10 iron (the dev give hook).
    expect(
      shard.teleportForTesting(p.playerId, {
        x: PAD.pad.pos.x,
        y: PAD.pad.pos.y + 5,
        z: PAD.pad.pos.z,
      }),
    ).toBe(true);
    await c.next(
      (m) => {
        if (m.type !== 'entity_update') return false;
        return ((m.payload as { entities: unknown[] }).entities ?? []).some(
          (e) =>
            (e as { callsign?: string }).callsign === p.callsign &&
            (e as { regime?: string }).regime === 'docked',
        );
      },
      'docked',
      15_000,
    );
    c.send('exit_ship', { shipId: p.shipId });
    await c.next(
      (m) =>
        m.type === 'entity_update' &&
        ((m.payload as { entities: { kind?: string }[] }).entities ?? []).some(
          (e) => e.kind === 'character',
        ),
      'on foot',
      10_000,
    );
    const terminal = terminalsFor(GALAXY_SEED, PAD.system).find((t) => t.padId === PAD.pad.padId)!;
    shard.teleportCharacterForTesting(p.playerId, terminal.pos);
    await new Promise((r) => setTimeout(r, 200));
    const give = await fetch(`${httpUrl}/api/dev/give`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${p.token}` },
      body: JSON.stringify({ resourceId: 'iron', amount: 10 }),
    });
    expect(give.status).toBe(200);
    const ship = shipOf(p.playerId, PAD.system.systemId);
    expect(ship.inventory?.iron).toBe(10);
    const startBalance = await repo.getBalance(p.playerId);

    // The cheat: 100 sells, one after another, as fast as the wire allows.
    for (let i = 0; i < 100; i++) {
      if (c.ws.readyState !== 1) break;
      c.send('sell', { resourceId: 'iron', amount: 1, source: 'inv' });
    }
    // Let the admitted ones settle (each sell is one serialized transaction).
    await new Promise((r) => setTimeout(r, 4_000));
    const price = sellUnitPrice('iron');
    const after = () => shipOf(p.playerId, PAD.system.systemId).inventory?.iron ?? 0;
    const sold = 10 - after();
    const burstBalance = await repo.getBalance(p.playerId);
    // EXACT accounting, whatever the burst admitted: credits moved ONLY for
    // the units actually removed. Never 100 sales, never a duplicated one.
    expect(
      burstBalance,
      `no credit duplication (burst sold ${sold}, balance +${burstBalance - startBalance})`,
    ).toBe(startBalance + sold * price);
    expect(burstBalance).toBeLessThanOrEqual(startBalance + 10 * price);
    // The excess was visibly rejected (transport bucket and/or insufficient).
    expect(
      c.errors('rate-limited').length + c.errors('insufficient').length,
      `the excess sells were rejected (server said: ${JSON.stringify(
        c.errors().map((m) => (m.payload as { code?: string }).code),
      )})`,
    ).toBeGreaterThan(0);
    // Conservation: the units left the inventory exactly once each — never
    // more than the 10 the player was given, never fewer than paid for.
    expect(sold, 'never more than the honest 10 units').toBeLessThanOrEqual(10);
    expect(10 - after(), 'units left the inventory exactly once').toBe(sold);
    // The burst may cost the connection (that is scenario 7's flood kick);
    // what it may never cost is a credit that was not earned.
  }, 60_000);

  it('6. warp spam: rapid warps → one in flight, the rest rejected, no duplicate player', async () => {
    const p = await claim('abuse-warpspam');
    const c = mkClient();
    await arrive(c, p, p.homeSystemId);
    const target = p.homeSystemId === PAD.system.systemId ? SPACE.systemId : PAD.system.systemId;
    // The cheat: 20 warps to `target`, back to back.
    for (let i = 0; i < 20; i++) {
      c.send('warp', { destinationSystemId: target });
    }
    const arrived = await c.next((m) => m.type === 'warp_arrived', 'warp_arrived', 20_000);
    expect((arrived.payload as { systemId: string }).systemId).toBe(target);
    // Let the queued remainder drain and settle.
    await new Promise((r) => setTimeout(r, 3_000));
    // (The one warp_arrived was already consumed by c.next() above — this
    // asserts NO further arrival fired for the remaining 19 queued warps.)
    expect(c.count('warp_arrived'), 'exactly ONE warp completed').toBe(0);
    expect(
      c.errors('invalid-message').length,
      'later warps were rejected (already in the target system)',
    ).toBeGreaterThan(0);
    // Server state: the ship row belongs to the target, and the target's
    // snapshot holds the player exactly ONCE (no duplicate entity).
    const row = await repo.getShipByOwner(p.playerId);
    expect(row?.position.systemId, 'the ship row moved once').toBe(target);
    const shard = router.active(target)!.shard;
    const mine = [...shard.entities.values()].filter((e) => e.playerId === p.playerId);
    expect(mine, 'exactly one entity for the player').toHaveLength(1);
    c.close();
  }, 45_000);

  it('7. message flood: 1000 junk messages/s → rate-limited, then a reconnect-required kick', async () => {
    const p = await claim('abuse-flood');
    const c = mkClient();
    await arrive(c, p, p.homeSystemId);
    const before = await repo.getBalance(p.playerId);
    // The cheat: 1000 junk frames, as fast as the client can push them.
    for (let i = 0; i < 1_000; i++) {
      c.send('ping', {});
    }
    // Wait for the server to chew through the queue: it answers the excess
    // with 'rate-limited' frames, then escalates to the flood close code.
    await c.waitForClose(20_000);
    expect(c.errors('rate-limited').length, 'the flood is rate-limited first').toBeGreaterThan(0);
    // Kicked with an application close code (client MUST reconnect): the
    // server's documented flood code 4009 'flooded'.
    expect(c.closeCode, 'reconnect-required close code').toBe(4009);
    expect(c.closeReason).toBe('flooded');
    // Nothing was mutated by the flood.
    expect(await repo.getBalance(p.playerId)).toBe(before);
  }, 45_000);

  it('8. payload abuse: > 64 KB rejected, non-JSON rejected, > 32 nesting rejected', async () => {
    const c = mkClient();
    await c.open();
    // Oversized (70 KB > the 64 KB MAX_MESSAGE_BYTES).
    c.sendRaw(
      JSON.stringify({ v: PROTOCOL_VERSION, type: 'ping', payload: { junk: 'x'.repeat(70_000) } }),
    );
    const e1 = await c.next((m) => m.type === 'error', 'oversized rejection');
    expect(e1.payload).toMatchObject({ code: 'invalid-message' });
    expect((e1.payload as { message: string }).message).toContain('65536');
    // Non-JSON.
    c.sendRaw('this is { definitely not json');
    const e2 = await c.next((m) => m.type === 'error', 'non-JSON rejection');
    expect(e2.payload).toMatchObject({ code: 'invalid-message' });
    // Deep nesting (40 levels > 32).
    c.send('ping', nestedPayload(40));
    const e3 = await c.next((m) => m.type === 'error', 'deep-nesting rejection');
    expect(e3.payload).toMatchObject({ code: 'invalid-message' });
    // Three rejections, well under the 50-invalid drop cap: the connection
    // SURVIVES and a clean handshake still works (state never mutated).
    expect(c.closed).toBe(false);
    const p = await claim('abuse-payload');
    c.send('hello', { v: PROTOCOL_VERSION });
    c.send('auth', { token: p.token });
    c.send('join_system', { systemId: p.homeSystemId });
    await c.next((m) => m.type === 'enter_system', 'handshake after payload abuse', 10_000);
    c.close();
  }, 30_000);
});
