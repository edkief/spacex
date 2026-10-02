import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { quatIdentity, type Vec3 } from '@shared/physics/vec';
import type { Planet, SystemGen } from '@shared/galaxy/types';
import { padsForSystem, type PadInfo } from '@shared/world/pads';
import { createDb } from '@server/db/client';
import { createRepo, type Repository } from '@server/db/repo';
import { sqliteTables } from '@server/db/schema';
import { SystemShard, GROUND_ITEM_TTL_MS, entityToState } from './shard';
import { createShardPersist } from './persist';
import type { SimEntity } from './types';

/**
 * TASK-34: the on-foot inventory through the REAL SimLoop (shard.interact.
 * test.ts conventions: stub repo/bus/log, one tick per sim.step, pad
 * position ONLY from padsForSystem).
 *
 * Contracts under test:
 * - handleDrop: validates (on foot, known resource, positive integer amount,
 *   amount ≤ owned) then removes from the stacks and spawns a 'groundItem'
 *   entity at the CHARACTER position (300 s ttl, in every snapshot);
 * - handlePickup (via the handleInteract 'groundItem' branch): partial pickup
 *   into the 40 u weight cap — takes what fits, the remainder stays on the
 *   ground item (despawn at zero); a full inventory is denied with
 *   {code:'inventory-full'};
 * - ttl expiry: the generic tick ttl sweep removes the item after 300 s;
 * - persistence: players.inventory JSON via the TASK-24 flush cadence —
 *   load on join (adoptEntity) and shard restart (loadShips) (real sqlite).
 *
 * The players disembark from PAD-DOCKED ships (padId set directly — the
 * dock-approach loop is covered by shard.interact.test.ts; the inventory
 * contracts do not depend on how the ship got there).
 */

const SEED = 'INVENTORY-SIM-SEED';
const SYSTEM_ID = 'sys-inventory-sim';
const PLANET: Planet = {
  id: 'planet-1',
  name: 'Varda',
  class: 'terran',
  radiusKm: 3000,
  hasAtmosphere: true,
  landable: true,
  dockCount: 1,
  resourceTypes: ['iron'],
  aiRoster: { count: 2, classes: ['scout', 'scout'] },
};
const SYSTEM: SystemGen = {
  systemId: SYSTEM_ID,
  name: 'Varda system',
  star: { class: 'G', name: 'Varda' },
  planets: [PLANET],
};
const PAD: PadInfo = padsForSystem(SEED, SYSTEM)[0];

function makeShard(opts?: { dtMs?: number }): SystemShard {
  return new SystemShard({
    systemId: SYSTEM_ID,
    galaxySeed: SEED,
    system: SYSTEM,
    repo: {
      getShipByOwner: async () => undefined, // the tests add entities directly
      getPlayersByIds: async () => [],
    },
    shipSwapBus: {
      emitSwap() {},
      onSwap: () => () => {},
      emitLivery() {},
      onLivery: () => () => {},
    },
    log: { debug() {}, warn() {}, info() {} },
    ...(opts?.dtMs !== undefined ? { dtMs: opts.dtMs } : {}),
  });
}

function makeEntity(playerId: string, pos: Vec3): SimEntity {
  return {
    id: `ship-${playerId}`,
    kind: 'ship',
    playerId,
    callsign: playerId === 'p1' ? 'pilot' : 'other',
    classId: 'scout',
    ship: { pos, vel: { x: 0, y: 0, z: 0 }, quat: quatIdentity(), regime: 'atmosphere' },
    hull: 1,
    shields: 1,
    targetId: null,
    docked: true,
    planetId: PLANET.id,
  };
}

/**
 * Pad-dock + disembark without the flight loop. BOTH players dock at the
 * SAME pad position → their characters spawn at the SAME position (0 m
 * apart, comfortably inside the 3 m reach).
 */
function onFoot(shard: SystemShard, playerId: string, send: (buffer: string) => void = () => void 0) {
  const entity = makeEntity(playerId, { ...PAD.pos });
  entity.padId = PAD.padId; // pad-docked (the approach loop is another task's proof)
  shard.addEntity(entity);
  shard.registerConnection(playerId, entity.callsign ?? 'pilot', send);
  expect(shard.handleExitShip(playerId, entity.id)).toBe('ok');
  return { charPos: { ...shard.entities.get(`char:${playerId}`)!.ship.pos } };
}

/**
 * Exactly ONE tick per call (the accumulator's first burst would otherwise
 * run 2 ticks). The first call lands at dtMs/2 so `owed` is exactly 1, then
 * each call advances exactly one period.
 */
