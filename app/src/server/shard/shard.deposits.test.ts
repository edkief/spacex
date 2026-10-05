import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb } from '@server/db/client';
import { createRepo } from '@server/db/repo';
import { sqliteTables } from '@server/db/schema';
import { quatIdentity, type Vec3 } from '@shared/physics/vec';
import type { Planet, SystemGen } from '@shared/galaxy/types';
import { MINING_UNIT_MS } from '@shared/mining';
import type { InputPayload } from '@shared/protocol/schemas';
import {
  depositsFor,
  DEPOSIT_DISCOVERY_RADIUS_M,
  DEPOSIT_RENDER_RANGE_M,
} from '@shared/world/deposits';
import { padsForSystem, type PadInfo } from '@shared/world/pads';
import { SystemShard } from './shard';
import { createShardPersist } from './persist';
import type { SimEntity } from './types';

/**
 * TASK-37: seeded deposits — server-side persistence + discovery.
 *
 * - PERSISTENCE (AC): mine 5 units, restart the shard (a NEW SystemShard over
 *   the SAME repo, exactly the TASK-24 restart shape minus the crash), and the
 *   remaining amount is initial − 5. The deposits table row is created
 *   LAZILY on the first mine and keeps living at remaining 0 after depletion.
 * - DISCOVERY (AC): a deposit flips `discovered` server-side when any player
 *   (ship OR character) comes within 50 m; the flag is persisted with the
 *   next mine.
 * - SNAPSHOT (AC): seeded deposits beyond 500 m of every player stay OUT of
 *   the 10 Hz snapshot (the client derives the full list from the same seed).
 */

const SEED = 'deposits-shard-seed';
const PLANET: Planet = {
  id: 'planet-dep',
  name: 'Ferra',
  class: 'rocky',
  radiusKm: 4000,
  hasAtmosphere: true,
  landable: true,
  dockCount: 1,
  resourceTypes: ['iron', 'copper'],
  aiRoster: { count: 1, classes: ['scout'] },
};
const SYSTEM: SystemGen = {
  systemId: 'sys-deposits',
  name: 'Ferra system',
  star: { class: 'G', name: 'Ferra' },
  planets: [PLANET],
};

let dir: string;
let repo: ReturnType<typeof createRepo>;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-shard-deposits-'));
  const handle = createDb({ driver: 'sqlite', dbPath: path.join(dir, 'deposits.db') });
  repo = createRepo(handle.db, sqliteTables);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const SILENT = { debug: () => undefined, info: () => undefined, warn: () => undefined };

function makeShard(): SystemShard {
  return new SystemShard({
    systemId: SYSTEM.systemId,
    galaxySeed: SEED,
    system: SYSTEM,
    repo,
    shipSwapBus: {
      emitSwap() {},
      onSwap: () => () => {},
      emitLivery() {},
      onLivery: () => () => {},
    },
    log: SILENT,
    now: () => fakeNow,
  });
}

/** The shard's seeded deposit with the SMALLEST seq (stable across restarts). */
function firstDeposit(shard: SystemShard): { id: string; pos: Vec3; seq: number; initial: number } {
  const deposit = depositsFor(SEED, SYSTEM)[0];
  const entity = shard.entities.get(`deposit:${deposit.depositId}`)!;
  return {
    id: entity.id,
    pos: { ...entity.ship.pos },
    seq: deposit.depositSeq,
    initial: deposit.amount,
  };
}

/**
 * A player on foot standing 1 m in front of `pos` (test teleport). The
 * character is created by the REAL dock → handleExitShip flow (not addEntity)
 * so the sim integrates it as a grounded surface character.
 */
const PAD: PadInfo = padsForSystem(SEED, SYSTEM)[0];

function onFootAt(shard: SystemShard, pos: Vec3): void {
  const ship: SimEntity = {
    id: 'ship-p1',
    kind: 'ship',
    playerId: 'p1',
    callsign: 'miner',
    classId: 'scout',
    ship: {
      pos: { x: PAD.pos.x, y: PAD.pos.y + 20, z: PAD.pos.z },
      vel: { x: 0, y: 0, z: 0 },
      quat: quatIdentity(),
      regime: 'surface',
    },
    hull: 1,
    shields: 1,
    targetId: null,
    docked: false,
    planetId: PLANET.id,
  };
  shard.addEntity(ship);
  shard.registerConnection('p1', 'miner', () => undefined);
  const frames = makeFrames();
  let t = 25;
  for (let i = 0; i < 4000 && ship.padId !== PAD.padId; i++) {
    shard.enqueueInput('p1', frames());
    t += 50;
    shard.sim.step(t);
  }
  if (ship.padId !== PAD.padId) throw new Error('ship never docked');
  expect(shard.handleExitShip('p1', 'ship-p1')).toBe('ok');
  shard.entities.get('char:p1')!.ship.pos = { x: pos.x, y: pos.y, z: pos.z + 1 };
}

