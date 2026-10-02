import { describe, expect, it } from 'vitest';

import { quatIdentity, type Vec3 } from '@shared/physics/vec';
import type { InputPayload } from '@shared/protocol/schemas';
import type { Planet, SystemGen } from '@shared/galaxy/types';
import { padsForSystem, type PadInfo } from '@shared/world/pads';
import { SystemShard } from './shard';
import type { SimEntity } from './types';

/**
 * TASK-39: the ship cargo hold through the REAL SimLoop (the
 * shard.interact.test.ts conventions: stub repo/bus/log, one tick per
 * sim.step, pad position ONLY from padsForSystem).
 *
 * Contracts under test:
 * - handleCargoOpen: in the ship → a 'cargo' frame with the hold ONLY
 *   (no inventory side); on foot at a PAD-docked own ship within 5 m →
 *   hold + inventory; not pad-docked → 'not-docked'; > 5 m → 'out-of-range';
 *   the frame rides the REQUESTING connection only (like 'ui-open');
 * - handleCargoTransfer: the validation ladder (wrong-regime → not-docked →
 *   out-of-range 5 m → invalid-resource → invalid-amount → insufficient),
 *   the atomic load (hold + inventory updated in one step, 'cargo' frame
 *   to the requester, 'cargo-transfer' event), the PARTIAL at the cap
 *   (scout 40 u: 39 loaded, a request for 5 moves exactly 1), and the
 *   unload direction bounded by the 40 u inventory cap;
 * - interact 'open-cargo' on ANOTHER player's ship → 'not-owner' (the
 *   holds are per-ship: two players can't touch each other's holds).
 */

const SEED = 'CARGO-SIM-SEED';
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
  systemId: 'sys-cargo-sim',
  name: 'Varda system',
  star: { class: 'G', name: 'Varda' },
  planets: [PLANET],
};
const PAD: PadInfo = padsForSystem(SEED, SYSTEM)[0];

interface ShipRowStub {
  id: string;
  ownerId: string;
  classId: string;
  position: { x: number; y: number; z: number; systemId: string };
  velocity: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  state: 'docked' | 'flying' | 'onfoot' | 'destroyed';
  regime: 'space' | 'atmosphere' | 'surface';
  hull: number;
  shields: number;
  onPad: string | null;
  livery: null;
  destroyedAt: null;
}

const fakeNow = 1_000_000;

function makeShard(): SystemShard {
  return new SystemShard({
    systemId: SYSTEM.systemId,
    galaxySeed: SEED,
    system: SYSTEM,
    repo: {
      getShipByOwner: async (ownerId: string) =>
        ownerId === 'p1' ? (SHIP_ROW as never) : undefined,
      getPlayersByIds: async () => [],
    },
    shipSwapBus: {
      emitSwap() {},
      onSwap: () => () => {},
      emitLivery() {},
      onLivery: () => () => {},
    },
    log: { debug() {}, warn() {}, info() {} },
    now: () => fakeNow,
  });
}

const SHIP_ROW: ShipRowStub = {
  id: 'ship-p1',
  ownerId: 'p1',
  classId: 'scout',
  position: { x: PAD.pos.x, y: PAD.pos.y, z: PAD.pos.z, systemId: SYSTEM.systemId },
  velocity: { x: 0, y: 0, z: 0 },
  rotation: quatIdentity(),
  state: 'flying',
  regime: 'surface',
  hull: 100,
  shields: 50,
  onPad: null,
  livery: null,
  destroyedAt: null,
};

function makeEntity(pos: Vec3): SimEntity {
  return {
    id: 'ship-p1',
    kind: 'ship',
    playerId: 'p1',
    callsign: 'pilot',
    classId: 'scout',
    ship: { pos, vel: { x: 0, y: 0, z: 0 }, quat: quatIdentity(), regime: 'atmosphere' },
    hull: 1,
    shields: 1,
    targetId: null,
    docked: false,
    planetId: PLANET.id,
  };
}

function makeFrames(): (partial?: Partial<InputPayload>) => InputPayload {
  let seq = 0;
  return (partial: Partial<InputPayload> = {}) => ({
    seq: ++seq,
    thrust: 0,
    turn: 0,
    pitch: 0,
    yaw: 0,
    fire: false,
    lock: false,
    ...partial,
  });
}

function makeStepper(shard: SystemShard): () => void {
  let t = 25;
  return () => {
    t += 50;
    shard.sim.step(t);
  };
}

