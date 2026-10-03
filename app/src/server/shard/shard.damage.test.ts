import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateSystem } from '@shared/galaxy/system';
import { generateStars } from '@shared/galaxy/stars';
import type { SystemGen } from '@shared/galaxy/types';
import type { DamageSource } from '@shared/physics/damage';
import type { EntityState, InputPayload } from '@shared/protocol/schemas';
import { createShipSwapBus, type ShipRowLike } from '@server/shards';

import { SystemShard, TICK_DT_MS, WRECK_TTL_MS } from './shard';
import type { SimEntity } from './types';

/**
 * Ship damage model in the sim (TASK-23 step 2): the applyHit hook (shared
 * shield-first math), destroyed state (frozen / input-ignored /
 * non-targetable), the static wreck entity with its 600 s ttl, and the
 * combat_event broadcast to the whole shard.
 */

const SEED = 'shard-damage-seed';
const PLAYER: DamageSource = { kind: 'player', id: 'p2' };
const AI: DamageSource = { kind: 'ai', id: 'rogue-9' };
/** The firing weapon id riding every combat event (TASK-42). */
const WEAPON = 'laser';

function testSystem(): SystemGen {
  const star = generateStars(SEED, 4)[0];
  return generateSystem(SEED, star.id);
}

function makeShard(system: SystemGen = testSystem()): SystemShard {
  return new SystemShard({
    systemId: system.systemId,
    galaxySeed: SEED,
    system,
    repo: { getShipByOwner: async () => undefined, getPlayersByIds: async () => [] },
    shipSwapBus: {
      emitSwap() {},
      onSwap: () => () => {},
      emitLivery() {},
      onLivery: () => () => {},
    },
    log: { debug() {}, warn() {}, info() {} },
  });
}

function addFakeConn(shard: SystemShard, playerId: string, callsign: string): { sends: string[] } {
  const sends: string[] = [];
  shard.registerConnection(playerId, callsign, (buffer) => {
    sends.push(buffer);
  });
  return { sends };
}

function makeEntity(
  playerId: string,
  pos: { x: number; y: number; z: number },
  vel: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 },
): SimEntity {
  return {
    id: `ship-${playerId}`,
    kind: 'ship',
    playerId,
    callsign: playerId,
    classId: 'scout',
    ship: {
      pos: { ...pos },
      vel: { ...vel },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      regime: 'space',
    },
    hull: 1,
    shields: 1,
    targetId: null,
    docked: false,
  };
}

function input(seq: number, partial: Partial<InputPayload> = {}): InputPayload {
  return {
    seq,
    thrust: 0,
    turn: 0,
    pitch: 0,
    yaw: 0,
    fire: false,
    lock: false,
    ...partial,
  };
}

