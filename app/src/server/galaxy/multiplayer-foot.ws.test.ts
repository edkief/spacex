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
 * TASK-36 step 4: on-foot multiplayer over LIVE ws (the inventory.ws.test.ts
 * scaffold, real server wiring). The ACs:
 * - position exchange: A walks, B's view of char A is within 2 m of the
 *   server truth after 1 s (200 ms interpolation window, never more);
 * - ground-item round trip: A drops, BOTH see it, B picks up — removal +
 *   the PICKER's inventory ride the same snapshots;
 * - presence data: the entity list carries the regime (B in ship → A sees
 *   only the ship; exit_ship → char onFoot:true; enter_ship → char gone);
 * - scale: 4 on foot + 4 in ships — the SERVER tick p95 stays within
 *   baseline + 4 ms while all four characters walk (the client headless
 *   can't run 8 tabs; the tick budget is the documented proxy).
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
  SESSION_SECRET: 'multiplayer-foot-secret',
  GALAXY_SEED,
  DB_DRIVER: 'sqlite',
  DB_PATH: './data/drift.db',
  DATABASE_URL: '',
  SYSTEM_INSTANCE_COUNT: 8,
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-foot-'));
  const { db } = createDb({ driver: 'sqlite', dbPath: path.join(dir, 'foot.db') });
  repo = createRepo(db, sqliteTables);
  const sessions = createSessionService({
    repo,
    codec: createTokenCodec('multiplayer-foot-secret'),
  });
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
  playerId?: string;
  padId?: string;
  onFoot?: boolean;
  quantity?: number;
  resourceId?: string;
  inventory?: { stacks: Record<string, number>; weightUsed: number };
}