function makeFrames(): () => InputPayload {
  let seq = 0;
  return () => ({ seq: ++seq, thrust: 0, turn: 0, pitch: 0, yaw: 0, fire: false, lock: false });
}

/** Restart shape (TASK-24): a NEW shard over the SAME repo + persisted load. */
async function restart(original: SystemShard): Promise<SystemShard> {
  original.stop();
  const persist = createShardPersist({ repo, systemId: SYSTEM.systemId, options: { log: SILENT } });
  const shard = makeShard();
  await shard.loadShips(await persist.loadShips());
  return shard;
}

// TASK-38: mining is the hold channel — the units land on the server's
// 1.5 s ticks (the injected fake clock below), not on the interact message.
let fakeNow = 1_000_000;

function advance(shard: SystemShard, ms: number): void {
  const end = fakeNow + ms;
  while (fakeNow < end) {
    fakeNow += 50;
    shard.sim.step(fakeNow);
  }
}

function mine(shard: SystemShard, depositId: string, times: number): void {
  expect(shard.handleInteract('p1', depositId, 'mine-start')).toBe('ok');
  for (let i = 0; i < times; i++) {
    advance(shard, MINING_UNIT_MS + 100); // one full cadence per unit
  }
  // End the (possibly still-live) channel so later tests start clean.
  if (shard.mining.size > 0) {
    expect(shard.handleInteract('p1', depositId, 'mine-stop')).toBe('ok');
  }
}

describe('TASK-37: deposit persistence (mine → restart → remaining)', () => {
  it('no row before the first mine; a mine creates it lazily; mine 5 → restart → remaining = initial − 5', async () => {
    const shard = makeShard();
    const dep = firstDeposit(shard);
    onFootAt(shard, dep.pos);
    expect(await repo.listDeposits(SYSTEM.systemId)).toEqual([]);

    mine(shard, dep.id, 5);
    const entity = shard.entities.get(dep.id)!;
    expect(entity.quantity).toBe(dep.initial - 5);

    const rows = await repo.listDeposits(SYSTEM.systemId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      systemId: SYSTEM.systemId,
      depositSeq: dep.seq,
      depositId: `${SYSTEM.systemId}:${dep.seq}`,
      planetId: PLANET.id,
      remaining: dep.initial - 5,
      discovered: true, // mining is in reach — the flag rides the row
    });
    expect(rows[0].pos).toEqual(dep.pos);

    const restarted = await restart(shard);
    const reloaded = restarted.entities.get(dep.id)!;
    expect(reloaded.quantity).toBe(dep.initial - 5);
    expect(reloaded.depositDiscovered).toBe(true);
    restarted.stop();
  });

  it('a fully depleted deposit despawns (entity removed) but its row stays at 0', async () => {
    // Test 1 left p1 carrying 5 iron in the shared repo — clear it so the
    // deposit can be fully drained under the 40u weight cap (seq 2 is 13
    // units: the 45-unit seq 1 would overfill the cap on its own).
    await repo.updatePlayerInventory('p1', {});
    const shard = makeShard();
    // Use a DIFFERENT deposit (the previous test mined seq 0 to initial−5).
    const deposit = depositsFor(SEED, SYSTEM)[2];
    const id = `deposit:${deposit.depositId}`;
    const pos = { ...shard.entities.get(id)!.ship.pos };
    onFootAt(shard, pos);
    mine(shard, id, deposit.amount); // drain it completely

    expect(shard.entities.has(id)).toBe(false); // despawned for everyone
    const rows = (await repo.listDeposits(SYSTEM.systemId)).filter(
      (r) => r.depositSeq === deposit.depositSeq,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].remaining).toBe(0); // the row REMAINS

    const restarted = await restart(shard);
    expect(restarted.entities.has(id)).toBe(false); // still gone after restart
    restarted.stop();
  });
});