/** Combat events out of a send log, decoded. */
function combatEvents(sends: string[]): unknown[] {
  return sends
    .filter((s) => JSON.parse(s).type === 'combat_event')
    .map((s) => (JSON.parse(s) as { payload: unknown }).payload);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SystemShard.applyHit (TASK-23 step 2)', () => {
  it('a partial hit reduces shields first, then hull, and broadcasts combat_event to the whole shard', () => {
    vi.useFakeTimers();
    const shard = makeShard();
    shard.addEntity(makeEntity('p1', { x: 1, y: 2, z: 3 }));
    const mine = addFakeConn(shard, 'p1', 'Alpha');
    const other = addFakeConn(shard, 'p2', 'Beta');

    // Scout: 100 hull / 50 shields. 70 points → 50 shields, 20 hull.
    const result = shard.applyHit('ship-p1', 70, PLAYER, WEAPON);
    expect(result).toEqual({ shieldHit: 50, hullHit: 20, destroyed: false });
    const e = shard.entities.get('ship-p1')!;
    expect(e.shields).toBeCloseTo(0, 12);
    expect(e.hull).toBeCloseTo(0.8, 12);

    const mineEvents = combatEvents(mine.sends);
    const otherEvents = combatEvents(other.sends);
    expect(mineEvents).toEqual([
      {
        kind: 'hit',
        target: 'ship-p1',
        source: PLAYER,
        weapon: WEAPON,
        damage: 70,
        shieldHit: 50,
        hullHit: 20,
      },
    ]);
    // Broadcast to the WHOLE shard: every in-system conn gets the event.
    expect(otherEvents).toEqual(mineEvents);
    shard.stop();
  });

  it('a killing hit destroys the ship: frozen at its final position with a static wreck', () => {
    vi.useFakeTimers();
    const shard = makeShard();
    const start = { x: 10, y: 20, z: 30 };
    const entity = makeEntity('p1', start, { x: 1, y: 0, z: 2 });
    shard.addEntity(entity);
    const { sends } = addFakeConn(shard, 'p1', 'Alpha');

    // 50 (shields) + 50 (half hull), then the final 50 → hull at zero.
    shard.applyHit('ship-p1', 100, AI, WEAPON);
    shard.applyHit('ship-p1', 50, AI, WEAPON);

    expect(entity.destroyed).toBe(true);
    expect(entity.hull).toBe(0);
    expect(entity.shields).toBe(0);
    // The wreck is a static entity at the final position (vel zeroed).
    const wreck = shard.entities.get('wreck:ship-p1');
    expect(wreck).toBeDefined();
    expect(wreck!.kind).toBe('wreck');
    expect(wreck!.ship.pos).toEqual(start);
    expect(wreck!.ship.vel).toEqual({ x: 0, y: 0, z: 0 });
    expect(wreck!.ttl).toBe(Math.round(WRECK_TTL_MS / TICK_DT_MS));
    // TASK-42: the wreck records its killer (skull marker, TASK-49).
    expect(wreck!.killerId).toBe(AI.id);
    // The first hit broadcasts 'hit'; ONLY the killing hit broadcasts
    // 'destroyed' (no 'hit' for it). An AI source never emits 'kill'.
    expect(combatEvents(sends)).toEqual([
      {
        kind: 'hit',
        target: 'ship-p1',
        source: AI,
        weapon: WEAPON,
        damage: 100,
        shieldHit: 50,
        hullHit: 50,
      },
      { kind: 'destroyed', target: 'ship-p1', source: AI, weapon: WEAPON },
    ]);
    shard.stop();
  });

  it('a player killing hit additionally broadcasts kill (kill = destroyed with a player source)', () => {
    vi.useFakeTimers();
    const shard = makeShard();
    shard.addEntity(makeEntity('p1', { x: 1, y: 1, z: 1 }));
    const { sends } = addFakeConn(shard, 'p1', 'Alpha');

    shard.applyHit('ship-p1', 150, PLAYER, WEAPON); // killing hit by a player
    expect(combatEvents(sends)).toEqual([
      { kind: 'destroyed', target: 'ship-p1', source: PLAYER, weapon: WEAPON },
      { kind: 'kill', killer: PLAYER.id, victim: 'ship-p1', weapon: WEAPON },
    ]);
    expect(shard.entities.get('wreck:ship-p1')!.killerId).toBe(PLAYER.id);
    shard.stop();
  });

  it('the wreck and the frozen ship both ride the 10 Hz snapshot wire contract', () => {
    vi.useFakeTimers();
    const shard = makeShard();
    shard.addEntity(makeEntity('p1', { x: 5, y: 5, z: 5 }));
    const { sends } = addFakeConn(shard, 'p1', 'Alpha');

    shard.applyHit('ship-p1', 150, AI, WEAPON); // killing hit
    shard.start();
    vi.advanceTimersByTime(2 * TICK_DT_MS); // one snapshot

    const snapshot = sends.filter((s) => JSON.parse(s).type === 'entity_update').pop()!;
    const entities = (JSON.parse(snapshot) as { payload: { entities: EntityState[] } }).payload
      .entities;
    const byId = new Map(entities.map((e) => [e.id, e]));
    expect(byId.get('ship-p1')).toMatchObject({ id: 'ship-p1', kind: 'ship', hull: 0 });
    expect(byId.get('wreck:ship-p1')).toMatchObject({
      id: 'wreck:ship-p1',
      kind: 'wreck',
      hull: 0,
      shields: 0,
      pos: { x: 5, y: 5, z: 5 },
      vel: { x: 0, y: 0, z: 0 },
      classId: 'scout',
    });
    shard.stop();
  });

  it('double-destroy guard: a second hit on a dead ship is a no-op (no event, no second wreck)', () => {
    vi.useFakeTimers();
    const shard = makeShard();
    shard.addEntity(makeEntity('p1', { x: 0, y: 0, z: 0 }));
    const { sends } = addFakeConn(shard, 'p1', 'Alpha');

    shard.applyHit('ship-p1', 150, AI, WEAPON);
    expect(shard.applyHit('ship-p1', 50, PLAYER, WEAPON)).toBeUndefined();
    expect(shard.applyHit('wreck:ship-p1', 50, PLAYER, WEAPON)).toBeUndefined(); // wrecks too
    expect(shard.applyHit('ship-nobody', 50, PLAYER, WEAPON)).toBeUndefined();

    const events = combatEvents(sends);
    expect(events).toHaveLength(1); // exactly one 'destroyed', nothing re-broadcast
    expect(shard.entities.has('wreck:ship-p1')).toBe(true);
    expect(entityCount(shard, 'wreck')).toBe(1);
    shard.stop();
  });

  function entityCount(shard: SystemShard, kind: SimEntity['kind']): number {
    return [...shard.entities.values()].filter((e) => e.kind === kind).length;
  }

  it('a destroyed ship stops integrating and ignores inputs', () => {
    vi.useFakeTimers();
    const shard = makeShard();
    const entity = makeEntity('p1', { x: 0, y: 0, z: 0 });
    shard.addEntity(entity);
    addFakeConn(shard, 'p1', 'Alpha');
    shard.start();

    // One tick of full thrust: the ship moves along +Z.
    shard.enqueueInput('p1', input(1, { thrust: 1 }));
    vi.advanceTimersByTime(TICK_DT_MS);
    const moved = entity.ship.pos.z;
    expect(moved).toBeGreaterThan(0);

    // Kill it in flight.
    shard.applyHit('ship-p1', 150, AI, WEAPON);
    const frozen = { ...entity.ship.pos };

    // Inputs are ignored from here on...
    expect(shard.enqueueInput('p1', input(2, { thrust: 1 }))).toBe(false);
    expect(shard.enqueueInput('p1', input(3, { thrust: 1 }))).toBe(false);
    // ...and the entity no longer integrates: 20 more ticks, no motion.
    vi.advanceTimersByTime(20 * TICK_DT_MS);
    expect(entity.ship.pos).toEqual(frozen);
    shard.stop();
  });

  it('the wreck expires after its 600 s ttl; the destroyed ship stays for the respawn', () => {
    vi.useFakeTimers();
    const shard = makeShard();
    shard.addEntity(makeEntity('p1', { x: 0, y: 0, z: 0 }));
    addFakeConn(shard, 'p1', 'Alpha');
    shard.start();

    shard.applyHit('ship-p1', 150, AI, WEAPON);
    expect(shard.entities.has('wreck:ship-p1')).toBe(true);

    const ttlTicks = Math.round(WRECK_TTL_MS / TICK_DT_MS); // 12 000 @ 20 Hz
    vi.advanceTimersByTime((ttlTicks - 1) * TICK_DT_MS);
    expect(shard.entities.has('wreck:ship-p1')).toBe(true); // one tick early: still there
    vi.advanceTimersByTime(TICK_DT_MS); // the final tick
    expect(shard.entities.has('wreck:ship-p1')).toBe(false); // expired
    expect(shard.entities.has('ship-p1')).toBe(true); // the ship waits for TASK-49
    expect(shard.entities.get('ship-p1')!.destroyed).toBe(true);
    shard.stop();
  });

  it('AI sources flow through the events unharmed', () => {
    vi.useFakeTimers();
    const shard = makeShard();
    shard.addEntity(makeEntity('p1', { x: 0, y: 0, z: 0 }));
    const { sends } = addFakeConn(shard, 'p1', 'Alpha');
    shard.applyHit('ship-p1', 5, { kind: 'ai', id: 'patrol-3' }, WEAPON);
    expect(combatEvents(sends)).toEqual([
      {
        kind: 'hit',
        target: 'ship-p1',
        source: { kind: 'ai', id: 'patrol-3' },
        weapon: WEAPON,
        damage: 5,
        shieldHit: 5,
        hullHit: 0,
      },
    ]);
    shard.stop();
  });
});