function makeStepper(shard: SystemShard, dtMs: number = 50): () => void {
  let t = 0;
  return () => {
    t = t === 0 ? dtMs / 2 : t + dtMs;
    shard.sim.step(t);
  };
}

interface WireMsg {
  type: string;
  payload: { code?: string; message?: string };
}

const messages = (sent: string[]): WireMsg[] => sent.map((b) => JSON.parse(b) as WireMsg);

/** The snapshot's wire state of one entity (the broadcast shape). */
function snapEntity(shard: SystemShard, id: string) {
  return shard.snapshot().find((s) => s.id === id);
}

/** The shard's single ground item (the tests drop exactly one each). */
function theItem(shard: SystemShard): SimEntity {
  const item = [...shard.entities.values()].find((e) => e.kind === 'groundItem');
  if (!item) throw new Error('no ground item in the shard');
  return item;
}

describe('TASK-34: drop → ground item → partial pickup (real sim)', () => {
  it('drop: removes from the stacks, spawns a groundItem at the character (snapshot carries quantity + resourceId + inventory)', () => {
    const shard = makeShard();
    const sent: string[] = [];
    const { charPos } = onFoot(shard, 'p1', (b) => sent.push(b));
    const step = makeStepper(shard);

    shard.giveInventoryForTesting('p1', { iron: 5, crystal: 1 });
    expect(shard.handleDrop('p1', 'iron', 2)).toBe('ok');

    // The stacks shrank; the ground item exists at the CHARACTER position.
    // (ttl asserted BEFORE the first step — the tick sweep decrements it.)
    expect(shard.getInventory('p1')).toEqual({ iron: 3, crystal: 1 });
    const item = theItem(shard);
    expect(item.quantity).toBe(2);
    expect(item.resourceId).toBe('iron');
    expect(item.ttl).toBe(Math.round(GROUND_ITEM_TTL_MS / 50));
    expect(item.ship.pos).toEqual(charPos);
    step();

    // Wire: quantity + resourceId ride the snapshot; BOTH the frozen ship and
    // the on-foot character (the client's self entity) carry the inventory.
    const wire = snapEntity(shard, item.id);
    expect(wire).toMatchObject({ kind: 'groundItem', quantity: 2, resourceId: 'iron' });
    const shipWire = snapEntity(shard, 'ship-p1');
    const charWire = snapEntity(shard, 'char:p1');
    expect(shipWire?.inventory).toEqual({ stacks: { iron: 3, crystal: 1 }, weightUsed: 6 });
    expect(charWire?.inventory).toEqual({ stacks: { iron: 3, crystal: 1 }, weightUsed: 6 });

    // A successful drop sends no error.
    expect(messages(sent).filter((m) => m.type === 'error')).toHaveLength(0);
  });

  it('partial pickup at the boundary: 37 iron + 2 crystal dropped → takes 1 (40/40), remainder stays', () => {
    const shard = makeShard();
    onFoot(shard, 'p1');
    onFoot(shard, 'p2');
    const step = makeStepper(shard);
    const pickups: Array<{
      playerId: string;
      targetId: string;
      resource: string;
      taken: number;
      remaining: number;
      depleted: boolean;
    }> = [];
    shard.events.on('pickup', (e) => pickups.push(e as never));

    shard.giveInventoryForTesting('p1', { iron: 37 }); // 37 u → 3 u of room
    shard.giveInventoryForTesting('p2', { crystal: 2 });
    expect(shard.handleDrop('p2', 'crystal', 2)).toBe('ok'); // 2 crystal = 6 u
    const item = theItem(shard);
    expect(item.ttl).toBe(Math.round(GROUND_ITEM_TTL_MS / 50));
    step();

    // p1's room is 3 u = exactly ONE crystal (3 u each) → partial pickup.
    expect(shard.handleInteract('p1', item.id)).toBe('ok');
    expect(shard.getInventory('p1')).toEqual({ iron: 37, crystal: 1 }); // 40/40
    expect(entityToState(item).quantity).toBe(1); // the remainder stays
    expect(pickups).toEqual([
      {
        playerId: 'p1',
        targetId: item.id,
        resource: 'crystal',
        taken: 1,
        remaining: 1,
        depleted: false,
      },
    ]);
  });

  it('full inventory (40/40): denied with {code: inventory-full}, nothing moves', () => {
    const shard = makeShard();
    const sent: string[] = [];
    onFoot(shard, 'p1', (b) => sent.push(b));
    onFoot(shard, 'p2');
    const step = makeStepper(shard);

    shard.giveInventoryForTesting('p1', { iron: 40 });
    shard.giveInventoryForTesting('p2', { iron: 1 });
    expect(shard.handleDrop('p2', 'iron', 1)).toBe('ok');
    step();
    const item = theItem(shard);

    expect(shard.handleInteract('p1', item.id)).toBe('ok'); // dispatch is 'ok'…
    expect(shard.getInventory('p1')).toEqual({ iron: 40 }); // …but nothing moved
    expect(item.quantity).toBe(1);
    expect(
      messages(sent)
        .filter((m) => m.type === 'error')
        .map((m) => m.payload.code),
    ).toEqual(['inventory-full']); // …denied with a structured error
  });

  it('drop → re-pickup round trip: full take at open capacity, despawn at zero', () => {
    const shard = makeShard();
    onFoot(shard, 'p1');
    const step = makeStepper(shard);

    shard.giveInventoryForTesting('p1', { copper: 3 });
    expect(shard.handleDrop('p1', 'copper', 3)).toBe('ok');
    step();
    const item = theItem(shard);
    expect(shard.getInventory('p1')).toEqual({});

    // Open capacity takes the WHOLE item (36 u room) → despawn at zero.
    expect(shard.handleInteract('p1', item.id)).toBe('ok');
    expect(shard.getInventory('p1')).toEqual({ copper: 3 });
    expect(shard.entities.has(item.id)).toBe(false);
    expect(shard.snapshot().some((s) => s.id === item.id)).toBe(false);
  });

  it('ttl expiry: the item despawns after 300 s (tick sweep), inventory untouched', () => {
    // dtMs 1000 → ttl = 300 ticks (the 300 s ttl in 300 simulated steps).
    const shard = makeShard({ dtMs: 1000 });
    onFoot(shard, 'p1');
    const step = makeStepper(shard, 1000);

    shard.giveInventoryForTesting('p1', { iron: 2 });
    expect(shard.handleDrop('p1', 'iron', 1)).toBe('ok');
    const item = theItem(shard);
    expect(item.ttl).toBe(300);

    for (let i = 0; i < 299; i++) step();
    expect(shard.entities.has(item.id)).toBe(true); // one tick shy: still there

    step(); // the 300th tick: ttl → 0 → the sweep removes it
    expect(shard.entities.has(item.id)).toBe(false);
    expect(shard.getInventory('p1')).toEqual({ iron: 1 }); // the drop stands
  });

  it('denials: wrong-regime, not-owned, invalid-resource, invalid-amount (no item ever spawns)', () => {
    const shard = makeShard();
    const sent: string[] = [];
    const step = makeStepper(shard);

    // Still in the ship (no character yet): wrong-regime.
    const entity = makeEntity('p1', { ...PAD.pos });
    entity.padId = PAD.padId;
    shard.addEntity(entity);
    shard.registerConnection('p1', 'pilot', (b) => sent.push(b));
    expect(shard.handleDrop('p1', 'iron', 1)).toBe('wrong-regime');
    expect(
      messages(sent)
        .filter((m) => m.type === 'error')
        .map((m) => m.payload.code),
    ).toEqual(['wrong-regime']);

    onFoot(shard, 'p1'); // disembark (the connection is reused)
    shard.giveInventoryForTesting('p1', { iron: 1 });
    expect(shard.handleDrop('p1', 'iron', 2)).toBe('not-owned'); // 2 > 1 owned
    expect(shard.handleDrop('p1', 'gold', 1)).toBe('invalid-resource');
    expect(shard.handleDrop('p1', 'iron', 0)).toBe('invalid-amount');
    step();
    expect([...shard.entities.values()].some((e) => e.kind === 'groundItem')).toBe(false);
    expect(shard.getInventory('p1')).toEqual({ iron: 1 }); // untouched
  });

  it('out-of-range pickup: > 3 m from the character is denied, the item stays', () => {
    const shard = makeShard();
    const sent: string[] = [];
    const { charPos } = onFoot(shard, 'p1', (b) => sent.push(b));
    const step = makeStepper(shard);

    // A ground item 4 m to the side (direct spawn — the drop path always
    // lands AT the character, so this one is placed manually).
    shard.entities.set('groundItem:far', {
      id: 'groundItem:far',
      kind: 'groundItem',
      playerId: null,
      classId: 'groundItem',
      ship: {
        pos: { x: charPos.x + 4, y: charPos.y, z: charPos.z },
        vel: { x: 0, y: 0, z: 0 },
        quat: quatIdentity(),
        regime: 'surface',
      },
      hull: 1,
      shields: 1,
      targetId: null,
      docked: false,
      quantity: 2,
      resourceId: 'iron',
      ttl: 300,
    });
    step();

    expect(shard.handleInteract('p1', 'groundItem:far')).toBe('out-of-range');
    expect(
      messages(sent)
        .filter((m) => m.type === 'error')
        .map((m) => m.payload.code),
    ).toEqual(['out-of-range']);
    expect(shard.entities.get('groundItem:far')?.quantity).toBe(2); // untouched
  });
});