describe('TASK-37: discovery (server-side flag, 50 m)', () => {
  it('flips when a player (ship) comes within 50 m; stays false beyond', () => {
    const shard = makeShard();
    const list = depositsFor(SEED, SYSTEM);
    const near = `deposit:${list[2].depositId}`;
    const far = `deposit:${list[3].depositId}`;
    // The two are ≥ 200 m apart by construction.
    const nearPos = shard.entities.get(near)!.ship.pos;
    const ship: SimEntity = {
      id: 'ship-p2',
      kind: 'ship',
      playerId: 'p2',
      classId: 'scout',
      ship: {
        pos: { x: nearPos.x, y: nearPos.y, z: nearPos.z + 40 },
        vel: { x: 0, y: 0, z: 0 },
        quat: quatIdentity(),
        regime: 'atmosphere',
      },
      hull: 1,
      shields: 1,
      targetId: null,
      docked: false,
    };
    shard.addEntity(ship);
    shard.registerConnection('p2', 'flyer', () => undefined);
    let t = 25;
    for (let i = 0; i < 4; i++) {
      t += 50;
      shard.sim.step(t); // the discovery sweep runs inside the tick
    }
    expect(shard.entities.get(near)!.depositDiscovered).toBe(true);
    expect(shard.entities.get(far)!.depositDiscovered).toBe(false);
    shard.stop();
  });

  it('discovery radius boundary: exactly 50 m flips, 50 m + 10 m does not', () => {
    const shard = makeShard();
    const deposit = depositsFor(SEED, SYSTEM)[4];
    const id = `deposit:${deposit.depositId}`;
    const p = shard.entities.get(id)!.ship.pos;
    const makeShip = (id: string, dist: number): SimEntity => ({
      id,
      kind: 'ship',
      playerId: id,
      classId: 'scout',
      ship: {
        pos: { x: p.x + dist, y: p.y, z: p.z },
        vel: { x: 0, y: 0, z: 0 },
        quat: quatIdentity(),
        regime: 'surface',
      },
      hull: 1,
      shields: 1,
      targetId: null,
      docked: false,
    });
    shard.addEntity(makeShip('ship-p3', DEPOSIT_DISCOVERY_RADIUS_M)); // exactly 50
    shard.addEntity(makeShip('ship-p4', DEPOSIT_DISCOVERY_RADIUS_M + 10));
    let t = 25;
    for (let i = 0; i < 4; i++) {
      t += 50;
      shard.sim.step(t);
    }
    expect(shard.entities.get(id)!.depositDiscovered).toBe(true); // the 50 m ship flips it
    shard.stop();
  });
});

describe('TASK-37: snapshot streaming (500 m ring keeps the wire lean)', () => {
  it('a player 10 km from every deposit gets NO seeded deposit in the snapshot; within 500 m gets its ring', () => {
    const shard = makeShard();
    // Park a ship far from the planet anchor (the anchor sits at 10 km).
    const farShip: SimEntity = {
      id: 'ship-p5',
      kind: 'ship',
      playerId: 'p5',
      classId: 'scout',
      ship: {
        pos: { x: 0, y: 50, z: 0 },
        vel: { x: 0, y: 0, z: 0 },
        quat: quatIdentity(),
        regime: 'space',
      },
      hull: 1,
      shields: 1,
      targetId: null,
      docked: false,
    };
    shard.addEntity(farShip);
    shard.registerConnection('p5', 'distant', () => undefined);

    const farState = shard.snapshot();
    expect(farState.filter((e) => e.kind === 'deposit' && e.pos.x > 5_000)).toEqual([]);

    // Move to a seeded deposit: only deposits inside the 500 m ring ride out.
    const deposit = depositsFor(SEED, SYSTEM)[0];
    const p = shard.entities.get(`deposit:${deposit.depositId}`)!.ship.pos;
    farShip.ship.pos = { x: p.x, y: p.y, z: p.z };
    const nearState = shard.snapshot();
    const seededInRing = nearState.filter((e) => e.kind === 'deposit' && e.quantity !== undefined);
    expect(seededInRing.length).toBeGreaterThan(0);
    for (const e of seededInRing) {
      const d = Math.hypot(e.pos.x - p.x, e.pos.y - p.y, e.pos.z - p.z);
      expect(d).toBeLessThanOrEqual(DEPOSIT_RENDER_RANGE_M);
    }
    shard.stop();
  });
});
