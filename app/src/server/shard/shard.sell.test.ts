import { describe, expect, it } from 'vitest';

import { quatIdentity, type Vec3 } from '@shared/physics/vec';
import type { InputPayload } from '@shared/protocol/schemas';
import type { Planet, SystemGen } from '@shared/galaxy/types';
import { padsForSystem, type PadInfo } from '@shared/world/pads';
import { terminalsFor } from '@shared/world/terminals';
import { SystemShard } from './shard';
import type { SimEntity } from './types';

/**
 * TASK-40 step 4: the dock sell through the REAL shard (the
 * shard.cargo.test.ts conventions: stub repo/bus/log, one tick per sim.step,
 * pad position ONLY from padsForSystem). Contracts under test:
 * - the station check: a docked ship is "at a station" (hold sell in the
 *   cockpit works); an undocked/moving ship → {code:'not-docked'}; on-foot
 *   'inv' selling needs the character within 10 m (TERMINAL_RANGE_M) of a
 *   station terminal, else {code:'not-at-station'} (the terminal sits at the
 *   pad edge, far from the disembark spawn);
 * - the validation ladder (invalid-resource → invalid-amount →
 *   insufficient) each leaves state untouched;
 * - the atomic sell: the source stack decrements AND credits are granted in
 *   ONE transaction (a failed credit write rolls the stack back — the
 *   rollback test), the NEW stacks ride the 'sell' frame, the 'sold' event
 *   fires;
 * - source selection: 'hold' sells the ship's cargo, 'inv' sells the on-foot
 *   inventory.
 */

const SEED = 'SELL-SIM-SEED';
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
  systemId: 'sys-sell-sim',
  name: 'Varda system',
  star: { class: 'G', name: 'Varda' },
  planets: [PLANET],
};
const PAD: PadInfo = padsForSystem(SEED, SYSTEM)[0];
// The terminal the shard spawns for this pad (at the pad edge).
const TERMINAL = terminalsFor(SEED, SYSTEM).find((t) => t.padId === PAD.padId)!;

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

const fakeNow = 1_000_000;

/** The repo surface the sell path touches (named so `withTransaction` can
 * reference it WITHOUT a circular `typeof repo` self-initializer). */
interface SellRepoStub {
  getShipByOwner: (ownerId: string) => Promise<unknown>;
  getPlayersByIds: () => Promise<unknown[]>;
  addCredits: (playerId: string, amount: number) => Promise<{ credits: number }>;
  updateShipCargo: (shipId: string, stacks: Record<string, number>) => Promise<void>;
  updatePlayerInventory: (playerId: string, stacks: Record<string, number>) => Promise<void>;
  withTransaction: <T>(fn: (r: SellRepoStub) => Promise<T>) => Promise<T>;
}

/** A repo stub with the sell path's transaction methods + observable state. */
function makeRepo(throwOnCredits = false) {
  const state = {
    credits: 500,
    shipCargo: null as Record<string, number> | null,
    inv: null as Record<string, number> | null,
    creditCalls: 0,
  };
  const repo: SellRepoStub = {
    getShipByOwner: async (ownerId: string) => (ownerId === 'p1' ? (SHIP_ROW as never) : undefined),
    getPlayersByIds: async () => [],
    addCredits: async (_playerId: string, amount: number) => {
      if (throwOnCredits) throw new Error('credit write failed (simulated)');
      state.creditCalls += 1;
      state.credits += amount;
      return { credits: state.credits };
    },
    updateShipCargo: async (_shipId: string, stacks: Record<string, number>) => {
      state.shipCargo = { ...stacks };
    },
    updatePlayerInventory: async (_playerId: string, stacks: Record<string, number>) => {
      state.inv = { ...stacks };
    },
    withTransaction: async <T>(fn: (r: SellRepoStub) => Promise<T>): Promise<T> => {
      const before = {
        credits: state.credits,
        shipCargo: state.shipCargo,
        inv: state.inv,
        creditCalls: state.creditCalls,
      };
      try {
        return await fn(repo);
      } catch (err) {
        // ROLLBACK: the real withTransaction rolls every write back on throw.
        state.credits = before.credits;
        state.shipCargo = before.shipCargo;
        state.inv = before.inv;
        state.creditCalls = before.creditCalls;
        throw err;
      }
    },
  };
  return { repo, state };
}