/**
 * Dock p1's ship on the pad and disembark (a standing character 2.5 m to
 * the ship's side — inside both the 3 m enter and the 5 m cargo reaches).
 */
function onFootAtPad(
  shard: SystemShard,
  send: (buffer: string) => void = () => {},
): { charPos: Vec3; step: () => void } {
  const entity = makeEntity({ x: PAD.pos.x, y: PAD.pos.y + 20, z: PAD.pos.z });
  shard.addEntity(entity);
  shard.registerConnection('p1', 'pilot', send);
  const frames = makeFrames();
  const step = makeStepper(shard);
  for (let i = 0; i < 4000 && entity.padId !== PAD.padId; i++) {
    shard.enqueueInput('p1', frames());
    step();
  }
  if (entity.padId !== PAD.padId) throw new Error('ship never docked');
  expect(shard.handleExitShip('p1', 'ship-p1')).toBe('ok');
  return { charPos: { ...shard.entities.get('char:p1')!.ship.pos }, step };
}

interface CargoFrame {
  hold: { stacks: Record<string, number>; weightUsed: number; capacity: number };
  inventory?: { stacks: Record<string, number>; weightUsed: number };
}

function cargoFrames(sent: string[]): CargoFrame[] {
  return sent
    .map((b) => JSON.parse(b) as { type: string; payload: CargoFrame })
    .filter((m) => m.type === 'cargo')
    .map((m) => m.payload);
}

function errorCodes(sent: string[]): string[] {
  return sent
    .map((b) => JSON.parse(b) as { type: string; payload: { code?: string } })
    .filter((m) => m.type === 'error')
    .map((m) => m.payload.code ?? 'undefined');
}

describe('TASK-39: cargo hold — open', () => {
  it('in the ship: a cargo frame with the hold ONLY (no inventory side), requester only', () => {
    const shard = makeShard();
    const entity = makeEntity({ x: PAD.pos.x + 100, y: PAD.pos.y, z: PAD.pos.z });
    shard.addEntity(entity);
    const toP1: string[] = [];
    const toP2: string[] = [];
    shard.registerConnection('p1', 'pilot', (b) => toP1.push(b));
    shard.addEntity({
      ...makeEntity({ x: PAD.pos.x + 200, y: PAD.pos.y, z: PAD.pos.z }),
      id: 'ship-p2',
      playerId: 'p2',
      callsign: 'other',
    });
    shard.registerConnection('p2', 'other', (b) => toP2.push(b));
    // Seed a hold on the in-flight ship.
    entity.cargo = { stacks: { iron: 10 }, weightUsed: 10, capacity: 40 };

    expect(shard.handleCargoOpen('p1')).toBe('ok');

    const frames = cargoFrames(toP1);
    expect(frames).toHaveLength(1);
    expect(frames[0].hold).toEqual({ stacks: { iron: 10 }, weightUsed: 10, capacity: 40 });
    expect(frames[0].inventory).toBeUndefined(); // in the ship: hold only
    expect(cargoFrames(toP2)).toHaveLength(0); // never broadcast
    expect(errorCodes(toP1)).toHaveLength(0);
  });

  it('on foot at a pad-docked ship within 5 m: hold + inventory in the frame', () => {
    const shard = makeShard();
    const toP1: string[] = [];
    onFootAtPad(shard, (b) => toP1.push(b));
    shard.giveInventoryForTesting('p1', { iron: 7 });
    const ship = shard.entities.get('ship-p1')!;
    ship.cargo = { stacks: { crystal: 2 }, weightUsed: 6, capacity: 40 };

    expect(shard.handleCargoOpen('p1')).toBe('ok');

    const frames = cargoFrames(toP1);
    expect(frames).toHaveLength(1);
    expect(frames[0].hold).toEqual({ stacks: { crystal: 2 }, weightUsed: 6, capacity: 40 });
    expect(frames[0].inventory).toEqual({ stacks: { iron: 7 }, weightUsed: 7 });
  });

  it('on foot but the ship is not pad-docked → not-docked, no frame', () => {
    const shard = makeShard();
    const toP1: string[] = [];
    onFootAtPad(shard, (b) => toP1.push(b));
    shard.entities.get('ship-p1')!.padId = undefined; // no tick: no re-dock

    expect(shard.handleCargoOpen('p1')).toBe('not-docked');
    expect(cargoFrames(toP1)).toHaveLength(0);
    expect(errorCodes(toP1)).toEqual(['not-docked']);
  });

  it('on foot but the character is > 5 m from the ship → out-of-range', () => {
    const shard = makeShard();
    const toP1: string[] = [];
    const { charPos } = onFootAtPad(shard, (b) => toP1.push(b));
    shard.entities.get('char:p1')!.ship.pos = { x: charPos.x + 6, y: charPos.y, z: charPos.z };

    expect(shard.handleCargoOpen('p1')).toBe('out-of-range');
    expect(cargoFrames(toP1)).toHaveLength(0);
    expect(errorCodes(toP1)).toEqual(['out-of-range']);
  });
});