describe('TASK-34: inventory persistence (real sqlite, simulated restart)', () => {
  let dir: string;
  let repo: Repository;

  const bus = {
    emitSwap() {},
    onSwap: () => () => {},
    emitLivery() {},
    onLivery: () => () => {},
  };
  const log = { debug() {}, warn() {}, info() {} };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-inv-persist-'));
    const { db } = createDb({ driver: 'sqlite', dbPath: path.join(dir, 'inv.db') });
    repo = createRepo(db, sqliteTables);
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function makePlayer(callsign: string): Promise<string> {
    const player = await repo.createPlayer({ callsign, homeSystemId: SYSTEM_ID });
    await repo.getOrCreateStarterShip(player.id, {
      position: { systemId: SYSTEM_ID, x: PAD.pos.x, y: PAD.pos.y, z: PAD.pos.z },
    });
    return player.id;
  }

  it('load on join → grant → flush; a fresh shard restores the stacks (adoptEntity + loadShips)', async () => {
    const playerId = await makePlayer('inv-persist');

    // Shard "1": join-time load (empty row → {}), then grant units.
    const shard = new SystemShard({
      systemId: SYSTEM_ID,
      galaxySeed: SEED,
      system: SYSTEM,
      repo,
      shipSwapBus: bus,
      log,
    });
    const adopted = await shard.adoptEntity(playerId, 'inv-persist');
    expect(adopted?.inventory).toEqual({}); // empty row loads empty
    shard.giveInventoryForTesting(playerId, { iron: 12, crystal: 2 });
    expect(shard.getInventory(playerId)).toEqual({ iron: 12, crystal: 2 }); // 18 u

    // The TASK-24 flush cadence writes inventories in the same transaction.
    const persist = createShardPersist({ repo, systemId: SYSTEM_ID });
    const summary = await persist.flushShips({ systemId: SYSTEM_ID, entities: shard.entities });
    expect(summary.inventories).toBe(1);
    expect(await repo.getPlayerInventory(playerId)).toEqual({ iron: 12, crystal: 2 });

    // Shard "2" (simulated restart): join-time load via adoptEntity…
    const shard2 = new SystemShard({
      systemId: SYSTEM_ID,
      galaxySeed: SEED,
      system: SYSTEM,
      repo,
      shipSwapBus: bus,
      log,
    });
    const readopted = await shard2.adoptEntity(playerId, 'inv-persist');
    expect(readopted?.inventory).toEqual({ iron: 12, crystal: 2 });

    // …and shard-spawn rehydration via loadShips (no connection involved).
    const shard3 = new SystemShard({
      systemId: SYSTEM_ID,
      galaxySeed: SEED,
      system: SYSTEM,
      repo,
      shipSwapBus: bus,
      log,
    });
    const load = await persist.loadShips();
    expect(load.ships).toHaveLength(1);
    await shard3.loadShips(load);
    expect(shard3.getInventory(playerId)).toEqual({ iron: 12, crystal: 2 });
  });

  it('an entity with no loaded inventory never clobbers the persisted row', async () => {
    const playerId = await makePlayer('inv-persist-2');
    await repo.updatePlayerInventory(playerId, { iron: 7 });

    const shard = new SystemShard({
      systemId: SYSTEM_ID,
      galaxySeed: SEED,
      system: SYSTEM,
      repo,
      shipSwapBus: bus,
      log,
    });
    const adopted = await shard.adoptEntity(playerId, 'inv-persist-2');
    // Simulate an entity whose inventory was never loaded (undefined — the
    // "never clobber" guard in the flush).
    delete adopted!.inventory;

    const persist = createShardPersist({ repo, systemId: SYSTEM_ID });
    const summary = await persist.flushShips({ systemId: SYSTEM_ID, entities: shard.entities });
    expect(summary.inventories).toBe(0);
    expect(await repo.getPlayerInventory(playerId)).toEqual({ iron: 7 }); // intact
  });
});