function makeShard(repo: ReturnType<typeof makeRepo>['repo']): SystemShard {
  return new SystemShard({
    systemId: SYSTEM.systemId,
    galaxySeed: SEED,
    system: SYSTEM,
    repo: repo as never,
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

/** Dock p1's ship on the pad and disembark (a standing character by the ship). */
function onFootAtPad(shard: SystemShard, send: (buffer: string) => void = () => {}): Vec3 {
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
  return { ...shard.entities.get('char:p1')!.ship.pos };
}

function errorCodes(sent: string[]): string[] {
  return sent
    .map((b) => JSON.parse(b) as { type: string; payload: { code?: string } })
    .filter((m) => m.type === 'error')
    .map((m) => m.payload.code ?? 'undefined');
}

function sellFrames(sent: string[]): Array<{
  resourceId: string;
  sold: number;
  earned: number;
  balance: number;
  hold: { stacks: Record<string, number>; weightUsed: number; capacity: number };
  inventory: { stacks: Record<string, number>; weightUsed: number };
}> {
  return sent
    .map((b) => JSON.parse(b))
    .filter((m) => m.type === 'sell')
    .map((m) => m.payload);
}

describe('TASK-40: dock sell — station check + validation ladder', () => {
  it('undocked (moving) ship → not-docked, for either source', async () => {
    const { repo, state } = makeRepo();
    const shard = makeShard(repo);
    const toP1: string[] = [];
    const entity = makeEntity({ x: PAD.pos.x, y: PAD.pos.y + 20, z: PAD.pos.z });
    shard.addEntity(entity);
    shard.registerConnection('p1', 'pilot', (b) => toP1.push(b));
    entity.cargo = { stacks: { iron: 10 }, weightUsed: 10, capacity: 40 };
    // Never docked: no padId, docked false.
    const r1 = await shard.handleSell('p1', { resourceId: 'iron', amount: 1, source: 'hold' });
    const r2 = await shard.handleSell('p1', { resourceId: 'iron', amount: 1, source: 'inv' });
    expect(r1).toEqual({ ok: false, code: 'not-docked' });
    expect(r2).toEqual({ ok: false, code: 'not-docked' });
    expect(errorCodes(toP1)).toEqual(['not-docked', 'not-docked']);
    expect(state.credits).toBe(500); // nothing was granted
    expect(state.shipCargo).toBeNull();
    expect(entity.cargo!.stacks).toEqual({ iron: 10 }); // untouched
  });

  it("in the docked ship: a 'hold' sell succeeds (no terminal proximity needed for the hold)", async () => {
    const { repo, state } = makeRepo();
    const shard = makeShard(repo);
    const toP1: string[] = [];
    const entity = makeEntity({ x: PAD.pos.x, y: PAD.pos.y + 20, z: PAD.pos.z });
    shard.addEntity(entity);
    shard.registerConnection('p1', 'pilot', (b) => toP1.push(b));
    const frames = makeFrames();
    const step = makeStepper(shard);
    for (let i = 0; i < 4000 && entity.padId !== PAD.padId; i++) {
      shard.enqueueInput('p1', frames());
      step();
    }
    expect(entity.padId).toBe(PAD.padId);
    entity.cargo = { stacks: { iron: 10 }, weightUsed: 10, capacity: 40 };

    const res = await shard.handleSell('p1', { resourceId: 'iron', amount: 10, source: 'hold' });
    expect(res).toEqual({ ok: true, sold: 10, earned: 50, balance: 550 });
    expect(entity.cargo!.stacks).toEqual({}); // the hold is drained
    expect(state.credits).toBe(550); // 500 + 10×5
    expect(state.creditCalls).toBe(1);
    expect(state.shipCargo).toEqual({}); // the DB saw the decrement
    const frames_ = sellFrames(toP1);
    expect(frames_).toHaveLength(1);
    expect(frames_[0]).toMatchObject({ resourceId: 'iron', sold: 10, earned: 50, balance: 550 });
    expect(frames_[0].hold).toEqual({ stacks: {}, weightUsed: 0, capacity: 40 });
  });

  it("on foot, 'inv' sell needs the character within 10 m of a terminal → not-at-station when far", async () => {
    const { repo, state } = makeRepo();
    const shard = makeShard(repo);
    const toP1: string[] = [];
    const charPos = onFootAtPad(shard, (b) => toP1.push(b));
    shard.giveInventoryForTesting('p1', { iron: 10 });
    // The disembark spawn is ~2.5 m from the pad center; the terminal is at
    // the pad edge (radius 20 − 2 = 18 m out) — the character is ~15 m from
    // it, well past the 10 m sell range.
    const res = await shard.handleSell('p1', { resourceId: 'iron', amount: 1, source: 'inv' });
    expect(res).toEqual({ ok: false, code: 'not-at-station' });
    expect(errorCodes(toP1)).toEqual(['not-at-station']);
    expect(state.credits).toBe(500);
    expect(shard.getInventory('p1')).toEqual({ iron: 10 }); // untouched
    expect(charPos).toBeDefined();
  });

  it("on foot AT the terminal: an 'inv' sell succeeds (10 m reach)", async () => {
    const { repo, state } = makeRepo();
    const shard = makeShard(repo);
    const toP1: string[] = [];
    onFootAtPad(shard, (b) => toP1.push(b));
    shard.giveInventoryForTesting('p1', { iron: 10 });
    // Park the character at the terminal (0 m — inside the 10 m sell range).
    expect(shard.teleportCharacterForTesting('p1', TERMINAL.pos)).toBe(true);

    const res = await shard.handleSell('p1', { resourceId: 'iron', amount: 4, source: 'inv' });
    expect(res).toEqual({ ok: true, sold: 4, earned: 20, balance: 520 });
    expect(shard.getInventory('p1')).toEqual({ iron: 6 }); // the pocket drained by 4
    expect(state.credits).toBe(520);
    expect(state.inv).toEqual({ iron: 6 }); // the DB saw the decrement
    const frames_ = sellFrames(toP1);
    expect(frames_).toHaveLength(1);
    expect(frames_[0]).toMatchObject({ resourceId: 'iron', sold: 4, earned: 20, balance: 520 });
    expect(frames_[0].inventory).toEqual({ stacks: { iron: 6 }, weightUsed: 6 });
  });

  it('invalid-resource → invalid-amount → insufficient (each leaves state untouched)', async () => {
    const { repo, state } = makeRepo();
    const shard = makeShard(repo);
    const toP1: string[] = [];
    onFootAtPad(shard, (b) => toP1.push(b));
    expect(shard.teleportCharacterForTesting('p1', TERMINAL.pos)).toBe(true);
    shard.giveInventoryForTesting('p1', { iron: 3 });

    const r1 = await shard.handleSell('p1', { resourceId: 'plutonium', amount: 1, source: 'inv' });
    const r2 = await shard.handleSell('p1', { resourceId: 'iron', amount: 0, source: 'inv' });
    const r3 = await shard.handleSell('p1', { resourceId: 'iron', amount: 5, source: 'inv' });
    expect(r1).toEqual({ ok: false, code: 'invalid-resource' });
    expect(r2).toEqual({ ok: false, code: 'invalid-amount' });
    expect(r3).toEqual({ ok: false, code: 'insufficient' });
    expect(errorCodes(toP1)).toEqual(['invalid-resource', 'invalid-amount', 'insufficient']);
    expect(state.credits).toBe(500);
    expect(shard.getInventory('p1')).toEqual({ iron: 3 }); // nothing sold
    expect(sellFrames(toP1)).toHaveLength(0); // every rung is a denial
  });
});

describe('TASK-40: dock sell — transaction atomicity (rollback)', () => {
  it('a failed credit write rolls the stack decrement back — nothing is applied', async () => {
    const { repo, state } = makeRepo(true); // addCredits throws
    const shard = makeShard(repo);
    const toP1: string[] = [];
    const entity = makeEntity({ x: PAD.pos.x, y: PAD.pos.y + 20, z: PAD.pos.z });
    shard.addEntity(entity);
    shard.registerConnection('p1', 'pilot', (b) => toP1.push(b));
    const frames = makeFrames();
    const step = makeStepper(shard);
    for (let i = 0; i < 4000 && entity.padId !== PAD.padId; i++) {
      shard.enqueueInput('p1', frames());
      step();
    }
    entity.cargo = { stacks: { iron: 10 }, weightUsed: 10, capacity: 40 };

    const res = await shard.handleSell('p1', { resourceId: 'iron', amount: 10, source: 'hold' });
    expect(res).toEqual({ ok: false, code: 'sell-failed' });
    expect(errorCodes(toP1)).toEqual(['sell-failed']);
    // The in-memory hold was NEVER touched (the commit threw before the apply).
    expect(entity.cargo!.stacks).toEqual({ iron: 10 });
    // And the DB rolled back: the credit write never landed, nor did the
    // stack decrement survive the rollback.
    expect(state.credits).toBe(500);
    expect(state.creditCalls).toBe(0);
    expect(state.shipCargo).toBeNull();
    expect(sellFrames(toP1)).toHaveLength(0);
  });

  it('the sold event fires on success with earned + balance', async () => {
    const { repo } = makeRepo();
    const shard = makeShard(repo);
    const toP1: string[] = [];
    const entity = makeEntity({ x: PAD.pos.x, y: PAD.pos.y + 20, z: PAD.pos.z });
    shard.addEntity(entity);
    shard.registerConnection('p1', 'pilot', (b) => toP1.push(b));
    const frames = makeFrames();
    const step = makeStepper(shard);
    for (let i = 0; i < 4000 && entity.padId !== PAD.padId; i++) {
      shard.enqueueInput('p1', frames());
      step();
    }
    entity.cargo = { stacks: { iron: 10 }, weightUsed: 10, capacity: 40 };
    const events: Array<{ playerId: string; sold: number; earned: number; balance: number }> = [];
    shard.events.on('sold', (e) =>
      events.push({ playerId: e.playerId, sold: e.sold, earned: e.earned, balance: e.balance }),
    );

    await shard.handleSell('p1', { resourceId: 'iron', amount: 10, source: 'hold' });
    expect(events).toEqual([{ playerId: 'p1', sold: 10, earned: 50, balance: 550 }]);
  });
});