describe('SystemShard dock-repair revival (TASK-23 step 3, in-shard)', () => {
  it('a bus swap (repair) revives a destroyed in-shard entity: full hull, docked, integrating again', async () => {
    const system = testSystem();
    const bus = createShipSwapBus();
    const shard = new SystemShard({
      systemId: system.systemId,
      galaxySeed: SEED,
      system,
      repo: { getShipByOwner: async () => undefined, getPlayersByIds: async () => [] },
      shipSwapBus: bus,
      log: { debug() {}, warn() {}, info() {} },
    });
    const entity = makeEntity('p1', { x: 9, y: 9, z: 9 });
    shard.addEntity(entity);
    addFakeConn(shard, 'p1', 'Alpha');
    shard.applyHit('ship-p1', 150, AI, WEAPON);
    expect(entity.destroyed).toBe(true);
    expect(shard.enqueueInput('p1', input(1, { thrust: 1 }))).toBe(false);

    const repaired: ShipRowLike = {
      id: 'ship-p1',
      classId: 'scout',
      livery: {},
      hull: 100,
      shields: 50,
      position: { systemId: system.systemId, x: 1, y: 0, z: 1 },
      velocity: { x: 0, y: 0, z: 0 },
      state: 'docked',
    };
    bus.emitSwap({ playerId: 'p1', ship: repaired, oldShipId: 'ship-p1' });
    // The bus handler is async-safe; the shard's handler body is synchronous,
    // but let one microtask drain so the promise chain settles.
    await Promise.resolve();

    expect(entity.destroyed).toBe(false);
    expect(entity.hull).toBe(1);
    expect(entity.shields).toBe(1);
    expect(entity.docked).toBe(true);
    expect(entity.ship.pos).toEqual({ x: 1, y: 0, z: 1 });
    // And it flies again.
    expect(shard.enqueueInput('p1', input(2, { thrust: 1 }))).toBe(true);

    shard.stop();
  });
});