function entitiesOf(m: WsEnvelope): WireEntity[] {
  return (m.payload as { entities?: WireEntity[] }).entities ?? [];
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

/** The shard of the pad system (always active once any player has warped in). */
function shard() {
  const s = router.active(PAD.systemId)?.shard;
  expect(s, `shard for ${PAD.systemId} must be active`).toBeDefined();
  return s!;
}

/**
 * Dock + disembark → the player's character entity, as seen on the wire.
 * All docked players share the SAME pad spot, so their characters spawn
 * meters apart (the 3 m pickup reach is trivially satisfied).
 */
async function onFoot(client: WsTestClient, player: Claimed): Promise<WireEntity> {
  const s = shard();
  expect(
    s.teleportForTesting(player.playerId, {
      x: PAD.pad.pos.x,
      y: PAD.pad.pos.y + 5,
      z: PAD.pad.pos.z,
    }),
  ).toBe(true);
  const docked = await client.next(
    // surface structured rejections immediately (they explain a stuck wait).
    // Require the padId: the wire regime 'docked' ALSO covers home-dock rest
    // (docked: true, no pad) — a STALE snapshot of that state, buffered
    // before the teleport, must not satisfy this wait, or exit_ship races
    // the real pad dock and is correctly rejected ('not-docked'). padId is
    // exactly the precondition handleExitShip checks.
    (m) =>
      m.type === 'error' ||
      entitiesOf(m).some(
        (e) => e.callsign === player.callsign && e.regime === 'docked' && e.padId !== undefined,
      ),
    `pad-docked entity_update for ${player.callsign}`,
    20_000,
  );
  if (docked.type === 'error') throw new Error(`dock failed: ${JSON.stringify(docked.payload)}`);
  client.send({ v: PROTOCOL_VERSION, type: 'exit_ship', payload: { shipId: player.shipId } });
  const upd = await client.next(
    // surface structured rejections immediately (they explain a stuck wait)
    (m) =>
      m.type === 'error' ||
      entitiesOf(m).some((e) => e.kind === 'character' && e.callsign === player.callsign),
    `character entity_update for ${player.callsign}`,
    10_000,
  );
  if (upd.type === 'error') throw new Error(`exit_ship rejected: ${JSON.stringify(upd.payload)}`);
  return entitiesOf(upd).find((e) => e.kind === 'character' && e.callsign === player.callsign)!;
}

/** A peer's LATEST wire position of one entity (scans the full message log). */
function lastWirePos(client: WsTestClient, id: string): { x: number; y: number; z: number } | null {
  for (let i = client.messages.length - 1; i >= 0; i--) {
    const e = entitiesOf(client.messages[i]).find((w) => w.id === id);
    if (e) return e.pos;
  }
  return null;
}

function dist3(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * One full-forward input frame. The server holds the last frame, but frames
 * arriving during a tick-debt drop window are discarded (sim.inputDrops),
 * so senders should stream rather than rely on a single send surviving.
 */
function walkFrame(seq: number) {
  return { seq, thrust: 1, turn: 0, pitch: 0, yaw: 0, fire: false, lock: false };
}

describe('TASK-36: on-foot multiplayer over live ws', () => {
  it('A walks, B sees char A within 2 m of the server truth after 1 s (C idles in a ship nearby)', async () => {
    const a = await claim('foot-a');
    const b = await claim('foot-b');
    const c = await claim('foot-c');
    const ca = mkClient();
    const cb = mkClient();
    const cc = mkClient();
    await Promise.all([arriveAtPad(ca, a), arriveAtPad(cb, b), arriveAtPad(cc, c)]);
    const charA = await onFoot(ca, a);
    await onFoot(cb, b);
    // C stays in the ship, near the pad (outside the 20 m dock disc).
    const s = shard();
    expect(
      s.teleportForTesting(c.playerId, {
        x: PAD.pad.pos.x + 60,
        y: PAD.pad.pos.y + 15,
        z: PAD.pad.pos.z,
      }),
    ).toBe(true);

    const start = shard().entities.get(charA.id)!.ship.pos;
    // One frame suffices: the server holds the latest input until replaced.
    ca.send({ v: PROTOCOL_VERSION, type: 'input', payload: walkFrame(1) });
    await sleep(1_000);

    const truth = shard().entities.get(charA.id)!.ship.pos;
    const bView = lastWirePos(cb, charA.id);
    expect(bView, 'B must have seen char A on the wire').not.toBeNull();
    expect(dist3(truth, start)).toBeGreaterThan(1); // A actually walked
    expect(dist3(truth, bView!)).toBeLessThanOrEqual(2); // within one interp window

    expect(ca.messages.filter((m) => m.type === 'error')).toHaveLength(0);
    expect(cb.messages.filter((m) => m.type === 'error')).toHaveLength(0);
  });

  it('ground-item round trip: A drops 1 iron, BOTH see it, B picks it up', async () => {
    const a = await claim('foot-d');
    const b = await claim('foot-e');
    const ca = mkClient();
    const cb = mkClient();
    await Promise.all([arriveAtPad(ca, a), arriveAtPad(cb, b)]);
    await onFoot(ca, a);
    await onFoot(cb, b);
    const s = shard();
    s.giveInventoryForTesting(a.playerId, { iron: 1 });

    ca.send({ v: PROTOCOL_VERSION, type: 'drop', payload: { resourceId: 'iron', amount: 1 } });
    const seesItem = (m: WsEnvelope) =>
      entitiesOf(m).some((e) => e.kind === 'groundItem' && e.resourceId === 'iron');
    const dropA = await ca.next(seesItem, 'groundItem visible (A)', 10_000);
    const dropB = await cb.next(seesItem, 'groundItem visible (B)', 10_000);
    const item = entitiesOf(dropA).find((e) => e.kind === 'groundItem')!;
    expect(
      entitiesOf(dropB).find((e) => e.id === item.id),
      'B sees the SAME item id',
    ).toBeTruthy();
    expect(item.quantity).toBe(1);

    // B walks to it (same pad spot ⇒ in the 3 m reach) and picks it up.
    cb.send({
      v: PROTOCOL_VERSION,
      type: 'interact',
      payload: { targetId: item.id, action: 'pickup' },
    });

    // From NOW on, both clients see the item LEAVE a snapshot batch.
    ca.messages.length = 0;
    cb.messages.length = 0;
    const gone = (m: WsEnvelope) =>
      entitiesOf(m).some((e) => e.callsign === b.callsign) &&
      !entitiesOf(m).some((e) => e.id === item.id);
    const goneA = await ca.next(gone, 'item removed (A)', 10_000);
    await cb.next(gone, 'item removed (B)', 10_000);
    // The PICKER's inventory gained the unit — not the dropper's.
    const selfB = entitiesOf(goneA).find(
      (e) => e.callsign === b.callsign && e.kind === 'character',
    )!;
    expect(selfB.inventory).toEqual({ stacks: { iron: 1 }, weightUsed: 1 });
    expect(s.entities.has(item.id)).toBe(false);
    expect(s.getInventory(b.playerId)).toEqual({ iron: 1 });
    expect(s.getInventory(a.playerId)).toEqual({});
    expect(ca.messages.filter((m) => m.type === 'error')).toHaveLength(0);
    expect(cb.messages.filter((m) => m.type === 'error')).toHaveLength(0);
  });

  it('presence data: A on foot, B in ship → ship only; exit_ship → char onFoot; enter_ship → char gone', async () => {
    const a = await claim('foot-f');
    const b = await claim('foot-g');
    const ca = mkClient();
    const cb = mkClient();
    await Promise.all([arriveAtPad(ca, a), arriveAtPad(cb, b)]);
    await onFoot(ca, a);
    // B docks (so exit/enter are legal) but STAYS in the ship.
    const s = shard();
    expect(
      s.teleportForTesting(b.playerId, {
        x: PAD.pad.pos.x,
        y: PAD.pad.pos.y + 5,
        z: PAD.pad.pos.z,
      }),
    ).toBe(true);
    // padId required (same rationale as onFoot): the wire 'docked' regime
    // also covers home-dock rest, so a stale pre-teleport snapshot must not
    // satisfy this wait or the later exit_ship races the real pad dock.
    await cb.next(
      (m) =>
        entitiesOf(m).some(
          (e) => e.callsign === b.callsign && e.regime === 'docked' && e.padId !== undefined,
        ),
      'B pad-docked',
      15_000,
    );

    // A sees B's SHIP entity and NO character for B.
    const shipsOnly = (m: WsEnvelope) =>
      entitiesOf(m).some((e) => e.kind === 'ship' && e.callsign === b.callsign);
    const snap = await ca.next(shipsOnly, "A sees B's ship", 10_000);
    expect(entitiesOf(snap).some((e) => e.kind === 'character' && e.callsign === b.callsign)).toBe(
      false,
    );

    // B disembarks → A sees the character with onFoot:true…
    cb.send({ v: PROTOCOL_VERSION, type: 'exit_ship', payload: { shipId: b.shipId } });
    const charSeen = await ca.next(
      (m) => entitiesOf(m).some((e) => e.kind === 'character' && e.callsign === b.callsign),
      "A sees B's character",
      10_000,
    );
    const charB = entitiesOf(charSeen).find(
      (e) => e.kind === 'character' && e.callsign === b.callsign,
    )!;
    expect(charB.onFoot).toBe(true);

    // …and re-enters → the character leaves A's snapshots.
    cb.send({ v: PROTOCOL_VERSION, type: 'enter_ship', payload: { shipId: b.shipId } });
    cb.messages.length = 0;
    ca.messages.length = 0;
    const charGone = (m: WsEnvelope) =>
      entitiesOf(m).some((e) => e.kind === 'ship' && e.callsign === b.callsign) &&
      !entitiesOf(m).some((e) => e.kind === 'character' && e.callsign === b.callsign);
    await ca.next(charGone, "A no longer sees B's character", 10_000);
    await cb.next(charGone, 'B no longer sees its own character', 10_000);
    expect(ca.messages.filter((m) => m.type === 'error')).toHaveLength(0);
    expect(cb.messages.filter((m) => m.type === 'error')).toHaveLength(0);
  });

  it('scale: 4 on foot + 4 in ships — tick p95 stays within baseline + 4 ms, all four walk', async () => {
    const walkers = Array.from({ length: 4 }, (_, i) => `scale-w${i}`);
    const flyers = Array.from({ length: 4 }, (_, i) => `scale-s${i}`);
    const wPlayers: Claimed[] = [];
    const fPlayers: Claimed[] = [];
    const wClients: WsTestClient[] = [];
    const fClients: WsTestClient[] = [];
    for (const cs of walkers) wPlayers.push(await claim(cs));
    for (const cs of flyers) fPlayers.push(await claim(cs));
    for (let i = 0; i < wPlayers.length; i++) wClients.push(mkClient());
    for (let i = 0; i < fPlayers.length; i++) fClients.push(mkClient());
    await Promise.all(
      [...wPlayers, ...fPlayers].map((p, i) =>
        arriveAtPad(i < 4 ? wClients[i] : fClients[i - 4], p),
      ),
    );
    const charStarts = new Map<string, { x: number; y: number; z: number }>();
    for (let i = 0; i < 4; i++) {
      const ch = await onFoot(wClients[i], wPlayers[i]);
      charStarts.set(ch.id, { ...ch.pos });
    }
    // The four ships hover near the pad (outside the dock disc, in atmosphere).
    const s = shard();
    fPlayers.forEach((p, i) => {
      expect(
        s.teleportForTesting(p.playerId, {
          x: PAD.pad.pos.x + 80 + i * 10,
          y: PAD.pad.pos.y + 20 + i * 5,
          z: PAD.pad.pos.z,
        }),
      ).toBe(true);
    });

    // Baseline: 1.5 s idle with all 8 entities in the shard.
    s.histogram.reset();
    await sleep(1_500);
    const baseline = s.histogram.percentile(0.95);
    expect(s.histogram.sampleCount).toBeGreaterThan(5);

    // Load: all four characters walk on held frames. The server holds the last
    // frame, but enqueueInput DROPS frames that land while the tick loop owes
    // more than maxCatchUpTicks (TASK-13 anti-spiral, sim.inputDrops) — under
    // full-suite machine load a single-shot send can be lost entirely and the
    // walkers never move. Stream at ~7/s per connection (well inside the 20/s
    // inbound bucket) so the window always has a live held frame.
    s.histogram.reset();
    const walkUntil = Date.now() + 5_000;
    let seq = 0;
    while (Date.now() < walkUntil) {
      seq += 1;
      for (const c of wClients) {
        c.send({ v: PROTOCOL_VERSION, type: 'input', payload: walkFrame(seq) });
      }
      await sleep(150);
    }
    const loaded = s.histogram.percentile(0.95);
    expect(loaded - baseline, `p95 ${loaded} ms vs baseline ${baseline} ms`).toBeLessThanOrEqual(4);
    // All four characters actually moved (held thrust walks them).
    for (const ch of wPlayers) {
      const id = `char:${ch.playerId}`;
      const now = s.entities.get(id)!.ship.pos;
      expect(dist3(now, charStarts.get(id)!)).toBeGreaterThan(1);
    }
  }, 60_000);
});