describe('TASK-39: cargo hold — transfer ladder + atomic moves', () => {
  it('still in the ship → wrong-regime (transfers happen AT the dock)', () => {
    const shard = makeShard();
    const toP1: string[] = [];
    const entity = makeEntity({ x: PAD.pos.x, y: PAD.pos.y, z: PAD.pos.z });
    shard.addEntity(entity);
    shard.registerConnection('p1', 'pilot', (b) => toP1.push(b));

    expect(shard.handleCargoTransfer('p1', { resourceId: 'iron', amount: 1, from: 'inv' })).toBe(
      'wrong-regime',
    );
    expect(errorCodes(toP1)).toEqual(['wrong-regime']);
    expect(cargoFrames(toP1)).toHaveLength(0);
  });

  it('on foot: not-docked → out-of-range → invalid-resource → invalid-amount (each leaves state untouched)', () => {
    const shard = makeShard();
    const toP1: string[] = [];
    const { charPos } = onFootAtPad(shard, (b) => toP1.push(b));
    const ship = shard.entities.get('ship-p1')!;
    ship.cargo = { stacks: {}, weightUsed: 0, capacity: 40 };
    shard.giveInventoryForTesting('p1', { iron: 5 });

    ship.padId = undefined;
    expect(shard.handleCargoTransfer('p1', { resourceId: 'iron', amount: 1, from: 'inv' })).toBe(
      'not-docked',
    );
    ship.padId = PAD.padId; // back to the pad for the next rungs

    shard.entities.get('char:p1')!.ship.pos = { x: charPos.x + 6, y: charPos.y, z: charPos.z };
    expect(shard.handleCargoTransfer('p1', { resourceId: 'iron', amount: 1, from: 'inv' })).toBe(
      'out-of-range',
    );
    shard.entities.get('char:p1')!.ship.pos = { ...charPos };

    expect(
      shard.handleCargoTransfer('p1', { resourceId: 'plutonium', amount: 1, from: 'inv' }),
    ).toBe('invalid-resource');
    expect(shard.handleCargoTransfer('p1', { resourceId: 'iron', amount: 0, from: 'inv' })).toBe(
      'invalid-amount',
    );

    expect(errorCodes(toP1)).toEqual([
      'not-docked',
      'out-of-range',
      'invalid-resource',
      'invalid-amount',
    ]);
    expect(cargoFrames(toP1)).toHaveLength(0); // every rung is a denial
    expect(ship.cargo!.stacks).toEqual({});
    expect(shard.getInventory('p1')).toEqual({ iron: 5 });
  });

  it('load: 5 of 10 iron moves in one atomic step — frame, entity, event, character mirror', () => {
    const shard = makeShard();
    const toP1: string[] = [];
    const { step } = onFootAtPad(shard, (b) => toP1.push(b));
    const ship = shard.entities.get('ship-p1')!;
    ship.cargo = { stacks: {}, weightUsed: 0, capacity: 40 };
    shard.giveInventoryForTesting('p1', { iron: 10 });
    const events: Array<{ playerId: string; moved: number; from: string }> = [];
    shard.events.on('cargo-transfer', (e) =>
      events.push({ playerId: e.playerId, moved: e.moved, from: e.from }),
    );

    expect(shard.handleCargoTransfer('p1', { resourceId: 'iron', amount: 5, from: 'inv' })).toBe(
      'ok',
    );
    step(); // the tick carries the character mirror on the snapshot path

    expect(ship.cargo!.stacks).toEqual({ iron: 5 });
    expect(ship.cargo!.weightUsed).toBe(5);
    expect(shard.getInventory('p1')).toEqual({ iron: 5 });
    expect(shard.entities.get('char:p1')!.inventory).toEqual({ iron: 5 });
    const frames = cargoFrames(toP1);
    expect(frames).toHaveLength(1);
    expect(frames[0].hold).toEqual({ stacks: { iron: 5 }, weightUsed: 5, capacity: 40 });
    expect(frames[0].inventory).toEqual({ stacks: { iron: 5 }, weightUsed: 5 });
    expect(events).toEqual([{ playerId: 'p1', moved: 5, from: 'inv' }]);
    expect(errorCodes(toP1)).toHaveLength(0);
  });

  it('PARTIAL at the cap: a 39/40 scout hold takes exactly 1 of a 5-unit request, then insufficient', () => {
    const shard = makeShard();
    const toP1: string[] = [];
    onFootAtPad(shard, (b) => toP1.push(b));
    const ship = shard.entities.get('ship-p1')!;
    ship.cargo = { stacks: {}, weightUsed: 0, capacity: 40 };
    shard.giveInventoryForTesting('p1', { iron: 40 });

    expect(shard.handleCargoTransfer('p1', { resourceId: 'iron', amount: 39, from: 'inv' })).toBe(
      'ok',
    );
    expect(ship.cargo!.weightUsed).toBe(39); // 39 in, 1 left in the pocket
    expect(shard.handleCargoTransfer('p1', { resourceId: 'iron', amount: 5, from: 'inv' })).toBe(
      'ok',
    );
    expect(ship.cargo!.stacks).toEqual({ iron: 40 }); // exactly 1 more fit
    expect(ship.cargo!.weightUsed).toBe(40); // the hold is FULL
    expect(shard.getInventory('p1')).toEqual({});
    // A full hold takes nothing: a structured insufficient (nothing moved).
    shard.giveInventoryForTesting('p1', { iron: 1 });
    expect(shard.handleCargoTransfer('p1', { resourceId: 'iron', amount: 1, from: 'inv' })).toBe(
      'insufficient',
    );
    expect(ship.cargo!.stacks).toEqual({ iron: 40 });
    expect(shard.getInventory('p1')).toEqual({ iron: 1 });
    expect(errorCodes(toP1)).toEqual(['insufficient']);
  });

  it('unload: hold → inventory, bounded by the stow AND the 40 u inventory cap', () => {
    const shard = makeShard();
    const toP1: string[] = [];
    onFootAtPad(shard, (b) => toP1.push(b));
    const ship = shard.entities.get('ship-p1')!;
    ship.cargo = { stacks: { iron: 40 }, weightUsed: 40, capacity: 40 };

    expect(shard.handleCargoTransfer('p1', { resourceId: 'iron', amount: 10, from: 'hold' })).toBe(
      'ok',
    );
    expect(ship.cargo!.stacks).toEqual({ iron: 30 });
    expect(shard.getInventory('p1')).toEqual({ iron: 10 });
    expect(shard.handleCargoTransfer('p1', { resourceId: 'iron', amount: 35, from: 'hold' })).toBe(
      'ok',
    );
    expect(ship.cargo!.stacks).toEqual({}); // only 30 were stowed
    expect(ship.cargo!.weightUsed).toBe(0);
    expect(shard.getInventory('p1')).toEqual({ iron: 40 }); // at the 40 u cap
    expect(shard.handleCargoTransfer('p1', { resourceId: 'iron', amount: 1, from: 'hold' })).toBe(
      'insufficient',
    ); // the hold is empty
    expect(errorCodes(toP1)).toEqual(['insufficient']);
  });

  it("interact 'open-cargo' on ANOTHER player's ship → not-owner, nothing opens", () => {
    const shard = makeShard();
    const toP1: string[] = [];
    const toP2: string[] = [];
    const { charPos } = onFootAtPad(shard, (b) => toP1.push(b));
    // p2's ship parked 1 m from p1's character (in reach of the interact).
    const p2ship = {
      ...makeEntity({ x: charPos.x, y: charPos.y, z: charPos.z + 1 }),
      id: 'ship-p2',
      playerId: 'p2',
      callsign: 'other',
    };
    p2ship.cargo = { stacks: { iron: 10 }, weightUsed: 10, capacity: 40 };
    shard.addEntity(p2ship);
    shard.registerConnection('p2', 'other', (b) => toP2.push(b));

    expect(shard.handleInteract('p1', 'ship-p2', 'open-cargo')).toBe('not-owner');
    expect(errorCodes(toP1)).toEqual(['not-owner']);
    expect(cargoFrames(toP1)).toHaveLength(0); // no panel for the intruder
    expect(cargoFrames(toP2)).toHaveLength(0); // and none leaked to p2
    expect(p2ship.cargo!.stacks).toEqual({ iron: 10 }); // the hold is untouched
  });
});
